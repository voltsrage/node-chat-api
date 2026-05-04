# Phase 23 — Read Receipts

## What exists

From Phase 22:
- `src/controllers/messageController.js` — `getMessageHistory` already calls `unreadService.resetUnread` fire-and-forget after fetching messages
- `src/services/unreadService.js` — `resetUnread(userId, roomId)` deletes the Redis unread key
- `src/routes/rooms.js` — `GET /:id/messages`; no receipts route
- `src/socket/index.js` — registers message and typing handlers on connect; exports `io` and `joinUserToRoom`

## What needs to be built

Four steps. Two concepts to understand before writing code:

**Read receipts vs unread counts — different keys, different purposes:**

| | Unread count | Read receipt |
|---|---|---|
| Key | `unread:{userId}:{roomId}` | `lastread:{userId}:{roomId}` |
| Value | Integer counter | ISO timestamp |
| TTL | None | None |
| Updated by | `message:send` fan-out | History fetch OR `read:mark` socket event |
| Reset by | History fetch (deleted) | Never reset — only overwritten |
| Purpose | Badge count | "Seen by" display |

The key insight: an unread count answers "how many?" and is deleted on read. A read receipt answers "when was the last time this user read?" and is overwritten, never deleted (except on leave/room delete).

**Two paths to mark as read:**

1. **HTTP** — `GET /rooms/:id/messages` fetches history. The user has pulled messages so they have read them.
2. **Socket** — `read:mark { roomId }` — the client sends this when a user is actively viewing a room and new messages stream in via `message:new`. Without this, a user who never re-fetches HTTP history would never have their receipt updated in real time.

Both paths call the same service function and emit the same `read:update` socket event.

---

## Step 1 — Read receipt service

**`src/services/readReceiptService.js`:**

```js
import { redis } from '../db/redis.js';
import { Room }  from '../models/Room.js';

// Key pattern: lastread:{userId}:{roomId}
// No TTL — a receipt from 3 months ago still meaningfully represents
// "this user was last here at that time"
const key = (userId, roomId) => `lastread:${userId}:${roomId}`;

export async function markRead(userId, roomId) {
  // Overwrite on every read — always reflects the most recent visit
  await redis.set(key(userId, roomId), new Date().toISOString());
}

export async function getRoomReceipts(roomId) {
  const room = await Room.findById(roomId).select('members').lean();
  if (!room) return {};

  // One pipeline round-trip for all members — same pattern as getUnreadCounts
  const pipeline = redis.pipeline();
  for (const m of room.members) {
    pipeline.get(key(m.userId.toString(), roomId));
  }
  const results = await pipeline.exec();

  const receipts = {};
  for (let i = 0; i < room.members.length; i++) {
    const ts = results[i][1];
    // Only include members who have read at least once — omit null entries
    if (ts) receipts[room.members[i].userId.toString()] = ts;
  }
  return receipts;
}

// Called when a user leaves a room or when a room is deleted
export async function clearReceipt(userId, roomId) {
  await redis.del(key(userId, roomId));
}

// Called when a room is deleted — clears receipts for all members at once
export async function clearAllReceipts(roomId, members) {
  if (!members.length) return;
  const pipeline = redis.pipeline();
  for (const m of members) {
    pipeline.del(key(m.userId.toString(), roomId));
  }
  await pipeline.exec();
}
```

**Why overwrite rather than only set if newer:**

Redis `SET` is unconditional and atomic. A conditional `SET NX` or compare-and-swap requires a Lua script. Since `markRead` is only called when a user actually fetches messages or sends a `read:mark` event — both of which represent genuine "I read this room now" signals — unconditional overwrite is correct. There is no scenario where an older timestamp should win.

---

## Step 2 — Socket handler: read:mark

The socket handler covers the case where a user is actively in a room and receives messages via `message:new` without making new HTTP history calls. The client should emit `read:mark` when the user views incoming messages.

**`src/socket/readReceiptHandlers.js`:**

```js
import { Room }              from '../models/Room.js';
import { markRead }          from '../services/readReceiptService.js';
import { logger }            from '../utils/logger.js';

export function registerReadReceiptHandlers(io, socket) {
  socket.on('read:mark', async ({ roomId } = {}) => {
    if (!roomId) return;

    try {
      // Verify membership — the socket user must be in the room
      // (socket.join is done on connect, so the user is in the Socket.io room,
      //  but we still verify against the DB to prevent spoofed roomIds)
      const isMember = await Room.exists({
        _id:              roomId,
        'members.userId': socket.user.sub,
      });
      if (!isMember) return;  // silently ignore — no error emitted

      await markRead(socket.user.sub, roomId);

      // Broadcast to all room members — including the sender so their
      // own client reflects the updated receipt state
      io.to(roomId).emit('read:update', {
        userId: socket.user.sub,
        roomId,
        readAt: new Date().toISOString(),
      });

    } catch (err) {
      logger.error({ err, roomId, userId: socket.user.sub }, 'read:mark failed');
    }
  });
}
```

**`src/socket/index.js`** — register the new handler:

```js
import { registerReadReceiptHandlers } from './readReceiptHandlers.js';

io.on('connection', async (socket) => {
  // ... existing connect setup ...

  registerMessageHandlers(io, socket);
  registerTypingHandlers(io, socket);
  registerReadReceiptHandlers(io, socket);   // add this line

  // ... disconnect handler ...
});
```

**Why `io.to()` (not `socket.to()`) for `read:update`:**

The sender's own clients need to reflect the receipt too — if Alice is signed in on two devices and marks a room as read on her phone, her laptop should also update its display. `io.to()` includes all sockets in the room; `socket.to()` excludes the sending socket.

**Why silently ignore non-member `read:mark`:**

Unlike HTTP endpoints that return structured error responses, socket events that represent client state updates (not commands) are safer to ignore silently. The client sent a valid event for a room it's not in — the correct response is to do nothing, not to emit an error that the client must handle. Emitting an error would complicate client code for an edge case that should never occur in a well-behaved client.

---

## Step 3 — Wire into getMessageHistory

**`src/controllers/messageController.js`** — update `getMessageHistory`:

```js
import * as messageService      from '../services/messageService.js';
import * as unreadService       from '../services/unreadService.js';
import * as readReceiptService  from '../services/readReceiptService.js';
import { ApiResponse }          from '../utils/ApiResponse.js';

export async function getMessageHistory(req, res) {
  const result = await messageService.getMessageHistory(req.params.id, req.query);

  const userId = req.user.sub;
  const roomId = req.params.id;

  // Both operations are fire-and-forget — neither should block the response
  unreadService.resetUnread(userId, roomId).catch(() => {});

  readReceiptService.markRead(userId, roomId)
    .then(() => {
      // Emit read:update to the room via the io instance stored on the app
      const io = req.app.get('io');
      if (io) {
        io.to(roomId).emit('read:update', {
          userId,
          roomId,
          readAt: new Date().toISOString(),
        });
      }
    })
    .catch(() => {});

  res.json(ApiResponse.success(result));
}
```

**Accessing `io` from an HTTP controller via `req.app.get('io')`:**

Socket.io's `io` instance is set on the Express app at server startup:

```js
// src/server.js (or wherever io is created)
const io = new Server(httpServer, { ... });
app.set('io', io);   // store for HTTP controllers to access
```

This is the idiomatic Express pattern for sharing stateful instances (io, database connections) with controllers without circular imports. The `if (io)` guard makes the controller testable without a real socket server.

**Why both `resetUnread` and `markRead` fire-and-forget:**

The history response is independent of these side effects. A user expects to receive their messages even if Redis is temporarily slow. Failing to update the receipt or unread count should never surface as a history fetch error.

---

## Step 4 — GET /rooms/:id/receipts, cleanup

**`src/controllers/roomController.js`** — add handler:

```js
import * as readReceiptService from '../services/readReceiptService.js';

export async function getRoomReceipts(req, res) {
  const receipts = await readReceiptService.getRoomReceipts(req.params.id);
  res.json(ApiResponse.success({ receipts }));
}
```

**`src/routes/rooms.js`** — add route:

```js
roomsRouter.get('/:id/receipts', requireMember, roomController.getRoomReceipts);
```

**`src/services/roomService.js`** — update `leaveRoom` and `deleteRoom` to clean up receipts:

```js
import { clearReceipt, clearAllReceipts } from './readReceiptService.js';

export async function leaveRoom(roomId, userId) {
  // ... existing leave logic ...
  await clearUnread(userId, roomId);
  await clearReceipt(userId, roomId);    // add this line
}

export async function deleteRoom(roomId, userId) {
  // ... existing delete logic ...
  for (const m of room.members) {
    await clearUnread(m.userId.toString(), roomId);
  }
  // Replace the member loop with a pipelined batch clear
  await clearAllReceipts(roomId, room.members);
}
```

**`SOCKET_EVENTS.md`** — add the two new events:

```markdown
## read:mark (client → server)
Sent when the user actively views a room's messages in real time.

| Field  | Type   | Description        |
|--------|--------|--------------------|
| roomId | string | Room being viewed  |

## read:update (server → client)
Broadcast to the room when any member marks the room as read.

| Field  | Type   | Description                      |
|--------|--------|----------------------------------|
| userId | string | User who read the room           |
| roomId | string | Room that was read               |
| readAt | string | ISO 8601 timestamp of the read   |
```

---

## Verification

**1. Receipt set after fetching history:**

```bash
curl -s "http://localhost:3000/api/v1/rooms/$ROOM/messages" \
  -H "Authorization: Bearer $BOB_TOKEN"

redis-cli GET "lastread:<bob-id>:<roomId>"
# Expected: ISO timestamp, e.g. "2024-01-15T10:30:00.000Z"
```

**2. Receipt updated on subsequent fetch — timestamp advances:**

```bash
# Wait a moment, then fetch again
curl -s "http://localhost:3000/api/v1/rooms/$ROOM/messages" \
  -H "Authorization: Bearer $BOB_TOKEN"

redis-cli GET "lastread:<bob-id>:<roomId>"
# Expected: a later timestamp than before
```

**3. GET /rooms/:id/receipts returns all members who have read:**

```bash
# Alice and Bob have both fetched history; Carol has not
curl -s "http://localhost:3000/api/v1/rooms/$ROOM/receipts" \
  -H "Authorization: Bearer $ALICE_TOKEN" | jq '.data.receipts'
# Expected:
# { "<alice-id>": "2024-01-15T...", "<bob-id>": "2024-01-15T..." }
# Carol is absent — she has no lastread key
```

**4. read:update socket event received when another user fetches history:**

```js
// Carol listens for read:update
carolSocket.on('read:update', ({ userId, roomId, readAt }) => {
  console.log(userId, readAt);
  // Expected: bob's userId with his read timestamp
});

// Bob fetches history via HTTP
fetch(`/api/v1/rooms/${roomId}/messages`, { headers: { Authorization: `Bearer ${BOB_TOKEN}` } });
```

**5. read:mark socket event updates receipt in real time:**

```js
// Alice is actively in the room watching messages stream in
// She does not make an HTTP call — uses the socket event instead
aliceSocket.emit('read:mark', { roomId: ROOM_ID });

// All room members receive:
// { userId: alice-id, roomId: ROOM_ID, readAt: "..." }

redis-cli GET "lastread:<alice-id>:<roomId>"
# Expected: updated timestamp
```

**6. Non-member read:mark is silently ignored:**

```js
// Carol is not a member of the private room
carolSocket.emit('read:mark', { roomId: PRIVATE_ROOM_ID });

// Carol receives no error event
// Redis key is not set
redis-cli GET "lastread:<carol-id>:<privateRoomId>"
# Expected: (nil)
```

**7. Receipt cleared on leave:**

```bash
# Bob has a receipt
redis-cli GET "lastread:<bob-id>:<roomId>"
# Expected: timestamp

# Bob leaves the room
curl -s -X POST "http://localhost:3000/api/v1/rooms/$ROOM/leave" \
  -H "Authorization: Bearer $BOB_TOKEN"

redis-cli GET "lastread:<bob-id>:<roomId>"
# Expected: (nil) — cleared by leaveRoom
```

**8. All receipts cleared on room delete:**

```bash
# Alice (owner) deletes the room
curl -s -X DELETE "http://localhost:3000/api/v1/rooms/$ROOM" \
  -H "Authorization: Bearer $ALICE_TOKEN"

redis-cli KEYS "lastread:*:<roomId>"
# Expected: (empty) — clearAllReceipts pipelined all keys
```

**9. receipts omits members who have never read:**

```bash
# Carol joins but never fetches history
curl -s "http://localhost:3000/api/v1/rooms/$ROOM/receipts" \
  -H "Authorization: Bearer $ALICE_TOKEN" | jq '.data.receipts | keys'
# Expected: Carol's userId is NOT in the keys
```

---

## File map

| File | Status |
|---|---|
| `src/services/readReceiptService.js` | New — `markRead`, `getRoomReceipts`, `clearReceipt`, `clearAllReceipts` |
| `src/socket/readReceiptHandlers.js` | New — `read:mark` handler; emits `read:update` to room |
| `src/socket/index.js` | Updated — `registerReadReceiptHandlers(io, socket)` on connect |
| `src/server.js` | Updated — `app.set('io', io)` so HTTP controllers can access the socket instance |
| `src/controllers/messageController.js` | Updated — `markRead` + `io.emit('read:update')` fire-and-forget in `getMessageHistory` |
| `src/controllers/roomController.js` | Updated — add `getRoomReceipts` handler |
| `src/routes/rooms.js` | Updated — `GET /:id/receipts` |
| `src/services/roomService.js` | Updated — `leaveRoom` calls `clearReceipt`; `deleteRoom` calls `clearAllReceipts` |
| `SOCKET_EVENTS.md` | Updated — document `read:mark` (client→server) and `read:update` (server→client) |

---

## Checklist

- [ ] Step 1 — `lastread:{userId}:{roomId}` has no TTL — can explain why unlike presence keys
- [ ] Step 1 — `getRoomReceipts` pipelines all GET calls into one round-trip
- [ ] Step 1 — Members with no receipt (never read) are omitted from the response — can explain why
- [ ] Step 1 — `clearAllReceipts` pipelines all DEL calls — no serial loop on room delete
- [ ] Step 2 — `read:mark` silently ignores non-members — can explain why no error is emitted
- [ ] Step 2 — `read:update` uses `io.to()` not `socket.to()` — sender's own clients update too
- [ ] Step 3 — `markRead` + `io.emit('read:update')` are fire-and-forget — can explain why
- [ ] Step 3 — `io` accessed via `req.app.get('io')` — can explain the `app.set('io', io)` pattern
- [ ] Step 3 — `if (io)` guard makes the controller testable without a real socket server
- [ ] Step 4 — `GET /:id/receipts` protected by `requireMember` — non-members cannot see who has read
- [ ] Step 4 — `leaveRoom` calls `clearReceipt` — no stale receipts for departed members
- [ ] Step 4 — `deleteRoom` calls `clearAllReceipts` (pipelined) not a serial loop
- [ ] Step 4 — `SOCKET_EVENTS.md` updated with both new events
- [ ] Verification — `redis-cli GET "lastread:..."` shows ISO timestamp after history fetch
- [ ] Verification — `GET /receipts` omits members who have never fetched history
- [ ] Verification — `read:update` received by all room clients when any member reads
- [ ] Verification — Receipt key is nil after `leaveRoom`
- [ ] Knowledge check — Can explain the difference between `lastread` and `unread` keys: purpose, value type, and lifecycle
- [ ] Knowledge check — Can explain the two paths that trigger `markRead` (HTTP fetch vs socket event) and why both are needed
- [ ] Knowledge check — Can explain why `io.to()` is correct here (sender's own receipt must update on all their devices)
