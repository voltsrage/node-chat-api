import {redis} from '../db/redis.js';
import {TooManyRequestsError} from '../errors/AppError.js'

/*
SET key 1 EX 60 NX means: set the key to 1 with a 60-second TTL, but only if the key does not already exist. 
This is a single atomic command that handles the first-request case. On subsequent requests within the window,
INCR the existing key. Each command is individually atomic; there is no window between them because NX checks existence and sets TTL in one operation.

Both approaches are valid. Lua is preferred when you need to read a value and conditionally take action in a single atomic operation.
*/
const INCR_WITH_EXPIRE = `
    local c = redis.call('INCR', KEYS[1])
    if c == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end
    return c
`;

/*
key design choices:

    req.ip as the identifier — unauthenticated endpoints must scope to IP, not userId
    rl:{keyPrefix}:{identifier} — namespaced so redis-cli KEYS "rl:auth:*" isolates all auth counters
    throw new TooManyRequestsError(...) — propagates through express-async-errors; no res.status() in middleware
*/
export function createRateLimiter({windowSec, max, keyPrefix}){
    return async function rateLimiter(req, _res, next) {
        const identifier = req.ip ?? 'unknown';
        const key = `rl:${keyPrefix}:${identifier}`;

        const count = await redis.eval(INCR_WITH_EXPIRE, 1, key, windowSec);

        if(count > max){
            const ttl = await redis.ttl(key);
            throw new TooManyRequestsError(
                `Too many requests. Retry after ${ttl} seconds.`
            );
        }

        next();
    }
}

// Pre-build instance for auth endpoints
export const authRateLimiter = createRateLimiter({
    windowSec: 15 * 60, // 15-minute fixed window
    max: 10,
    keyPrefix: 'auth'
})