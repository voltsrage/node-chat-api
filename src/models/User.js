import mongoose  from "mongoose";

const userSchema = new mongoose.Schema(
    {
        username: {type: String, required: true, unique: true, trim: true},
        email: {type: String, required: true, unique: true, lowercase: true, trim: true},
        passwordHash: {type:String, required: true, select: false},
        displayName: {type: String, default: null},
        avatarUrl: {type: String, default: null}
    },
    {timestamps: {createdAt: true, updatedAt: true}}
);

// Indexes are declared here to be explicit — never rely on Mongoose to infer
// the right index from `unique: true` alone without verification.
userSchema.index({username: 1}, {unique:true});
userSchema.index({email:1}, {unique: true});

export const User = mongoose.model('User', userSchema);