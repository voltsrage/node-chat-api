import bcrypt from 'bcrypt'
import {User} from '../models/User.js'
import {ConflictError, UnauthorizedError} from '../errors/AppError.js'
import {
    signAccessToken,
    issueRefreshToken,
    validateRefreshToken,
    revokeRefreshToken
}
from '../utils/tokens.js'

const BCRYPT_ROUNDS = 12;

export async function register({username, email, password}){
    const existing = await User.findOne({ $or :[ {username}, {email}]});

    if(existing)
    {
        const field = existing.username == username ? 'Username' : 'Email';
        throw new ConflictError(`${field} is already taken.`, 'ALREADY_EXISTS');
    }

    const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    const user = await User.create({username, email, passwordHash});

    const accessToken = signAccessToken(user._id.toString(), user.username);
    const refreshToken = await issueRefreshToken(user._id.toString());

    return {user: toPublicUser(user), accessToken, refreshToken};
}

export async function login({email, password}){
    const user = await User.findOne({email}).select('+passwordHash');
    if(!user) throw new UnauthorizedError('Invalid email or password');

    const valid = await bcrypt.compare(password, user.passwordHash);
    if(!valid) throw new UnauthorizedError('Invalid email or password');

    const accessToken = signAccessToken(user._id.toString(), user.username);
    const refreshToken = await issueRefreshToken(user._id.toString());

    return {user: toPublicUser(user), accessToken, refreshToken};
}

export async function refresh(token)
{
    const result = await validateRefreshToken(token);
    if(!result) throw new UnauthorizedError('Invalid or expired refresh token');

    // Rotate: delete old token before issuing new one — prevents reuse after rotation
    await revokeRefreshToken(result.userId, result.tokenId);

    const user = await User.findById(result.userId);
    if(!user) throw new UnauthorizedError('User not found.');

    const accessToken = signAccessToken(user._id.toString(), user.username);
    const refreshToken = await issueRefreshToken(user._id.toString());

    return {accessToken, refreshToken};
}

export async function logout(token){
    const result = await validateRefreshToken(token);
    if(!result) return; // Already invalid or expired — treat as success, not an error

    await revokeRefreshToken(result.userId, result.tokenId);
}


function toPublicUser(user){
    return{
        id: user.id,
        username: user.username,
        email: user.email,
        displayName: user.displayName,
        avatarUrl: user.avatarUrl,
        createdAt: user.createdAt
    }
}