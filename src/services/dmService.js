import {randomBytes} from 'crypto';
import { Room } from '../models/Room.js';
import {User} from '../models/User.js';
import {NotFoundError, ValidationError} from '../errors/AppError.js';

function buildDmKey(id1, id2){
    // Sort alphabetically so buildDmKey(alice, bob) === buildDmKey(bob, alice)
    // String comparison on ObjectId hex strings is stable across calls

    return [id1.toString(), id2.toString()].sort().join(':');
}

function toDmResponse(room){
    return {
        id: room._id,
        type: room.type,
        isPrivate: true,
        memberIds: room.members.map(m => m.userId),
        createdAt: room.createdAt
    }
}

export async function findOrCreateDm(requesterId, targetId){
    if(requesterId.toString() === targetId.toString()){
        throw new ValidationError('Cannot start a DM with yourself.', 'SELF_DM');
    }

    // Confirm the target user exists before creating a room for them
    const target = await User.exists({_id: targetId});
    if (!target) throw new NotFoundError('User not found.', 'USER_NOT_FOUND');

    const dmKey = buildDmKey(requesterId, targetId);

    // Fast path: DM already exists

    const existing = await Room.findOne({type: 'dm', dmKey}).lean();

    if(existing) return toDmResponse(existing);

    // Slow path: create a new DM room
    try{
        const room = await Room.create({
            type: 'dm',
            dmKey,
            name: dmKey,// Internal — never shown in the group room list
            isPrivate: true,
            createdBy: requesterId,
            members: [
                { userId: requesterId },
                { userId: targetId },
            ],
        })
        return toDmResponse(room);
    }
    catch(err){
         // Duplicate key error (11000) — two concurrent requests raced to create
        // the same DM room. The other request won; fetch and return what it created.
        if(err.code === 11000){
            const room = await Room.findOne({type: 'dm', dmKey}).lean();
            if(room) return toDmResponse(room);
        }
        throw err;
    }
}

export async function listDms(userId){
    const rooms = await Room.find({
        type: 'dm',
        'members.userId':userId,
    })
        .sort({updatedAt: -1})
        .lean();

    return rooms.map(toDmResponse);
}