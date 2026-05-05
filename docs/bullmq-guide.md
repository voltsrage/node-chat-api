# BullMQ Guide: Job Queues in This Application

This guide explains how BullMQ is used in this codebase, why certain decisions were made, and how the pieces connect.

---

## What Problem Does BullMQ Solve?

Sending an email over SMTP is slow and unreliable. If done synchronously — awaiting the SMTP call inside a request handler — the HTTP response blocks until the email is delivered. Worse, if the SMTP server is temporarily down, the entire request fails.

BullMQ decouples the work from the request/response cycle:

1. The request handler **enqueues** the job and returns immediately (~5ms)
2. A **worker** process picks up the job and does the SMTP call independently
3. If the worker fails, BullMQ **retries** automatically with backoff

The user gets a fast response. The email is still delivered even if the SMTP server hiccups.

---

## Architecture Overview

```
HTTP Request
     │
     ▼
authService.js          (producer)
  └─ emailQueue.add()
         │
         ▼
    Redis (BullMQ)       (broker)
  ┌──────────────────┐
  │  email queue     │
  │  ┌─────────────┐ │
  │  │ Job: {...}  │ │
  │  │ Job: {...}  │ │
  │  └─────────────┘ │
  └──────────────────┘
         │
         ▼
  emailWorker.js         (consumer)
  └─ processEmail()
       └─ sendVerificationEmail() / sendPasswordResetEmail()
```

The producer and consumer share no direct code dependency — they communicate through Redis. This means the worker can be restarted, scaled, or replaced without touching the producer.

---

## File Map

| File | Role |
|---|---|
| `src/queues/connection.js` | Creates a Redis connection configured for BullMQ |
| `src/queues/email.queue.js` | Defines the `email` queue with retry and retention settings |
| `src/workers/emailWorker.js` | Processes jobs from the `email` queue |
| `src/services/authService.js` | Enqueues jobs (the producer) |
| `src/routes/admin.js` | Mounts Bull Board, a UI for monitoring queues |

---

## The Redis Connection

BullMQ requires its own `ioredis` instance, separate from the general Redis client used for sessions and presence.

```js
// src/queues/connection.js
export function createBullConnection() {
    const conn = new Redis(process.env.REDIS_URL, {
        maxRetriesPerRequest: null,
        retryStrategy(times) {
            return Math.min(times * 100, 3000);
        }
    });

    conn.on('error', (err) => logger.error({ err }, 'BullMQ Redis connection error'));

    return conn;
}
```

**Why `maxRetriesPerRequest: null`?**

By default, ioredis retries a failed command a fixed number of times, then rejects the promise. BullMQ uses [blocking Redis commands](https://redis.io/docs/latest/commands/blpop/) (like `BLPOP`) that can legitimately wait for minutes. If ioredis gives up on those commands early, the worker crashes. Setting this to `null` tells ioredis to keep retrying indefinitely — which is exactly what BullMQ needs.

> **Why a separate connection?** The general Redis client in `src/db/redis.js` cannot use `maxRetriesPerRequest: null`. That client is used in request handlers where a hung command would block the entire event loop. BullMQ's long-polling operations must not share a connection with short-lived commands.

---

## The Email Queue

```js
// src/queues/email.queue.js
export const emailQueue = new Queue('email', {
    connection: createBullConnection(),
    defaultJobOptions: {
        attempts: 3,
        backoff: {
            type: 'exponential',
            delay: 5000, // 1st retry: 5s, 2nd: 25s, 3rd: 125s
        },
        removeOnComplete: { count: 100 },
        removeOnFail: { count: 500 },
    }
});
```

### Retry Strategy

Each job gets up to 3 attempts with exponential backoff:

```
Attempt 1: immediate
Attempt 2: wait 5s   (5000ms × 5⁰)
Attempt 3: wait 25s  (5000ms × 5¹)
→ after all attempts: job moved to "failed" state
```

Exponential backoff prevents hammering an SMTP server that's temporarily overloaded — each failure gives it more time to recover before trying again.

### Job Retention

Without explicit retention settings, BullMQ keeps every completed and failed job in Redis forever. On a busy queue, this grows without bound and bloats memory.

- **`removeOnComplete: { count: 100 }`** — keeps a sliding window of the last 100 completed jobs. When job 101 completes, job 1 is deleted.
- **`removeOnFail: { count: 500 }`** — keeps the last 500 failed jobs so they can be inspected via Bull Board before being purged.

The asymmetry (100 completed vs. 500 failed) is intentional: failed jobs need to be debugged, so they're retained longer.

---

## The Email Worker

```js
// src/workers/emailWorker.js
async function processEmail(job) {
    switch (job.name) {
        case 'send-verification':
            await sendVerificationEmail(job.data.to, job.data.token);
            break;
        case 'send-reset':
            await sendPasswordResetEmail(job.data.to, job.data.token);
            break;
        default:
            throw new Error(`Unknown job name: ${job.name}`);
    }
}

const worker = new Worker('email', processEmail, {
    connection: createBullConnection(),
    concurrency: 5,
});
```

### Concurrency

`concurrency: 5` allows the worker to process up to 5 jobs simultaneously. Each job spends most of its time waiting on a network round-trip to the SMTP server — that wait is I/O, not CPU. Without concurrency, 5 queued emails would take 5× as long because they'd run serially. With concurrency, all 5 fire in parallel and finish in roughly the time it takes to send one.

Concurrency is set to 5 rather than a higher number to avoid triggering SMTP rate limits. Most SMTP providers throttle clients that open too many simultaneous connections.

### Job Dispatch by Name

The worker uses `job.name` (not a separate queue per email type) to decide what to do. This is simpler than running multiple queues and gives a single place to observe all email traffic. Adding a new email type means adding a new `case` in one switch and one `emailQueue.add(...)` call — no new queue or worker needed.

Throwing from the processor function tells BullMQ to mark the job as failed and schedule a retry. An `unknown job name` error is not retryable (the job data is wrong), but it surfaces in Bull Board rather than failing silently.

### Graceful Shutdown

```js
process.on('SIGTERM', async () => {
    logger.info('SIGTERM received — closing email worker');
    await worker.close();
    process.exit(0);
});
```

`worker.close()` waits for any in-progress jobs to finish before shutting down. Without this, a SIGTERM (e.g. from a container restart) could interrupt a job mid-SMTP-call, causing that job to be retried from the start. The close call gives those jobs a chance to complete cleanly.

---

## Enqueuing Jobs (Producer Side)

Jobs are enqueued in `authService.js` at three points:

```js
// Registration: send email verification
await emailQueue.add('send-verification', { to: email, token });

// Resend verification (rate-limited to 3/hour)
await emailQueue.add('send-verification', { to: email, token });

// Forgot password: send reset link
await emailQueue.add('send-reset', { to: email, token });
```

`emailQueue.add()` writes the job to Redis and returns. It does not wait for the email to be sent — that happens asynchronously in the worker process. The HTTP response goes out immediately, regardless of SMTP availability.

### Job Data Shape

All email jobs share the same data shape:

```js
{
  to: string,     // recipient address
  token: string   // verification or reset token
}
```

The `job.name` field determines which email template is used; the `job.data` fields are passed through to the mailer utility.

---

## Queue Monitoring (Bull Board)

```js
// src/routes/admin.js
createBullBoard({
    queues: [new BullMQAdapter(emailQueue)],
    serverAdapter,
});

export const adminRouter = serverAdapter.getRouter();
```

Bull Board is mounted at `/admin/queues`. It provides a web UI showing:

- Active, waiting, completed, and failed job counts
- Per-job details: payload, timestamps, attempt history, error messages
- Manual controls: retry a failed job, delete a job, pause/resume the queue

This is the first place to look when emails aren't being delivered — failed jobs appear here with their error messages and stack traces.

> **Note:** The `/admin/queues` route currently has no authentication. It should be protected by an auth middleware before being exposed outside a trusted network.

---

## What BullMQ Is NOT Used For

The presence eviction job (`src/jobs/presenceEvictionJob.js`) runs on a `setInterval` rather than BullMQ. It runs every 60 seconds to remove stale presence entries from Redis sorted sets.

This task didn't need BullMQ because:

- It has no retry requirements — if one tick fails, the next one runs in 60 seconds
- It doesn't benefit from monitoring or inspection (it either ran or it didn't)
- It doesn't need to survive process restarts — stale entries will just age out on the next tick
- It's tightly coupled to the server process that owns the presence data

BullMQ adds operational complexity (a separate process, a monitored queue, retry state in Redis). That complexity is justified for email, where delivery is observable and failures need human attention. For a background cleanup sweep, `setInterval` is sufficient.

---

## Running the Worker

The email worker is a separate Node.js process — it is not started by the main API server. In development, run it alongside the server:

```bash
node src/workers/emailWorker.js
```

In production, the worker should be run as a separate service (separate container, PM2 process, or equivalent). This separation means the worker can be restarted independently without affecting the API, and the API can restart without dropping in-progress email jobs.

---

## Quick Reference

| Concept | Where | Detail |
|---|---|---|
| Queue definition | `src/queues/email.queue.js` | Name: `'email'`, 3 attempts, exponential backoff |
| Redis connection | `src/queues/connection.js` | Separate from app Redis; `maxRetriesPerRequest: null` |
| Worker | `src/workers/emailWorker.js` | Concurrency: 5; handles `send-verification`, `send-reset` |
| Producers | `src/services/authService.js` | Three call sites: register, resend, forgot-password |
| Monitoring UI | `/admin/queues` | Bull Board; no auth currently |
| Retry schedule | Queue defaults | 5s → 25s → 125s (exponential, base 5000ms) |
| Job retention | Queue defaults | 100 completed, 500 failed |
