# Phase 3 — Authentication

## What exists

From Phase 2:
- Express app with middleware in order: pino-http → json → correlationId → routes → 404 → errorHandler
- `ApiResponse` envelope helpers
- All error classes including `UnauthorizedError`
- `express-async-errors` — async throws propagate automatically

## What needs to be built

Eight steps. The central concept is the **access token / refresh token split**: access tokens are fast and stateless but unrevocable; refresh tokens are revocable but require a Redis round-trip. Implementing both makes the trade-off concrete.

---

## Step 1 — Install dependencies

```bash
npm install bcrypt jsonwebtoken ioredis
```

Add the new environment variables to `.env.example`:

```
JWT_SECRET=change-me-in-production
JWT_REFRESH_SECRET=another-secret-change-me-in-production
REDIS_URL=redis://localhost:6379
```

Two separate secrets — one per token type. If the access token secret is compromised, an attacker cannot forge refresh tokens, and vice versa.

---

## Step 2 — Redis client

`ioredis` connects automatically on instantiation. The `retryStrategy` keeps reconnecting with an increasing delay rather than crashing the process on a transient Redis outage.

**`src/db/redis.js`:**

```js
import Redis from 'ioredis';
import { logger } from '../utils/logger.js';

export const redis = new Redis(process.env.REDIS_URL, {
  retryStrategy(times) {
    return Math.min(times * 100, 3000);
  },
});

redis.on('connect', () => logger.info('Redis connected'));
redis.on('error',   (err) => logger.error({ err }, 'Redis connection error'));
```

---

## Step 3 — Token helpers

All token logic lives in one place. Nothing outside this file touches JWT signing or Redis refresh key structure directly.

The Redis key `refresh:{userId}:{tokenId}` is documented in the PRD. Including `userId` in the key enables a future "logout all devices" operation: `redis.keys('refresh:{userId}:*')` then delete all matches.

**Refresh token rotation** is implemented in the `refresh` endpoint: the old Redis key is deleted before the new token is issued. This prevents a stolen refresh token from being reused after one successful refresh.

**`src/utils/tokens.js`:**

```js
import jwt from 'jsonwebtoken';
import { v4 as uuidv4 } from 'uuid';
import { redis } from '../db/redis.js';

const ACCESS_TTL_SEC  = 15 * 60;         // 15 minutes
const REFRESH_TTL_SEC = 7 * 24 * 3600;  // 7 days

export function signAccessToken(userId, username) {
  return jwt.sign(
    { sub: userId, username },
    process.env.JWT_SECRET,
    { expiresIn: ACCESS_TTL_SEC }
  );
}

export async function issueRefreshToken(userId) {
  const tokenId = uuidv4();
  await redis.set(`refresh:${userId}:${tokenId}`, 'valid', 'EX', REFRESH_TTL_SEC);

  return jwt.sign(
    { sub: userId, jti: tokenId, type: 'refresh' },
    process.env.JWT_REFRESH_SECRET,
    { expiresIn: REFRESH_TTL_SEC }
  );
}

export async function validateRefreshToken(token) {
  let payload;
  try {
    payload = jwt.verify(token, process.env.JWT_REFRESH_SECRET);
  } catch {
    return null;
  }

  if (payload.type !== 'refresh') return null;

  const exists = await redis.exists(`refresh:${payload.sub}:${payload.jti}`);
  if (!exists) return null;

  return { userId: payload.sub, tokenId: payload.jti };
}

export async function revokeRefreshToken(userId, tokenId) {
  await redis.del(`refresh:${userId}:${tokenId}`);
}
```

Why the refresh token is a signed JWT and not a plain UUID: the JWT signature prevents forgery without a Redis lookup. The Redis check is only what makes it revocable. A plain UUID stored in Redis would also work, but you would lose the ability to read `userId` from the token without a Redis lookup — which would require a different key structure.

---

## Step 4 — Auth service

`login` uses `.select('+passwordHash')` to override the `select: false` set on the schema in Phase 1 — the only place where the hash should be loaded.

Error messages for login use the same string for both "user not found" and "wrong password." Distinguishing them lets an attacker enumerate valid email addresses.

**`src/services/authService.js`:**

```js
import bcrypt from 'bcrypt';
import { User } from '../models/User.js';
import { ConflictError, UnauthorizedError } from '../errors/AppError.js';
import {
  signAccessToken,
  issueRefreshToken,
  validateRefreshToken,
  revokeRefreshToken,
} from '../utils/tokens.js';

const BCRYPT_ROUNDS = 12;

export async function register({ username, email, password }) {
  const existing = await User.findOne({ $or: [{ username }, { email }] });
  if (existing) {
    const field = existing.username === username ? 'Username' : 'Email';
    throw new ConflictError(`${field} is already taken.`, 'ALREADY_EXISTS');
  }

  const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
  const user = await User.create({ username, email, passwordHash });

  const accessToken  = signAccessToken(user._id.toString(), user.username);
  const refreshToken = await issueRefreshToken(user._id.toString());

  return { user: toPublicUser(user), accessToken, refreshToken };
}

export async function login({ email, password }) {
  const user = await User.findOne({ email }).select('+passwordHash');
  if (!user) throw new UnauthorizedError('Invalid email or password.');

  const valid = await bcrypt.compare(password, user.passwordHash);
  if (!valid) throw new UnauthorizedError('Invalid email or password.');

  const accessToken  = signAccessToken(user._id.toString(), user.username);
  const refreshToken = await issueRefreshToken(user._id.toString());

  return { user: toPublicUser(user), accessToken, refreshToken };
}

export async function refresh(token) {
  const result = await validateRefreshToken(token);
  if (!result) throw new UnauthorizedError('Invalid or expired refresh token.');

  // Rotate: delete old token before issuing new one — prevents reuse after rotation
  await revokeRefreshToken(result.userId, result.tokenId);

  const user = await User.findById(result.userId);
  if (!user) throw new UnauthorizedError('User not found.');

  const accessToken     = signAccessToken(user._id.toString(), user.username);
  const newRefreshToken = await issueRefreshToken(user._id.toString());

  return { accessToken, refreshToken: newRefreshToken };
}

export async function logout(token) {
  const result = await validateRefreshToken(token);
  if (!result) return; // Already invalid or expired — treat as success, not an error
  await revokeRefreshToken(result.userId, result.tokenId);
}

function toPublicUser(user) {
  return {
    id:          user._id,
    username:    user.username,
    email:       user.email,
    displayName: user.displayName,
    avatarUrl:   user.avatarUrl,
    createdAt:   user.createdAt,
  };
}
```

---

## Step 5 — JWT authentication middleware (HTTP)

Attach `req.user` with the decoded payload so downstream route handlers can access `req.user.sub` (userId) and `req.user.username` without re-decoding the token.

**`src/middleware/authenticate.js`:**

```js
import jwt from 'jsonwebtoken';
import { UnauthorizedError } from '../errors/AppError.js';

export function authenticate(req, res, next) {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer '))
    throw new UnauthorizedError('Authorization header missing or malformed.');

  const token = header.slice(7);
  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET);
  } catch {
    throw new UnauthorizedError('Invalid or expired token.');
  }

  next();
}
```

---

## Step 6 — Socket.io authentication middleware

Defined now, wired into the Socket.io server in Phase 6. The JWT comes from the client's handshake `auth` object: `io({ auth: { token: accessToken } })`.

Socket.io middleware signals failure by calling `next(new Error(...))` — not by throwing. The error string `'UNAUTHORIZED'` is passed to the client as the disconnect reason.

**`src/middleware/socketAuthenticate.js`:**

```js
import jwt from 'jsonwebtoken';

export function socketAuthenticate(socket, next) {
  const token = socket.handshake.auth?.token;
  if (!token) return next(new Error('UNAUTHORIZED'));

  try {
    socket.user = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch {
    next(new Error('UNAUTHORIZED'));
  }
}
```

---

## Step 7 — Auth router

JSDoc comments produce the Swagger documentation. `security: []` on public routes overrides the global bearer auth requirement defined in the Swagger config.

**`src/routes/auth.js`:**

```js
import { Router } from 'express';
import * as authService from '../services/authService.js';
import { ValidationError } from '../errors/AppError.js';
import { ApiResponse } from '../utils/ApiResponse.js';

export const authRouter = Router();

/**
 * @openapi
 * /auth/register:
 *   post:
 *     summary: Register a new user
 *     tags: [Auth]
 *     security: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [username, email, password]
 *             properties:
 *               username: { type: string }
 *               email:    { type: string, format: email }
 *               password: { type: string, minLength: 8 }
 *     responses:
 *       '201': { description: Account created }
 *       '409': { description: Username or email already taken }
 *       '422': { description: Missing or invalid fields }
 */
authRouter.post('/register', async (req, res) => {
  const { username, email, password } = req.body;

  if (!username || !email || !password)
    throw new ValidationError('username, email, and password are required.');
  if (password.length < 8)
    throw new ValidationError('Password must be at least 8 characters.');

  const result = await authService.register({ username, email, password });
  res.status(201).json(ApiResponse.created(result));
});

/**
 * @openapi
 * /auth/login:
 *   post:
 *     summary: Authenticate and receive tokens
 *     tags: [Auth]
 *     security: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [email, password]
 *             properties:
 *               email:    { type: string }
 *               password: { type: string }
 *     responses:
 *       '200': { description: Tokens issued }
 *       '401': { description: Invalid credentials }
 */
authRouter.post('/login', async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password)
    throw new ValidationError('email and password are required.');

  const result = await authService.login({ email, password });
  res.json(ApiResponse.success(result));
});

/**
 * @openapi
 * /auth/refresh:
 *   post:
 *     summary: Exchange a refresh token for a new access token
 *     tags: [Auth]
 *     security: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [refreshToken]
 *             properties:
 *               refreshToken: { type: string }
 *     responses:
 *       '200': { description: New tokens issued }
 *       '401': { description: Invalid or expired refresh token }
 */
authRouter.post('/refresh', async (req, res) => {
  const { refreshToken } = req.body;

  if (!refreshToken)
    throw new ValidationError('refreshToken is required.');

  const result = await authService.refresh(refreshToken);
  res.json(ApiResponse.success(result));
});

/**
 * @openapi
 * /auth/logout:
 *   post:
 *     summary: Revoke the refresh token
 *     tags: [Auth]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [refreshToken]
 *             properties:
 *               refreshToken: { type: string }
 *     responses:
 *       '200': { description: Logged out }
 */
authRouter.post('/logout', async (req, res) => {
  const { refreshToken } = req.body;
  if (refreshToken) await authService.logout(refreshToken);
  res.json(ApiResponse.success(null));
});
```

---

## Step 8 — Mount the router in app.js

Add one line to `src/app.js` in the routes section:

```js
import { authRouter } from './routes/auth.js';

// Under the Swagger block, before the 404 handler:
app.use('/api/v1/auth', authRouter);
```

---

## Verification

**1. Register:**

```bash
curl -s -X POST http://localhost:3000/api/v1/auth/register \
  -H 'Content-Type: application/json' \
  -d '{"username":"alice","email":"alice@example.com","password":"password123"}'
# Expected: 201 with { data: { user: {...}, accessToken: "...", refreshToken: "..." } }
```

**2. Login:**

```bash
curl -s -X POST http://localhost:3000/api/v1/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"alice@example.com","password":"password123"}'
# Expected: 200 with tokens
```

**3. Protected route blocked without token:**

```bash
curl -s http://localhost:3000/api/v1/users/me
# Expected: 401 { "error": { "code": "UNAUTHORIZED" } }
```

**4. Refresh token works once, then fails (rotation):**

```bash
# Save the refresh token from login, then:
curl -s -X POST http://localhost:3000/api/v1/auth/refresh \
  -H 'Content-Type: application/json' \
  -d '{"refreshToken":"<token>"}'
# Expected: 200 with new tokens

# Use the SAME old refresh token again:
curl -s -X POST http://localhost:3000/api/v1/auth/refresh \
  -H 'Content-Type: application/json' \
  -d '{"refreshToken":"<same-old-token>"}'
# Expected: 401 — Redis key was deleted on first refresh
```

**5. Logout revokes the refresh token:**

```bash
curl -s -X POST http://localhost:3000/api/v1/auth/logout \
  -H 'Content-Type: application/json' \
  -d '{"refreshToken":"<token>"}'
# Expected: 200

# Attempt refresh with the revoked token:
curl -s -X POST http://localhost:3000/api/v1/auth/refresh \
  -H 'Content-Type: application/json' \
  -d '{"refreshToken":"<same-token>"}'
# Expected: 401
```

**6. Check Redis directly to confirm key lifecycle:**

```bash
redis-cli
> KEYS refresh:*         # shows active refresh tokens
> TTL refresh:<userId>:<tokenId>   # confirm 7-day TTL
```

---

## File map

| File | Status |
|---|---|
| `.env.example` | Updated — `JWT_SECRET`, `JWT_REFRESH_SECRET`, `REDIS_URL` |
| `src/db/redis.js` | New — `ioredis` client with reconnect strategy |
| `src/utils/tokens.js` | New — `signAccessToken`, `issueRefreshToken`, `validateRefreshToken`, `revokeRefreshToken` |
| `src/services/authService.js` | New — `register`, `login`, `refresh`, `logout`, `toPublicUser` |
| `src/middleware/authenticate.js` | New — JWT middleware for HTTP routes |
| `src/middleware/socketAuthenticate.js` | New — JWT middleware for Socket.io (wired in Phase 6) |
| `src/routes/auth.js` | New — four auth endpoints with Swagger JSDoc |
| `src/app.js` | Updated — mount `authRouter` at `/api/v1/auth` |

---

## Checklist

- [ ] Step 1 — `bcrypt`, `jsonwebtoken`, `ioredis` installed; `.env.example` updated with three new vars
- [ ] Step 2 — `src/db/redis.js` created; `connect` and `error` events logged; retryStrategy configured
- [ ] Step 3 — `signAccessToken` signs with `JWT_SECRET`, 15-minute TTL
- [ ] Step 3 — `issueRefreshToken` stores `refresh:{userId}:{tokenId}` in Redis with 7-day TTL
- [ ] Step 3 — `validateRefreshToken` verifies JWT signature, checks `type: 'refresh'`, checks Redis key exists
- [ ] Step 3 — `revokeRefreshToken` deletes the Redis key
- [ ] Step 4 — `register` throws `ConflictError` on duplicate username or email
- [ ] Step 4 — `register` hashes with bcrypt at cost factor 12; `passwordHash` never in response
- [ ] Step 4 — `login` uses `.select('+passwordHash')` to load the hash; returns same error for user-not-found and wrong-password
- [ ] Step 4 — `refresh` deletes old Redis key before issuing new token (rotation)
- [ ] Step 4 — `logout` treats already-invalid token as success, not an error
- [ ] Step 5 — `authenticate` middleware attaches decoded payload to `req.user`; throws `UnauthorizedError` for missing, invalid, or expired tokens
- [ ] Step 6 — `socketAuthenticate` reads token from `socket.handshake.auth.token`; calls `next(new Error('UNAUTHORIZED'))` on failure
- [ ] Step 7 — all four routes return the standard `ApiResponse` envelope
- [ ] Step 7 — public routes annotated with `security: []` in JSDoc
- [ ] Step 8 — `authRouter` mounted at `/api/v1/auth` in `app.js`
- [ ] Verification — register returns 201 with both tokens
- [ ] Verification — second use of the same refresh token returns 401 (rotation working)
- [ ] Verification — logout + subsequent refresh returns 401 (revocation working)
- [ ] Verification — `KEYS refresh:*` in redis-cli shows active tokens; key disappears after logout
