import 'dotenv/config';
import { Worker } from 'bullmq';
import {sendVerificationEmail, sendPasswordResetEmail} from '../utils/email.js';
import { logger } from '../utils/logger.js';
import { createBullConnection } from '../queues/connection.js';

/*
    **`concurrency: 5`** means the worker processes up to 5 jobs at the same time. 
    Each job awaits an SMTP call — without concurrency > 1, jobs would be processed one at a time serially, 
    which is wasteful since most of the job's time is spent waiting on the network.
*/
async function processEmail(job){
    switch(job.name){
        case 'send-verification':
            await sendVerificationEmail(job.data.to, job.data.token);
            break;
        case 'send-reset':
            await sendPasswordResetEmail(job.data.to, job.data.token);
            break;
        default:
            // Throwing causes BullMQ to mark the job as failed and retry
            throw new Error(`Unknown job name: ${job.name}`);
    }    
}

const worker = new Worker('email', processEmail, {
    connection: createBullConnection(),
    concurrency: 5, // Process up to 5 emails simultaneously
});

worker.on('completed', (job) => {
    logger.info({ jobId: job.id, name: job.name, to: job.data.to }, 'Email sent');
})

worker.on('failed', (job) => {
    logger.error(
        { jobId: job.id, name: job.name, attempt: job.attemptsMade, err },
        'Email job failed'
    );
});

worker.on('error', (job) => {
    logger.error({ err }, 'Worker error');
});

logger.info({concurrency: 5}, 'Email worker started');

process.on('SIGTERM', async() => {
    logger.info('SIGTERM received — closing email worker');
    await worker.close();
    process.exit(0);
});