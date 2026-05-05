import {Room} from '../models/Room.js';
import {User} from '../models/User.js';
import {redis} from '../db/redis.js';
import {NotFoundError, ValidationError} from '../errors/AppError.js'
import { paginatedResponse } from '../utils/paginate.js';
import { clearUnread } from './unreadService.js';
import {randomBytes} from 'crypto';

const ROOM_CACHE_TTL = 5 * 60;
const cacheKey = (id) => `room:${id}`;
const INVITE_TTL = 48 * 60* 60; // 48 hours in seconds

export async function createRoom(userId, {name, description, isPrivate}){
    const room = await Room.create({
        name,
        description : description ?? null,
        isPrivate: isPrivate ?? false,
        createdBy: userId,
        memberIds: [userId]
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
            {isPrivate: true, memberIds: userId}
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
    // $addToSet is idempotent - joining a room you are already in is a silent no-op
    const room = await Room.findByIdAndUpdate(
        roomId,
        {$addToSet: {memberIds: userId}},
        {new: true}
    );

    if (!room) throw new NotFoundError('Room not found.', 'ROOM_NOT_FOUND');

    // Invalidate immediately - stale member count in the cache would be misleading
    await redis.del(cacheKey(roomId));

    return toRoomResponse(room);    
}

export async function leaveRoom(roomId, userId) {
    // $pull is idempotent - leaving a room you are not in is a silent no-op
    const room = await Room.findByIdAndUpdate(
        roomId,
        {$pull: {memberIds: userId}},
        {new: true}
    );
    if (!room) throw new NotFoundError('Room not found.', 'ROOM_NOT_FOUND');

    await redis.del(cacheKey(roomId));

    // Clean up the unread counter - user is no longer a member
    await clearUnread(userId, roomId);
}

export async function listMembers(roomId, {page, pageSize, skip}){
    const room = await Room.findById(roomId).select('memberIds').lean();
    if (!room) throw new NotFoundError('Room not found.', 'ROOM_NOT_FOUND');

    const total = room.memberIds.length;
    const pageOfIds = room.memberIds.slice(skip, skip + pageSize);

    const members = await User.find({_id: {$in: pageOfIds}})
        .select('username displayName avatarUrl createdAt')
        .lean();

    return paginatedResponse(members, total, page, pageSize);
}

/*
    **Why `createInvite` returns 403 for both "not found" and "not a member":**

    If the endpoint returned 404 for non-existent rooms, an attacker could probe private room IDs by 
    calling `POST /rooms/:id/invite`. 
    A 403 for both cases reveals only that the caller cannot perform this action — not whether the room exists.
*/
export async function createInvite(roomId, userId){
    // Verify room exists and caller is a member - only members can invite others
    const isMember = await Room.exists({_id: roomId, memberIds: userId});
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

    const room = await Room.findByIdAndUpdate(
        roomId,
        {$addToSet: {memberIds: userId}},
        {new: true}
    );

    if(!room) throw new NotFoundError('Room no longer exists.', 'ROOM_NOT_FOUND');

    // Invalidate the room cache - member count changed
    await redis.del(cacheKey(roomId));

    return toRoomResponse(room);
}

function toRoomResponse(room){
    return {
        id: room._id,
        name: room.name,
        description: room.description,
        createdBy: room.createdBy,
        memberCount: room.memberIds.length,
        isPrivate: room.isPrivate ?? false,
        createdAt: room.createdAt
    }
}