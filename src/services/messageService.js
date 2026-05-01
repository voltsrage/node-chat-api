import {Message} from '../models/Message.js';
import { Room } from '../models/Room.js';
import { NotFoundError, ValidationError } from '../errors/AppError';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

export async function getMessageHistory(roomId, {before, limit} = {}){
    const n = Math.min(Math.max(1, parseInt(limit) || DEFAULT_LIMIT), MAX_LIMIT);

    const roomExists = await Room.exists({_id: roomId});
    if (!roomExists) throw new NotFoundError('Room not found.', 'ROOM_NOT_FOUND');

    const filter = {roomId};

    if(before){
        const cursor = new Date(before);
        if(isNaN(cursor.getTime()))
            throw new ValidationError('before must be a valid ISO 8601 timestamp.');
        filter.createdAt = {$lt: cursor};
    }

    // Fetch n+1 to check hasMore without a separate count query
    const docs = await Message.find(filter)
        .sort({ createdAt: -1})
        .limit(n + 1)
        .lean();

    const hasMore = docs.length > n;
    const items = hasMore ? docs.slice(0, n) : docs;

    return {
        items: items.map(toMessageResponse),
        nextCursor: hasMore ? items[items.length - 1].createdAt.toISOString(): null,
        hasMore
    };
}

function toMessageResponse(msg){
    return {
        id: msg._id,
        roomId: msg.roomId,
        senderId: msg.senderId,
        senderUsername: msg.senderUsername,
        content: msg.deletedAt ? '[deleted]' : msg.content,
        type: msg.type,
        editedAt: msg.editedAt ?? null,
        deletedAt: msg.deletedAt ?? null,
        createdAt: msg.createdAt
    }
}