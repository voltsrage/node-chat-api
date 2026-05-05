import {redis} from '../db/redis.js';
import {Room } from '../models/Room.js';

// Key pattern: unread:{userId}:{roomId}
// No TTL — unread state is permanent until explicitly cleared.
// Unlike presence or typing, an unread count from 3 months ago is still valid.
const key = (userId, roomId) => `unread:${userId}:${roomId}`;

export async function incrementUnread(roomId, senderId){
    // Fetch all room members — must include offline users, not just connected sockets.
    // A user who is offline when the message arrives still needs an unread count.
    const room = await Room.findById(roomId).select('memberIds').lean();
    if(!room) return;

    const others = room.memberIds.filter(id => id.toString() !== senderId);
    if(!others.length) return;

    // Pipeline all INCR calls in one Redis round-trip.
    // A room with 100 members would otherwise require 99 serial INCR commands.
    const pipeline = redis.pipeline();
    for(const memberId of others){
        pipeline.incr(key(memberId, roomId));
    }

    await pipeline.exec();
}

export async function resetUnread(userId, roomId){
    await redis.del(key(userId, roomId));
}

export async function getUnreadCounts(userId){
    // Find all rooms this user belongs to
    const rooms = await Room.find({memberIds: userId}).select('_id').lean();
    if(!rooms.length) return {};

    // Batch-read all unread counters in one pipeline round-trip
    const pipeline = redis.pipeline();
    for(const room of rooms){
        pipeline.get(key(userId, room._id));
    }

    const results = await pipeline.exec();

    // Build the result map - omit rooms with zero unread (keeps payload small)
    const counts = {};
    for(let i = 0; i < rooms.length; i++)
    {
        const count = parseInt(results[i][1])|| 0;
        if(count > 0) counts[rooms[i]._id.toString()] = count;
    }

    return counts;
}

// Called when a user leaves a room - cleans up their counter
export async function clearUnread(userId, roomId){
    await redis.del(key(userId, roomId));
}