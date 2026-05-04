import Redis from "ioredis";
import {logger} from '../utils/logger.js';

/*
The adapter requires two separate connections:

    pubClient — used to publish events when io.to(room).emit() is called on this instance
    subClient — enters Redis SUBSCRIBE mode and listens for events published by other instances

These must be separate because a Redis connection in SUBSCRIBE mode can only receive messages — 
it cannot execute any other commands (GET, SET, ZADD, etc.). If you tried to reuse the main redis client for subscribing, 
all data operations would fail while the connection is blocked.

This means each instance maintains three Redis connections:

Connection	Purpose
redis (from db/redis.js)	All data operations: presence, typing, rate limiting, caching
pubClient	Socket.io adapter — publish events to other instances
subClient	Socket.io adapter — receive events from other instances (blocked in SUBSCRIBE mode)

pubClient.duplicate() creates a new connection that inherits all the config (URL, retry strategy) from pubClient. 
This is the correct way to create the sub client — no config duplication
*/

export const pubClient = new Redis(process.env.REDIS_URL, {
    retryStrategy(times) {
        return Math.min(times * 100, 3000);
    }
});

export const subClient = pubClient.duplicate({ enableReadyCheck: false });

pubClient.on('error', (err) => logger.error({ err }, 'Redis pub client error'));
subClient.on('error', (err) => logger.error({ err }, 'Redis sub client error'));

export async function closeAdapterConnections() {
    await Promise.all([pubClient.quit(), subClient.quit()]);
}