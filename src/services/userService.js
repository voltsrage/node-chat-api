import { User } from '../models/User.js';
import { NotFoundError, ValidationError } from '../errors/AppError.js';

export async function getMyProfile(userId) {
    const user = await User.findById(userId).lean();
    if (!user) throw new NotFoundError('User not found.', 'USER_NOT_FOUND');
    return toOwnProfile(user);
}

export async function updateMyProfile(userId, {displayName, avatarUrl}){
    const updates = {};
    if(displayName != undefined) updates.displayName = displayName;
    if(avatarUrl != undefined) updates.avatarUrl = avatarUrl;

    if(Object.keys(updates).length == 0)
        throw new ValidationError('No updatable fields provided.');

    const user = await User.findByIdAndUpdate(
        userId,
        {$set: updates},
        {new: true, runValidators: true}
    ).lean();
    if (!user) throw new NotFoundError('User not found.', 'USER_NOT_FOUND');

    return toOwnProfile(user);
}

export async function getUserById(userId){
    const user = await User.findById(userId).lean();
    if (!user) throw new NotFoundError('User not found.', 'USER_NOT_FOUND');
    return toPublicProfile(user);
}

function toOwnProfile(user) {
    return {
        id: user._id,
        username: user.username,
        email: user.email,
        displayName: user.displayName,
        avatarUrl: user.avatarUrl,
        createdAt: user.createdAt,
    };
}

function toPublicProfile(user) {
    return {
        id: user._id,
        username: user.username,
        displayName: user.displayName,
        avatarUrl: user.avatarUrl,
        createdAt: user.createdAt,
    };
}