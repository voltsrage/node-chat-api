# Phase 7 — Presence System

## What exists

From Phase 6:
- `socket/index.js` — `userSockets` map, `createSocketServer`, connect/disconnect handlers; disconnect has a `TODO Phase 7` stub
- `socketAuthenticate` middleware — `socket.user.sub` (userId), `socket.user.username`
- `redis` client — available throughout
- `roomsRouter` — protected by `authenticate`; Phase 5's presence route is not yet added

## What needs to be built

Seven steps. The central concept is **sorted set as a time-indexed presence store**: the score is a Unix timestamp, which lets the background job efficiently find and evict stale entries with a single `ZREMRANGEBYSCORE` call instead of scanning every key. The background job exists solely to handle crashed clients — clean disconnects are handled immediately in the disconnect handler.

---

## Step 1 — Presence service

Two sorted sets from the PRD:

```
online:users          ZSET   member = userId   score = lastActiveTimestamp (ms)
presence:{roomId}     ZSET   member = userId   score = joinedTimestamp (ms)
```

`getRoomPresence` cross-checks `presence:{roomId}` against `online:users` in a single pipeline to filter out users whose socket crashed but whose `presence:{roomId}` entry was not yet evicted. This means the endpoint is accurate even when the background job hasn't run yet.

**`src/services/presenceService.js`:**

```js
import { redis } from '../db/redis.js';

const ONLINE_KEY       = 'online:users';
const STALE_THRESHOLD  = 5 * 60 * 1000; // 5 minutes in ms

export async function markOnline(userId) {
  await redis.zadd(ONLINE_KEY, Date.now(), userId);
}

export async function markOffline(userId, roomIds = []) {
  const pipeline = redis.pipeline();
  pipeline.zrem(ONLINE_KEY, userId);
  for (const roomId of roomIds) {
    pipeline.zrem(`presence:${roomId}`, userId);
  }
  await pipeline.exec();
}

export async function joinPresence(userId, roomId) {
  await redis.zadd(`presence:${roomId}`, Date.now(), userId);
}

export async function getRoomPresence(roomId) {
  const members = await redis.zrange(`presence:${roomId}`, 0, -1);
  if (!members.length) return [];

  // Batch-check which members still have a fresh entry in online:users.
  // A single pipeline avoids N serial round-trips.
  const pipeline = redis.pipeline();
  for (const userId of members) pipeline.zscore(ONLINE_KEY, userId);
  const results = await pipeline.exec();

  const cutoff = Date.now() - STALE_THRESHOLD;

  return members.filter((_, i) => {
    const score = results[i][1]; // pipeline returns [err, value] tuples
    return score !== null && Number(score) >= cutoff;
  });
}

// Called by the eviction job — returns the count of removed entries
export async function evictStaleUsers() {
  const cutoff = Date.now() - STALE_THRESHOLD;
  return redis.zremrangebyscore(ONLINE_KEY, '-inf', cutoff);
}
```

**Why `presence:{roomId}` is not cleaned by the eviction job:** The job only cleans `online:users`. Stale entries in `presence:{roomId}` are filtered out at read time by `getRoomPresence`. This avoids the need to scan all `presence:*` keys on every job tick, which would require a `SCAN` call and grow with the number of rooms.

---

## Step 2 — Presence eviction background job

`setInterval` is sufficient here — no need for a `BackgroundService` abstraction. The job runs every 60 seconds and removes entries from `online:users` older than 5 minutes. It returns a cleanup function so it can be stopped gracefully on process shutdown.

**`src/jobs/presenceEvictionJob.js`:**

```js
import { evictStaleUsers } from '../services/presenceService.js';
import { logger } from '../utils/logger.js';

const INTERVAL_MS = 60 * 1000; // 60 seconds

export function startPresenceEvictionJob() {
  async function tick() {
    try {
      const removed = await evictStaleUsers();
      if (removed > 0) {
        logger.info({ removed }, 'Presence eviction: removed stale users from online:users');
      }
    } catch (err) {
      logger.error({ err }, 'Presence eviction job error');
    }
  }

  const timer = setInterval(tick, INTERVAL_MS);
  logger.info({ intervalMs: INTERVAL_MS }, 'Presence eviction job started');

  return () => clearInterval(timer);
}
```

---

## Step 3 — Update socket/index.js

Three changes to `src/socket/index.js`:

1. **On connect:** call `markOnline` and `joinPresence` for each room after auto-joining
2. **On disconnect:** call `markOffline` with all rooms from `socket.rooms` (Socket.io tracks this automatically)
3. Remove the `TODO Phase 7` comment

`socket.rooms` is a `Set<string>` maintained by Socket.io. It always contains the socket's own ID — filter that out to get only the room channels.

**`src/socket/index.js`** — replace the relevant sections:

```js
import { Server } from 'socket.io';
import { Room } from '../models/Room.js';
import { socketAuthenticate } from '../middleware/socketAuthenticate.js';
import { registerMessageHandlers } from './messageHandlers.js';
import { registerTypingHandlers } from './typingHandlers.js';
import { markOnline, markOffline, joinPresence } from '../services/presenceService.js';
import { logger } from '../utils/logger.js';

const userSockets = new Map();

export function joinUserToRoom(io, userId, roomId) {
  const socketIds = userSockets.get(userId);
  if (!socketIds?.size) return;
  for (const socketId of socketIds) {
    const socket = io.sockets.sockets.get(socketId);
    socket?.join(roomId);
  }
}

export function createSocketServer(httpServer) {
  const io = new Server(httpServer, {
    cors: { origin: '*' },
  });

  io.use(socketAuthenticate);

  io.on('connection', async (socket) => {
    const userId = socket.user.sub;
    logger.info({ userId, socketId: socket.id }, 'Socket connected');

    // Track socket
    if (!userSockets.has(userId)) userSockets.set(userId, new Set());
    userSockets.get(userId).add(socket.id);

    // Mark online and auto-join all room channels
    try {
      await markOnline(userId);

      const rooms = await Room.find({ memberIds: userId }).select('_id').lean();
      for (const room of rooms) {
        const roomId = room._id.toString();
        socket.join(roomId);
        await joinPresence(userId, roomId);
      }
    } catch (err) {
      logger.error({ err, userId }, 'Error during socket connect setup');
    }

    registerMessageHandlers(io, socket);
    registerTypingHandlers(io, socket);

    socket.on('disconnect', async (reason) => {
      logger.info({ userId, socketId: socket.id, reason }, 'Socket disconnected');

      const sockets = userSockets.get(userId);
      if (sockets) {
        sockets.delete(socket.id);
        if (sockets.size === 0) userSockets.delete(userId);
      }

      // Only clean presence when this was the user's LAST socket
      // (multi-tab: if another tab is still open, they remain online)
      if (!userSockets.has(userId)) {
        // socket.rooms contains all Socket.io channels this socket was in
        const roomIds = [...socket.rooms].filter(r => r !== socket.id);
        try {
          await markOffline(userId, roomIds);
        } catch (err) {
          logger.error({ err, userId }, 'Error during socket disconnect cleanup');
        }
      }
    });
  });

  return io;
}
```

**Multi-tab note:** If a user has two tabs open and closes one, `userSockets` still has the remaining socket. Calling `markOffline` at that point would incorrectly remove them from presence. The guard `if (!userSockets.has(userId))` ensures presence is only cleared when the last socket disconnects.

---

## Step 4 — Presence controller

Enrich the userId list from Redis with user data from MongoDB. The response shape is flat — `users` is a list of user objects, `count` is a convenience field.

**`src/controllers/presenceController.js`:**

```js
import * as presenceService from '../services/presenceService.js';
import { User } from '../models/User.js';
import { ApiResponse } from '../utils/ApiResponse.js';

export async function getRoomPresence(req, res) {
  const userIds = await presenceService.getRoomPresence(req.params.id);

  const users = userIds.length
    ? await User.find({ _id: { $in: userIds } })
        .select('username displayName avatarUrl')
        .lean()
    : [];

  res.json(ApiResponse.success({ users, count: users.length }));
}
```

---

## Step 5 — Add presence route to rooms router

Append to `src/routes/rooms.js`:

```js
import * as presenceController from '../controllers/presenceController.js';

/**
 * @openapi
 * /rooms/{id}/presence:
 *   get:
 *     summary: List users currently online in the room
 *     tags: [Rooms]
 *     parameters:
 *       - { name: id, in: path, required: true, schema: { type: string } }
 *     responses:
 *       '200':
 *         description: Active users in the room
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 users: { type: array }
 *                 count: { type: integer }
 */
roomsRouter.get('/:id/presence', presenceController.getRoomPresence);
```

---

## Step 6 — Start eviction job in index.js

**`src/index.js`** — add two lines:

```js
import { startPresenceEvictionJob } from './jobs/presenceEvictionJob.js';

// Inside start(), after connectDB():
const stopEviction = startPresenceEvictionJob();

// Optional: clean shutdown
process.on('SIGTERM', () => {
  stopEviction();
  process.exit(0);
});
```

---

## Verification

**1. User appears in presence on connect:**

```bash
# Connect a socket client as alice
# Then immediately:
redis-cli ZRANGE online:users 0 -1 WITHSCORES
# Expected: alice's userId with a recent timestamp

redis-cli ZRANGE presence:<roomId> 0 -1 WITHSCORES
# Expected: alice's userId with a recent timestamp

curl -s http://localhost:3000/api/v1/rooms/<roomId>/presence \
  -H "Authorization: Bearer $TOKEN"
# Expected: { data: { users: [{ username: "alice", ... }], count: 1 } }
```

**2. User disappears on clean disconnect:**

```bash
# Disconnect alice's socket
redis-cli ZRANGE online:users 0 -1
# Expected: alice's userId is gone

redis-cli ZRANGE presence:<roomId> 0 -1
# Expected: alice's userId is gone

# GET /rooms/:id/presence → count: 0
```

**3. Multi-tab: presence persists until last tab closes:**

```bash
# Open two sockets for alice (two tabs)
# Close tab 1 — alice should still appear in presence (tab 2 is open)
# Close tab 2 — alice should now disappear from presence
```

**4. Crash case — background eviction:**

```bash
# Connect alice's socket
# Kill the client process without closing the socket:
#   Ctrl+C on the client, or kill the Node process

# Immediately after crash:
redis-cli ZRANGE online:users 0 -1 WITHSCORES
# Expected: alice is still there (disconnect handler didn't fire)

redis-cli ZRANGE presence:<roomId> 0 -1
# Expected: alice is still there

# Wait for the socket server to detect the dead connection (30-90s depending on TCP timeout)
# OR: wait for the eviction job (up to 60s after the 5-minute threshold)
# After eviction job runs (score older than 5 minutes):

redis-cli ZRANGE online:users 0 -1
# Expected: alice is gone

# GET /rooms/:id/presence also returns 0 immediately after crash
# because getRoomPresence cross-checks against online:users in real time
```

**5. Inspect eviction job output in logs:**

```bash
# After 5 minutes from a crashed client + one job tick:
# Pino log: { "msg": "Presence eviction: removed stale users from online:users", "removed": 1 }
```

**6. Confirm `getRoomPresence` accuracy before job runs:**

```bash
# Crash alice (do not wait for eviction job)
# GET /rooms/:id/presence immediately
# Expected: alice NOT in the response — because getRoomPresence cross-checks online:users
# This proves the endpoint is accurate independent of the job cadence
```

---

## File map

| File | Status |
|---|---|
| `src/services/presenceService.js` | New — `markOnline`, `markOffline`, `joinPresence`, `getRoomPresence`, `evictStaleUsers` |
| `src/jobs/presenceEvictionJob.js` | New — 60s interval job; `ZREMRANGEBYSCORE` on `online:users`; returns cleanup function |
| `src/socket/index.js` | Updated — `markOnline` + `joinPresence` on connect; `markOffline` on last-socket disconnect; `TODO Phase 7` removed |
| `src/controllers/presenceController.js` | New — reads from presenceService, enriches with User data from MongoDB |
| `src/routes/rooms.js` | Updated — append `GET /:id/presence` mapped to presence controller |
| `src/index.js` | Updated — start eviction job; register SIGTERM handler for clean shutdown |

---

## Checklist

- [ ] Step 1 — `markOnline` writes to `online:users` with `Date.now()` as score
- [ ] Step 1 — `markOffline` removes from `online:users` and all `presence:{roomId}` keys in a single pipeline
- [ ] Step 1 — `joinPresence` writes to `presence:{roomId}` with `Date.now()` as score
- [ ] Step 1 — `getRoomPresence` uses pipeline to batch `ZSCORE` calls; filters by 5-minute cutoff
- [ ] Step 1 — `evictStaleUsers` uses `ZREMRANGEBYSCORE` with `-inf` to cutoff; returns removed count
- [ ] Step 2 — Eviction job runs every 60 seconds; logs count only when `removed > 0`
- [ ] Step 2 — Job returns a cleanup function; `clearInterval` called on SIGTERM
- [ ] Step 3 — `markOnline` called before `joinPresence` on connect
- [ ] Step 3 — `joinPresence` called for every room the socket auto-joins
- [ ] Step 3 — Disconnect handler checks `!userSockets.has(userId)` before calling `markOffline`
- [ ] Step 3 — Room IDs derived from `socket.rooms` with socket's own ID filtered out
- [ ] Step 3 — Phase 7 TODO comment removed from disconnect handler
- [ ] Step 4 — Controller returns `{ users: [...], count: n }` shape
- [ ] Step 4 — Empty `userIds` array skips the MongoDB query
- [ ] Step 5 — Route appended to `roomsRouter`; protected by existing `authenticate`
- [ ] Step 6 — `startPresenceEvictionJob()` called in `start()` in `index.js`
- [ ] Verification — `ZRANGE online:users 0 -1` shows user on connect; gone on clean disconnect
- [ ] Verification — Multi-tab: presence only clears when last socket closes
- [ ] Verification — Crash test: `GET /rooms/:id/presence` returns 0 immediately after crash (before eviction job)
- [ ] Verification — Eviction job log entry appears after stale threshold passes
