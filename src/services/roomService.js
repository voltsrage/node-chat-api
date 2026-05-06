import {ROLE_RANK, Room} from '../models/Room.js';
import {User} from '../models/User.js';
import {redis} from '../db/redis.js';
import {NotFoundError, ValidationError, ForbiddenError} from '../errors/AppError.js'
import { paginatedResponse } from '../utils/paginate.js';
import { clearUnread } from './unreadService.js';
import {randomBytes} from 'crypto';
import { clearReceipt,clearAllReceipts } from './readReceiptService.js';

const ROOM_CACHE_TTL = 5 * 60;
const cacheKey = (id) => `room:${id}`;
const INVITE_TTL = 48 * 60* 60; // 48 hours in seconds

export async function createRoom(userId, {name, description, isPrivate}){
    const room = await Room.create({
        name,
        description : description ?? null,
        isPrivate: isPrivate ?? false,
        createdBy: userId,
        members: [{userId, role: 'owner'}] // creator is always owner
    });

    return toRoomResponse(room);
}

// .lean() is used on all read-only queries. 
// It returns plain JavaScript objects instead of full Mongoose documents, skipping the overhead of instantiating virtuals, middleware, and the prototype chain. 
// This is the equivalent of AsNoTracking() in Entity Framework.
export async function listRooms({page, pageSize, skip}, userId){
    // Public rooms: visible to everyone
    // Private rooms: visible only to members

    const filter = {
        $or: [
            {isPrivate: {$ne: true}},
            {isPrivate: true, 'members.userId': userId}
        ]
    }
    const [rooms, total] = await Promise.all([
        Room.find(filter).sort({createdAt: -1}).skip(skip).limit(pageSize).lean(),
        Room.countDocuments(filter)
    ]);

    return paginatedResponse(rooms.map(toRoomResponse), total, page, pageSize);
}

export async function getRoomById(roomId){
    const cached = await redis.get(cacheKey(roomId));

    if(cached) return JSON.parse(cached);

    const room = await Room.findById(roomId).lean();
    if (!room) throw new NotFoundError('Room not found.', 'ROOM_NOT_FOUND');

    const response = toRoomResponse(room);
    await redis.set(cacheKey(roomId), JSON.stringify(response), 'EX', ROOM_CACHE_TTL);

    return response;
}

export async function joinRoom(roomId, userId) {
    // $not: $elemMatch guards against double-join
    const room = await Room.findOneAndUpdate(
        {
            _id: roomId,
            isPrivate: false,
            members: {$not: {$elemMatch: {userId}}}
        },
        {$push: {members: {userId, role: 'member'}}},
        {new: true}
    );

    if (!room) {
        const exists = await Room.findById(roomId).lean();
        if(!exists) throw new NotFoundError('Room not found.', 'ROOM_NOT_FOUND');
        if(exists.isPrivate) throw new ForbiddenError('Room is private.', 'NOT_MEMBER');

        // Already a member - idempotent
        return toRoomResponse(exists);
    }

    // Invalidate immediately - stale member count in the cache would be misleading
    await redis.del(cacheKey(roomId));

    return toRoomResponse(room);    
}

export async function leaveRoom(roomId, userId) {
    const room = await Room.findById(roomId);
    if(!room) throw new NotFoundError('Room not found.', 'ROOM_NOT_FOUND');

    const member = room.members.find(m => m.userId.toString() === userId);
    if(!member) throw new ForbiddenError('You are not a member.', 'NOT_MEMBER');

    if(member.role === 'owner'){
        // Must transfer ownership before leaving - pick oldest admin, then oldest member
        const heir =
            room.members.find(m => m.role === 'admin' && m.userId.toString() !== userId) ??
            room.members.find(m => m.userId.toString() !== userId);

        if(heir){
            heir.role = 'owner';
        } else {
            // Owner is the last member - delete the room entirely
            await Room.deleteOne({_id: roomId});
            await redis.del(cacheKey(roomId));
            await clearUnread(userId, roomId);
            await clearReceipt(userId, roomId);
            return null
        }
    }

    room.members = room.members.filter(m => m.userId.toString() !== userId);
    await room.save();
    await redis.del(cacheKey(roomId));
    await clearUnread(userId, roomId);
    await clearReceipt(userId, roomId);

    return toRoomResponse(room.toObject());
}

export async function listMembers(roomId){
    const room = await Room.findById(roomId).select('members')
        .populate('members.userId', 'username email')
        .lean();

    if(!room) throw new NotFoundError('Room not found.', 'ROOM_NOT_FOUND');

    return room.members.map(m => ({
        userId: m.userId._id,
        username: m.userId.username,
        role: m.role,
        joinedAt: m.joinedAt
    }))
    
}

/*
    **Why `createInvite` returns 403 for both "not found" and "not a member":**

    If the endpoint returned 404 for non-existent rooms, an attacker could probe private room IDs by 
    calling `POST /rooms/:id/invite`. 
    A 403 for both cases reveals only that the caller cannot perform this action — not whether the room exists.
*/
export async function createInvite(roomId, userId){
    // Verify room exists and caller is a member - only members can invite others
    const isMember = await Room.exists({_id: roomId, 'members.userId': userId});
    if(!isMember){
        // Don't distinguish "room not found" from "not a member" —
        // both return 403 to avoid leaking whether a private room exists
        throw new ForbiddenError('Room not found or you are not a member.', 'NOT_MEMBER');
    }

    const token = randomBytes(32).toString('hex');

    // Store as JSON - need both roomId and who created the invite for audit purposes
    await redis.set(
        `invite:${token}`,
        JSON.stringify({roomId, createdBy: userId}),
        'EX',
        INVITE_TTL
    );

    return {
        token,
        inviteUrl : `${process.env.APP_URL}/api/v1/rooms/join-invite?token=${token}`,
        expiresIn: '48 hours'
    }
}

export async function joinViaInvite(token, userId){
    if(!token) throw new ValidationError('Invite token is required', 'MISSING_TOKEN');

    // Atomic read-and-delete — same pattern as email verification and password reset
    // Only one request can consume the token even under concurrent access
    const raw = await redis.getdel(`invite:${token}`);
    if(!raw){
        throw new ValidationError('Invalid or expired invite token.', 'INVALID_TOKEN');
    }

    const {roomId} = JSON.parse(raw);

    const room = await Room.findOneAndUpdate(
        {_id: roomId, members: {$not : {$elemMatch: {userId}}}},
        {$push: {members: {userId, role:'member'}}},
        {new: true}
    );

    if(!room) 
    {
        const exists = await Room.findById(roomId).lean();
        if(!exists) throw new NotFoundError('Room no longer exists.', 'ROOM_NOT_FOUND');
        return toRoomResponse(exists); // already a member - idempotent
    }

    // Invalidate the room cache - member count changed
    await redis.del(cacheKey(roomId));

    return toRoomResponse(room);
}

export async function kickMember(roomId, actorId, targetId){
    const room = await Room.findById(roomId);
    if (!room) throw new NotFoundError('Room not found.', 'ROOM_NOT_FOUND');
    
    const actor = room.members.find(m => m.userId.toString() === actorId);
    const target = room.members.find(m => m.userId.toString() === targetId);

    if(!actor) throw new ForbiddenError('You are not a member.', 'NOT_MEMBER');
    if(!target)  throw new NotFoundError('Target user is not a member.', 'TARGET_NOT_MEMBER');

    // Owners cannot be kicked - the must transfer ownership first
    if(target.role === 'owner'){
        throw new ForbiddenError('Cannot kick the room owner.', 'KICK_OWNER');
    };

    // Admins can kick members but not other admins
    if(actor.role === 'admin' && ROLE_RANK[target.role] >= ROLE_RANK['admin']){
        throw new ForbiddenError('Admins cannot kick other admins.', 'INSUFFICIENT_ROLE');
    };

    room.members = room.members.filter(m => m.userId.toString() !== targetId);
    await room.save();
    await clearUnread(targetId, roomId);
    await redis.del(cacheKey(roomId));

    return toRoomResponse(room.toObject());
}

export async function setMemberRole(roomId, actorId, targetId, newRole){
    if(!['admin', 'member'].includes(newRole))
        throw new ValidationError('Role must be "admin" or "member".', 'INVALID_ROLE');

    const room = await Room.findById(roomId);
    if (!room) throw new NotFoundError('Room not found.', 'ROOM_NOT_FOUND');
    
    const actor = room.members.find(m => m.userId.toString() === actorId);
    const target = room.members.find(m => m.userId.toString() === targetId);

    if(!actor) throw new ForbiddenError('You are not a member.', 'NOT_MEMBER');
    if(!target)  throw new NotFoundError('Target user is not a member.', 'TARGET_NOT_MEMBER');

    // Owner's role can only be changed via explicit transferOwnership - not here
    if(target.role == 'owner'){
        throw new ForbiddenError("Cannot change the owner's role.", 'CHANGE_OWNER_ROLE');
    }

    // Admins can demote to member but cannot promote anyone to admin
    if(actor.role === 'admin' && newRole === 'admin')
        throw new ForbiddenError('Admins cannot promote to admin.', 'INSUFFICIENT_ROLE');

    target.role = newRole;
    await room.save();

    return toRoomResponse(room.toObject());
}

export async function deleteRoom(roomId, userId){
    const room = await Room.findById(roomId);
    if(!room) throw new NotFoundError('Room not found.', 'ROOM_NOT_FOUND');

    const member = room.members.find(m => m.userId.toString() === userId);
    if(!member || member.role !== 'owner')
        throw new ForbiddenError('Only the room owner can delete the room.', 'INSUFFICIENT_ROLE');

    await Room.deleteOne({_id: roomId});
    await redis.del(cacheKey(roomId));

    // Clean up unread counters for all members
    for(const m of room.members) {
        await clearUnread(m.userId.toString(), roomId);
    }
}

function toRoomResponse(room){
    return {
        id: room._id,
        name: room.name,
        description: room.description,
        createdBy: room.createdBy,
        memberCount: room.members.length,
        isPrivate: room.isPrivate ?? false,
        createdAt: room.createdAt
    }
}