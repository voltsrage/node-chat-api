import Redis from 'ioredis';
import {logger } from '../utils/logger.js';

/**
    BullMQ also requires `maxRetriesPerRequest: null` on the ioredis instance. 
    By default, ioredis retries failed commands a fixed number of times. 
    For blocking commands, this causes premature errors — `null` tells ioredis to retry 
    indefinitely (or until the connection closes), which is what BullMQ needs.
 */
export function createBullConnection() {
    const conn = new Redis(process.env.REDIS_URL, {
        maxRetriesPerRequest: null,  // Required by BullMQ — do not remove
        retryStrategy(times) {
            return Math.min(times * 100, 3000);
        }
    });

    conn.on('error', (err) => logger.error({ err }, 'BullMQ Redis connection error'));

    return conn;
}