import bcrypt from 'bcrypt'
import {User} from '../models/User.js'
import {ConflictError, UnauthorizedError, ValidationError} from '../errors/AppError.js'
import {
    signAccessToken,
    issueRefreshToken,
    validateRefreshToken,
    revokeRefreshToken
}
from '../utils/tokens.js';
import {randomBytes} from 'crypto';
import { sendVerificationEmail } from '../utils/email.js';
import { redis } from '../db/redis.js';

const BCRYPT_ROUNDS = 12;
const VERIFY_TOKEN_TTL = 24 * 60 * 60; // 24 hours in seconds


export async function register({username, email, password}){
    const existing = await User.findOne({ $or :[ {username}, {email}]});

    if(existing)
    {
        const field = existing.username == username ? 'Username' : 'Email';
        throw new ConflictError(`${field} is already taken.`, 'ALREADY_EXISTS');
    }

    const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    const user = await User.create({username, email, passwordHash});

    // Generate a 64-character hex token(32 random bytes)
    const token = randomBytes(32).toString('hex');

    // Store token → userId in Redis with 24-hour TTL
    // Key pattern: email-verify:{token}
    // This avoids MongoDB — Redis expiry handles cleanup automatically
    await redis.set(`email-verify:${token}`, user._id.toString(), 'EX', VERIFY_TOKEN_TTL);

    // Send email (synchronous here; Phase 16 moves this into a BullMQ job)
    await sendVerificationEmail(email, token)

    const accessToken = signAccessToken(user);
    const refreshToken = await issueRefreshToken(user._id.toString());

    return {accessToken, refreshToken};
}

export async function verifyEmail(token){
    if(!token) throw new ValidationError('Token is required.', 'MISSING_TOKEN');

    // GET + DEL would be two operations with a race window.
    // GETDEL is atomic in Redis 6.2+. For older Redis, use a Lua script.

    // `redis.getdel` atomically reads and deletes the key — single-use enforcement. If two requests race to verify the same token, one gets the userId and one gets `null`. Without atomicity, both could read the key before either deletes it.
    const userId = await redis.getdel(`email-verify:${token}`);

    if(!userId){
        throw new ValidationError('Invalid or expired verification token.', 'INVALID_TOKEN');
    }

    await User.findByIdAndUpdate(userId, {$set:{verified: true}});
}



const RESEND_INCR_LUA = `
    local c = redis.call('INCR', KEYS[1])
    if c == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end
    return c
`;

export async function resendVerification(userId) {
    const user = await User.findById(userId).select('+verified').lean();

    if(!user) throw new NotFoundError('User not found.', 'USER_NOT_FOUND');

    if(user.verified)
    {
        throw new ValidationError('Email is already verified.', 'ALREADY_VERIFIED');
    }

    // Rate limit: 3 resend requests per hour per user
    const count = await redis.eval(RESEND_INCR_LUA, 1, `rl:resend:${userId}`, 3600);

    if(count > 3){
        throw new TooManyRequestsError('Too many resend requests. Try again in an hour.');
    }

    // Old token (if any) expires naturally - no need to track or delete it
    const token = randomBytes(32).toString('hex');
    await redis.set(`email-verify:${token}`, userId.toString(), 'EX', VERIFY_TOKEN_TTL);

    await sendVerificationEmail(user.email, token);
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