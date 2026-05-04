# TeamChatAPI — Constraints Gap Analysis

Comparison of [system-design-constraints.md](./system-design-constraints.md) against the current implementation.
Last updated: 2026-05-05.

---

## Summary Scorecard

| Area | Status |
|---|---|
| Auth security (bcrypt, JWT, lockout) | Strong |
| Core trade-off decisions | Strong |
| Message data limits (length, page size) | Missing |
| Room membership / size caps | Missing |
| User field validation | Partial |
| Rate limiting coverage | Partial (auth only) |
| Input sanitization | Missing |
| Soft-delete field name + purge job | Bugged / Incomplete |
| Room list pagination strategy | Violates constraint |

---

## Well-Matched Areas

### Security

| Constraint | Doc | Code | Location |
|---|---|---|---|
| bcrypt cost factor | 12 | `BCRYPT_ROUNDS = 12` | `authService.js:15` |
| Access token TTL | 15 min | `ACCESS_TTL_SEC = 15 * 60` | `tokens.js:5` |
| Refresh token TTL | 7 days | `REFRESH_TTL_SEC = 7 * 24 * 3600` | `tokens.js:6` |
| Refresh token storage | Redis, revocable | `redis.set('refresh:{userId}:{jti}', ...)` | `tokens.js:22` |
| Account lockout | 5 attempts / 15 min | Lockout check before bcrypt compare | `authService.js:119–148` |
| Room access enforcement | Members only | `Room.exists({ _id: roomId, memberIds: senderId })` | `messageService.js:40` |

### Key Trade-off Decisions

All five design decisions from the constraints doc are implemented:

1. **`memberIds` array on Room** — kept as an array with `{memberIds: 1}` index (`Room.js:16`)
2. **`senderUsername` denormalized on Message** — avoids populate on bulk reads (`Message.js:7`)
3. **Cursor-based pagination on message history** — `before` ISO timestamp cursor (`messageService.js:16–19`)
4. **Soft delete** — `deletedAt` field used in service queries (`messageService.js:65, 83`) — see bug below
5. **15-minute edit window** — enforced at service layer (`messageService.js:59`)

### Auth Rate Limiting

Login, register, and forgot-password share a single `authRateLimiter`: 10 requests per 15-minute fixed window per IP — matches the constraint exactly (`rateLimiter.js:43–47`, `auth.js:32, 55, 145`).

---

## Gaps — Missing Constraints

### Message Data Constraints

| Constraint | Doc | Code | Gap |
|---|---|---|---|
| Max content length | 4,000 chars | No validation | Not enforced at schema or service layer |
| Max messages per page | 50 | `MAX_LIMIT = 100` (`messageService.js:6`) | Allows double the documented cap |
| Soft-delete purge | 30-day hard delete | No job exists | `presenceEvictionJob.js` is the only background job; no message purge |

### Room Constraints

None of the room-level caps are enforced.

| Constraint | Doc | Gap |
|---|---|---|
| Max members per room | 500 | `joinRoom` calls `$addToSet` unconditionally — no cap check (`roomService.js:49`) |
| Max rooms per user | 100 | No check in `createRoom` |
| Max room name length | 80 chars | No `maxlength` in schema or controller |
| Max room description length | 500 chars | No `maxlength` in schema or controller |

### User Constraints

| Constraint | Doc | Code | Gap |
|---|---|---|---|
| Username format | 3–32 chars, `[a-zA-Z0-9_]` | Presence check only (`authController.js:8`) | No length or character validation |
| Display name length | 1–64 chars | Not validated | |
| Avatar upload size | 2 MB max, JPEG/PNG/WebP | No upload endpoint exists | Feature not yet built |
| Concurrent sessions | 5 max | `issueRefreshToken` issues without counting existing tokens | No session cap |

Password minimum length (8 chars) is the one user constraint correctly enforced — at registration (`authController.js:10`) and password reset (`authService.js:233`).

### Rate Limits

Only auth endpoints are rate-limited. Every other constraint from the table is missing.

| Endpoint | Doc | Code |
|---|---|---|
| `message:send` (WebSocket) | 60 msg/min | 30 msg/min sliding window (`socket/rateLimiter.js:3–4`) |
| POST /rooms | 10 rooms/hour | No limiter |
| GET /rooms/:id/messages | 120 req/min | No limiter |
| PATCH /messages/:id | 30 req/min | No limiter |
| DELETE /messages/:id | 30 req/min | No limiter |
| File/avatar upload | 20 uploads/hour | No upload feature |

### Input Sanitization

The constraint requires all user content to be HTML-escaped before storage. The code only calls `.trim()` on message content (`messageService.js:51`). No HTML escaping is applied anywhere in the pipeline — messages with `<script>` or other HTML are stored and returned as-is.

### Room List Pagination

The constraint says cursor-based pagination only, no `skip` beyond page 3. Message history correctly uses a `createdAt` cursor. Room listing uses offset pagination:

```js
// roomService.js:26 — uses the prohibited skip pattern
Room.find({}).sort({createdAt: -1}).skip(skip).limit(pageSize)
```

At large room counts this degrades to a full collection scan before returning results.

---

## Active Bugs That Conflict with the Design

### 1. Soft-delete field name mismatch

The Message schema defines the field as `deleteAt`:

```js
// models/Message.js:11
deleteAt: {type: Date, default: null}
```

Every service query filters on `deletedAt` (with a `d`):

```js
// messageService.js:65 — edit guard
deletedAt: null,

// messageService.js:83 — delete guard
{ _id: messageId, senderId: userId, deletedAt: null }

// messageService.js:85 — soft-delete write
{ $set: { deletedAt: new Date() } }
```

Because the queried field does not exist in the schema, the `deletedAt: null` filter always matches (MongoDB returns `null` for any missing field), and the `$set: { deletedAt }` write creates a shadow field that Mongoose ignores on future reads. Practically: deleted messages are never filtered out, and the edit guard never blocks editing a deleted message.

**Fix:** Rename `deleteAt` to `deletedAt` in `Message.js`.

### 2. `findOneAndReplace` used instead of `findOneAndUpdate` in `editMessage`

```js
// messageService.js:61
const message = await Message.findOneAndReplace(
    { _id: messageId, senderId: userId, deletedAt: null, createdAt: { $gte: windowStart } },
    { $set: { content: content.trim(), editedAt: new Date() } },
    { new: true }
);
```

`findOneAndReplace` replaces the entire matched document with its second argument verbatim — it does not interpret `$set` as an update operator. A successful edit would replace the message document with the literal object `{ $set: { content, editedAt } }`, destroying `roomId`, `senderId`, `senderUsername`, `type`, and `createdAt`.

**Fix:** Change `findOneAndReplace` to `findOneAndUpdate`.

---

## Implementation Checklist

Items needed to bring the application into full compliance with the constraints doc.

### Bugs (fix first)
- [ ] Rename `deleteAt` → `deletedAt` in `models/Message.js`
- [ ] Change `findOneAndReplace` → `findOneAndUpdate` in `messageService.editMessage`

### Validation
- [ ] Enforce 4,000-char max on message content (schema `maxlength` or service check)
- [ ] Lower `MAX_LIMIT` from 100 → 50 in `messageService.js`
- [ ] Enforce 500-member cap in `roomService.joinRoom` before `$addToSet`
- [ ] Enforce 100-rooms-per-user cap in `roomService.createRoom`
- [ ] Add `maxlength: 80` to `Room.name` schema field
- [ ] Add `maxlength: 500` to `Room.description` schema field
- [ ] Add username validation: 3–32 chars, `/^[a-zA-Z0-9_]+$/`
- [ ] Add display name length validation: 1–64 chars
- [ ] Add 5-session cap to `issueRefreshToken`

### Rate Limiting
- [ ] Increase socket message limit from 30/min → 60/min
- [ ] Add 10 rooms/hour limiter to `POST /rooms`
- [ ] Add 120 req/min limiter to `GET /rooms/:id/messages`
- [ ] Add 30 req/min limiter to `PATCH /messages/:id`
- [ ] Add 30 req/min limiter to `DELETE /messages/:id`

### Security
- [ ] Add HTML escaping to all user-supplied content before storage

### Pagination
- [ ] Replace skip-based room listing with a cursor-based approach (`createdAt < cursor`)

### Background Jobs
- [ ] Add a message purge job: hard-delete messages where `deletedAt < now - 30 days`

### Features Not Yet Built
- [ ] Avatar upload endpoint (2 MB max, JPEG/PNG/WebP, 20 uploads/hour rate limit)
