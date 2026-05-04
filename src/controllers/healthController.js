import mongoose from 'mongoose';
import {redis} from '../db/redis.js';
import { logger } from '../utils/logger.js';

const withTimeout = (promise, ms) => 
    Promise.race([
        promise,
        new Promise((_, reject) =>
            setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms)
        )
    ]);

export function liveness(_req, res){
    // No dependency checks — this endpoint must always return 200
    // as long as the Node.js process is running
    res.json({status: 'ok'});
}

export async function readiness(_req, res){
    const checks = {};
    let healthy = true;

    try{
        await withTimeout(mongoose.connection.db.admin().ping(), 2000);
        checks.mongodb = 'ok';
    }
    catch (err){
        logger.warn({ err }, 'Readiness check: MongoDB ping failed');
        checks.mongodb = 'error';
        healthy = false;
    }

    try{
        await withTimeout(redis.ping(), 2000);
        checks.redis = 'ok';
    }
    catch (err){
        logger.warn({err}, 'Readiness check: Redis ping failed');
        checks.redis = 'error';
        healthy = false;
    }

    res.status(healthy ? 200 : 503).json({
        status: healthy ? 'ok' :'degraded', checks
    })
}   