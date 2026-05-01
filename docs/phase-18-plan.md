# Phase 18 — Unread Message Counts

## What exists

From Phase 17:
- `src/socket/messageHandlers.js` — `message:send` broadcasts `message:new` after saving to MongoDB
- `src/controllers/messageController.js` — `getMessageHistory` fetches paginated messages
- `src/socket/index.js` — on connect: marks user online, joins rooms, emits nothing back to the connecting socket
- `src/routes/users.js` — `GET /users/me`, `PUT /users/me`, `GET /users/:id`

## What needs to be built

Five steps. The core concept is **fan-out on write**: one message triggers N counter increments (one per room member). Redis `INCR` is the right primitive because it is atomic — no two concurrent messages can corrupt a counter — and all N increments for one message are pipelined into a single round-trip.

The server only counts. The client resets by fetching history. This separation means the server does not need to know which room the user currently has open.

---

## Step 1 — Unread service

**`src/services/unreadService.js`:**

```js
import { redis } from '../db/redis.js';
import { Room } from '../models/Room.js';

// Key pattern: unread:{userId}:{roomId}
// No TTL — unread state is permanent until explicitly cleared.
// Unlike presence or typing, an unread count from 3 months ago is still valid.
const key = (userId, roomId) => `unread:${userId}:${roomId}`;

export async function incrementUnread(roomId, senderId) {
  // Fetch all room members — must include offline users, not just connected sockets.
  // A user who is offline when the message arrives still needs an unread count.
  const room = await Room.findById(roomId).select('memberIds').lean();
  if (!room) return;

  const others = room.memberIds.filter(id => id.toString() !== senderId);
  if (!others.length) return;

  // Pipeline all INCR calls into one Redis round-trip.
  // A room with 100 members would otherwise require 99 serial INCR commands.
  const pipeline = redis.pipeline();
  for (const memberId of others) {
    pipeline.incr(key(memberId, roomId));
  }
  await pipeline.exec();
}

export async function resetUnread(userId, roomId) {
  await redis.del(key(userId, roomId));
}

export async function getUnreadCounts(userId) {
  // Find all rooms this user belongs to
  const rooms = await Room.find({ memberIds: userId }).select('_id').lean();
  if (!rooms.length) return {};

  // Batch-read all unread counters in one pipeline round-trip
  const pipeline = redis.pipeline();
  for (const room of rooms) {
    pipeline.get(key(userId, room._id));
  }
  const results = await pipeline.exec();

  // Build the result map — omit rooms with zero unread (keeps payload small)
  const counts = {};
  for (let i = 0; i < rooms.length; i++) {
    const count = parseInt(results[i][1]) || 0;
    if (count > 0) counts[rooms[i]._id.toString()] = count;
  }
  return counts;
}

// Called when a user leaves a room — cleans up their counter
export async function clearUnread(userId, roomId) {
  await redis.del(key(userId, roomId));
}
```

**Why no TTL:**

Presence keys (`online:users`, `presence:{roomId}`) are ephemeral — they represent current state that should self-clean after inactivity. Unread counts represent a durable fact: "you have unseen messages". A user who logs back in after a week should still see their unread badges. No TTL is the correct choice.

**The fan-out cost:**

`incrementUnread` queries MongoDB once per message to get the member list. For a room with 50 members, one `message:send` costs one MongoDB read + one pipelined Redis write. This is acceptable for moderate room sizes. For rooms with thousands of members, a cached member list (Redis SET `room-members:{roomId}`) would eliminate the MongoDB read — worth noting as a scaling discussion point.

---

## Step 2 — Increment on message:new

**`src/socket/messageHandlers.js`** — call `incrementUnread` after broadcasting:

```js
import * as messageService  from '../services/messageService.js';
import * as unreadService   from '../services/unreadService.js';
import { checkMessageRateLimit } from './rateLimiter.js';

const KNOWN_CODES = new Set([
  'NOT_MEMBER', 'EDIT_NOT_ALLOWED', 'DELETE_NOT_ALLOWED',
  'INVALID_CONTENT', 'INVALID_EMOJI', 'MESSAGE_NOT_FOUND',
]);

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

    // Fan-out: increment unread counter for all room members except the sender.
    // Fire-and-forget — do not await; a counter failure should not affect
    // the message delivery that already succeeded.
    unreadService.incrementUnread(roomId, socket.user.sub).catch((err) =>
      logger.error({ err, roomId }, 'Failed to increment unread counts')
    );
  }));

  // message:edit, message:delete, message:react — unchanged
}
```

**Fire-and-forget with `.catch`:**

`incrementUnread` is not `await`ed. The message has already been saved and broadcast — the unread count is a derived convenience value. If the counter write fails, the message is not lost. The `.catch` ensures the unhandled promise rejection does not surface as an unhandled error in Node.js.

---

## Step 3 — Reset on history fetch

When a user opens a conversation and fetches its history, they have "read" the messages. Resetting the counter here means no additional client-side event is needed — fetching history implies reading.

**`src/controllers/messageController.js`** — add `resetUnread` call:

```js
import * as messageService from '../services/messageService.js';
import * as unreadService  from '../services/unreadService.js';
import { ApiResponse }     from '../utils/ApiResponse.js';

export async function getMessageHistory(req, res) {
  const result = await messageService.getMessageHistory(req.params.id, req.query);

  // Reset the caller's unread counter for this room.
  // Fetching history == the user has read (or is about to read) these messages.
  // Fire-and-forget — a counter reset failure should not fail the history response.
  unreadService.resetUnread(req.user.sub, req.params.id).catch(() => {});

  res.json(ApiResponse.success(result));
}
```

**Also update `roomService.leaveRoom`** to clean up the unread key when a user leaves:

```js
// src/services/roomService.js
import { clearUnread } from './unreadService.js';

export async function leaveRoom(roomId, userId) {
  const room = await Room.findByIdAndUpdate(
    roomId,
    { $pull: { memberIds: userId } },
    { new: true }
  );
  if (!room) throw new NotFoundError('Room not found.', 'ROOM_NOT_FOUND');

  await redis.del(cacheKey(roomId));

  // Clean up the unread counter — user is no longer a member
  await clearUnread(userId, roomId);
}
```

---

## Step 4 — GET /users/me/unread

**`src/controllers/userController.js`** — add:

```js
import * as unreadService from '../services/unreadService.js';

export async function getUnreadCounts(req, res) {
  const counts = await unreadService.getUnreadCounts(req.user.sub);
  res.json(ApiResponse.success({ counts }));
}
```

**`src/routes/users.js`** — append before the `/:id` route:

```js
import * as userController from '../controllers/userController.js';

/**
 * @openapi
 * /users/me/unread:
 *   get:
 *     summary: Get unread message counts for all rooms
 *     tags: [Users]
 *     responses:
 *       '200':
 *         description: Map of roomId to unread count (only rooms with count > 0)
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 counts:
 *                   type: object
 *                   additionalProperties: { type: integer }
 *             example:
 *               counts: { "roomId1": 5, "roomId2": 12 }
 */
usersRouter.get('/me/unread', userController.getUnreadCounts);

// GET /me/unread must be registered before GET /:id
// — otherwise 'unread' is captured as the :id param
usersRouter.get('/me',  userController.getMe);
usersRouter.put('/me',  userController.updateMe);
usersRouter.get('/:id', userController.getUserById);
```

**Route order matters:** `/me/unread` must appear before `/me` and `/:id` — Express matches routes in registration order. `unread` would be captured as the `:id` parameter if `/:id` appeared first, or even as a sub-path mismatch if `/me` appeared before `/me/unread`.

---

## Step 5 — Emit unread counts on socket connect

Sending the unread map on connection means the client has everything it needs to render unread badges as soon as the socket handshake completes — no additional HTTP round-trip required.

**`src/socket/index.js`** — add to the connect handler:

```js
import { markOnline, markOffline, joinPresence } from '../services/presenceService.js';
import { getUnreadCounts } from '../services/unreadService.js';

io.on('connection', async (socket) => {
  const userId = socket.user.sub;

  if (!userSockets.has(userId)) userSockets.set(userId, new Set());
  userSockets.get(userId).add(socket.id);

  try {
    await markOnline(userId);

    const rooms = await Room.find({ memberIds: userId }).select('_id').lean();
    for (const room of rooms) {
      const roomId = room._id.toString();
      socket.join(roomId);
      await joinPresence(userId, roomId);
    }

    // Send unread counts to the connecting socket only (not the whole room)
    // The client uses this to initialise badge state immediately on login
    const counts = await getUnreadCounts(userId);
    socket.emit('unread:counts', counts);

  } catch (err) {
    logger.error({ err, userId }, 'Error during socket connect setup');
  }

  registerMessageHandlers(io, socket);
  registerTypingHandlers(io, socket);

  socket.on('disconnect', async (reason) => {
    // ... existing disconnect handler unchanged ...
  });
});
```

`socket.emit` (not `io.to(...).emit`) — the unread counts are personal to the connecting user, not a broadcast.

---

## Verification

**1. Counter increments for non-senders after a message:**

```bash
# Alice sends a message to a room with Bob and Carol as members
socket.emit('message:send', { roomId: ROOM_ID, content: 'hello' });

# Check Redis directly
redis-cli GET "unread:<bob-id>:<roomId>"
# Expected: "1"

redis-cli GET "unread:<carol-id>:<roomId>"
# Expected: "1"

redis-cli GET "unread:<alice-id>:<roomId>"
# Expected: (nil) — sender's count is not incremented
```

**2. Counter accumulates across multiple messages:**

```bash
# Alice sends 5 messages
for i in 1 2 3 4 5; do
  socket.emit('message:send', { roomId: ROOM_ID, content: "msg ${i}" });
done

redis-cli GET "unread:<bob-id>:<roomId>"
# Expected: "5"
```

**3. Counter resets when Bob fetches history:**

```bash
curl -s "http://localhost:3000/api/v1/rooms/$ROOM_ID/messages" \
  -H "Authorization: Bearer $BOB_TOKEN"

redis-cli GET "unread:<bob-id>:<roomId>"
# Expected: (nil) — key deleted
```

**4. GET /users/me/unread returns correct counts:**

```bash
curl -s http://localhost:3000/api/v1/users/me/unread \
  -H "Authorization: Bearer $BOB_TOKEN"
# Expected:
# { "data": { "counts": { "<roomId>": 5 } } }

# After Bob reads the room:
curl -s "http://localhost:3000/api/v1/rooms/$ROOM_ID/messages" \
  -H "Authorization: Bearer $BOB_TOKEN"

curl -s http://localhost:3000/api/v1/users/me/unread \
  -H "Authorization: Bearer $BOB_TOKEN"
# Expected: { "data": { "counts": {} } }  ← empty; no rooms with unread > 0
```

**5. unread:counts emitted on socket connect:**

```js
const socket = io(SERVER_URL, { auth: { token: BOB_TOKEN } });

socket.on('unread:counts', (counts) => {
  console.log(counts);
  // Expected: { "<roomId>": 5 } — reflects pending unread messages
  // before Bob has called GET /rooms/:id/messages
});
```

**6. Leave room clears unread counter:**

```bash
# Bob has 5 unread in the room
curl -s -X POST "http://localhost:3000/api/v1/rooms/$ROOM_ID/leave" \
  -H "Authorization: Bearer $BOB_TOKEN"

redis-cli GET "unread:<bob-id>:<roomId>"
# Expected: (nil) — cleared by leaveRoom
```

**7. Pipeline efficiency — one round-trip for N rooms:**

```bash
# User is a member of 10 rooms with unread messages
# GET /users/me/unread should complete in ~2-5ms (one MongoDB query + one Redis pipeline)
# Not ~20-50ms (one Redis GET per room serially)

time curl -s http://localhost:3000/api/v1/users/me/unread \
  -H "Authorization: Bearer $TOKEN"
# Expected: real time < 10ms
```

---

## File map

| File | Status |
|---|---|
| `src/services/unreadService.js` | New — `incrementUnread`, `resetUnread`, `getUnreadCounts`, `clearUnread` |
| `src/socket/messageHandlers.js` | Updated — `unreadService.incrementUnread` called fire-and-forget after `message:new` broadcast |
| `src/controllers/messageController.js` | Updated — `unreadService.resetUnread` called fire-and-forget after history fetch |
| `src/services/roomService.js` | Updated — `clearUnread` called in `leaveRoom` |
| `src/controllers/userController.js` | Updated — add `getUnreadCounts` handler |
| `src/routes/users.js` | Updated — `GET /me/unread` registered before `/me` and `/:id` |
| `src/socket/index.js` | Updated — `socket.emit('unread:counts', ...)` on connect |
| `SOCKET_EVENTS.md` | Updated — document `unread:counts` server→client event |

---

## Checklist

- [ ] Step 1 — `unread:{userId}:{roomId}` keys have no TTL — can explain why unread state is durable unlike presence
- [ ] Step 1 — `incrementUnread` pipelines all INCR calls into one Redis round-trip
- [ ] Step 1 — `incrementUnread` queries MongoDB for all members (including offline); can explain why connected-only would be wrong
- [ ] Step 1 — `getUnreadCounts` omits rooms with count 0 — can explain why
- [ ] Step 1 — `clearUnread` exported for use by `leaveRoom`
- [ ] Step 2 — `incrementUnread` is fire-and-forget (`.catch` not `await`) — can explain why
- [ ] Step 2 — Sender's count is NOT incremented — `filter(id => id !== senderId)`
- [ ] Step 3 — `resetUnread` is fire-and-forget in the controller — history response is not blocked by counter reset
- [ ] Step 3 — `leaveRoom` calls `clearUnread` — no stale counter if user rejoins
- [ ] Step 4 — `GET /me/unread` registered before `GET /:id` in the users router
- [ ] Step 5 — `socket.emit` not `io.to(...).emit` — counts are private to the connecting user
- [ ] Step 5 — Unread counts sent immediately on connect — client needs no separate HTTP call to populate badges
- [ ] Verification — Sender's Redis key is nil after their own message
- [ ] Verification — Counter reaches correct total after N messages
- [ ] Verification — Counter is nil after `GET /rooms/:id/messages`
- [ ] Verification — `GET /me/unread` returns empty object after all rooms are read
- [ ] Verification — `unread:counts` received on socket connect contains correct pending counts
- [ ] Knowledge check — Can explain the fan-out write pattern and why Redis INCR is atomic
- [ ] Knowledge check — Can explain why pipeline is used in `getUnreadCounts` (N rooms → one round-trip vs N round-trips)
- [ ] Knowledge check — Can explain the scaling concern with `incrementUnread` for large rooms and what the cache-based alternative looks like
