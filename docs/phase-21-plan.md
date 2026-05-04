# Phase 21 — Room Roles / RBAC

## What exists

From Phase 20:
- `src/models/Room.js` — Room schema with `memberIds: [ObjectId]`, `type`, `dmKey`, `isPrivate`
- `src/middleware/requireMember.js` — queries `memberIds: { $ne: userId }` for private room gating
- `src/services/roomService.js` — all member operations use `memberIds`; `createRoom`, `joinRoom`, `leaveRoom`, `listMembers`, `createInvite`, `joinViaInvite`
- `src/services/unreadService.js` — `incrementUnread` reads `room.memberIds`
- `src/socket/index.js` — `Room.find({ memberIds: userId })` on connect

## What needs to be built

Five steps. The core change is migrating `memberIds: [ObjectId]` to `members: [{ userId, role, joinedAt }]`. This one schema change enables all role-gated operations.

Three roles in descending authority: `owner > admin > member`.

Two concepts worth understanding before writing code:

**Why in-document roles and not a separate collection:** Roles are always read with the room (to check membership and authority). A separate `RoomMemberships` collection would require a join on every room access. Embedding keeps it one query. The member array is bounded — a room can have thousands of members, but the per-member record is tiny (ObjectId + 6-char string + timestamp = ~50 bytes).

**Why the `$elemMatch` projection matters:** A room with 1,000 members has a 50 KB `members` array. When checking one user's role, projecting `{ members: { $elemMatch: { userId } } }` returns only that user's sub-document. Without the projection, Mongoose deserialises all 1,000 entries.

---

## Step 1 — Schema migration: memberIds → members

**`src/models/Room.js`** — replace `memberIds` with `members`:

```js
const memberSchema = new mongoose.Schema({
  userId:   { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  role:     { type: String, enum: ['owner', 'admin', 'member'], default: 'member' },
  joinedAt: { type: Date, default: Date.now },
}, { _id: false });

const roomSchema = new mongoose.Schema({
  name:        { type: String, trim: true, sparse: true },
  description: { type: String, default: null },
  type:        { type: String, enum: ['group', 'dm'], default: 'group' },
  dmKey:       { type: String, unique: true, sparse: true },
  isPrivate:   { type: Boolean, default: false },
  createdBy:   { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  members:     [memberSchema],
}, { timestamps: true });

// Primary membership lookup — used by requireMember, listRooms, socket connect
roomSchema.index({ 'members.userId': 1 });
```

**Why `_id: false` on memberSchema:**

Sub-documents in arrays get an auto-generated `_id` by default. Member entries are not independently addressable — they live inside Room and are always accessed through the parent document. Suppressing `_id` eliminates 12 bytes per entry and removes noise from update operators.

**ROLE_RANK constant — export alongside the model:**

```js
export const ROLE_RANK = { owner: 3, admin: 2, member: 1 };
```

Exporting it from the model file means `requireRoomRole` and `setMemberRole` both import from one source of truth.

---

## Step 2 — Update all memberIds references

Every file that reads or writes `memberIds` must be updated. The query translation rules:

| Old (`memberIds`) | New (`members`) |
|---|---|
| `memberIds: userId` | `'members.userId': userId` |
| `memberIds: { $ne: userId }` | `members: { $not: { $elemMatch: { userId } } }` |
| `$addToSet: { memberIds: userId }` | `$push: { members: { userId, role: 'member' } }` |
| `$pull: { memberIds: userId }` | `$pull: { members: { userId } }` (or `room.members.filter(...)` + save) |
| `room.memberIds.length` | `room.members.length` |
| `room.memberIds.filter(...)` | `room.members.map(m => m.userId).filter(...)` |

**`src/middleware/requireMember.js`** — update the compound query:

```js
// Before:
// memberIds: { $ne: req.user.sub }

// After:
const privateNonMember = await Room.exists({
  _id:      req.params.id,
  isPrivate: true,
  members:  { $not: { $elemMatch: { userId: req.user.sub } } },
});
```

**Why `$not: $elemMatch` and not `'members.userId': { $ne: userId }`:**

`{ 'members.userId': { $ne: userId } }` matches documents where *at least one* member has a different userId — it returns true even when the user IS a member (as long as anyone else is also a member). `$not: { $elemMatch: { userId } }` correctly means "no member sub-document has this userId".

**`src/services/roomService.js`** — update all six functions:

```js
function toRoomResponse(room) {
  return {
    id:          room._id,
    name:        room.name,
    description: room.description,
    createdBy:   room.createdBy,
    memberCount: room.members.length,   // was memberIds.length
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
    members:     [{ userId, role: 'owner' }],   // creator is always owner
  });
  return toRoomResponse(room);
}

export async function listRooms({ page, pageSize, skip }, userId) {
  const filter = {
    type: { $ne: 'dm' },
    $or: [
      { isPrivate: { $ne: true } },
      { isPrivate: true, 'members.userId': userId },
    ],
  };

  const [rooms, total] = await Promise.all([
    Room.find(filter).sort({ createdAt: -1 }).skip(skip).limit(pageSize).lean(),
    Room.countDocuments(filter),
  ]);

  return paginatedResponse(rooms.map(toRoomResponse), total, page, pageSize);
}

export async function joinRoom(roomId, userId) {
  // $not: $elemMatch guards against double-join
  const room = await Room.findOneAndUpdate(
    {
      _id:      roomId,
      type:     { $ne: 'dm' },
      isPrivate: false,
      members:  { $not: { $elemMatch: { userId } } },
    },
    { $push: { members: { userId, role: 'member' } } },
    { new: true }
  );

  if (!room) {
    const exists = await Room.findById(roomId).lean();
    if (!exists)         throw new NotFoundError('Room not found.', 'ROOM_NOT_FOUND');
    if (exists.isPrivate) throw new ForbiddenError('Room is private.', 'NOT_MEMBER');
    // Already a member — idempotent
    return toRoomResponse(exists);
  }
  return toRoomResponse(room.toObject());
}

export async function leaveRoom(roomId, userId) {
  const room = await Room.findById(roomId);
  if (!room) throw new NotFoundError('Room not found.', 'ROOM_NOT_FOUND');

  const member = room.members.find(m => m.userId.toString() === userId);
  if (!member) throw new ForbiddenError('You are not a member.', 'NOT_MEMBER');

  if (member.role === 'owner') {
    // Must transfer ownership before leaving — pick oldest admin, then oldest member
    const heir =
      room.members.find(m => m.role === 'admin' && m.userId.toString() !== userId) ??
      room.members.find(m => m.userId.toString() !== userId);

    if (heir) {
      heir.role = 'owner';
    } else {
      // Owner is the last member — delete the room entirely
      await Room.deleteOne({ _id: roomId });
      await redis.del(cacheKey(roomId));
      await clearUnread(userId, roomId);
      return null;
    }
  }

  room.members = room.members.filter(m => m.userId.toString() !== userId);
  await room.save();
  await redis.del(cacheKey(roomId));
  await clearUnread(userId, roomId);

  return toRoomResponse(room.toObject());
}

export async function listMembers(roomId) {
  const room = await Room.findById(roomId)
    .populate('members.userId', 'username email')
    .lean();
  if (!room) throw new NotFoundError('Room not found.', 'ROOM_NOT_FOUND');

  return room.members.map(m => ({
    userId:   m.userId._id,
    username: m.userId.username,
    role:     m.role,
    joinedAt: m.joinedAt,
  }));
}

export async function createInvite(roomId, userId) {
  // was: Room.exists({ _id: roomId, memberIds: userId })
  const isMember = await Room.exists({ _id: roomId, 'members.userId': userId });
  if (!isMember) throw new ForbiddenError('Room not found or you are not a member.', 'NOT_MEMBER');

  const token = randomBytes(32).toString('hex');
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

export async function joinViaInvite(token, userId) {
  if (!token) throw new ValidationError('Invite token is required.', 'MISSING_TOKEN');

  const raw = await redis.getdel(`invite:${token}`);
  if (!raw) throw new ValidationError('Invalid or expired invite token.', 'INVALID_TOKEN');

  const { roomId } = JSON.parse(raw);

  // was: $addToSet: { memberIds: userId }
  const room = await Room.findOneAndUpdate(
    { _id: roomId, members: { $not: { $elemMatch: { userId } } } },
    { $push: { members: { userId, role: 'member' } } },
    { new: true }
  );
  if (!room) {
    // Either room was deleted or user was already a member
    const exists = await Room.findById(roomId).lean();
    if (!exists) throw new NotFoundError('Room no longer exists.', 'ROOM_NOT_FOUND');
    return toRoomResponse(exists);  // already a member — idempotent
  }

  await redis.del(cacheKey(roomId));
  return toRoomResponse(room.toObject());
}
```

**`src/services/unreadService.js`** — update `incrementUnread`:

```js
export async function incrementUnread(roomId, senderId) {
  const room = await Room.findById(roomId).select('members').lean();
  if (!room) return;

  // was: room.memberIds.filter(id => id.toString() !== senderId)
  const others = room.members
    .filter(m => m.userId.toString() !== senderId)
    .map(m => m.userId);

  if (!others.length) return;

  const pipeline = redis.pipeline();
  for (const memberId of others) {
    pipeline.incr(key(memberId, roomId));
  }
  await pipeline.exec();
}
```

**`src/services/unreadService.js`** — update `getUnreadCounts`:

```js
export async function getUnreadCounts(userId) {
  // was: Room.find({ memberIds: userId })
  const rooms = await Room.find({ 'members.userId': userId }).select('_id').lean();
  // ... rest unchanged
}
```

**`src/socket/index.js`** — update room-join on connect:

```js
// was: Room.find({ memberIds: userId })
const rooms = await Room.find({ 'members.userId': userId }).select('_id').lean();
```

**`src/services/dmService.js`** — update `findOrCreateDm`:

```js
// was: memberIds: [userIdA, userIdB]
room = await Room.create({
  type:    'dm',
  dmKey,
  members: [
    { userId: userIdA, role: 'member' },
    { userId: userIdB, role: 'member' },
  ],
});
```

---

## Step 3 — requireRoomRole middleware

**`src/middleware/requireRoomRole.js`:**

```js
import mongoose              from 'mongoose';
import { Room, ROLE_RANK }   from '../models/Room.js';
import { ForbiddenError }    from '../errors/AppError.js';

export function requireRoomRole(minRole) {
  return async function (req, _res, next) {
    // Skip for invalid ObjectIds — handler returns 400/404
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) return next();

    // Projection returns only the matching member sub-document, not the full array.
    // For large rooms this avoids deserialising every member entry.
    const room = await Room.findOne(
      { _id: req.params.id, 'members.userId': req.user.sub },
      { members: { $elemMatch: { userId: req.user.sub } } }
    ).lean();

    if (!room?.members?.[0]) {
      throw new ForbiddenError('You are not a member of this room.', 'NOT_MEMBER');
    }

    const userRole = room.members[0].role;

    if (ROLE_RANK[userRole] < ROLE_RANK[minRole]) {
      throw new ForbiddenError(
        `This action requires the '${minRole}' role or higher.`,
        'INSUFFICIENT_ROLE'
      );
    }

    // Attach to req so downstream handlers can make role-based decisions
    // without issuing a second query
    req.memberRole = userRole;
    next();
  };
}
```

**Why `requireMember` still runs before `requireRoomRole` on private room routes:**

`requireMember` gates private room _visibility_ — non-members of private rooms should get a uniform 403 that doesn't confirm whether the room exists. `requireRoomRole` then checks authority within a room. Stacking them in order means: (1) non-members of private rooms see the same opaque 403 as before, and (2) the role check only runs once the user has passed the membership gate.

For _public_ rooms, `requireMember` is a no-op (passes all non-members through). `requireRoomRole` then 403s if the caller has no member entry at all.

---

## Step 4 — New service functions: kickMember, setMemberRole, deleteRoom

**`src/services/roomService.js`** — add three functions:

```js
export async function kickMember(roomId, actorId, targetId) {
  const room = await Room.findById(roomId);
  if (!room) throw new NotFoundError('Room not found.', 'ROOM_NOT_FOUND');

  const actor  = room.members.find(m => m.userId.toString() === actorId);
  const target = room.members.find(m => m.userId.toString() === targetId);

  if (!actor)  throw new ForbiddenError('You are not a member.', 'NOT_MEMBER');
  if (!target) throw new NotFoundError('Target user is not a member.', 'TARGET_NOT_MEMBER');

  // Owners cannot be kicked — they must transfer ownership first
  if (target.role === 'owner') {
    throw new ForbiddenError('Cannot kick the room owner.', 'KICK_OWNER');
  }

  // Admins can kick members but not other admins
  if (actor.role === 'admin' && ROLE_RANK[target.role] >= ROLE_RANK['admin']) {
    throw new ForbiddenError('Admins cannot kick other admins.', 'INSUFFICIENT_ROLE');
  }

  room.members = room.members.filter(m => m.userId.toString() !== targetId);
  await room.save();
  await clearUnread(targetId, roomId);
  await redis.del(cacheKey(roomId));

  return toRoomResponse(room.toObject());
}

export async function setMemberRole(roomId, actorId, targetId, newRole) {
  if (!['admin', 'member'].includes(newRole)) {
    throw new ValidationError('Role must be "admin" or "member".', 'INVALID_ROLE');
  }

  const room = await Room.findById(roomId);
  if (!room) throw new NotFoundError('Room not found.', 'ROOM_NOT_FOUND');

  const actor  = room.members.find(m => m.userId.toString() === actorId);
  const target = room.members.find(m => m.userId.toString() === targetId);

  if (!actor)  throw new ForbiddenError('You are not a member.', 'NOT_MEMBER');
  if (!target) throw new NotFoundError('Target user is not a member.', 'TARGET_NOT_MEMBER');

  // Owner's role can only be changed via explicit transferOwnership — not here
  if (target.role === 'owner') {
    throw new ForbiddenError("Cannot change the owner's role.", 'CHANGE_OWNER_ROLE');
  }

  // Admins can demote to member but cannot promote anyone to admin
  if (actor.role === 'admin' && newRole === 'admin') {
    throw new ForbiddenError('Admins cannot promote to admin.', 'INSUFFICIENT_ROLE');
  }

  target.role = newRole;
  await room.save();

  return toRoomResponse(room.toObject());
}

export async function deleteRoom(roomId, userId) {
  const room = await Room.findById(roomId);
  if (!room) throw new NotFoundError('Room not found.', 'ROOM_NOT_FOUND');

  const member = room.members.find(m => m.userId.toString() === userId);
  if (!member || member.role !== 'owner') {
    throw new ForbiddenError('Only the room owner can delete the room.', 'INSUFFICIENT_ROLE');
  }

  await Room.deleteOne({ _id: roomId });
  await redis.del(cacheKey(roomId));

  // Clean up unread counters for all members
  for (const m of room.members) {
    await clearUnread(m.userId.toString(), roomId);
  }
}
```

**The ownership transfer rule in `leaveRoom` (from Step 2):**

When an owner calls `leaveRoom`, the server must assign a new owner automatically — otherwise the room becomes ownerless. The priority: oldest existing admin first (they're already trusted), then oldest remaining member. If the owner is the last person in the room, the room is deleted. This prevents orphaned rooms from accumulating.

---

## Step 5 — Controller and routes

**`src/controllers/roomController.js`** — add three handlers:

```js
export async function kickMember(req, res) {
  const room = await roomService.kickMember(
    req.params.id,
    req.user.sub,
    req.params.userId
  );
  res.json(ApiResponse.success(room));
}

export async function setMemberRole(req, res) {
  const { role } = req.body;
  if (!role) throw new ValidationError('role is required.');

  const room = await roomService.setMemberRole(
    req.params.id,
    req.user.sub,
    req.params.userId,
    role
  );
  res.json(ApiResponse.success(room));
}

export async function deleteRoom(req, res) {
  await roomService.deleteRoom(req.params.id, req.user.sub);
  res.status(204).send();
}
```

**`src/routes/rooms.js`** — add three role-gated routes:

```js
import { requireMember }   from '../middleware/requireMember.js';
import { requireRoomRole } from '../middleware/requireRoomRole.js';
import { requireVerified } from '../middleware/requireVerified.js';

// ── Existing routes — unchanged ───────────────────────────────────────────────
roomsRouter.post('/',            requireVerified, roomController.createRoom);
roomsRouter.get('/',                              roomController.listRooms);
roomsRouter.post('/join-invite', requireVerified, roomController.joinViaInvite);

roomsRouter.get('/:id',          requireMember, roomController.getRoomById);
roomsRouter.post('/:id/join',    requireMember, requireVerified, roomController.joinRoom);
roomsRouter.post('/:id/leave',   requireMember, roomController.leaveRoom);
roomsRouter.get('/:id/members',  requireMember, roomController.listMembers);
roomsRouter.get('/:id/messages', requireMember, messageController.getMessageHistory);
roomsRouter.get('/:id/presence', requireMember, presenceController.getRoomPresence);
roomsRouter.post('/:id/invite',  requireMember, requireVerified, roomController.createInvite);

// ── New role-gated routes ─────────────────────────────────────────────────────
// DELETE is owner-only — requireRoomRole('owner') enforces this
roomsRouter.delete('/:id',
  requireMember,
  requireRoomRole('owner'),
  roomController.deleteRoom
);

// Kick requires admin — requireRoomRole('admin') allows both admin and owner
roomsRouter.delete('/:id/members/:userId',
  requireMember,
  requireRoomRole('admin'),
  roomController.kickMember
);

// Role assignment — owner can set any role; admin can only demote to member
// requireRoomRole('admin') gates the route; service enforces the admin/owner constraint
roomsRouter.put('/:id/members/:userId/role',
  requireMember,
  requireRoomRole('admin'),
  roomController.setMemberRole
);
```

**Why `requireRoomRole('admin')` on `setMemberRole` even though admins have limited authority:**

The middleware only checks the _minimum_ required role. The finer-grained constraint (admin cannot promote to admin) lives in the service, where `req.memberRole` is compared against the target role. Encoding this logic in the middleware would require passing the request body — the wrong layer for business rules.

---

## Verification

**1. Room creator becomes owner:**

```bash
ROOM=$(curl -s -X POST http://localhost:3000/api/v1/rooms \
  -H "Authorization: Bearer $ALICE_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"name":"test-room"}' | jq -r '.data.id')

curl -s "http://localhost:3000/api/v1/rooms/$ROOM/members" \
  -H "Authorization: Bearer $ALICE_TOKEN" | jq '.data[] | {username, role}'
# Expected: { username: "alice", role: "owner" }
```

**2. Joining makes regular member:**

```bash
# Bob joins the public room
curl -s -X POST "http://localhost:3000/api/v1/rooms/$ROOM/join" \
  -H "Authorization: Bearer $BOB_TOKEN"

curl -s "http://localhost:3000/api/v1/rooms/$ROOM/members" \
  -H "Authorization: Bearer $ALICE_TOKEN" | jq '.data[] | {username, role}'
# Expected: alice=owner, bob=member
```

**3. Admin can kick a member, not another admin or owner:**

```bash
# Alice promotes Bob to admin
curl -s -X PUT "http://localhost:3000/api/v1/rooms/$ROOM/members/$BOB_ID/role" \
  -H "Authorization: Bearer $ALICE_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"role":"admin"}'
# Expected: 200 OK

# Carol joins as member
# Bob (admin) kicks Carol (member) — OK
curl -s -X DELETE "http://localhost:3000/api/v1/rooms/$ROOM/members/$CAROL_ID" \
  -H "Authorization: Bearer $BOB_TOKEN"
# Expected: 200 OK

# Bob tries to kick Alice (owner)
curl -s -X DELETE "http://localhost:3000/api/v1/rooms/$ROOM/members/$ALICE_ID" \
  -H "Authorization: Bearer $BOB_TOKEN"
# Expected: 403 KICK_OWNER
```

**4. Admin cannot promote to admin:**

```bash
# Bob (admin) tries to promote Carol to admin
curl -s -X PUT "http://localhost:3000/api/v1/rooms/$ROOM/members/$CAROL_ID/role" \
  -H "Authorization: Bearer $BOB_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"role":"admin"}'
# Expected: 403 INSUFFICIENT_ROLE
```

**5. Ownership transfers automatically when owner leaves:**

```bash
# Alice (owner) leaves — Bob (admin) should become owner
curl -s -X POST "http://localhost:3000/api/v1/rooms/$ROOM/leave" \
  -H "Authorization: Bearer $ALICE_TOKEN"

curl -s "http://localhost:3000/api/v1/rooms/$ROOM/members" \
  -H "Authorization: Bearer $BOB_TOKEN" | jq '.data[] | {username, role}'
# Expected: bob=owner
```

**6. Room deleted when owner is last member:**

```bash
SOLO_ROOM=$(curl -s -X POST http://localhost:3000/api/v1/rooms \
  -H "Authorization: Bearer $ALICE_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"name":"solo"}' | jq -r '.data.id')

# Alice is the only member — leaving deletes the room
curl -s -X POST "http://localhost:3000/api/v1/rooms/$SOLO_ROOM/leave" \
  -H "Authorization: Bearer $ALICE_TOKEN"
# Expected: 200 (leaveRoom returns null — controller should handle this as 204)

# Confirm the room is gone
curl -s "http://localhost:3000/api/v1/rooms/$SOLO_ROOM" \
  -H "Authorization: Bearer $BOB_TOKEN"
# Expected: 404 ROOM_NOT_FOUND
```

**7. DELETE /rooms/:id requires owner role:**

```bash
# Bob (admin) tries to delete
curl -s -X DELETE "http://localhost:3000/api/v1/rooms/$ROOM" \
  -H "Authorization: Bearer $BOB_TOKEN"
# Expected: 403 INSUFFICIENT_ROLE

# Alice (owner) deletes
curl -s -X DELETE "http://localhost:3000/api/v1/rooms/$ROOM" \
  -H "Authorization: Bearer $ALICE_TOKEN"
# Expected: 204 No Content
```

**8. `listMembers` response includes roles:**

```bash
curl -s "http://localhost:3000/api/v1/rooms/$ROOM/members" \
  -H "Authorization: Bearer $ALICE_TOKEN"
# Expected:
# { data: [
#   { userId: "...", username: "alice", role: "owner",  joinedAt: "..." },
#   { userId: "...", username: "bob",   role: "member", joinedAt: "..." }
# ] }
```

**9. Confirm MongoDB stores the members array:**

```js
// mongosh
db.rooms.findOne({ _id: ObjectId('<roomId>') }, { members: 1 })
// Expected:
// { members: [
//   { userId: ObjectId("..."), role: "owner",  joinedAt: ISODate("...") },
//   { userId: ObjectId("..."), role: "member", joinedAt: ISODate("...") }
// ] }
```

---

## File map

| File | Status |
|---|---|
| `src/models/Room.js` | Updated — `memberIds` replaced with `members: [memberSchema]`; `ROLE_RANK` exported; index on `'members.userId'` |
| `src/middleware/requireMember.js` | Updated — `memberIds: { $ne }` → `members: { $not: { $elemMatch } }` |
| `src/middleware/requireRoomRole.js` | New — `requireRoomRole(minRole)` factory; `$elemMatch` projection; attaches `req.memberRole` |
| `src/services/roomService.js` | Updated — all functions migrated to `members`; add `kickMember`, `setMemberRole`, `deleteRoom`; `leaveRoom` handles ownership transfer |
| `src/services/unreadService.js` | Updated — `incrementUnread` maps `room.members` instead of `room.memberIds` |
| `src/services/dmService.js` | Updated — `findOrCreateDm` uses `members` array |
| `src/socket/index.js` | Updated — `Room.find({ 'members.userId': userId })` |
| `src/controllers/roomController.js` | Updated — add `kickMember`, `setMemberRole`, `deleteRoom` handlers |
| `src/routes/rooms.js` | Updated — add `DELETE /:id`, `DELETE /:id/members/:userId`, `PUT /:id/members/:userId/role` |

---

## Checklist

- [ ] Step 1 — `members` uses an embedded sub-document schema with `_id: false`
- [ ] Step 1 — `ROLE_RANK` exported from model file — single source of truth for role ordering
- [ ] Step 1 — Index added on `'members.userId'` — can explain why dot-notation indexes embedded arrays
- [ ] Step 2 — `requireMember` uses `$not: { $elemMatch }` — can explain why `{ $ne: userId }` is wrong for arrays
- [ ] Step 2 — `createRoom` assigns `role: 'owner'` to the creator
- [ ] Step 2 — `joinRoom` and `joinViaInvite` assign `role: 'member'` to joiners
- [ ] Step 2 — `leaveRoom` auto-transfers ownership: oldest admin first, then oldest member
- [ ] Step 2 — `leaveRoom` deletes the room when the owner is the last member
- [ ] Step 2 — `listMembers` returns `{ userId, username, role, joinedAt }` — roles visible to members
- [ ] Step 3 — `requireRoomRole` uses `$elemMatch` projection — can explain the performance reason
- [ ] Step 3 — `requireRoomRole` attaches `req.memberRole` — downstream handlers avoid a second query
- [ ] Step 3 — `requireMember` still runs before `requireRoomRole` — can explain the two-layer purpose
- [ ] Step 4 — `kickMember` blocks kicking the owner (`KICK_OWNER`)
- [ ] Step 4 — `kickMember` blocks admin kicking admin (`INSUFFICIENT_ROLE`)
- [ ] Step 4 — `setMemberRole` blocks changing owner's role (`CHANGE_OWNER_ROLE`)
- [ ] Step 4 — `setMemberRole` blocks admin promoting to admin (`INSUFFICIENT_ROLE`)
- [ ] Step 5 — `DELETE /:id` requires `requireRoomRole('owner')`
- [ ] Step 5 — `DELETE /:id/members/:userId` and `PUT /:id/members/:userId/role` require `requireRoomRole('admin')`
- [ ] Step 5 — Can explain why finer admin/owner constraints belong in the service, not the middleware
- [ ] Verification — `listMembers` response includes `role` and `joinedAt` fields
- [ ] Verification — Owner leaving auto-transfers to an admin before a regular member
- [ ] Verification — Owner leaving a solo room deletes the room (404 on subsequent GET)
- [ ] Verification — `DELETE /rooms/:id` returns 204 for owner, 403 for admin
- [ ] Knowledge check — Can explain why `$not: $elemMatch` is required instead of `$ne` for embedded arrays
- [ ] Knowledge check — Can explain why `$elemMatch` projection is used in `requireRoomRole` for large rooms
- [ ] Knowledge check — Can explain the ownership transfer priority (admin before member) and why it matters
