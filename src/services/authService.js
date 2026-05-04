import bcrypt from 'bcrypt'
import { User } from '../models/User.js'
import { ConflictError, UnauthorizedError, ValidationError } from '../errors/AppError.js'
import {
    signAccessToken,
    issueRefreshToken,
    validateRefreshToken,
    revokeRefreshToken
}
    from '../utils/tokens.js';
import { randomBytes } from 'crypto';
import { sendVerificationEmail, sendPasswordResetEmail } from '../utils/email.js';
import { redis } from '../db/redis.js';

const BCRYPT_ROUNDS = 12;
const VERIFY_TOKEN_TTL = 24 * 60 * 60; // 24 hours in seconds
const RESET_TOKEN_TTL = 60 * 60; // 1 hour
const LOCKOUT_THRESHOLD = 5;
const LOCKOUT_TTL = 15 *60; //15 minutes in seconds

const FORGOT_INCR_LUA = `
  local c = redis.call('INCR', KEYS[1])
  if c == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end
  return c
`;


export async function register({ username, email, password }) {
    const existing = await User.findOne({ $or: [{ username }, { email }] });

    if (existing) {
        const field = existing.username == username ? 'Username' : 'Email';
        throw new ConflictError(`${field} is already taken.`, 'ALREADY_EXISTS');
    }

    const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    const user = await User.create({ username, email, passwordHash });

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

    return { accessToken, refreshToken };
}

export async function verifyEmail(token) {
    if (!token) throw new ValidationError('Token is required.', 'MISSING_TOKEN');

    // GET + DEL would be two operations with a race window.
    // GETDEL is atomic in Redis 6.2+. For older Redis, use a Lua script.

    // `redis.getdel` atomically reads and deletes the key — single-use enforcement. If two requests race to verify the same token, one gets the userId and one gets `null`. Without atomicity, both could read the key before either deletes it.
    const userId = await redis.getdel(`email-verify:${token}`);

    if (!userId) {
        throw new ValidationError('Invalid or expired verification token.', 'INVALID_TOKEN');
    }

    await User.findByIdAndUpdate(userId, { $set: { verified: true } });
}



const RESEND_INCR_LUA = `
    local c = redis.call('INCR', KEYS[1])
    if c == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end
    return c
`;

export async function resendVerification(userId) {
    const user = await User.findById(userId).select('+verified').lean();

    if (!user) throw new NotFoundError('User not found.', 'USER_NOT_FOUND');

    if (user.verified) {
        throw new ValidationError('Email is already verified.', 'ALREADY_VERIFIED');
    }

    // Rate limit: 3 resend requests per hour per user
    const count = await redis.eval(RESEND_INCR_LUA, 1, `rl:resend:${userId}`, 3600);

    if (count > 3) {
        throw new TooManyRequestsError('Too many resend requests. Try again in an hour.');
    }

    // Old token (if any) expires naturally - no need to track or delete it
    const token = randomBytes(32).toString('hex');
    await redis.set(`email-verify:${token}`, userId.toString(), 'EX', VERIFY_TOKEN_TTL);

    await sendVerificationEmail(user.email, token);
}


export async function login({ email, password }) {
    // Use the same generic error for "username not found" and "wrong password"
    // to prevent username enumeration
    const user = await User.findOne({ email }).select('+passwordHash');

    if (!user) {
        // No user found - still throw INVALID_CREDENTIALS, not USER_NOT_FOUND
        const err = new Error('INVALID_CREDENTIALS');
        err.code = 'INVALID_CREDENTIALS';
        throw err;
    }

    // Check lockout BEFORE verifying the password
    // Even a correct password is rejected while locked — otherwise an attacker
    // could use the response time difference (bcrypt is slow) to infer a correct password
    const locked = await redis.exists(`login-locked:${user._id}`);
    if(locked){
        const ttl = await redis.ttl(`login-locked:${user._id}`);
        throw new LockedError(
            `Account locked after too many failed attempts. Try again in ${Math.ceil(ttl / 60)} minutes.`,
            'ACCOUNT_LOCKED'
        );
    }

    const valid = await bcrypt.compare(password, user.passwordHash);
    if (!valid) {
        // Increment the failed-attempt counter atomically
        const attempts = await redis.eval(FORGOT_INCR_LUA, 1, `login-attempts:${user._id}`, LOCKOUT_TTL); 

        if(attempts >= LOCKOUT_THRESHOLD){
            // Threshold reached — set the lock key
            // The attempt counter TTL and lock TTL are both 15 minutes.
            // The lock key is what login checks, not the counter directly.
            await redis.set(`login-locked:${user._id}`, 1, 'EX', LOCKOUT_TTL);
            throw new LockedError(
                'Too many failed attempts. Account locked for 15 minutes.',
                'ACCOUNT_LOCKED'
            );
        }

        const remaining = LOCKOUT_THRESHOLD - attempts;
        const err       = new Error('INVALID_CREDENTIALS');
        err.code        = 'INVALID_CREDENTIALS';
        err.remaining   = remaining; // optional: include in response for UX
        throw err;
    }

    // Successful login — reset the attempt counter
    // The lock key (if it somehow exists) will expire naturally
    await redis.del(`login-attempts:${user._id}`);

    const accessToken = signAccessToken(user._id.toString(), user.username);
    const refreshToken = await issueRefreshToken(user._id.toString());

    return { accessToken, refreshToken };
}

export async function refresh(token) {
    const result = await validateRefreshToken(token);
    if (!result) throw new UnauthorizedError('Invalid or expired refresh token');

    // Rotate: delete old token before issuing new one — prevents reuse after rotation
    await revokeRefreshToken(result.userId, result.tokenId);

    const user = await User.findById(result.userId);
    if (!user) throw new UnauthorizedError('User not found.');

    const accessToken = signAccessToken(user._id.toString(), user.username);
    const refreshToken = await issueRefreshToken(user._id.toString());

    return { accessToken, refreshToken };
}

export async function logout(token) {
    const result = await validateRefreshToken(token);
    if (!result) return; // Already invalid or expired — treat as success, not an error

    await revokeRefreshToken(result.userId, result.tokenId);
}

export async function forgotPassword(email) {
    // Rate limit by email address: 3 requests per hour
    // Prevents token-spam attacks against a victim's inbox
    const rateKey = `rl:forgot:${email.toLowerCase()}`;
    const count = await redis.eval(FORGOT_INCR_LUA, 1, rateKey, 3600);

    if(count > 3){
        // Still return 200 — do not confirm whether the email exists
        // Leaking "rate limited" tells the attacker the account exists
        return;
    }

    // Look up user silently — no error thrown if not found
    const user = await User.findOne({email: email.toLowerCase()}).lean();
    if(!user){
        // Do NOT throw NotFoundError — that would confirm the email is not registered
        // (email enumeration attack). Return silently.       
        return;
    }

    const token = randomBytes(32).toString('hex');
    await redis.set(`pwd-reset:${token}`, user._id.toString(), 'EX', RESET_TOKEN_TTL);
    await sendPasswordResetEmail(email, token);
}

async function invalidateAllRefreshTokens(userId){
    // SCAN for all refresh token keys belonging to this user.
    // SCAN iterates in O(1) per call — safe for production unlike KEYS which blocks.
    // Trade-off: requires multiple round-trips for large keyspaces.
    // Alternative: a version counter (see Knowledge Check) invalidates in O(1).
    const keys = [];
    let cursor = '0';

    do{
        const [nextCursor, batch] = await redis.scan(
            cursor, 'MATCH', `refresh:${userId}:*`, 'COUNT', 50
        );
        cursor = nextCursor;
        keys.push(...batch)
    } while (cursor !== '0');

    if(keys.length > 0){
        await redis.del(...keys);
    }
}

export async function resetPassword(token, newPassword){
    if(!token) throw new ValidationError('Token is required', 'MISSING_TOKEN');

    if(!newPassword || newPassword.length < 8){
        throw new ValidationError('Password must be at least 8 characters.', 'WEAK_PASSWORD');
    }

    // Atomically read and delete — single-use enforcement
    // If two concurrent requests arrive with the same token, only one gets the userId
    const userId = await redis.getdel(`pwd-reset:${token}`);
    if(!userId)
        throw new ValidationError('Invalid or expired reset token.', 'INVALID_TOKEN');

    const passwordHash = await bcrypt.hash(newPassword, 12);

    await User.findByIdAndUpdate(userId, {$set: {passwordHash}});

    // Invalidate ALL existing refresh tokens for this user.
    // Required: if an attacker triggered this reset, the legitimate user's
    // active sessions must be terminated. The user re-authenticates with
    // their new password to get fresh tokens.
    await invalidateAllRefreshTokens(userId);
}

function toPublicUser(user) {
    return {
        id: user.id,
        username: user.username,
        email: user.email,
        displayName: user.displayName,
        avatarUrl: user.avatarUrl,
        createdAt: user.createdAt
    }
}