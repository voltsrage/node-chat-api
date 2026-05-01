# Phase 6 — Socket.io Real-time Messaging and Typing Indicators

## What exists

From Phase 5:
- `socketAuthenticate` middleware — validates JWT from `socket.handshake.auth.token` (built in Phase 3, unused until now)
- `messageService.js` — read-only (`getMessageHistory`); write operations added in this phase
- `roomController.js` — `joinRoom` has a Phase 4 TODO for socket subscription; wired in this phase
- `redis` client available throughout

## What needs to be built

Eight steps. Two concepts to internalize:
1. **Typing indicator TTL** — Redis expiry handles cleanup automatically; deleting the key on `typing:stop` is not necessary and can cause race conditions.
2. **Disconnect cleanup** — every ephemeral state entry written on connect must be removed on disconnect. An incomplete disconnect handler means users appear online indefinitely.

---

## Step 1 — Install Socket.io

```bash
npm install socket.io
```

No additional packages needed — `ioredis` and the JWT middleware are already in place.

---

## Step 2 — Message service write operations

Add three write functions to the existing `src/services/messageService.js`. The socket handlers call these — the service owns all database logic, the handlers own the socket protocol.

`editMessage` uses a compound query that checks `senderId`, `deletedAt`, and `createdAt` in a single `findOneAndUpdate`. If any condition fails, the update returns `null` — one round-trip, no separate permission check.

**`src/services/messageService.js`** — append after the existing `getMessageHistory` function:

```js
export async function createMessage(roomId, { senderId, senderUsername, content }) {
  const isMember = await Room.exists({ _id: roomId, memberIds: senderId });
  if (!isMember) {
    const err = new Error('NOT_MEMBER');
    err.code  = 'NOT_MEMBER';
    throw err;
  }

  const message = await Message.create({
    roomId,
    senderId,
    senderUsername,
    content: content.trim(),
    type:    'text',
  });

  return toMessageResponse(message);
}

export async function editMessage(messageId, userId, content) {
  const windowStart = new Date(Date.now() - 15 * 60 * 1000);

  const message = await Message.findOneAndUpdate(
    {
      _id:       messageId,
      senderId:  userId,
      deletedAt: null,
      createdAt: { $gte: windowStart },  // 15-minute edit window
    },
    { $set: { content: content.trim(), editedAt: new Date() } },
    { new: true }
  );

  if (!message) {
    const err = new Error('EDIT_NOT_ALLOWED');
    err.code  = 'EDIT_NOT_ALLOWED';
    throw err;
  }

  return toMessageResponse(message);
}

export async function deleteMessage(messageId, userId) {
  const message = await Message.findOneAndUpdate(
    { _id: messageId, senderId: userId, deletedAt: null },
    { $set: { deletedAt: new Date() } },
    { new: true }
  );

  if (!message) {
    const err = new Error('DELETE_NOT_ALLOWED');
    err.code  = 'DELETE_NOT_ALLOWED';
    throw err;
  }

  return { id: message._id, roomId: message.roomId };
}
```

---

## Step 3 — Message socket handlers

`safe` is a local wrapper that catches thrown errors and emits them to the client. It distinguishes domain errors (known `.code` values) from unexpected crashes.

`message:edit` broadcasts to the whole room — including the sender — so all open tabs update simultaneously.

`message:delete` broadcasts only the IDs, not the content; the client uses `messageId` to remove the message from its local state.

**`src/socket/messageHandlers.js`:**

```js
import * as messageService from '../services/messageService.js';

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

---

## Step 4 — Typing socket handlers

**`typing:stop` does not delete the Redis key.** The 3-second TTL handles cleanup automatically. The reason: if `typing:stop` arrives before `typing:start` is fully processed (a race on a loaded server), deleting the key would leave no entry to expire and the indicator would never clear. Letting the TTL expire is atomic and race-free.

`typing:stop` still broadcasts immediately so the UI can update without waiting for the TTL. The Redis key is a safety net for clients that disconnect without sending `typing:stop`.

`socket.to(roomId)` emits to everyone in the room *except* the sender. The user typing does not need to see their own indicator.

**`src/socket/typingHandlers.js`:**

```js
import { redis } from '../db/redis.js';

const TYPING_TTL = 3; // seconds

export function registerTypingHandlers(io, socket) {
  socket.on('typing:start', async ({ roomId } = {}) => {
    if (!roomId) return;
    try {
      await redis.set(
        `typing:${roomId}:${socket.user.sub}`,
        socket.user.username,
        'EX',
        TYPING_TTL
      );
      socket.to(roomId).emit('typing:update', {
        roomId,
        userId:   socket.user.sub,
        username: socket.user.username,
        typing:   true,
      });
    } catch {
      // Typing is ephemeral — swallow errors silently
    }
  });

  socket.on('typing:stop', async ({ roomId } = {}) => {
    if (!roomId) return;
    // Do NOT delete the Redis key — let the 3s TTL expire naturally
    // This prevents a race where stop arrives before start is processed
    socket.to(roomId).emit('typing:update', {
      roomId,
      userId:   socket.user.sub,
      username: socket.user.username,
      typing:   false,
    });
  });
}
```

---

## Step 5 — Socket server

`userSockets` maps `userId → Set<socketId>`. A user can have multiple sockets open (multiple browser tabs), so the value is a `Set` rather than a single ID.

On connect, the server queries MongoDB for all rooms the user is a member of and calls `socket.join()` on each. This is the mechanism that makes `io.to(roomId).emit(...)` work — if a socket is not joined to the Socket.io room channel, it does not receive broadcasts.

The disconnect handler removes the socket from `userSockets` and has a placeholder for Phase 7 presence cleanup.

**`src/socket/index.js`:**

```js
import { Server } from 'socket.io';
import { Room } from '../models/Room.js';
import { socketAuthenticate } from '../middleware/socketAuthenticate.js';
import { registerMessageHandlers } from './messageHandlers.js';
import { registerTypingHandlers } from './typingHandlers.js';
import { logger } from '../utils/logger.js';

// userId → Set<socketId> — tracks active connections per user
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
    cors: { origin: '*' }, // Tighten to specific origins in production
  });

  io.use(socketAuthenticate);

  io.on('connection', async (socket) => {
    const userId = socket.user.sub;
    logger.info({ userId, socketId: socket.id }, 'Socket connected');

    // Track socket
    if (!userSockets.has(userId)) userSockets.set(userId, new Set());
    userSockets.get(userId).add(socket.id);

    // Auto-join Socket.io room channels for all rooms the user is a member of
    try {
      const rooms = await Room.find({ memberIds: userId }).select('_id').lean();
      for (const room of rooms) socket.join(room._id.toString());
    } catch (err) {
      logger.error({ err, userId }, 'Failed to auto-join rooms on connect');
    }

    // Register event handlers
    registerMessageHandlers(io, socket);
    registerTypingHandlers(io, socket);

    socket.on('disconnect', (reason) => {
      logger.info({ userId, socketId: socket.id, reason }, 'Socket disconnected');

      const sockets = userSockets.get(userId);
      if (sockets) {
        sockets.delete(socket.id);
        if (sockets.size === 0) userSockets.delete(userId);
      }

      // TODO Phase 7: remove user from presence sorted sets
    });
  });

  return io;
}
```

---

## Step 6 — Update index.js

Socket.io must attach to the raw HTTP server, not the Express app. Create the HTTP server first, then attach both Express and Socket.io to it. Store `io` on the Express app via `app.set('io', io)` so controllers can access it through `req.app.get('io')`.

**`src/index.js`** — replace the existing file:

```js
import 'dotenv/config';
import { createServer } from 'http';
import { app } from './app.js';
import { connectDB } from './db/connect.js';
import { createSocketServer } from './socket/index.js';
import { logger } from './utils/logger.js';

const PORT = process.env.PORT || 3000;

async function start() {
  await connectDB();

  const httpServer = createServer(app);
  const io         = createSocketServer(httpServer);

  // Make io accessible in controllers via req.app.get('io')
  app.set('io', io);

  httpServer.listen(PORT, () => logger.info({ port: PORT }, 'Server started'));
}

start().catch(err => {
  logger.error(err, 'Failed to start server');
  process.exit(1);
});
```

---

## Step 7 — Wire the Phase 4 TODO in room controller

The `joinRoom` controller had a stub comment since Phase 4. Now that `io` is available and `joinUserToRoom` is exported, complete it.

**`src/controllers/roomController.js`** — update `joinRoom`:

```js
import { joinUserToRoom } from '../socket/index.js';

export async function joinRoom(req, res) {
  const room = await roomService.joinRoom(req.params.id, req.user.sub);

  // Subscribe the user's active socket(s) to the room channel immediately
  // so they receive real-time messages without reconnecting
  const io = req.app.get('io');
  joinUserToRoom(io, req.user.sub, req.params.id);

  res.json(ApiResponse.success(room));
}
```

---

## Verification

Use two browser tabs (or two terminal sessions with a Socket.io test client) connected with different user tokens.

**1. Real-time message delivery:**

Connect two clients to the same room. Send `message:send` from client 1. Confirm client 2 receives `message:new` with the correct payload.

```js
// Client 1 (sender)
socket.emit('message:send', { roomId: '<room-id>', content: 'Hello' });

// Client 2 (receiver) — should fire automatically
socket.on('message:new', (msg) => {
  console.assert(msg.senderUsername === 'alice');
  console.assert(msg.content === 'Hello');
});
```

**2. Message edit — 15-minute window:**

```js
// Edit within the window — both clients receive message:edit
socket.emit('message:edit', { messageId: '<id>', content: 'Hello (edited)' });

// Edit a message older than 15 minutes — sender receives error
socket.on('error', (err) => {
  console.assert(err.code === 'EDIT_NOT_ALLOWED');
});
```

**3. Soft delete — content replaced with `[deleted]`:**

```js
socket.emit('message:delete', { messageId: '<id>' });

// Both clients receive message:delete
socket.on('message:delete', ({ messageId, roomId }) => {
  // Client removes the message from its local state
});

// GET /rooms/:id/messages — deleted message returns '[deleted]' as content
```

**4. Typing indicator — TTL expiry without `typing:stop`:**

```js
// Client 1
socket.emit('typing:start', { roomId: '<room-id>' });

// Client 2 receives immediately
socket.on('typing:update', ({ typing, username }) => {
  console.assert(typing === true);
  console.assert(username === 'alice');
});

// Do NOT send typing:stop from client 1
// After 3 seconds, confirm the Redis key is gone:
// redis-cli TTL typing:<roomId>:<userId>  → should return -2 (expired)

// Client 2 does NOT automatically receive a typing:update { typing: false }
// unless client 1 sends typing:stop — the TTL only cleans Redis, not the broadcast
// The UI should handle this by clearing indicators after a client-side timeout
```

**5. Non-member cannot send messages:**

```js
// Connect as a user who is NOT a member of the room
socket.emit('message:send', { roomId: '<room-id>', content: 'Intruder' });

socket.on('error', (err) => {
  console.assert(err.code === 'NOT_MEMBER');
});
```

**6. HTTP join immediately enables real-time messages:**

```js
// User is connected via socket but not yet a member of the room
// Call POST /rooms/:id/join via HTTP
// Without reconnecting, user should now receive message:new events for that room
```

---

## File map

| File | Status |
|---|---|
| `src/services/messageService.js` | Updated — add `createMessage`, `editMessage`, `deleteMessage` |
| `src/socket/messageHandlers.js` | New — `message:send`, `message:edit`, `message:delete` with `safe` wrapper |
| `src/socket/typingHandlers.js` | New — `typing:start` (sets Redis TTL), `typing:stop` (broadcasts only, no Redis delete) |
| `src/socket/index.js` | New — `createSocketServer`, `joinUserToRoom`, `userSockets` map |
| `src/index.js` | Updated — HTTP server wraps Express; `io` stored on app via `app.set` |
| `src/controllers/roomController.js` | Updated — `joinRoom` calls `joinUserToRoom` to complete Phase 4 TODO |

---

## Checklist

- [ ] Step 2 — `createMessage` checks room membership before inserting (`Room.exists`)
- [ ] Step 2 — `editMessage` checks `senderId`, `deletedAt`, and `createdAt >= windowStart` in a single query
- [ ] Step 2 — `editMessage` returns `null` → throws `EDIT_NOT_ALLOWED`; does not distinguish which condition failed
- [ ] Step 2 — `deleteMessage` is a soft delete — sets `deletedAt`, does not remove the document
- [ ] Step 3 — `safe` wrapper emits `error` to the client on failure; known codes pass through, all others become `INTERNAL_ERROR`
- [ ] Step 3 — `message:edit` broadcasts `message:edit` to entire room (including sender) so all tabs update
- [ ] Step 3 — `message:delete` broadcasts only `{ messageId, roomId }`, not the message content
- [ ] Step 4 — `typing:start` sets `typing:{roomId}:{userId}` with a 3-second TTL and value of username
- [ ] Step 4 — `typing:stop` broadcasts `{ typing: false }` but does NOT delete the Redis key
- [ ] Step 4 — `socket.to(roomId)` used (not `io.to`) so the sender does not receive their own typing indicator
- [ ] Step 5 — `userSockets` uses `userId → Set<socketId>` to support multiple tabs
- [ ] Step 5 — On connect: query MongoDB for user's rooms and call `socket.join()` for each
- [ ] Step 5 — On disconnect: remove socketId from `userSockets`; delete userId key when the set is empty
- [ ] Step 5 — Phase 7 presence TODO comment in disconnect handler
- [ ] Step 6 — `createServer(app)` wraps Express; `io` attaches to `httpServer`, not `app`
- [ ] Step 6 — `app.set('io', io)` called after `createSocketServer` returns
- [ ] Step 7 — `joinRoom` controller retrieves `io` via `req.app.get('io')` and calls `joinUserToRoom`
- [ ] Verification — client 2 receives `message:new` when client 1 sends `message:send`
- [ ] Verification — `typing:start` without `typing:stop`: Redis key expires after 3 seconds (`redis-cli TTL`)
- [ ] Verification — `message:edit` on a message older than 15 minutes emits `EDIT_NOT_ALLOWED`
- [ ] Verification — non-member `message:send` emits `NOT_MEMBER`
- [ ] Verification — HTTP join via `POST /rooms/:id/join` immediately subscribes the active socket to the room
