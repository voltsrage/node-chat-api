import Redis from "ioredis";
import { logger } from "../utils/logger.js";

export const redis = new Redis(process.env.REDIS_URL, {
    retryStrategy(times) {
        return Math.min(times*100,  3000)
    }
})

redis.on('connect', () => logger.info('Redis connected'))
redis.on('error', (err) => logger.error({err}, 'Redis connection error'))