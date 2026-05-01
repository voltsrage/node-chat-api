# Phase 17 — Message Reactions

## What exists

From Phase 16:
- `src/models/Message.js` — Message schema without a `reactions` field
- `src/services/messageService.js` — `createMessage`, `editMessage`, `deleteMessage`, `getMessageHistory`; `toMessageResponse` helper
- `src/socket/messageHandlers.js` — `message:send`, `message:edit`, `message:delete`

## What needs to be built

Four steps. Two concepts worth internalising before writing code:

**Embed vs reference:** Reactions belong inside the Message document because they are always read with the message, their count is bounded (no realistic message has 10,000 reactions), and embedding lets a single query return the message and all its reactions. A separate `Reactions` collection would require a join on every message fetch.

**Toggle pattern:** The toggle requires two possible operations — add or remove — decided by whether the user has already reacted. MongoDB has no conditional update that branches on a sub-document value in one round-trip without a Lua script. The standard pattern is: attempt an add with a `$ne` filter; if the filter misses (user was already present), do the remove. Two round-trips in the worst case, one in the best case, both atomic.

---

## Step 1 — Message schema

**`src/models/Message.js`** — add `reactions`:

```js
reactions: {
  type:    Map,
  of:      [String],   // Map<emoji, userId[]>
  default: {},
},
```

**What this looks like in MongoDB:**

```json
{
  "_id": "...",
  "content": "hello",
  "reactions": {
    "👍": ["userId1", "userId2"],
    "❤️": ["userId3"]
  }
}
```

**Why `Map` and not a plain `Object` or a sub-document array:**

| Shape | Problem |
|---|---|
| `[{ emoji, userIds }]` | Requires `$elemMatch` for updates; harder to query "all users who reacted with 👍" |
| `{ "👍": [...] }` as a plain Mixed type | Mongoose does not track changes; must call `.markModified('reactions')` manually |
| `Map` | Mongoose tracks changes to map entries automatically; dot-notation updates work cleanly |

**Mongoose Map with `.lean()`:** When a query uses `.lean()`, the Map comes back as a plain JS object (MongoDB's native representation) — no conversion needed. When returned from `findOneAndUpdate` without `.lean()`, it is a Mongoose `Map` instance that must be converted with `Object.fromEntries` before JSON serialisation.

---

## Step 2 — toggleReaction in messageService

**`src/services/messageService.js`** — add `toggleReaction`:

```js
export async function toggleReaction(messageId, userId, emoji) {
  // Validate emoji — count Unicode codepoints, not UTF-16 code units
  // "👍".length === 2 (surrogate pair), but [...'👍'].length === 1
  const points = [...emoji];
  if (!points.length || points.length > 4) {
    throw new ValidationError('Emoji must be 1–4 codepoints.', 'INVALID_EMOJI');
  }

  // Attempt 1: add userId if it is NOT already in the array for this emoji.
  // The filter  reactions.{emoji}: { $ne: userId }  matches when:
  //   a) the emoji key does not exist yet (new reaction)
  //   b) the array exists but does not contain this userId
  const afterAdd = await Message.findOneAndUpdate(
    {
      _id:      messageId,
      deletedAt: null,
      [`reactions.${emoji}`]: { $ne: userId },
    },
    { $addToSet: { [`reactions.${emoji}`]: userId } },
    { new: true }
  );

  if (afterAdd) return toMessageResponse(afterAdd);

  // Attempt 2: userId was already in the array — remove it (toggle off).
  // This is a separate round-trip; no way to do both branches in one
  // MongoDB operation without a server-side script.
  const afterRemove = await Message.findOneAndUpdate(
    { _id: messageId, deletedAt: null },
    { $pull: { [`reactions.${emoji}`]: userId } },
    { new: true }
  );

  if (!afterRemove) {
    throw new NotFoundError('Message not found.', 'MESSAGE_NOT_FOUND');
  }

  return toMessageResponse(afterRemove);
}
```

**Why `$addToSet` and not `$push`:**

`$addToSet` is idempotent — it adds the element only if it is not already present. Using `$push` would add duplicate userIds if two requests race between the check and the write. `$addToSet` makes the add operation safe even in a concurrent environment.

**Why two round-trips is acceptable here:**

The alternative is a MongoDB aggregation pipeline update or a `$where` JavaScript expression — both are slow and do not use indexes. Two fast indexed `findOneAndUpdate` calls on `_id` complete in ~1ms each. The toggle operation is user-initiated (one at a time per user), so the latency is imperceptible and the race window between the two calls is negligible at this scale.

---

## Step 3 — Update toMessageResponse

`toMessageResponse` is used by every message operation. Adding `reactions` here means all responses — send, edit, delete, history — automatically include the reactions map without changing any controller or handler.

**`src/services/messageService.js`** — update `toMessageResponse`:

```js
function toMessageResponse(msg) {
  // msg may be a Mongoose document (findOneAndUpdate) or a lean plain object
  // Mongoose Map → plain object; lean object is already plain
  const reactions = msg.reactions instanceof Map
    ? Object.fromEntries(msg.reactions)
    : (msg.reactions ?? {});

  return {
    id:             msg._id,
    roomId:         msg.roomId,
    senderId:       msg.senderId,
    senderUsername: msg.senderUsername,
    content:        msg.deletedAt ? '[deleted]' : msg.content,
    type:           msg.type,
    reactions,
    editedAt:       msg.editedAt  ?? null,
    deletedAt:      msg.deletedAt ?? null,
    createdAt:      msg.createdAt,
  };
}
```

**Empty reactions:** An unreacted message has `reactions: {}` (empty object), not `null`. Clients should initialise their reaction display from this field on page load — no separate fetch needed.

---

## Step 4 — Socket handler

**`src/socket/messageHandlers.js`** — add `message:react` inside `registerMessageHandlers`:

```js
import * as messageService from '../services/messageService.js';
import { checkMessageRateLimit } from './rateLimiter.js';

// Add to KNOWN_CODES:
const KNOWN_CODES = new Set([
  'NOT_MEMBER', 'EDIT_NOT_ALLOWED', 'DELETE_NOT_ALLOWED',
  'INVALID_CONTENT', 'INVALID_EMOJI', 'MESSAGE_NOT_FOUND',
]);

export function registerMessageHandlers(io, socket) {
  // ... existing message:send, message:edit, message:delete handlers ...

  socket.on('message:react', safe(socket, async ({ messageId, emoji } = {}) => {
    if (!emoji) return socket.emit('error', { code: 'INVALID_EMOJI' });

    const message = await messageService.toggleReaction(
      messageId,
      socket.user.sub,
      emoji
    );

    // Broadcast only the updated reactions — not the full message.
    // The client already has the message content; it only needs to
    // update its reaction display.
    io.to(message.roomId.toString()).emit('message:reaction', {
      messageId: message.id,
      roomId:    message.roomId,
      reactions: message.reactions,
    });
  }));
}
```

**Why `io.to()` not `socket.to()`:**

The sender also needs to see their own reaction applied in real time. `io.to(room)` broadcasts to the entire room including the sender. `socket.to(room)` excludes the sender — appropriate for typing indicators (you don't need to see your own typing indicator) but wrong for reactions (you need to see your own emoji added to the count).

**Why broadcast `reactions` only, not the full message:**

Broadcasting the full message response on every reaction would be wasteful — the content, senderId, timestamps have not changed. Clients merge the incoming `reactions` map into their existing message object by `messageId`. This is the same pattern as `message:delete` broadcasting only `{ messageId, roomId }` rather than the full deleted message.

---

## Verification

**1. Add a reaction:**

```js
// Client A
socket.emit('message:react', { messageId: '<id>', emoji: '👍' });

// All clients in the room receive:
socket.on('message:reaction', ({ messageId, reactions }) => {
  console.log(reactions);
  // Expected: { "👍": ["<userA-id>"] }
});
```

**2. Toggle off — same emoji removes the reaction:**

```js
// Client A reacts again with the same emoji
socket.emit('message:react', { messageId: '<id>', emoji: '👍' });

// All clients receive:
socket.on('message:reaction', ({ reactions }) => {
  console.log(reactions['👍']);
  // Expected: [] — userId removed from the array
});
```

**3. Multiple users react with the same emoji:**

```js
// Client A and Client B both react with 👍
// After both react, all clients receive:
// { "👍": ["<userA-id>", "<userB-id>"] }
```

**4. Reactions appear in message history:**

```bash
curl -s "http://localhost:3000/api/v1/rooms/<roomId>/messages?limit=5" \
  -H "Authorization: Bearer $TOKEN"

# Expected: each message object includes a "reactions" field
# { ..., "reactions": { "👍": ["userId1"] }, ... }
# Un-reacted messages: "reactions": {}
```

**5. Confirm MongoDB storage directly:**

```js
// mongosh
db.messages.findOne({ _id: ObjectId('<id>') }, { reactions: 1 })
// Expected: { reactions: { "👍": ["userId1", "userId2"] } }
```

**6. Invalid emoji rejected:**

```js
socket.emit('message:react', { messageId: '<id>', emoji: 'this-is-not-an-emoji-lol' });

socket.on('error', (err) => {
  console.log(err.code); // Expected: 'INVALID_EMOJI'
});
```

**7. Reaction on deleted message rejected:**

```js
// Delete a message, then try to react to it
socket.emit('message:delete', { messageId: '<id>' });
socket.emit('message:react', { messageId: '<id>', emoji: '👍' });

// Expected: error { code: 'MESSAGE_NOT_FOUND' }
// (deletedAt: null filter prevents reactions on deleted messages)
```

**8. Concurrent reaction race — two users react simultaneously:**

```bash
# This is hard to simulate precisely but the two-operation pattern handles it correctly:
# If both users fire message:react at the same instant:
#   - Both pass the $ne filter (neither is in the array yet)
#   - Both do $addToSet — $addToSet is idempotent but the filter already scoped it
#   - Result: both userIds appear in the array
# No duplicates, no lost reactions
```

---

## File map

| File | Status |
|---|---|
| `src/models/Message.js` | Updated — add `reactions: { type: Map, of: [String], default: {} }` |
| `src/services/messageService.js` | Updated — add `toggleReaction`; update `toMessageResponse` to include reactions |
| `src/socket/messageHandlers.js` | Updated — add `message:react` handler; `INVALID_EMOJI` and `MESSAGE_NOT_FOUND` to `KNOWN_CODES` |
| `SOCKET_EVENTS.md` | Updated — document `message:react` (client→server) and `message:reaction` (server→client) |

---

## Checklist

- [ ] Step 1 — `reactions` uses `type: Map, of: [String]` on the Message schema
- [ ] Step 1 — Can explain why `Map` is better than `Mixed` or an array of sub-documents for this use case
- [ ] Step 1 — Can explain the embed vs reference decision for reactions
- [ ] Step 2 — `toggleReaction` validates emoji using `[...emoji].length` (codepoints, not UTF-16 units)
- [ ] Step 2 — First `findOneAndUpdate` uses `{ $ne: userId }` filter and `$addToSet`
- [ ] Step 2 — Second `findOneAndUpdate` (the remove) only runs if the first returned null
- [ ] Step 2 — Can explain why `$addToSet` is safer than `$push` for the add operation
- [ ] Step 2 — Can explain why two round-trips is acceptable and what the alternatives are
- [ ] Step 3 — `toMessageResponse` handles both Mongoose `Map` (from `findOneAndUpdate`) and plain object (from `.lean()`)
- [ ] Step 3 — Un-reacted messages return `reactions: {}`, not `null`
- [ ] Step 4 — `message:react` uses `io.to()` not `socket.to()` — sender receives their own reaction
- [ ] Step 4 — Broadcast payload is `{ messageId, roomId, reactions }` — not the full message
- [ ] Step 4 — `INVALID_EMOJI` and `MESSAGE_NOT_FOUND` added to `KNOWN_CODES`
- [ ] Step 4 — `SOCKET_EVENTS.md` updated with `message:react` and `message:reaction`
- [ ] Verification — Toggle on then off: reactions array returns to `[]`
- [ ] Verification — Reactions field appears in `GET /rooms/:id/messages` response
- [ ] Verification — Reacting on a deleted message returns `MESSAGE_NOT_FOUND`
- [ ] Knowledge check — Can explain why `io.to()` is used here but `socket.to()` is used for typing indicators
- [ ] Knowledge check — Can explain what happens if two users react with the same emoji at exactly the same time
