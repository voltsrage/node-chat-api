# Phase 19 — Private Rooms and Invitations

## What exists

From Phase 18:
- `src/models/Room.js` — Room schema without an `isPrivate` field
- `src/services/roomService.js` — `createRoom`, `listRooms`, `getRoomById`, `joinRoom`, `leaveRoom`, `listMembers`; `toRoomResponse` does not include `isPrivate`
- `src/routes/rooms.js` — six routes, all protected by `authenticate` + `requireVerified`
- `src/middleware/requireVerified.js` — checks `req.user.verified`

## What needs to be built

Five steps. Two access control layers that must both be correct:

1. **List filtering** — `GET /rooms` must hide private rooms from non-members
2. **Per-room gating** — every `GET /rooms/:id`, `/messages`, `/members`, `/presence` must 403 non-members on private rooms

A common mistake is implementing only the list filter. An attacker who knows (or guesses) a private room ID can still call `GET /rooms/:id` directly and read the room — the list never hid it from a direct lookup. Both layers are required.

---

## Step 1 — Room schema + updated toRoomResponse

**`src/models/Room.js`** — add one field:

```js
isPrivate: { type: Boolean, default: false },
```

**`src/services/roomService.js`** — add `isPrivate` to `toRoomResponse` and `createRoom`:

```js
function toRoomResponse(room) {
  return {
    id:          room._id,
    name:        room.name,
    description: room.description,
    createdBy:   room.createdBy,
    memberCount: room.memberIds.length,
    isPrivate:   room.isPrivate ?? false,
    createdAt:   room.createdAt,
  };
}

export async function createRoom(userId, { name, description, isPrivate }) {
  const room = await Room.create({
    name,
    description: description ?? null,
    isPrivate:   isPrivate  ?? false,
    createdBy:   userId,
    memberIds:   [userId],
  });
  return toRoomResponse(room);
}
```

The response now includes `isPrivate` so clients can display a lock icon and know whether to show invite options.

---

## Step 2 — requireMember middleware

This middleware fires on every `/:id` sub-route. It performs a single `Room.exists` query that short-circuits to 403 only when the room is private AND the requesting user is not in `memberIds`. Public rooms and non-existent rooms pass through — the handler deals with them.

**`src/middleware/requireMember.js`:**

```js
import mongoose from 'mongoose';
import { Room }          from '../models/Room.js';
import { ForbiddenError } from '../errors/AppError.js';

export async function requireMember(req, _res, next) {
  // Skip the check for invalid ObjectIds — the handler will return 400/404
  if (!mongoose.Types.ObjectId.isValid(req.params.id)) return next();

  // A single indexed query:
  //   - Returns null  → room doesn't exist, room is public, OR user IS a member
  //   - Returns doc   → room is private AND user is NOT a member
  const privateNonMember = await Room.exists({
    _id:       req.params.id,
    isPrivate: true,
    memberIds: { $ne: req.user.sub },
  });

  if (privateNonMember) {
    throw new ForbiddenError(
      'This room is private. An invitation is required.',
      'NOT_MEMBER'
    );
  }

  next();
}
```

**Why this query shape is correct:**

`Room.exists({ isPrivate: true, memberIds: { $ne: userId } })` only matches when the room is private AND the userId is absent from `memberIds`. Four cases:

| Room state | User state | Result |
|---|---|---|
| Public | Non-member | `null` → passes through |
| Public | Member | `null` → passes through |
| Private | Member | `null` → passes through |
| Private | Non-member | doc → 403 |
| Does not exist | — | `null` → passes through (handler returns 404) |

**Side effect:** `POST /:id/join` on a private room returns 403 for non-members. This is the correct behavior — private rooms are only joinable via invite token. The regular join route becomes the public-room join endpoint implicitly.

---

## Step 3 — Room service: listRooms, createInvite, joinViaInvite

**Update `listRooms`** to accept `userId` and filter private rooms:

```js
export async function listRooms({ page, pageSize, skip }, userId) {
  // Public rooms: visible to everyone
  // Private rooms: visible only to members
  const filter = {
    $or: [
      { isPrivate: { $ne: true } },
      { isPrivate: true, memberIds: userId },
    ],
  };

  const [rooms, total] = await Promise.all([
    Room.find(filter).sort({ createdAt: -1 }).skip(skip).limit(pageSize).lean(),
    Room.countDocuments(filter),
  ]);

  return paginatedResponse(rooms.map(toRoomResponse), total, page, pageSize);
}
```

**Add `createInvite`:**

```js
import { randomBytes } from 'crypto';

const INVITE_TTL = 48 * 60 * 60; // 48 hours in seconds

export async function createInvite(roomId, userId) {
  // Verify room exists and caller is a member — only members can invite others
  const isMember = await Room.exists({ _id: roomId, memberIds: userId });
  if (!isMember) {
    // Don't distinguish "room not found" from "not a member" —
    // both return 403 to avoid leaking whether a private room exists
    throw new ForbiddenError('Room not found or you are not a member.', 'NOT_MEMBER');
  }

  const token = randomBytes(32).toString('hex');

  // Store as JSON — need both roomId and who created the invite for audit purposes
  await redis.set(
    `invite:${token}`,
    JSON.stringify({ roomId, createdBy: userId }),
    'EX',
    INVITE_TTL
  );

  return {
    token,
    inviteUrl: `${process.env.APP_URL}/api/v1/rooms/join-invite?token=${token}`,
    expiresIn: '48 hours',
  };
}
```

**Add `joinViaInvite`:**

```js
export async function joinViaInvite(token, userId) {
  if (!token) throw new ValidationError('Invite token is required.', 'MISSING_TOKEN');

  // Atomic read-and-delete — same pattern as email verification and password reset
  // Only one request can consume the token even under concurrent access
  const raw = await redis.getdel(`invite:${token}`);
  if (!raw) {
    throw new ValidationError('Invalid or expired invite token.', 'INVALID_TOKEN');
  }

  const { roomId } = JSON.parse(raw);

  const room = await Room.findByIdAndUpdate(
    roomId,
    { $addToSet: { memberIds: userId } },
    { new: true }
  );
  if (!room) throw new NotFoundError('Room no longer exists.', 'ROOM_NOT_FOUND');

  // Invalidate the room cache — member count changed
  await redis.del(cacheKey(roomId));

  return toRoomResponse(room);
}
```

**Why `createInvite` returns 403 for both "not found" and "not a member":**

If the endpoint returned 404 for non-existent rooms, an attacker could probe private room IDs by calling `POST /rooms/:id/invite`. A 403 for both cases reveals only that the caller cannot perform this action — not whether the room exists.

---

## Step 4 — Controller and routes

**`src/controllers/roomController.js`** — update `createRoom`, `listRooms`; add `createInvite`, `joinViaInvite`:

```js
export async function createRoom(req, res) {
  const { name, description, isPrivate } = req.body;
  if (!name) throw new ValidationError('name is required.');

  const room = await roomService.createRoom(req.user.sub, { name, description, isPrivate });
  res.status(201).json(ApiResponse.created(room));
}

export async function listRooms(req, res) {
  const pagination = parsePaginationQuery(req.query);
  // Pass userId so private rooms are filtered correctly
  const result = await roomService.listRooms(pagination, req.user.sub);
  res.json(ApiResponse.success(result));
}

export async function createInvite(req, res) {
  const invite = await roomService.createInvite(req.params.id, req.user.sub);
  res.json(ApiResponse.success(invite));
}

export async function joinViaInvite(req, res) {
  const room = await roomService.joinViaInvite(req.query.token, req.user.sub);
  res.json(ApiResponse.success(room));
}
```

**`src/routes/rooms.js`** — add the two new routes and apply `requireMember`:

```js
import { requireMember }   from '../middleware/requireMember.js';
import { requireVerified } from '../middleware/requireVerified.js';

export const roomsRouter = Router();
roomsRouter.use(authenticate);

// ── Routes without an :id param ───────────────────────────────────────────────
roomsRouter.post('/',            requireVerified, roomController.createRoom);
roomsRouter.get('/',                              roomController.listRooms);

// POST /join-invite must be registered BEFORE /:id routes.
// Without this ordering, Express captures 'join-invite' as the :id parameter.
roomsRouter.post('/join-invite', requireVerified, roomController.joinViaInvite);

// ── Routes with an :id param ─────────────────────────────────────────────────
// requireMember fires before every /:id handler.
// It is a no-op for public rooms and passes non-members to 403 on private rooms.
roomsRouter.get('/:id',          requireMember, roomController.getRoomById);
roomsRouter.post('/:id/join',    requireMember, requireVerified, roomController.joinRoom);
roomsRouter.post('/:id/leave',   requireMember, roomController.leaveRoom);
roomsRouter.get('/:id/members',  requireMember, roomController.listMembers);
roomsRouter.get('/:id/messages', requireMember, messageController.getMessageHistory);
roomsRouter.get('/:id/presence', requireMember, presenceController.getRoomPresence);

// Only members can create invites — requireMember enforces this
roomsRouter.post('/:id/invite',  requireMember, requireVerified, roomController.createInvite);
```

**`/join-invite` before `/:id` — why route order matters here:**

Express matches routes top-to-bottom. If `/:id` were registered first, a request to `/rooms/join-invite` would match with `req.params.id === 'join-invite'`, reach `requireMember`, fail the ObjectId validity check (since "join-invite" is not a valid ObjectId), and pass through to `getRoomById` — which would then fail trying to query MongoDB with an invalid ID. Registering the literal path first prevents the collision entirely.

---

## Verification

**1. Private room hidden from list for non-members:**

```bash
# Alice creates a private room
ROOM=$(curl -s -X POST http://localhost:3000/api/v1/rooms \
  -H "Authorization: Bearer $ALICE_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"name":"secret-room","isPrivate":true}' | jq -r '.data.id')

# Bob lists rooms — should NOT see secret-room
curl -s http://localhost:3000/api/v1/rooms \
  -H "Authorization: Bearer $BOB_TOKEN" | jq '.data.items[].name'
# Expected: no "secret-room" in the list
```

**2. Direct GET on private room blocked for non-members:**

```bash
curl -s "http://localhost:3000/api/v1/rooms/$ROOM" \
  -H "Authorization: Bearer $BOB_TOKEN"
# Expected: 403 { error: { code: "NOT_MEMBER" } }
# — confirms the list filter alone is not sufficient
```

**3. Invite creation and single-use consumption:**

```bash
# Alice creates an invite
INVITE=$(curl -s -X POST "http://localhost:3000/api/v1/rooms/$ROOM/invite" \
  -H "Authorization: Bearer $ALICE_TOKEN" | jq -r '.data.token')

redis-cli TTL "invite:$INVITE"
# Expected: ~172800 (48 hours)

# Bob joins via invite
curl -s -X POST "http://localhost:3000/api/v1/rooms/join-invite?token=$INVITE" \
  -H "Authorization: Bearer $BOB_TOKEN"
# Expected: 200 with room object; Bob is now a member

redis-cli GET "invite:$INVITE"
# Expected: (nil) — consumed by GETDEL

# Carol tries to use the same token — single-use
curl -s -X POST "http://localhost:3000/api/v1/rooms/join-invite?token=$INVITE" \
  -H "Authorization: Bearer $CAROL_TOKEN"
# Expected: 422 INVALID_TOKEN
```

**4. Bob can now access the private room:**

```bash
curl -s "http://localhost:3000/api/v1/rooms/$ROOM" \
  -H "Authorization: Bearer $BOB_TOKEN"
# Expected: 200 with room details — Bob is now a member

curl -s "http://localhost:3000/api/v1/rooms/$ROOM/messages" \
  -H "Authorization: Bearer $BOB_TOKEN"
# Expected: 200 with message history
```

**5. Regular join blocked for private rooms:**

```bash
# Carol tries to join a private room without an invite
curl -s -X POST "http://localhost:3000/api/v1/rooms/$ROOM/join" \
  -H "Authorization: Bearer $CAROL_TOKEN"
# Expected: 403 NOT_MEMBER — requireMember fires before joinRoom handler
```

**6. Private room appears in Alice's list but not in Carol's:**

```bash
# Alice (member):
curl -s http://localhost:3000/api/v1/rooms \
  -H "Authorization: Bearer $ALICE_TOKEN" | jq '.data.items[].name'
# Expected: "secret-room" is present

# Carol (non-member):
curl -s http://localhost:3000/api/v1/rooms \
  -H "Authorization: Bearer $CAROL_TOKEN" | jq '.data.items[].name'
# Expected: "secret-room" is absent
```

**7. Confirm Redis invite key TTL:**

```bash
# Create a new invite and immediately check
INVITE2=$(curl -s -X POST "http://localhost:3000/api/v1/rooms/$ROOM/invite" \
  -H "Authorization: Bearer $ALICE_TOKEN" | jq -r '.data.token')

redis-cli TTL "invite:$INVITE2"
# Expected: 172800 (exactly 48 hours at creation)
```

---

## File map

| File | Status |
|---|---|
| `src/models/Room.js` | Updated — add `isPrivate: Boolean, default: false` |
| `src/services/roomService.js` | Updated — `toRoomResponse` includes `isPrivate`; `createRoom` accepts `isPrivate`; `listRooms` accepts `userId` and filters; add `createInvite`, `joinViaInvite` |
| `src/middleware/requireMember.js` | New — single `Room.exists` query; 403 for private non-members; passes through for public rooms and non-existent rooms |
| `src/controllers/roomController.js` | Updated — `createRoom` and `listRooms` updated; add `createInvite`, `joinViaInvite` |
| `src/routes/rooms.js` | Updated — `POST /join-invite` before `/:id` routes; `requireMember` on all `/:id` routes |

---

## Checklist

- [ ] Step 1 — `isPrivate: false` default added to Room schema
- [ ] Step 1 — `toRoomResponse` includes `isPrivate` — clients can render lock icons
- [ ] Step 1 — `createRoom` accepts `isPrivate` from request body
- [ ] Step 2 — `requireMember` uses `Room.exists` with compound query — one round-trip
- [ ] Step 2 — `Room.exists` condition: `isPrivate: true` AND `memberIds: { $ne: userId }` — can trace all five cases in the table
- [ ] Step 2 — Invalid ObjectId skips the check (`mongoose.Types.ObjectId.isValid`)
- [ ] Step 2 — Non-existent rooms return `null` from `Room.exists` and pass through to the handler (which returns 404)
- [ ] Step 3 — `listRooms` filter uses `$or` — public rooms OR private rooms where user is a member
- [ ] Step 3 — `createInvite` stores `{ roomId, createdBy }` as JSON with 48-hour TTL
- [ ] Step 3 — `createInvite` returns same 403 for "room not found" and "not a member" — no room existence leakage
- [ ] Step 3 — `joinViaInvite` uses `redis.getdel` — atomic single-use enforcement
- [ ] Step 4 — `POST /join-invite` registered before any `/:id` route — can explain why order matters
- [ ] Step 4 — `requireMember` applied to all six `/:id` routes
- [ ] Verification — Non-member `GET /rooms/:id` on a private room returns 403 (not 404)
- [ ] Verification — Same invite token used twice: second attempt returns 422
- [ ] Verification — `POST /rooms/:id/join` on a private room returns 403 (not 200)
- [ ] Verification — Private room appears in member's list; absent from non-member's list
- [ ] Knowledge check — Can explain why filtering the list alone is insufficient (direct GET bypass)
- [ ] Knowledge check — Can explain why `createInvite` returns the same error for "not found" and "not a member"
- [ ] Knowledge check — Can explain why `/join-invite` must be registered before `/:id`
