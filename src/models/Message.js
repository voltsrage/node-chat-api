import mongoose from "mongoose";

const messageSchema = new mongoose.Schema(
    {
        roomId: {type: mongoose.Schema.Types.ObjectId, ref: 'Room', required: true},
        senderId: {type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true},
        senderUsername: {type: String, required: true}, // denormalized — avoids populate on bulk reads,
        content: {type: String, required: true},
        type: {type: String, enum: ['text', 'system'], default: 'text'},
        editedAt: {type: Date, default: null},
        deletedAt: {type: Date, default: null},
        /*
        | Shape | Problem |
        |---|---|
        | `[{ emoji, userIds }]` | Requires `$elemMatch` for updates; harder to query "all users who reacted with 👍" |
        | `{ "👍": [...] }` as a plain Mixed type | Mongoose does not track changes; must call `.markModified('reactions')` manually |
        | `Map` | Mongoose tracks changes to map entries automatically; dot-notation updates work cleanly |
        */
        reactions:{
            type: Map, of: [String], // Map<emoji, userId[]>
            default: {}
        }
    },
    {timestamps: {createdAt: true, updatedAt: true}}
);

// Primary query: messages in a room ordered by time — both fields must be in the index.
messageSchema.index({roomId: 1, createdAt: -1});
messageSchema.index({senderId: 1})

export const Message = mongoose.model('Message', messageSchema);