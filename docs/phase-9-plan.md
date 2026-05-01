# Phase 9 — Rate Limiting

## What exists

From Phase 8:
- `src/middleware/authenticate.js` — JWT verification middleware
- `src/routes/auth.js` — register, login, logout, refresh endpoints
- `src/socket/messageHandlers.js` — `message:send`, `message:edit`, `message:delete`
- `redis` client — `ioredis` instance with reconnect strategy
- `TooManyRequestsError` — defined in Phase 2 (`src/errors/AppError.js`)

## What needs to be built

Five steps. Two rate limiters with different strategies:

- **Fixed-window** for auth endpoints — IP-scoped, 10 attempts per 15-minute window, Lua-atomic INCR
- **Sliding-window** for `message:send` — user-scoped, 30 messages per 60-second rolling window, ZSET-based

The difference matters for an interview question:

| Strategy | Implementation | Weakness |
|---|---|---|
| Fixed window | INCR + EXPIRE | Boundary burst: `max` requests at :59, `max` more at :01 |
| Sliding window | ZSET + ZREMRANGEBYSCORE | Slightly higher Redis memory; more commands per request |

---

## Step 1 — The INCR + EXPIRE race condition

The naive approach is two commands:

```js
const count = await redis.incr(key);  // key created here
await redis.expire(key, windowSec);   // TTL set here
```

If the process dies, is killed by OOM, or the event loop is blocked between those two lines, the key exists with count = 1 and **no TTL**. It never expires. The user is permanently rate-limited until the key is manually deleted.

**The fix — Lua script:**

Redis executes Lua scripts atomically. The script runs as a single unit: either both operations complete or neither does.

```lua
local c = redis.call('INCR', KEYS[1])
if c == 1 then
  redis.call('EXPIRE', KEYS[1], ARGV[1])
end
return c
```

`ioredis` supports `redis.eval(script, numkeys, ...keys, ...args)` natively. No extra package needed.

**Alternative — `SET key 1 EX n NX`:**

`SET key 1 EX 60 NX` means: set the key to `1` with a 60-second TTL, but only if the key does not already exist. This is a single atomic command that handles the first-request case. On subsequent requests within the window, `INCR` the existing key. Each command is individually atomic; there is no window between them because `NX` checks existence and sets TTL in one operation.

Both approaches are valid. Lua is preferred when you need to read a value and conditionally take action in a single atomic operation.

---

## Step 2 — Fixed-window auth rate limiter

**`src/middleware/rateLimiter.js`:**

```js
import { redis } from '../db/redis.js';
import { TooManyRequestsError } from '../errors/AppError.js';

const INCR_WITH_EXPIRE = `
  local c = redis.call('INCR', KEYS[1])
  if c == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end
  return c
`;

export function createRateLimiter({ windowSec, max, keyPrefix }) {
  return async function rateLimiter(req, _res, next) {
    const identifier = req.ip ?? 'unknown';
    const key        = `rl:${keyPrefix}:${identifier}`;

    const count = await redis.eval(INCR_WITH_EXPIRE, 1, key, windowSec);

    if (count > max) {
      const ttl = await redis.ttl(key);
      throw new TooManyRequestsError(
        `Too many requests. Retry after ${ttl} seconds.`
      );
    }

    next();
  };
}

// Pre-built instance for auth endpoints
export const authRateLimiter = createRateLimiter({
  windowSec: 15 * 60,  // 15-minute fixed window
  max: 10,
  keyPrefix: 'auth',
});
```

Key design choices:
- `req.ip` as the identifier — unauthenticated endpoints must scope to IP, not userId
- `rl:{keyPrefix}:{identifier}` — namespaced so `redis-cli KEYS "rl:auth:*"` isolates all auth counters
- `throw new TooManyRequestsError(...)` — propagates through `express-async-errors`; no `res.status()` in middleware

---

## Step 3 — Apply rate limiter to auth routes

`logout` and `refresh` do not need IP rate limiting — they require a valid token (refresh token in Redis), which is already a gate. Applying the limiter there would lock users out of logging back in after expiry.

**`src/routes/auth.js`** — add to register and login only:

```js
import { authRateLimiter } from '../middleware/rateLimiter.js';

authRouter.post('/register', authRateLimiter, authController.register);
authRouter.post('/login',    authRateLimiter, authController.login);
authRouter.post('/logout',   authenticate,    authController.logout);
authRouter.post('/refresh',                   authController.refresh);
```

---

## Step 4 — Sliding-window socket rate limiter

The fixed-window boundary burst: a user sends 30 messages at 11:59:59, the window resets at 12:00:00, and they send 30 more at 12:00:01 — 60 messages in 2 seconds. The sliding window counts requests within a rolling time range, so the window always covers exactly `windowSec` seconds ending at **now**.

ZSET approach — each request is a scored set member:
- `ZREMRANGEBYSCORE key -inf {now - windowMs}` — remove entries older than the window
- `ZADD key {now} {uniqueMember}` — record the current request
- `ZCARD key` — count requests currently in the window
- `EXPIRE key {windowSec}` — reset TTL so the key cleans itself up after inactivity

**`src/socket/rateLimiter.js`:**

```js
import { redis } from '../db/redis.js';

const MESSAGE_WINDOW_SEC = 60;
const MESSAGE_MAX        = 30;

export async function checkMessageRateLimit(userId) {
  const key    = `rl:msg:${userId}`;
  const now    = Date.now();
  const cutoff = now - MESSAGE_WINDOW_SEC * 1000;

  const pipeline = redis.pipeline();
  pipeline.zremrangebyscore(key, '-inf', cutoff);
  // Member includes Math.random() to prevent collision if two messages
  // arrive in the same millisecond — ZADD with duplicate score but unique member
  pipeline.zadd(key, now, `${now}-${Math.random()}`);
  pipeline.zcard(key);
  pipeline.expire(key, MESSAGE_WINDOW_SEC);
  const results = await pipeline.exec();

  const count = results[2][1]; // [err, value] — index 2 is the ZCARD result
  return count <= MESSAGE_MAX;
}
```

All four commands run in a single pipeline round-trip. The ZSET approach trades slightly more memory (one entry per request in the window vs one integer) for accurate sliding-window semantics.

---

## Step 5 — Apply to message:send

The rate limit check fires before `createMessage` — a rejected request costs only a Redis pipeline call, no MongoDB write.

**`src/socket/messageHandlers.js`** — add rate limit check to `message:send`:

```js
import * as messageService from '../services/messageService.js';
import { checkMessageRateLimit } from './rateLimiter.js';

const KNOWN_CODES = new Set(['NOT_MEMBER', 'EDIT_NOT_ALLOWED', 'DELETE_NOT_ALLOWED', 'INVALID_CONTENT']);

const safe = (socket, fn) => async (data = {}) => {
  try {
    await fn(data);
  } catch (err) {
    const code = KNOWN_CODES.has(err.code) ? err.code : 'INTERNAL_ERROR';
    socket.emit('error', { code });
  }
};

export function registerMessageHandlers(io, socket) {
  socket.on('message:send', safe(socket, async ({ roomId, content }) => {
    if (!content?.trim())
      return socket.emit('error', { code: 'INVALID_CONTENT' });

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

  socket.on('message:edit', safe(socket, async ({ messageId, content }) => {
    if (!content?.trim())
      return socket.emit('error', { code: 'INVALID_CONTENT' });

    const message = await messageService.editMessage(messageId, socket.user.sub, content);
    io.to(message.roomId.toString()).emit('message:edit', message);
  }));

  socket.on('message:delete', safe(socket, async ({ messageId }) => {
    const result = await messageService.deleteMessage(messageId, socket.user.sub);
    io.to(result.roomId.toString()).emit('message:delete', {
      messageId: result.id,
      roomId:    result.roomId,
    });
  }));
}
```

`message:edit` and `message:delete` are not rate-limited here — they cannot be used to spam new content, and a 15-minute edit window already bounds their misuse. Rate-limit the write path, not every event.

---

## Verification

**1. Auth rate limiter — exhaust the window:**

```bash
# Send 11 login requests from the same IP
for i in $(seq 1 11); do
  curl -s -X POST http://localhost:3000/api/v1/auth/login \
    -H 'Content-Type: application/json' \
    -d '{"username":"nobody","password":"wrong"}' | jq '.error.code // .data'
done
# Expected: first 10 return 401 (INVALID_CREDENTIALS or USER_NOT_FOUND)
# 11th returns: 429 { error: { code: "TOO_MANY_REQUESTS" } }
```

**2. Confirm the Redis key and TTL after auth requests:**

```bash
redis-cli KEYS "rl:auth:*"
# Expected: one key for your IP, e.g., rl:auth:127.0.0.1

redis-cli GET "rl:auth:127.0.0.1"
# Expected: "11"

redis-cli TTL "rl:auth:127.0.0.1"
# Expected: ~900 (15 minutes), never -1
# -1 would mean no TTL — indicates the Lua script is not working correctly
```

**3. Client isolation — second IP is unaffected:**

```bash
# From a different IP (or use a different loopback alias), the counter is independent:
redis-cli KEYS "rl:auth:*"
# Expected: two separate keys, each with their own counter
```

**4. Socket rate limiter — burst test:**

```js
// Connect as alice and send 31 messages rapidly
const results = [];
socket.on('error', (err) => results.push(err));

for (let i = 0; i < 31; i++) {
  socket.emit('message:send', { roomId: ROOM_ID, content: `msg ${i}` });
}

// Wait briefly then check
setTimeout(() => {
  console.log('Errors received:', results.length);   // Expected: 1
  console.log('Rate limited:', results[0]?.code);    // Expected: 'RATE_LIMITED'
}, 500);
```

**5. Confirm the sliding window ZSET:**

```bash
redis-cli ZCARD "rl:msg:<userId>"
# Expected: 30 (the max — 31st was rejected before being added to the set)
# Note: ZADD runs before ZCARD in the pipeline, so 31 entries may momentarily
# appear before the rejection — ZCARD returns 31, rejection fires at count > 30

redis-cli ZRANGE "rl:msg:<userId>" 0 -1 WITHSCORES
# Expected: entries with millisecond timestamps as scores

redis-cli TTL "rl:msg:<userId>"
# Expected: ~60 seconds
```

**6. Confirm the sliding window (no boundary burst):**

```bash
# 1. Send 30 messages (fills window) → all accepted
# 2. Wait 61 seconds (window expires)
# 3. Send 30 more → all accepted (old entries have slid out of the 60s window)
# 4. Send 1 more immediately → rejected (window has 30 entries again)

# Step 3 would be rejected with a fixed-window limiter (window resets on TTL,
# but if you sent 30 at t=0 and 30 at t=60, the fixed window may still be active)
```

**7. Boundary burst demonstration (fixed window, for contrast):**

```bash
# With the fixed-window auth limiter, set max=3 and windowSec=10 for testing:
# Send 3 requests at t=9 (3 requests used)
# Window resets at t=10
# Send 3 more at t=11 → all accepted
# Result: 6 requests in 2 seconds — the boundary burst
#
# The sliding window prevents this because requests at t=9 remain in the window
# until t=69 (9 + 60), so they count against the t=11 budget
```

---

## File map

| File | Status |
|---|---|
| `src/middleware/rateLimiter.js` | New — `createRateLimiter` factory, `authRateLimiter` instance; Lua-atomic INCR |
| `src/routes/auth.js` | Updated — `authRateLimiter` applied to `POST /register` and `POST /login` |
| `src/socket/rateLimiter.js` | New — `checkMessageRateLimit`; ZSET sliding window in one pipeline |
| `src/socket/messageHandlers.js` | Updated — `checkMessageRateLimit` call before `createMessage` in `message:send` |

---

## Checklist

- [ ] Step 1 — Can explain why INCR + EXPIRE has a race condition (key exists with no TTL if process dies between the two)
- [ ] Step 1 — Can explain why Lua makes INCR + EXPIRE atomic (Redis executes Lua as a single unit)
- [ ] Step 1 — Can explain the `SET NX EX` alternative and when it is equivalent
- [ ] Step 2 — `createRateLimiter` uses `redis.eval` with the Lua script — not two separate commands
- [ ] Step 2 — Key format is `rl:{keyPrefix}:{identifier}` — namespaced and IP-scoped
- [ ] Step 2 — `TooManyRequestsError` thrown (not inline `res.status(429)`) — propagates through `express-async-errors`
- [ ] Step 3 — `authRateLimiter` applied to `/register` and `/login`; NOT applied to `/logout` or `/refresh`
- [ ] Step 3 — Can explain why `/refresh` does not need IP rate limiting
- [ ] Step 4 — Sliding window pipeline: `ZREMRANGEBYSCORE`, `ZADD`, `ZCARD`, `EXPIRE` — one round-trip
- [ ] Step 4 — ZADD member includes `Math.random()` to handle same-millisecond requests
- [ ] Step 4 — `expire` resets TTL on every request so inactive keys clean themselves up
- [ ] Step 4 — Can explain the boundary burst problem and why sliding window prevents it
- [ ] Step 5 — Rate limit check fires before `createMessage` — rejected requests incur no MongoDB write
- [ ] Step 5 — `socket.emit('error', { code: 'RATE_LIMITED' })` returned explicitly, not thrown
- [ ] Step 5 — `message:edit` and `message:delete` are not rate-limited — can explain why
- [ ] Verification — 11th auth request returns 429
- [ ] Verification — Redis key for auth always has TTL > 0 (never `-1`) — confirms Lua atomicity
- [ ] Verification — ZSET has at most 30 entries; 31st message triggers `RATE_LIMITED` error event
- [ ] Verification — Second client's counter is unaffected by first client being rate-limited
- [ ] Knowledge check — Can explain fixed window vs sliding window trade-off
- [ ] Knowledge check — Can explain why `ZREMRANGEBYSCORE` is O(log n + k) and why that is acceptable here
