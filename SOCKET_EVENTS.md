# Socket.io Events

Authentication: all connections must pass a valid JWT in the handshake auth object:

```js
const socket = io(SERVER_URL, { auth: { token: '<access-token>' } });
```

---

## Client → Server

### `message:send`

Send a new message to a room.

**Payload:**
```json
{ "roomId": "<string>", "content": "<string>" }
```

**Server response:** broadcasts `message:new` to the room on success; emits `error` on failure.

**Error codes:** `INVALID_CONTENT`, `NOT_MEMBER`, `RATE_LIMITED`, `INTERNAL_ERROR`

---

### `message:edit`

Edit a message within the 15-minute edit window.

**Payload:**
```json
{ "messageId": "<string>", "content": "<string>" }
```

**Server response:** broadcasts `message:edit` to the room on success.

**Error codes:** `INVALID_CONTENT`, `EDIT_NOT_ALLOWED`, `INTERNAL_ERROR`

---

### `message:delete`

Soft-delete a message. Content is replaced with `[deleted]`.

**Payload:**
```json
{ "messageId": "<string>" }
```

**Server response:** broadcasts `message:delete` to the room on success.

**Error codes:** `DELETE_NOT_ALLOWED`, `INTERNAL_ERROR`

---

### `message:react`

Toggle a reaction on a message. Sending the same emoji twice removes the reaction.

**Payload:**
```json
{ "messageId": "<string>", "emoji": "<string>" }
```

**Server response:** broadcasts `message:reaction` to the room on success.

**Error codes:** `INVALID_EMOJI`, `MESSAGE_NOT_FOUND`, `INTERNAL_ERROR`

---

### `typing:start`

Notify the room that this user is typing. Sets a 3-second Redis TTL.

**Payload:**
```json
{ "roomId": "<string>" }
```

**Server response:** broadcasts `typing:update` to the room (excluding sender).

---

### `typing:stop`

Notify the room that this user stopped typing. Does not delete the Redis key — the 3-second TTL expires naturally.

**Payload:**
```json
{ "roomId": "<string>" }
```

**Server response:** broadcasts `typing:update` to the room (excluding sender).

---

### `read:mark`

Notify the server that this user has read all messages in a room up to the current moment.

**Payload:**
```json
{ "roomId": "<string>" }
```

**Server response:** broadcasts `read:update` to the whole room (including sender) on success. Silently ignored if the user is not a member.

---

### `disconnect`

Emitted by Socket.io when the client connection closes (tab close, network drop, explicit `socket.disconnect()`). No payload.

**Server behaviour:** removes the socket from presence tracking; calls `markOffline` only when this was the user's last active socket (multi-tab guard).

---

## Server → Client

### `unread:counts`

Emitted automatically to the connecting socket immediately after authentication. Not broadcast to the room — personal to the connecting user.

**Payload:**
```json
{ "<roomId>": "<number>" }
```

Only rooms with a count greater than zero are included. An empty object means no unread messages.

---

### `message:new`

A new message was sent to a room this socket is joined to.

**Payload:**
```json
{
  "id": "<string>",
  "roomId": "<string>",
  "senderId": "<string>",
  "senderUsername": "<string>",
  "content": "<string>",
  "type": "text",
  "editedAt": "<ISO string | null>",
  "deletedAt": "<ISO string | null>",
  "createdAt": "<ISO string>"
}
```

---

### `message:edit`

A message in a room this socket is joined to was edited.

**Payload:** same shape as `message:new`; `editedAt` is set.

---

### `message:delete`

A message was soft-deleted.

**Payload:**
```json
{ "messageId": "<string>", "roomId": "<string>" }
```

The client should replace the message content with `[deleted]` using `messageId`.

---

### `message:reaction`

The reactions on a message were updated (emoji added or removed).

**Payload:**
```json
{
  "messageId": "<string>",
  "roomId": "<string>",
  "reactions": { "<emoji>": ["<userId>", "..."] }
}
```

The client should replace the full reactions map for the given `messageId` rather than applying a diff.

---

### `read:update`

A room member's read position was updated.

**Payload:**
```json
{ "userId": "<string>", "roomId": "<string>", "readAt": "<ISO string>" }
```

Broadcast to the whole room including the sender. The client uses this to render "seen by" indicators.

---

### `typing:update`

A user in a room started or stopped typing.

**Payload:**
```json
{
  "roomId": "<string>",
  "userId": "<string>",
  "username": "<string>",
  "typing": "<boolean>"
}
```

`typing: false` is broadcast immediately on `typing:stop`. If `typing:stop` is never sent (e.g., client crashes), the indicator clears after the 3-second Redis TTL — the client must handle this with a client-side timeout.

---

### `error`

An event handler encountered an error.

**Payload:**
```json
{ "code": "<string>" }
```

| Code | Meaning |
|---|---|
| `INVALID_CONTENT` | Empty or whitespace-only message content |
| `INVALID_EMOJI` | Missing or unsupported emoji in `message:react` |
| `NOT_MEMBER` | Sender is not a member of the target room |
| `MESSAGE_NOT_FOUND` | Target message does not exist |
| `EDIT_NOT_ALLOWED` | Message not found, already deleted, or outside 15-minute edit window |
| `DELETE_NOT_ALLOWED` | Message not found, already deleted, or not owned by sender |
| `UNVERIFIED` | Account is not email-verified; message sending is gated |
| `RATE_LIMITED` | Sender exceeded 30 messages per 60-second window |
| `INTERNAL_ERROR` | Unexpected server error |
