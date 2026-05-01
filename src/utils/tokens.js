import jwt from 'jsonwebtoken'
import {v4 as uuidv4} from 'uuid'
import {redis} from '../db/redis.js'

const ACCESS_TTL_SEC  = 15 * 60;         // 15 minutes
const REFRESH_TTL_SEC = 7 * 24 * 3600;  // 7 days

export function signAccessToken(userId, username){
    return jwt.sign(
        {sub: userId, username},
        process.env.JWT_SECRET,
        {expiresIn: ACCESS_TTL_SEC}
    )
}

export async function issueRefreshToken(userId){
    const tokenId = uuidv4();
    await redis.set(`refresh:${userId}:${tokenId}`, 'valid', 'EX', REFRESH_TTL_SEC)

    return jwt.sign(
        {sub: userId, jti: tokenId, type: 'refresh'},
        process.env.JWT_REFRESH_SECRET,
        {expiresIn: REFRESH_TTL_SEC}
    )
}

export async function validateRefreshToken(token){
    let payload;
    try{
        payload = jwt.verify(token, process.env.JWT_REFRESH_SECRET);
    }
    catch{
        return null;
    }

    if(payload.type != 'refresh') return null;

    const exists = await redis.exists(`refresh:${payload.sub}:${payload.jti}`)

    if(!exists) return null;

    return {userId: payload.sub, tokenId: payload.jti}
}

export async function revokeRefreshToken(userId, tokenId) {
    await redis.del(`refresh:${userId}:${tokenId}`);
}