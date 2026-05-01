# Phase 14 — Email Verification

## What exists

From Phase 13:
- `src/models/User.js` — User schema without a `verified` field
- `src/services/authService.js` — `register`, `login`, `logout`, `refresh`
- `src/utils/tokens.js` — `signAccessToken` builds the JWT payload
- `src/middleware/authenticate.js` — attaches `req.user` from JWT
- `src/errors/AppError.js` — error classes through `TooManyRequestsError`; no `ForbiddenError` yet
- `src/routes/auth.js` — register, login, logout, refresh

## What needs to be built

Six steps. The core concept: a Redis-backed token is strictly better than a MongoDB-backed token for short-lived one-time values. Redis gives automatic expiry (no cleanup job needed), O(1) lookup, and a single-operation delete — the token is consumed atomically the moment it is used.

The second concept: `verified` belongs in the JWT payload so `requireVerified` needs no database lookup. The trade-off is that the flag does not update until the user's access token is refreshed — acceptable for a 15-minute access token lifetime.

---

## Step 1 — User schema + ForbiddenError

**`src/models/User.js`** — add one field:

```js
verified: { type: Boolean, default: false },
```

No `verificationToken` field on the schema — the token lives only in Redis. Storing it in MongoDB would require a cleanup job to remove expired tokens and adds a write to the user document on every registration. Redis TTL handles both for free.

**`src/errors/AppError.js`** — add `ForbiddenError`:

```js
export class ForbiddenError extends AppError {
  constructor(message = 'Forbidden.', code = 'FORBIDDEN') {
    super(message, 403, code);
  }
}
```

`403 Forbidden` is semantically correct here: the user IS authenticated (valid JWT) but is not authorized to take this action until their email is verified. `401 Unauthorized` would imply they are not authenticated at all.

---

## Step 2 — Include `verified` in the JWT; `requireVerified` middleware

**`src/utils/tokens.js`** — update `signAccessToken` to carry the flag:

```js
export function signAccessToken(user) {
  return jwt.sign(
    {
      sub:      user._id.toString(),
      username: user.username,
      verified: user.verified ?? false,
    },
    process.env.JWT_SECRET,
    { expiresIn: '15m' }
  );
}
```

Including `verified` in the JWT means every route that calls `authenticate` automatically has the flag on `req.user` — no extra database lookup in `requireVerified`.

**Trade-off to know:** If a user verifies their email and then immediately tries to create a room, their current access token still has `verified: false`. They must call `POST /auth/refresh` (or re-login) to get a new token that reflects the updated flag. This is the expected behavior for short-lived stateless tokens — document it in the API response.

**`src/middleware/requireVerified.js`:**

```js
import { ForbiddenError } from '../errors/AppError.js';

export function requireVerified(req, _res, next) {
  if (!req.user.verified) {
    throw new ForbiddenError(
      'Email address not verified. Check your inbox or call POST /auth/resend-verification.',
      'UNVERIFIED'
    );
  }
  next();
}
```

---

## Step 3 — Email utility

Install Nodemailer:

```bash
npm install nodemailer
```

For local development, use [Mailtrap](https://mailtrap.io) (free SMTP sandbox that catches all emails without delivering them) or any other SMTP service. For production, replace with SendGrid, Postmark, or AWS SES.

**`src/utils/email.js`:**

```js
import nodemailer from 'nodemailer';
import { logger } from './logger.js';

const transporter = nodemailer.createTransport({
  host:   process.env.SMTP_HOST,
  port:   parseInt(process.env.SMTP_PORT) || 587,
  secure: process.env.SMTP_SECURE === 'true',
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

export async function sendVerificationEmail(to, token) {
  const link = `${process.env.APP_URL}/api/v1/auth/verify-email?token=${token}`;

  await transporter.sendMail({
    from:    `"TeamChat" <${process.env.SMTP_FROM}>`,
    to,
    subject: 'Verify your TeamChat email address',
    text:    `Verify your email by visiting: ${link}\n\nThis link expires in 24 hours.`,
    html:    `
      <p>Thanks for registering. Click the link below to verify your email address:</p>
      <p><a href="${link}">${link}</a></p>
      <p>This link expires in 24 hours. If you did not register, ignore this email.</p>
    `,
  });

  logger.info({ to }, 'Verification email sent');
}
```

**New environment variables** — add to `.env` and `.env.example`:

```env
SMTP_HOST=smtp.mailtrap.io
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=<mailtrap-username>
SMTP_PASS=<mailtrap-password>
SMTP_FROM=noreply@teamchat.local
APP_URL=http://localhost:3000
```

---

## Step 4 — Auth service: register, verifyEmail, resendVerification

**`src/services/authService.js`** — three changes:

**Update `register`** to generate a token and send the email:

```js
import { randomBytes } from 'crypto';
import { sendVerificationEmail } from '../utils/email.js';

const VERIFY_TOKEN_TTL = 24 * 60 * 60; // 24 hours in seconds

export async function register({ username, email, password }) {
  // ... existing duplicate-check and user creation ...

  // Generate a 64-character hex token (32 random bytes)
  const token = randomBytes(32).toString('hex');

  // Store token → userId in Redis with 24-hour TTL
  // Key pattern: email-verify:{token}
  // This avoids MongoDB — Redis expiry handles cleanup automatically
  await redis.set(`email-verify:${token}`, user._id.toString(), 'EX', VERIFY_TOKEN_TTL);

  // Send email (synchronous here; Phase 16 moves this into a BullMQ job)
  await sendVerificationEmail(email, token);

  const accessToken  = signAccessToken(user);
  const refreshToken = await createRefreshToken(user._id);

  return { accessToken, refreshToken };
}
```

**Add `verifyEmail`:**

```js
export async function verifyEmail(token) {
  if (!token) throw new ValidationError('Token is required.', 'MISSING_TOKEN');

  // GET + DEL would be two operations with a race window.
  // GETDEL is atomic in Redis 6.2+. For older Redis, use a Lua script.
  const userId = await redis.getdel(`email-verify:${token}`);

  if (!userId) {
    throw new ValidationError('Invalid or expired verification token.', 'INVALID_TOKEN');
  }

  await User.findByIdAndUpdate(userId, { $set: { verified: true } });
}
```

`redis.getdel` atomically reads and deletes the key — single-use enforcement. If two requests race to verify the same token, one gets the userId and one gets `null`. Without atomicity, both could read the key before either deletes it.

**Add `resendVerification`:**

```js
const RESEND_INCR_LUA = `
  local c = redis.call('INCR', KEYS[1])
  if c == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end
  return c
`;

export async function resendVerification(userId) {
  const user = await User.findById(userId).select('+verified').lean();
  if (!user) throw new NotFoundError('User not found.', 'USER_NOT_FOUND');

  if (user.verified) {
    throw new ValidationError('Email is already verified.', 'ALREADY_VERIFIED');
  }

  // Rate limit: 3 resend requests per hour per user
  const count = await redis.eval(RESEND_INCR_LUA, 1, `rl:resend:${userId}`, 3600);
  if (count > 3) {
    throw new TooManyRequestsError('Too many resend requests. Try again in an hour.');
  }

  // Old token (if any) expires naturally — no need to track or delete it
  const token = randomBytes(32).toString('hex');
  await redis.set(`email-verify:${token}`, userId.toString(), 'EX', VERIFY_TOKEN_TTL);
  await sendVerificationEmail(user.email, token);
}
```

---

## Step 5 — Auth controller and routes

**`src/controllers/authController.js`** — add two handlers:

```js
export async function verifyEmail(req, res) {
  await authService.verifyEmail(req.query.token);
  // Instruct the client to refresh their access token — the old token
  // still has verified: false until a new one is issued
  res.json(ApiResponse.success({
    message: 'Email verified. Call POST /auth/refresh to update your access token.',
  }));
}

export async function resendVerification(req, res) {
  await authService.resendVerification(req.user.sub);
  res.json(ApiResponse.success({ message: 'Verification email sent.' }));
}
```

**`src/routes/auth.js`** — append two routes:

```js
import { requireVerified } from '../middleware/requireVerified.js';

/**
 * @openapi
 * /auth/verify-email:
 *   get:
 *     summary: Verify email address using a token from the verification email
 *     tags: [Auth]
 *     parameters:
 *       - { name: token, in: query, required: true, schema: { type: string } }
 *     responses:
 *       '200': { description: Email verified }
 *       '422': { description: Invalid or expired token }
 */
authRouter.get('/verify-email', authController.verifyEmail);

/**
 * @openapi
 * /auth/resend-verification:
 *   post:
 *     summary: Resend verification email (max 3 per hour)
 *     tags: [Auth]
 *     responses:
 *       '200': { description: Email sent }
 *       '422': { description: Email already verified }
 *       '429': { description: Rate limit exceeded }
 */
authRouter.post('/resend-verification', authenticate, authController.resendVerification);
```

---

## Step 6 — Apply requireVerified to protected actions

**`src/routes/rooms.js`** — gate room creation and joining:

```js
import { requireVerified } from '../middleware/requireVerified.js';

// Add requireVerified after authenticate on write operations
roomsRouter.post('/',         requireVerified, roomController.createRoom);
roomsRouter.post('/:id/join', requireVerified, roomController.joinRoom);

// Read operations remain open to authenticated but unverified users
roomsRouter.get('/',          roomController.listRooms);
roomsRouter.get('/:id',       roomController.getRoomById);
```

**`src/socket/messageHandlers.js`** — gate `message:send` in the socket layer:

```js
socket.on('message:send', safe(socket, async ({ roomId, content }) => {
  if (!content?.trim())
    return socket.emit('error', { code: 'INVALID_CONTENT' });

  // verified flag comes from the JWT decoded in socketAuthenticate
  if (!socket.user.verified)
    return socket.emit('error', { code: 'UNVERIFIED' });

  const allowed = await checkMessageRateLimit(socket.user.sub);
  if (!allowed)
    return socket.emit('error', { code: 'RATE_LIMITED' });

  const message = await messageService.createMessage(roomId, {
    senderId:       socket.user.sub,
    senderUsername: socket.user.username,
    content,
  });

  io.to(roomId).emit('message:new', message);
}));
```

`requireVerified` is an Express middleware and cannot be used directly in Socket.io handlers. The socket equivalent is an explicit check on `socket.user.verified`, which is set by `socketAuthenticate` from the JWT payload.

---

## Verification

**1. Registration sends a verification email:**

```bash
curl -s -X POST http://localhost:3000/api/v1/auth/register \
  -H 'Content-Type: application/json' \
  -d '{"username":"alice","email":"alice@example.com","password":"secret123"}'

# Open Mailtrap — expect one email with subject "Verify your TeamChat email address"
# Confirm the link contains a 64-character hex token
```

**2. Token stored in Redis with 24-hour TTL:**

```bash
# Copy the token from the email link
redis-cli KEYS "email-verify:*"
# Expected: one key

redis-cli TTL "email-verify:<token>"
# Expected: ~86400 (24 hours)

redis-cli GET "email-verify:<token>"
# Expected: alice's userId
```

**3. Verify the email:**

```bash
curl -s "http://localhost:3000/api/v1/auth/verify-email?token=<token>"
# Expected: 200 { data: { message: "Email verified. Call POST /auth/refresh..." } }

redis-cli GET "email-verify:<token>"
# Expected: (nil) — key was deleted atomically by GETDEL

# Confirm MongoDB updated:
# mongosh: db.users.findOne({ username: 'alice' }, { verified: 1 })
# Expected: { verified: true }
```

**4. Token is single-use (replay attack):**

```bash
# Attempt to use the same token a second time
curl -s "http://localhost:3000/api/v1/auth/verify-email?token=<token>"
# Expected: 422 { error: { code: "INVALID_TOKEN" } }
# Key was deleted on first use — second request gets null from Redis
```

**5. Unverified user cannot create a room:**

```bash
# Log in as a fresh unverified user, get their access token
curl -s -X POST http://localhost:3000/api/v1/rooms \
  -H "Authorization: Bearer $UNVERIFIED_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"name":"test-room"}'
# Expected: 403 { error: { code: "UNVERIFIED" } }
```

**6. Access token reflects verified status after refresh:**

```bash
# After verifying email, the old access token still has verified: false
# Decode it at jwt.io — confirmed: verified: false

# Call refresh endpoint
curl -s -X POST http://localhost:3000/api/v1/auth/refresh \
  -H 'Content-Type: application/json' \
  -d '{"refreshToken":"<refresh-token>"}'

# Decode the NEW access token — confirmed: verified: true
# Now POST /rooms succeeds
```

**7. Resend rate limit:**

```bash
# Call resend 4 times as the same authenticated user
for i in 1 2 3 4; do
  curl -s -X POST http://localhost:3000/api/v1/auth/resend-verification \
    -H "Authorization: Bearer $TOKEN"
done
# Expected: first 3 return 200; 4th returns 429 TOO_MANY_REQUESTS

redis-cli GET "rl:resend:<userId>"
# Expected: "4"
redis-cli TTL "rl:resend:<userId>"
# Expected: ~3600 (1 hour)
```

**8. Expired token returns INVALID_TOKEN:**

```bash
# Set a very short TTL to test expiry
redis-cli SET "email-verify:testtoken" "<userId>" EX 1
sleep 2
curl -s "http://localhost:3000/api/v1/auth/verify-email?token=testtoken"
# Expected: 422 INVALID_TOKEN — key expired, GETDEL returns null
```

---

## File map

| File | Status |
|---|---|
| `src/models/User.js` | Updated — add `verified: Boolean, default: false` |
| `src/errors/AppError.js` | Updated — add `ForbiddenError` (403) |
| `src/utils/tokens.js` | Updated — `signAccessToken` includes `verified` in payload |
| `src/utils/email.js` | New — `sendVerificationEmail` via Nodemailer |
| `src/services/authService.js` | Updated — `register` sends verification email; add `verifyEmail`, `resendVerification` |
| `src/middleware/requireVerified.js` | New — checks `req.user.verified`; throws `ForbiddenError` if false |
| `src/controllers/authController.js` | Updated — add `verifyEmail`, `resendVerification` handlers |
| `src/routes/auth.js` | Updated — `GET /verify-email`, `POST /resend-verification` |
| `src/routes/rooms.js` | Updated — `requireVerified` on `POST /` and `POST /:id/join` |
| `src/socket/messageHandlers.js` | Updated — `socket.user.verified` check in `message:send` |
| `.env` / `.env.example` | Updated — `SMTP_*` and `APP_URL` variables |

---

## Checklist

- [ ] Step 1 — `verified: false` default added to User schema
- [ ] Step 1 — `ForbiddenError` uses status 403; can explain 403 vs 401 distinction
- [ ] Step 2 — `signAccessToken` includes `verified` in the JWT payload
- [ ] Step 2 — `requireVerified` reads from `req.user.verified` — no database lookup
- [ ] Step 2 — Can explain the trade-off: token must be refreshed to reflect new verified status
- [ ] Step 3 — `sendVerificationEmail` uses `process.env.APP_URL` to build the link — not a hardcoded URL
- [ ] Step 3 — SMTP credentials are in `.env`, not in source code
- [ ] Step 4 — `register` stores `email-verify:{token}` → userId in Redis with 24-hour TTL
- [ ] Step 4 — `verifyEmail` uses `redis.getdel` — atomic read-and-delete, single-use enforcement
- [ ] Step 4 — `resendVerification` checks `user.verified` before generating a new token
- [ ] Step 4 — `resendVerification` uses Lua-atomic INCR for the per-user rate limit
- [ ] Step 4 — Can explain why old tokens are not explicitly deleted on resend (they expire naturally)
- [ ] Step 5 — `GET /verify-email` response instructs client to refresh their access token
- [ ] Step 5 — `POST /resend-verification` requires `authenticate` — scoped to the logged-in user
- [ ] Step 6 — `requireVerified` applied to `POST /rooms` and `POST /:id/join`; read routes unaffected
- [ ] Step 6 — Socket `message:send` checks `socket.user.verified` directly (not via Express middleware)
- [ ] Verification — Token is deleted from Redis after first use (replay returns INVALID_TOKEN)
- [ ] Verification — Unverified user receives 403 on `POST /rooms`
- [ ] Verification — New access token after refresh has `verified: true` in payload
- [ ] Verification — 4th resend request returns 429 within the 1-hour window
- [ ] Knowledge check — Can explain why Redis is preferable to MongoDB for storing verification tokens
- [ ] Knowledge check — Can explain why `GETDEL` prevents a race condition that GET + DEL cannot
