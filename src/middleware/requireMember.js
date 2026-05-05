import mongoose from "mongoose";
import { Room } from "../models/Room.js";
import { ForbiddenError } from "../errors/AppError.js";

export async function requireMember(req, _res, next){
    // Skip the check for invalid ObjectIds - the handle will return 400/404
    if(!mongoose.Types.ObjectId.isValid(req.params.id)) return next();

    // A single index query
    // - Returns null -> room doesn't exist, room is public, OR user IS a member
    // - Returns dock -> room is private and user is NOT a member
    const privateNonMember = await Room.exists({
        _id: req.params.id,
        isPrivate: true,
        membersIds: {$ne: req.user.sub}
    });

    /*
        | Room state | User state | Result |
        |---|---|---|
        | Public | Non-member | `null` → passes through |
        | Public | Member | `null` → passes through |
        | Private | Member | `null` → passes through |
        | Private | Non-member | doc → 403 |
        | Does not exist | — | `null` → passes through (handler returns 404) |

        **Side effect:** `POST /:id/join` on a private room returns 403 for non-members. 
        This is the correct behavior — private rooms are only joinable via invite token. 
        The regular join route becomes the public-room join endpoint implicitly.
    */
    if(privateNonMember){
        throw new ForbiddenError(
            'This room is private. An invitation is required.',
            'NOT_MEMBER'
        ); 
    }

    next();
}