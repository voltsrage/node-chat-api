import mongoose from "mongoose";

/*
    **Why in-document roles and not a separate collection:** 
    Roles are always read with the room (to check membership and authority). 
    A separate `RoomMemberships` collection would require a join on every room access. 
    Embedding keeps it one query. The member array is bounded — a room can have thousands of members, 
    but the per-member record is tiny (ObjectId + 6-char string + timestamp = ~50 bytes).

    **Why the `$elemMatch` projection matters:** A room with 1,000 members has a 50 KB `members` array. 
    When checking one user's role, projecting `{ members: { $elemMatch: { userId } } }` returns only that user's sub-document. 
    Without the projection, Mongoose deserialises all 1,000 entries.
*/

const memberSchema = new mongoose.Schema({
    userId: {type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true},
    role: {type: String, enum: ['owner', 'admin', 'member'], default: 'member'},
    joinedAt: {type: Date, default: Date.now}
},
/**
     **Why `_id: false` on memberSchema:**

    Sub-documents in arrays get an auto-generated `_id` by default. 
    Member entries are not independently addressable — 
    they live inside Room and are always accessed through the parent document. 
    Suppressing `_id` eliminates 12 bytes per entry and removes noise from update operators.
 */
{_id: false}
)

const roomSchema = new mongoose.Schema(
    {
        name: {type: String, required: true, unique: true, trim: true, sparse: true},
        description: {type: String, default: null},
        createdBy: {type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true},
        // Indexes are declared here to be explicit — never rely on Mongoose to infer
        // the right index from `unique: true` alone without verification.
        members : [memberSchema],
        isPrivate: {type: Boolean, default: false},
        type: {type: String, enum: ['group', 'dm'], default: 'group'},
        /*
        **Why `sparse: true` on both `name` and `dmKey`:**

        A non-sparse unique index treats `null` as a value. Two group rooms with `dmKey: undefined` would both be indexed as `null` — the second create would throw a duplicate key error. `sparse: true` tells MongoDB to skip documents where the field is absent or `null`, so only defined values participate in the uniqueness check.

        */
        dmKey: {type:String, unique: true, sparse: true}
    },
    {timestamps: {createdAt: true, updatedAt: true}}
);

roomSchema.index({name: 1}, {unique: true});
roomSchema.index({'members.userId': 1}) // "which rooms does user X belong to?"
roomSchema.index({createdAt: -1}) // sorted room listing

export const Room = mongoose.model('Room', roomSchema);

export const ROLE_RANK= {owner: 3, admin: 2, member: 1};