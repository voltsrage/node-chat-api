import {Room} from '../models/Room.js';
import {User} from '../models/User.js';
import {redis} from '../db/redis.js';
import {NotFoundError} from '../errors/AppError.js'
import { paginatedResponse } from '../utils/paginate.js';
import { clearUnread } from './unreadService.js';

const ROOM_CACHE_TTL = 5 * 60;
const cacheKey = (id) => `room:${id}`;

export async function createRoom(userId, {name, description}){
    const room = await Room.create({
        name,
        description : description ?? null,
        createdBy: userId,
        memberIds: [userId]
    });

    return toRoomResponse(room);
}

// .lean() is used on all read-only queries. 
// It returns plain JavaScript objects instead of full Mongoose documents, skipping the overhead of instantiating virtuals, middleware, and the prototype chain. 
// This is the equivalent of AsNoTracking() in Entity Framework.
export async function listRooms({page, pageSize, skip}){
    const [rooms, total] = await Promise.all([
        Room.find({}).sort({createdAt: -1}).skip(skip).limit(pageSize).lean(),
        Room.countDocuments()
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

function toRoomResponse(room){
    return {
        id: room._id,
        name: room.name,
        description: room.description,
        createdBy: room.createdBy,
        memberCount: room.memberIds.length,
        createdAt: room.createdAt
    }
}