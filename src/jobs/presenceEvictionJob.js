import {evictStaleUsers} from '../services/presenceService.js';
import { logger } from '../utils/logger.js';

const INTERVAL_MS = 60 * 1000; // 60 seconds

// setInterval is sufficient here — no need for a BackgroundService abstraction. 
// The job runs every 60 seconds and removes entries from online:users older than 5 minutes. 
// It returns a cleanup function so it can be stopped gracefully on process shutdown
export function startPresenceEvictionJob() {
    async function tick(){
        try{
            const removed = await evictStaleUsers();
            if(removed > 0){
                logger.info({ removed }, 'Presence eviction: removed stale users from online:users');
            }
        }
        catch (err)
        {
            logger.error({ err }, 'Presence eviction job error');
        }
    }

    const timer = setInterval(tick, INTERVAL_MS);
    logger.info({ intervalMs: INTERVAL_MS }, 'Presence eviction job started');

    return () => clearInterval(timer);
}