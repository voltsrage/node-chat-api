import {Queue} from 'bullmq';
import { createBullConnection } from './connection.js';

/*
    **`removeOnComplete` and `removeOnFail` are important for production:
    ** Without them, every completed and failed job stays in Redis indefinitely. 
    For a busy queue, this grows without bound. `{ count: 100 }` is a sliding window — when the 101st job completes, 
    the oldest completed job is removed.
*/
export const emailQueue = new Queue('email', {
    connection: createBullConnection(),
    defaultJobOptions: {
        attempts: 3,
        backoff:{
            type: 'exponential',
            delay: 5000, // 1st retry: 5s, 2nd: 25s, 3rd: 125s
        },
        removeOnComplete: {count: 100},  // Keep last 100 completed jobs in Redis
        removeOnFail: {count: 500} // Keep last 500 failed jobs for inspection
    }
});