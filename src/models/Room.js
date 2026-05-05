import mongoose from "mongoose";

const roomSchema = new mongoose.Schema(
    {
        name: {type: String, required: true, unique: true, trim: true},
        description: {type: String, default: null},
        createdBy: {type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true},
        // Indexes are declared here to be explicit — never rely on Mongoose to infer
        // the right index from `unique: true` alone without verification.
        memberIds : [{type: mongoose.Schema.Types.ObjectId, ref: 'User'}],
        isPrivate: {type: Boolean, default: false}
    },
    {timestamps: {createdAt: true, updatedAt: true}}
);

roomSchema.index({name: 1}, {unique: true});
roomSchema.index({memberIds: 1}) // "which rooms does user X belong to?"
roomSchema.index({createdAt: -1}) // sorted room listing

export const Room = mongoose.model('Room', roomSchema);