import mongoose from "mongoose";
import{Room, ROLE_RANK} from '../models/Room.js';
import { ForbiddenError } from "../errors/AppError.js";

/*

    **Why `requireMember` still runs before `requireRoomRole` on private room routes:**

    `requireMember` gates private room _visibility_ — non-members of private rooms should get a uniform 403 
    that doesn't confirm whether the room exists. `requireRoomRole` then checks authority within a room. 
    Stacking them in order means: (1) non-members of private rooms see the same opaque 403 as before, 
    and (2) the role check only runs once the user has passed the membership gate.

    For _public_ rooms, `requireMember` is a no-op (passes all non-members through). 
    `requireRoomRole` then 403s if the caller has no member entry at all.
*/

export function requireRoomRole(minRole){
    return async function(req, _res, next){
        // Skip for invalid ObjectIds — handler returns 400/404
        if (!mongoose.Types.ObjectId.isValid(req.params.id)) return next();

        // Projection returns only the matching member sub-document, not the full array.
        // For large rooms this avoids deserialising every member entry.
        const room = await Room.findOne(
            {_id: req.params.id, 'members.userId': req.user.sub},
            {members: {$elemMatch: {userId: req.user.sub}}}
        ).lean();

        if(!room?.members?.[0])
            throw new ForbiddenError('You are not a member of this room.', 'NOT_MEMBER');

        const userRole = room.members[0].role;

        if(ROLE_RANK[userRole] < ROLE_RANK[minRole]){
            throw new ForbiddenError(
                `This action requires the '${minRole}' role or higher.`,
                'INSUFFICIENT_ROLE'
            );
        }

        // Attach to req so downstream handlers can make role-based decisions
        // without issuing a second query
        req.memberRole = userRole;
        next();
    }

    
}