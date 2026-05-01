# Phase 15 — Password Reset and Account Lockout

## What exists

From Phase 14:
- `src/services/authService.js` — `register`, `login`, `logout`, `refresh`, `verifyEmail`, `resendVerification`
- `src/utils/email.js` — `sendVerificationEmail` via Nodemailer
- `src/errors/AppError.js` — includes `ForbiddenError` (403)
- `src/utils/tokens.js` — `signAccessToken`, `createRefreshToken`, `verifyRefreshToken`
- Redis key patterns in use: `refresh:{userId}:{tokenId}`, `email-verify:{token}`, `rl:*`

## What needs to be built

Five steps. Two independent security features that share the same Redis token pattern:

**Password reset:** Request token → email → validate + consume token → update password + invalidate all sessions.

**Account lockout:** Failed login → increment counter → lock after 5 failures → auto-unlock after 15 minutes.

Both share a critical security principle: **never confirm whether an input (email, username) exists in your system**. Every failure path returns the same generic response to prevent enumeration attacks.

---

## Step 1 — LockedError (423) and reset email helper

**`src/errors/AppError.js`** — add `LockedError`:

```js
export class LockedError extends AppError {
  constructor(message = 'Account temporarily locked.', code = 'ACCOUNT_LOCKED') {
    super(message, 423, code);
  }
}
```

HTTP 423 (Locked) is the correct status for a temporarily locked resource. It signals the client to display a "try again later" message rather than prompting for credentials again.

**`src/utils/email.js`** — add `sendPasswordResetEmail`:

```js
export async function sendPasswordResetEmail(to, token) {
  const link = `${process.env.APP_URL}/api/v1/auth/reset-password?token=${token}`;

  await transporter.sendMail({
    from:    `"TeamChat" <${process.env.SMTP_FROM}>`,
    to,
    subject: 'Reset your TeamChat password',
    text:    `Reset your password by visiting: ${link}\n\nThis link expires in 1 hour. If you did not request this, ignore the email.`,
    html:    `
      <p>You requested a password reset. Click the link below:</p>
      <p><a href="${link}">${link}</a></p>
      <p>This link expires in 1 hour. If you did not request this, your account is safe — ignore this email.</p>
    `,
  });

  logger.info({ to }, 'Password reset email sent');
}
```

---

## Step 2 — forgotPassword service function

**`src/services/authService.js`** — add `forgotPassword`:

```js
const RESET_TOKEN_TTL   = 60 * 60;     // 1 hour in seconds
const FORGOT_INCR_LUA  = `
  local c = redis.call('INCR', KEYS[1])
  if c == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end
  return c
`;

export async function forgotPassword(email) {
  // Rate limit by email address: 3 requests per hour
  // Prevents token-spam attacks against a victim's inbox
  const rateKey = `rl:forgot:${email.toLowerCase()}`;
  const count   = await redis.eval(FORGOT_INCR_LUA, 1, rateKey, 3600);
  if (count > 3) {
    // Still return 200 — do not confirm whether the email exists
    // Leaking "rate limited" tells the attacker the account exists
    return;
  }

  // Look up user silently — no error thrown if not found
  const user = await User.findOne({ email: email.toLowerCase() }).lean();
  if (!user) {
    // Do NOT throw NotFoundError — that would confirm the email is not registered
    // (email enumeration attack). Return silently.
    return;
  }

  const token = randomBytes(32).toString('hex');
  await redis.set(`pwd-reset:${token}`, user._id.toString(), 'EX', RESET_TOKEN_TTL);
  await sendPasswordResetEmail(email, token);
}
```

**Why the silent return on unknown email:**

If `POST /auth/forgot-password` returns 404 for unregistered emails and 200 for registered ones, an attacker can enumerate every email in your database by probing the endpoint. Always return 200 with a generic "if this email is registered, you'll receive a link" message. The controller response handles this.

---

## Step 3 — resetPassword service function

**`src/services/authService.js`** — add `resetPassword` and the `invalidateAllRefreshTokens` helper:

```js
async function invalidateAllRefreshTokens(userId) {
  // SCAN for all refresh token keys belonging to this user.
  // SCAN iterates in O(1) per call — safe for production unlike KEYS which blocks.
  // Trade-off: requires multiple round-trips for large keyspaces.
  // Alternative: a version counter (see Knowledge Check) invalidates in O(1).
  const keys   = [];
  let   cursor = '0';

  do {
    const [nextCursor, batch] = await redis.scan(
      cursor, 'MATCH', `refresh:${userId}:*`, 'COUNT', 50
    );
    cursor = nextCursor;
    keys.push(...batch);
  } while (cursor !== '0');

  if (keys.length > 0) {
    await redis.del(...keys);
  }
}

export async function resetPassword(token, newPassword) {
  if (!token) throw new ValidationError('Token is required.', 'MISSING_TOKEN');

  if (!newPassword || newPassword.length < 8) {
    throw new ValidationError('Password must be at least 8 characters.', 'WEAK_PASSWORD');
  }

  // Atomically read and delete — single-use enforcement
  // If two concurrent requests arrive with the same token, only one gets the userId
  const userId = await redis.getdel(`pwd-reset:${token}`);
  if (!userId) {
    throw new ValidationError('Invalid or expired reset token.', 'INVALID_TOKEN');
  }

  const passwordHash = await bcrypt.hash(newPassword, 12);

  await User.findByIdAndUpdate(userId, { $set: { passwordHash } });

  // Invalidate ALL existing refresh tokens for this user.
  // Required: if an attacker triggered this reset, the legitimate user's
  // active sessions must be terminated. The user re-authenticates with
  // their new password to get fresh tokens.
  await invalidateAllRefreshTokens(userId);
}
```

**Why invalidating all refresh tokens is a security requirement, not a convenience:**

If an attacker resets the password (e.g., they have access to the victim's email), they now control the account. The legitimate user still has a valid refresh token — without invalidation, both parties would have active sessions simultaneously. Invalidating all sessions forces the legitimate user to re-authenticate with the new password (which the attacker set) and alerts them something is wrong.

---

## Step 4 — Account lockout in login

**Redis keys:**

| Key | TTL | Purpose |
|---|---|---|
| `login-attempts:{userId}` | 15 minutes (reset on success) | Failed attempt counter |
| `login-locked:{userId}` | 15 minutes | Lock flag; presence = locked |

The counter and lock are separate keys. The counter is reset on successful login; the lock key is not — a successful login after the lock TTL expires does not need to explicitly delete the lock (it has already expired).

**`src/services/authService.js`** — update `login`:

```js
const LOCKOUT_THRESHOLD = 5;
const LOCKOUT_TTL       = 15 * 60; // 15 minutes in seconds

export async function login({ username, password }) {
  // Use the same generic error for "username not found" and "wrong password"
  // to prevent username enumeration
  const user = await User.findOne({ username }).select('+passwordHash').lean();

  if (!user) {
    // No user found — still throw INVALID_CREDENTIALS, not USER_NOT_FOUND
    const err = new Error('INVALID_CREDENTIALS');
    err.code  = 'INVALID_CREDENTIALS';
    throw err;
  }

  // Check lockout BEFORE verifying the password
  // Even a correct password is rejected while locked — otherwise an attacker
  // could use the response time difference (bcrypt is slow) to infer a correct password
  const locked = await redis.exists(`login-locked:${user._id}`);
  if (locked) {
    const ttl = await redis.ttl(`login-locked:${user._id}`);
    throw new LockedError(
      `Account locked after too many failed attempts. Try again in ${Math.ceil(ttl / 60)} minutes.`,
      'ACCOUNT_LOCKED'
    );
  }

  const valid = await bcrypt.compare(password, user.passwordHash);

  if (!valid) {
    // Increment the failed-attempt counter atomically
    const attempts = await redis.eval(FORGOT_INCR_LUA, 1, `login-attempts:${user._id}`, LOCKOUT_TTL);

    if (attempts >= LOCKOUT_THRESHOLD) {
      // Threshold reached — set the lock key
      // The attempt counter TTL and lock TTL are both 15 minutes.
      // The lock key is what login checks, not the counter directly.
      await redis.set(`login-locked:${user._id}`, '1', 'EX', LOCKOUT_TTL);
      throw new LockedError(
        'Too many failed attempts. Account locked for 15 minutes.',
        'ACCOUNT_LOCKED'
      );
    }

    const remaining = LOCKOUT_THRESHOLD - attempts;
    const err       = new Error('INVALID_CREDENTIALS');
    err.code        = 'INVALID_CREDENTIALS';
    err.remaining   = remaining; // optional: include in response for UX
    throw err;
  }

  // Successful login — reset the attempt counter
  // The lock key (if it somehow exists) will expire naturally
  await redis.del(`login-attempts:${user._id}`);

  const accessToken  = signAccessToken(user);
  const refreshToken = await createRefreshToken(user._id);

  return { accessToken, refreshToken };
}
```

**Why check lockout before `bcrypt.compare`:**

`bcrypt.compare` is intentionally slow (the cost factor is the point). An attacker who knows the correct password could observe the response time: slow = bcrypt ran = password was correct. Checking the lock key first short-circuits before bcrypt, giving a fast 423 regardless of whether the password is right or wrong.

---

## Step 5 — Controller and routes

**`src/controllers/authController.js`** — add three handlers:

```js
export async function forgotPassword(req, res) {
  const { email } = req.body;
  // Always 200 — do not confirm whether the email is registered
  if (email) await authService.forgotPassword(email);
  res.json(ApiResponse.success({
    message: 'If that email is registered, a reset link has been sent.',
  }));
}

export async function resetPassword(req, res) {
  const { newPassword } = req.body;
  const { token }       = req.query;
  await authService.resetPassword(token, newPassword);
  res.json(ApiResponse.success({
    message: 'Password updated. All existing sessions have been invalidated.',
  }));
}
```

`login` already exists in the controller — no change needed there; the `LockedError` thrown by the service propagates through `express-async-errors` and is handled by the global error handler.

**`src/routes/auth.js`** — append two routes:

```js
/**
 * @openapi
 * /auth/forgot-password:
 *   post:
 *     summary: Request a password reset email
 *     tags: [Auth]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [email]
 *             properties:
 *               email: { type: string, format: email }
 *     responses:
 *       '200':
 *         description: Always 200 — does not confirm whether the email is registered
 */
authRouter.post('/forgot-password', authRateLimiter, authController.forgotPassword);

/**
 * @openapi
 * /auth/reset-password:
 *   post:
 *     summary: Reset password using a token from the reset email
 *     tags: [Auth]
 *     parameters:
 *       - { name: token, in: query, required: true, schema: { type: string } }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [newPassword]
 *             properties:
 *               newPassword: { type: string, minLength: 8 }
 *     responses:
 *       '200': { description: Password updated; all sessions invalidated }
 *       '422': { description: Invalid or expired token, or weak password }
 */
authRouter.post('/reset-password', authController.resetPassword);
```

`forgot-password` reuses the existing `authRateLimiter` from Phase 9 (IP-scoped, 10 req / 15 min). This is a second layer on top of the per-email rate limit inside the service.

---

## Verification

**1. Full reset flow:**

```bash
# 1. Request a reset
curl -s -X POST http://localhost:3000/api/v1/auth/forgot-password \
  -H 'Content-Type: application/json' \
  -d '{"email":"alice@example.com"}'
# Expected: 200 with generic message (even for an unregistered email)

# 2. Check Redis
redis-cli KEYS "pwd-reset:*"
# Expected: one key

redis-cli TTL "pwd-reset:<token>"
# Expected: ~3600 (1 hour)

# 3. Copy token from Mailtrap email, then reset the password
curl -s -X POST "http://localhost:3000/api/v1/auth/reset-password?token=<token>" \
  -H 'Content-Type: application/json' \
  -d '{"newPassword":"newpassword123"}'
# Expected: 200 { message: "Password updated. All existing sessions have been invalidated." }

# 4. Confirm token was consumed
redis-cli GET "pwd-reset:<token>"
# Expected: (nil) — GETDEL deleted it

# 5. Confirm old refresh tokens are gone
redis-cli KEYS "refresh:<userId>:*"
# Expected: (empty list) — all sessions invalidated
```

**2. Token is single-use:**

```bash
# Use the same token twice
curl -s -X POST "http://localhost:3000/api/v1/auth/reset-password?token=<token>" \
  -d '{"newPassword":"anotherpassword"}'
# Expected: 422 INVALID_TOKEN — token was deleted on first use
```

**3. Unregistered email returns 200 (no enumeration):**

```bash
curl -s -X POST http://localhost:3000/api/v1/auth/forgot-password \
  -H 'Content-Type: application/json' \
  -d '{"email":"nobody@nowhere.com"}'
# Expected: 200 with the same generic message — no 404, no indication email is unregistered

redis-cli KEYS "pwd-reset:*"
# Expected: no new keys — nothing was stored for a non-existent user
```

**4. Account lockout — 5 failed logins:**

```bash
for i in $(seq 1 6); do
  curl -s -X POST http://localhost:3000/api/v1/auth/login \
    -H 'Content-Type: application/json' \
    -d '{"username":"alice","password":"wrongpassword"}' | jq '.error.code'
done
# Expected: first 4 return "INVALID_CREDENTIALS"
#           5th returns "ACCOUNT_LOCKED" (threshold hit)
#           6th returns "ACCOUNT_LOCKED" (still locked)

redis-cli EXISTS "login-locked:<alice-userId>"
# Expected: 1

redis-cli TTL "login-locked:<alice-userId>"
# Expected: ~900 (15 minutes)
```

**5. Correct password is rejected while locked:**

```bash
# While the lock is active, even the correct password fails
curl -s -X POST http://localhost:3000/api/v1/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"alice","password":"correctpassword"}'
# Expected: 423 ACCOUNT_LOCKED — bcrypt is never called
```

**6. Successful login resets the attempt counter:**

```bash
# Wait for the lock to expire (or manually delete it for testing):
redis-cli DEL "login-locked:<userId>"

# Log in with the correct password
curl -s -X POST http://localhost:3000/api/v1/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"alice","password":"correctpassword"}'
# Expected: 200 with tokens

redis-cli GET "login-attempts:<userId>"
# Expected: (nil) — counter deleted on successful login
```

**7. Weak password rejected:**

```bash
curl -s -X POST "http://localhost:3000/api/v1/auth/reset-password?token=<valid-token>" \
  -H 'Content-Type: application/json' \
  -d '{"newPassword":"short"}'
# Expected: 422 WEAK_PASSWORD
```

---

## File map

| File | Status |
|---|---|
| `src/errors/AppError.js` | Updated — add `LockedError` (423) |
| `src/utils/email.js` | Updated — add `sendPasswordResetEmail` |
| `src/services/authService.js` | Updated — add `forgotPassword`, `resetPassword`, `invalidateAllRefreshTokens`; update `login` with lockout logic |
| `src/controllers/authController.js` | Updated — add `forgotPassword`, `resetPassword` handlers |
| `src/routes/auth.js` | Updated — `POST /forgot-password`, `POST /reset-password` |

---

## Checklist

- [ ] Step 1 — `LockedError` uses status 423; can explain 423 vs 401/403
- [ ] Step 2 — `forgotPassword` returns 200 for both registered and unregistered emails — no enumeration
- [ ] Step 2 — Per-email rate limit (3/hour) uses Lua-atomic INCR — same pattern as Phase 14
- [ ] Step 2 — Token stored as `pwd-reset:{token}` → userId with 1-hour TTL
- [ ] Step 3 — `resetPassword` uses `redis.getdel` — atomic single-use enforcement
- [ ] Step 3 — `resetPassword` validates `newPassword.length >= 8` before touching the database
- [ ] Step 3 — `invalidateAllRefreshTokens` uses SCAN with MATCH pattern — not `KEYS` (which blocks)
- [ ] Step 3 — All refresh tokens deleted after password reset — can explain why this is a security requirement
- [ ] Step 4 — Lockout check happens BEFORE `bcrypt.compare` — prevents timing attack
- [ ] Step 4 — `login-locked:{userId}` and `login-attempts:{userId}` are separate keys
- [ ] Step 4 — Counter uses Lua-atomic INCR with TTL
- [ ] Step 4 — Lock key set when `attempts >= 5`; TTL is 15 minutes
- [ ] Step 4 — Successful login deletes `login-attempts:{userId}`; lock key expires naturally
- [ ] Step 5 — `POST /forgot-password` uses `authRateLimiter` (IP-level, second layer)
- [ ] Step 5 — `POST /reset-password` does not require authentication — token IS the credential
- [ ] Verification — Same token used twice returns 422 on the second attempt
- [ ] Verification — Unregistered email request returns 200 (confirmed: no Redis key created)
- [ ] Verification — 6th login attempt returns 423 while lock key exists in Redis
- [ ] Verification — Correct password rejected with 423 while locked (bcrypt never called)
- [ ] Verification — All `refresh:{userId}:*` keys gone after password reset
- [ ] Knowledge check — Can explain the email enumeration attack and why `forgotPassword` always returns 200
- [ ] Knowledge check — Can explain why the lockout check must precede `bcrypt.compare`
- [ ] Knowledge check — Can explain the SCAN vs KEYS trade-off for `invalidateAllRefreshTokens`
- [ ] Knowledge check — Alternative to SCAN: a version counter `refresh-ver:{userId}` invalidated in O(1) by incrementing; each token's payload carries the version; mismatch = invalid
