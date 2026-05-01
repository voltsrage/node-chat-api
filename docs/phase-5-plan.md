# Phase 5 — Message History and User Management

## What exists

From Phase 4:
- `Room` model with compound index `{ roomId: 1, createdAt: -1 }` on `Message`
- `roomsRouter` with `authenticate` applied globally — all sub-routes are protected
- `parsePaginationQuery` helper for offset pagination (rooms, members)
- `NotFoundError`, `ValidationError` available

## What needs to be built

Seven steps. The core concept is **cursor pagination**: the cursor is a point in time, not a row offset. New messages arriving between page requests do not shift the cursor, so page 2 always starts exactly where page 1 ended.

Also includes User Management — three simple endpoints needed before Phase 6 socket work begins.

---

## Step 1 — Message service

Fetch one extra document (`limit + 1`) to determine `hasMore` without a separate count query. If `docs.length > limit`, there are more; slice to `limit` before returning.

`nextCursor` is the `createdAt` timestamp of the **last** (oldest) item returned. The caller passes this back as `?before=<nextCursor>` to get the next page of older messages.

Deleted messages are not removed from the collection — they are soft-deleted. Return `'[deleted]'` as the content so the conversation thread stays intact for other users.

**`src/services/messageService.js`:**

```js
import { Message } from '../models/Message.js';
import { Room } from '../models/Room.js';
import { NotFoundError, ValidationError } from '../errors/AppError.js';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT     = 100;

export async function getMessageHistory(roomId, { before, limit } = {}) {
  const n = Math.min(Math.max(1, parseInt(limit) || DEFAULT_LIMIT), MAX_LIMIT);

  const roomExists = await Room.exists({ _id: roomId });
  if (!roomExists) throw new NotFoundError('Room not found.', 'ROOM_NOT_FOUND');

  const filter = { roomId };

  if (before) {
    const cursor = new Date(before);
    if (isNaN(cursor.getTime()))
      throw new ValidationError('before must be a valid ISO 8601 timestamp.');
    filter.createdAt = { $lt: cursor };
  }

  // Fetch n+1 to check hasMore without a separate count query
  const docs = await Message.find(filter)
    .sort({ createdAt: -1 })
    .limit(n + 1)
    .lean();

  const hasMore = docs.length > n;
  const items   = hasMore ? docs.slice(0, n) : docs;

  return {
    items:      items.map(toMessageResponse),
    nextCursor: hasMore ? items[items.length - 1].createdAt.toISOString() : null,
    hasMore,
  };
}

function toMessageResponse(msg) {
  return {
    id:             msg._id,
    roomId:         msg.roomId,
    senderId:       msg.senderId,
    senderUsername: msg.senderUsername,
    content:        msg.deletedAt ? '[deleted]' : msg.content,
    type:           msg.type,
    editedAt:       msg.editedAt  ?? null,
    deletedAt:      msg.deletedAt ?? null,
    createdAt:      msg.createdAt,
  };
}
```

---

## Step 2 — Message controller

The controller extracts `req.params.id` and `req.query`, calls the service, and sends the response. The cursor validation (`before` is a valid date) lives in the service because it is a domain concern — the service would reject an invalid cursor regardless of transport.

**`src/controllers/messageController.js`:**

```js
import * as messageService from '../services/messageService.js';
import { ApiResponse } from '../utils/ApiResponse.js';

export async function getMessageHistory(req, res) {
  const result = await messageService.getMessageHistory(req.params.id, req.query);
  res.json(ApiResponse.success(result));
}
```

---

## Step 3 — Message history route

Add to `src/routes/rooms.js`. The controller import and route registration are appended to the existing file — `roomsRouter.use(authenticate)` at the top already protects this route.

**`src/routes/rooms.js`** — append:

```js
import * as messageController from '../controllers/messageController.js';

/**
 * @openapi
 * /rooms/{id}/messages:
 *   get:
 *     summary: Paginated message history (cursor-based)
 *     tags: [Rooms]
 *     parameters:
 *       - { name: id,     in: path,  required: true, schema: { type: string } }
 *       - name: before
 *         in: query
 *         description: ISO 8601 timestamp — return messages older than this point
 *         schema: { type: string, format: date-time }
 *       - { name: limit, in: query, schema: { type: integer, default: 50, maximum: 100 } }
 *     responses:
 *       '200':
 *         description: Message page
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 items:      { type: array }
 *                 nextCursor: { type: string, nullable: true }
 *                 hasMore:    { type: boolean }
 *       '404': { description: Room not found }
 */
roomsRouter.get('/:id/messages', messageController.getMessageHistory);
```

---

## Step 4 — User service

`GET /users/me` returns the caller's own profile including email. `GET /users/:id` returns a public profile — no email.

**`src/services/userService.js`:**

```js
import { User } from '../models/User.js';
import { NotFoundError, ValidationError } from '../errors/AppError.js';

export async function getMyProfile(userId) {
  const user = await User.findById(userId).lean();
  if (!user) throw new NotFoundError('User not found.', 'USER_NOT_FOUND');
  return toOwnProfile(user);
}

export async function updateMyProfile(userId, { displayName, avatarUrl }) {
  const updates = {};
  if (displayName !== undefined) updates.displayName = displayName;
  if (avatarUrl   !== undefined) updates.avatarUrl   = avatarUrl;

  if (Object.keys(updates).length === 0)
    throw new ValidationError('No updatable fields provided.');

  const user = await User.findByIdAndUpdate(
    userId,
    { $set: updates },
    { new: true, runValidators: true }
  ).lean();
  if (!user) throw new NotFoundError('User not found.', 'USER_NOT_FOUND');

  return toOwnProfile(user);
}

export async function getUserById(userId) {
  const user = await User.findById(userId).lean();
  if (!user) throw new NotFoundError('User not found.', 'USER_NOT_FOUND');
  return toPublicProfile(user);
}

function toOwnProfile(user) {
  return {
    id:          user._id,
    username:    user.username,
    email:       user.email,
    displayName: user.displayName,
    avatarUrl:   user.avatarUrl,
    createdAt:   user.createdAt,
  };
}

function toPublicProfile(user) {
  return {
    id:          user._id,
    username:    user.username,
    displayName: user.displayName,
    avatarUrl:   user.avatarUrl,
    createdAt:   user.createdAt,
  };
}
```

---

## Step 5 — User controller

Input extraction and response shaping live here. The service receives only the data it needs — never `req` or `res`.

**`src/controllers/userController.js`:**

```js
import * as userService from '../services/userService.js';
import { ApiResponse } from '../utils/ApiResponse.js';

export async function getMe(req, res) {
  const user = await userService.getMyProfile(req.user.sub);
  res.json(ApiResponse.success(user));
}

export async function updateMe(req, res) {
  const { displayName, avatarUrl } = req.body;
  const user = await userService.updateMyProfile(req.user.sub, { displayName, avatarUrl });
  res.json(ApiResponse.success(user));
}

export async function getUserById(req, res) {
  const user = await userService.getUserById(req.params.id);
  res.json(ApiResponse.success(user));
}
```

---

## Step 6 — Users route

`GET /users/me` is registered before `GET /users/:id`. Express matches routes in registration order — if `:id` came first, it would capture the literal string `"me"` and the wrong handler would fire.

**`src/routes/users.js`:**

```js
import { Router } from 'express';
import { authenticate } from '../middleware/authenticate.js';
import * as userController from '../controllers/userController.js';

export const usersRouter = Router();
usersRouter.use(authenticate);

/**
 * @openapi
 * /users/me:
 *   get:
 *     summary: Get own profile
 *     tags: [Users]
 *     responses:
 *       '200': { description: Own profile including email }
 */
usersRouter.get('/me', userController.getMe);

/**
 * @openapi
 * /users/me:
 *   put:
 *     summary: Update display name or avatar URL
 *     tags: [Users]
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               displayName: { type: string }
 *               avatarUrl:   { type: string }
 *     responses:
 *       '200': { description: Updated profile }
 *       '422': { description: No updatable fields provided }
 */
usersRouter.put('/me', userController.updateMe);

/**
 * @openapi
 * /users/{id}:
 *   get:
 *     summary: Get another user's public profile
 *     tags: [Users]
 *     parameters:
 *       - { name: id, in: path, required: true, schema: { type: string } }
 *     responses:
 *       '200': { description: Public profile — no email }
 *       '404': { description: User not found }
 */
usersRouter.get('/:id', userController.getUserById);
```

**`src/app.js`** — add after the rooms router:

```js
import { usersRouter } from './routes/users.js';

app.use('/api/v1/users', usersRouter);
```

---

## Step 7 — `.explain()` verification and cursor pagination demonstration

**`.explain()` in `mongosh`** — replace the ObjectId with a real room ID:

```js
db.messages
  .find(
    { roomId: ObjectId("PASTE_ROOM_ID_HERE"), createdAt: { $lt: new Date() } },
    { _id: 1, content: 1, senderUsername: 1, createdAt: 1 }
  )
  .sort({ createdAt: -1 })
  .limit(51)   // limit + 1 as the service uses
  .explain("executionStats")
```

| Field | Expected |
|---|---|
| `winningPlan.inputStage.indexName` | `roomId_1_createdAt_-1` |
| `executionStats.totalDocsExamined` | Equal to `nReturned` |
| `executionStats.executionStages.stage` | `FETCH` (not `COLLSCAN`) |

**Why cursor pagination prevents duplicates:**

```
Cursor pagination:
  Page 1: messages T=10, T=9, T=8, T=7, T=6  → nextCursor = T=6
  [new message T=11 arrives]
  Page 2: ?before=T6 → T=5, T=4, T=3, T=2, T=1  ← no overlap

Offset pagination:
  Page 1: skip=0 → T=10, T=9, T=8, T=7, T=6
  [new message T=11 arrives]
  Page 2: skip=5 → collection is now T=11,T=10,T=9,T=8,T=7,T=6,T=5...
          skip=5 lands on T=6 — already seen on page 1  ← duplicate
```

The cursor anchors to a specific timestamp. A new message at a newer timestamp does not shift what is before or after it.

---

## Verification

**1. Message history — first page:**

```bash
TOKEN="<access-token>"
ROOM_ID="<room-id>"

curl -s "http://localhost:3000/api/v1/rooms/$ROOM_ID/messages?limit=10" \
  -H "Authorization: Bearer $TOKEN"
# Expected: { data: { items: [...], nextCursor: "<ISO string>", hasMore: true/false } }
```

**2. Paginate with cursor — no overlap:**

```bash
CURSOR="<nextCursor from above>"

curl -s "http://localhost:3000/api/v1/rooms/$ROOM_ID/messages?before=$CURSOR&limit=10" \
  -H "Authorization: Bearer $TOKEN"
# Expected: items all older than the cursor; no item from page 1 repeated
```

**3. Final page:**

```bash
# Keep paginating — final response:
# { data: { items: [...], nextCursor: null, hasMore: false } }
```

**4. Invalid cursor returns 422:**

```bash
curl -s "http://localhost:3000/api/v1/rooms/$ROOM_ID/messages?before=not-a-date" \
  -H "Authorization: Bearer $TOKEN"
# Expected: 422 { error: { code: "VALIDATION_ERROR" } }
```

**5. Own profile includes email; public profile does not:**

```bash
curl -s http://localhost:3000/api/v1/users/me \
  -H "Authorization: Bearer $TOKEN"
# Expected: profile with email field

curl -s http://localhost:3000/api/v1/users/<other-user-id> \
  -H "Authorization: Bearer $TOKEN"
# Expected: profile WITHOUT email field
```

**6. Update profile:**

```bash
curl -s -X PUT http://localhost:3000/api/v1/users/me \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"displayName":"Alice Smith"}'
# Expected: 200 with updated displayName
```

---

## File map

| File | Status |
|---|---|
| `src/services/messageService.js` | New — `getMessageHistory` with cursor pagination and soft-delete handling |
| `src/controllers/messageController.js` | New — extracts params, calls service, sends response |
| `src/routes/rooms.js` | Updated — append import + `GET /:id/messages` mapped to controller |
| `src/services/userService.js` | New — `getMyProfile`, `updateMyProfile`, `getUserById` |
| `src/controllers/userController.js` | New — `getMe`, `updateMe`, `getUserById`; no `req`/`res` passed to service |
| `src/routes/users.js` | New — thin: `authenticate` + Swagger JSDoc + `/me` registered before `/:id` |
| `src/app.js` | Updated — mount `usersRouter` at `/api/v1/users` |

---

## Checklist

- [ ] Step 1 — `getMessageHistory` defaults to limit 50, clamps to max 100
- [ ] Step 1 — First-page request (no `before`) returns newest messages
- [ ] Step 1 — Invalid `before` value throws `ValidationError`
- [ ] Step 1 — Fetches `limit + 1`; `hasMore` is `true` if result exceeds `limit`
- [ ] Step 1 — `nextCursor` is the `createdAt` of the last (oldest) item; `null` on final page
- [ ] Step 1 — Deleted messages return `'[deleted]'` as content
- [ ] Step 1 — Query uses `.lean()`
- [ ] Step 2 — `messageController` imports only from service and `ApiResponse`; no validation logic
- [ ] Step 3 — Route appended to `roomsRouter`; no inline handler; protected by existing `authenticate`
- [ ] Step 4 — `updateMyProfile` only sets fields present in the call arguments (no `undefined` overwrite)
- [ ] Step 4 — `toOwnProfile` includes email; `toPublicProfile` does not
- [ ] Step 5 — `userController` functions never receive `req` or `res` — only extracted values are passed to service
- [ ] Step 6 — `usersRouter.get('/me', ...)` registered before `usersRouter.get('/:id', ...)`
- [ ] Step 6 — route file imports only from controller and `authenticate`; no inline handlers
- [ ] Step 7 — `.explain()` confirms `roomId_1_createdAt_-1` index; `totalDocsExamined` equals `nReturned`
- [ ] Verification — sequential cursor pages return no overlapping messages
- [ ] Verification — final page: `hasMore: false`, `nextCursor: null`
- [ ] Verification — `GET /users/<id>` response has no `email` field
