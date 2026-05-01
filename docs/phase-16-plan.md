# Phase 16 — Async Job Queue (BullMQ)

## What exists

From Phase 15:
- `src/services/authService.js` — `register`, `resendVerification`, `forgotPassword` each call `sendVerificationEmail` or `sendPasswordResetEmail` directly, blocking the request until the SMTP response arrives
- `src/utils/email.js` — Nodemailer transporter, two send functions
- `docker-compose.yml` — 5 services; no worker service yet

## What needs to be built

Five steps. The core problem being solved: email delivery is external I/O with no latency guarantee. A slow or temporarily unavailable SMTP server currently makes `/register` time out for the user. The queue decouples the request from the side effect — the API adds a job and returns immediately; a separate worker process picks it up and handles retries without the user waiting.

```
Before:  POST /register → bcrypt → MongoDB → sendEmail (SMTP, 200–2000ms) → 200 OK
After:   POST /register → bcrypt → MongoDB → queue.add (Redis, <5ms) → 200 OK
                                                        ↓
                                               worker picks up job
                                               → sendEmail (SMTP, retried on failure)
```

---

## Step 1 — BullMQ connection config

Install BullMQ:

```bash
npm install bullmq
```

BullMQ requires its own dedicated Redis connections — it must not share the connection used for data operations. The reason: BullMQ internally uses blocking Redis commands (like `BRPOPLPUSH`) that hold the connection open waiting for work. A shared connection would block all data operations (GET, SET, ZADD, etc.) while waiting.

BullMQ also requires `maxRetriesPerRequest: null` on the ioredis instance. By default, ioredis retries failed commands a fixed number of times. For blocking commands, this causes premature errors — `null` tells ioredis to retry indefinitely (or until the connection closes), which is what BullMQ needs.

**`src/queues/connection.js`** — shared connection factory for all queues and workers:

```js
import Redis from 'ioredis';
import { logger } from '../utils/logger.js';

export function createBullConnection() {
  const conn = new Redis(process.env.REDIS_URL, {
    maxRetriesPerRequest: null,  // Required by BullMQ — do not remove
    retryStrategy(times) {
      return Math.min(times * 100, 3000);
    },
  });

  conn.on('error', (err) => logger.error({ err }, 'BullMQ Redis connection error'));

  return conn;
}
```

A factory function rather than a singleton because Queue and Worker each need their own connection — BullMQ calls `.duplicate()` internally, but starting from isolated instances is cleaner and avoids accidental state sharing.

---

## Step 2 — Email queue

**`src/queues/emailQueue.js`:**

```js
import { Queue } from 'bullmq';
import { createBullConnection } from './connection.js';

export const emailQueue = new Queue('email', {
  connection: createBullConnection(),
  defaultJobOptions: {
    attempts: 3,
    backoff: {
      type:  'exponential',
      delay: 5000,   // 1st retry: 5s, 2nd: 25s, 3rd: 125s
    },
    removeOnComplete: { count: 100 },  // Keep last 100 completed jobs in Redis
    removeOnFail:     { count: 500 },  // Keep last 500 failed jobs for inspection
  },
});
```

**`removeOnComplete` and `removeOnFail` are important for production:** Without them, every completed and failed job stays in Redis indefinitely. For a busy queue, this grows without bound. `{ count: 100 }` is a sliding window — when the 101st job completes, the oldest completed job is removed.

**Job names used in this queue:**

| Job name | Data | Triggered by |
|---|---|---|
| `send-verification` | `{ to, token }` | `register`, `resendVerification` |
| `send-reset` | `{ to, token }` | `forgotPassword` |

Job names function as a routing key — the worker uses them to call the right email function.

---

## Step 3 — Email worker

The worker runs as a **separate process** (`node src/workers/emailWorker.js`). Separation is intentional:

- The API process handles HTTP requests — low latency is critical
- The worker process handles email delivery — latency does not affect the user
- If the worker crashes (malformed template, OOM from a large queue), the API keeps serving requests
- Worker replicas can be scaled independently of API replicas

**`src/workers/emailWorker.js`:**

```js
import 'dotenv/config';
import { Worker } from 'bullmq';
import { sendVerificationEmail, sendPasswordResetEmail } from '../utils/email.js';
import { logger } from '../utils/logger.js';
import { createBullConnection } from '../queues/connection.js';

async function processEmail(job) {
  switch (job.name) {
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
  connection:  createBullConnection(),
  concurrency: 5,   // Process up to 5 emails simultaneously
});

worker.on('completed', (job) => {
  logger.info({ jobId: job.id, name: job.name, to: job.data.to }, 'Email sent');
});

worker.on('failed', (job, err) => {
  logger.error(
    { jobId: job.id, name: job.name, attempt: job.attemptsMade, err },
    'Email job failed'
  );
});

worker.on('error', (err) => {
  logger.error({ err }, 'Worker error');
});

logger.info({ concurrency: 5 }, 'Email worker started');

// Graceful shutdown — finish in-progress jobs before exiting
process.on('SIGTERM', async () => {
  logger.info('SIGTERM received — closing email worker');
  await worker.close();
  process.exit(0);
});
```

**`concurrency: 5`** means the worker processes up to 5 jobs at the same time. Each job awaits an SMTP call — without concurrency > 1, jobs would be processed one at a time serially, which is wasteful since most of the job's time is spent waiting on the network.

**Retry behaviour with `attempts: 3` and `exponential` backoff:**

| Attempt | Delay before retry |
|---|---|
| 1 (initial) | — |
| 2 (first retry) | 5 seconds |
| 3 (second retry) | 25 seconds (5 × 5) |
| After 3 failures | Job moves to `failed` state |

Failed jobs remain in Redis (up to the `removeOnFail` count) and can be inspected or manually retried later.

---

## Step 4 — Update authService to enqueue

Replace every direct `sendVerificationEmail` / `sendPasswordResetEmail` call with `emailQueue.add(...)`. The service no longer imports from `email.js`.

**`src/services/authService.js`** — swap import and update three functions:

```js
// Remove:
// import { sendVerificationEmail, sendPasswordResetEmail } from '../utils/email.js';

// Add:
import { emailQueue } from '../queues/emailQueue.js';

// ── register ──────────────────────────────────────────────────────────────────
export async function register({ username, email, password }) {
  // ... existing user creation and token generation ...

  await redis.set(`email-verify:${token}`, user._id.toString(), 'EX', VERIFY_TOKEN_TTL);

  // Enqueue instead of await — returns in <5ms regardless of SMTP availability
  await emailQueue.add('send-verification', { to: email, token });

  return { accessToken, refreshToken };
}

// ── resendVerification ────────────────────────────────────────────────────────
export async function resendVerification(userId) {
  // ... existing rate limit and user lookup ...

  await redis.set(`email-verify:${token}`, userId.toString(), 'EX', VERIFY_TOKEN_TTL);

  await emailQueue.add('send-verification', { to: user.email, token });
}

// ── forgotPassword ────────────────────────────────────────────────────────────
export async function forgotPassword(email) {
  // ... existing rate limit and user lookup ...

  await redis.set(`pwd-reset:${token}`, user._id.toString(), 'EX', RESET_TOKEN_TTL);

  await emailQueue.add('send-reset', { to: email, token });
}
```

`await emailQueue.add(...)` still awaits — it waits for the job to be written to Redis (fast), not for the email to be sent. The worker picks it up asynchronously.

---

## Step 5 — docker-compose.yml worker service + monitoring

**`docker-compose.yml`** — add the `worker` service:

```yaml
  worker:
    build: .
    command: node src/workers/emailWorker.js
    env_file: .env
    environment:
      - NODE_ENV=production
    depends_on:
      redis:
        condition: service_healthy
      # No mongo dependency — email worker only needs Redis
    networks:
      - internal
    restart: unless-stopped
```

The worker does not expose any ports and does not depend on MongoDB — it only reads job data from Redis and calls an external SMTP server.

**Optional — Bull Board dashboard:**

Bull Board provides a web UI for inspecting queue state, viewing failed jobs, and manually retrying them.

```bash
npm install @bull-board/api @bull-board/express
```

**`src/routes/admin.js`** — mount the dashboard (protect with basic auth or restrict by IP in production):

```js
import { createBullBoard }    from '@bull-board/api';
import { BullMQAdapter }      from '@bull-board/api/bullMQAdapter.js';
import { ExpressAdapter }     from '@bull-board/express';
import { emailQueue }         from '../queues/emailQueue.js';

const serverAdapter = new ExpressAdapter();
serverAdapter.setBasePath('/admin/queues');

createBullBoard({
  queues:        [new BullMQAdapter(emailQueue)],
  serverAdapter,
});

export const adminRouter = serverAdapter.getRouter();
```

**`src/app.js`:**

```js
import { adminRouter } from './routes/admin.js';
app.use('/admin/queues', adminRouter);
// Restrict to internal IPs or add basic auth before deploying
```

Access at `http://localhost:3000/admin/queues`.

---

## Verification

**1. Registration no longer blocks on SMTP:**

```bash
# Time the register request before and after this phase
time curl -s -X POST http://localhost:3000/api/v1/auth/register \
  -H 'Content-Type: application/json' \
  -d '{"username":"alice","email":"alice@example.com","password":"secret123"}'

# Before Phase 16: real time ~200–500ms (SMTP round-trip included)
# After Phase 16:  real time ~20–50ms (only bcrypt + MongoDB + Redis write)
```

**2. Job appears in Redis:**

```bash
# Immediately after registering — before the worker processes it
redis-cli KEYS "bull:email:*"
# Expected: keys representing the queued job

redis-cli LLEN "bull:email:wait"
# Expected: 1 (job waiting to be picked up by the worker)
```

**3. Worker processes the job:**

```bash
# Watch worker logs
docker compose logs -f worker

# Expected output after registration:
# { "msg": "Email sent", "jobId": "1", "name": "send-verification", "to": "alice@example.com" }
```

**4. Retry behaviour — simulate SMTP failure:**

```bash
# 1. Set an invalid SMTP password in .env:
SMTP_PASS=wrongpassword

# 2. Restart only the worker container (not the API)
docker compose restart worker

# 3. Register a new user
# 4. Watch worker logs — expect retry attempts with increasing delays:
# Attempt 1: failed — will retry in 5s
# Attempt 2: failed — will retry in 25s
# Attempt 3: failed — job moved to 'failed' state

# 5. In Bull Board (/admin/queues), the failed job is visible with the error details
# 6. Restore the correct SMTP password, click "Retry" in Bull Board
# Expected: job succeeds on the next attempt
```

**5. Worker failure does not affect the API:**

```bash
# Kill the worker process
docker compose stop worker

# Register a new user — API returns 200 immediately
# Job is queued in Redis

# Start the worker again
docker compose start worker

# Worker picks up the pending job and sends the email
# Emails are not lost even during worker downtime
```

**6. Confirm job cleanup (removeOnComplete):**

```bash
# After many registrations, completed job count stays bounded
redis-cli LLEN "bull:email:completed"
# Expected: at most 100 (removeOnComplete: { count: 100 })
```

---

## File map

| File | Status |
|---|---|
| `src/queues/connection.js` | New — `createBullConnection` factory; `maxRetriesPerRequest: null` |
| `src/queues/emailQueue.js` | New — `emailQueue` with retry config and job retention limits |
| `src/workers/emailWorker.js` | New — `Worker` processing `send-verification` and `send-reset`; concurrency 5; graceful shutdown |
| `src/services/authService.js` | Updated — `register`, `resendVerification`, `forgotPassword` enqueue jobs instead of calling email functions |
| `src/routes/admin.js` | New (optional) — Bull Board dashboard mounted at `/admin/queues` |
| `src/app.js` | Updated (optional) — mount `adminRouter` |
| `docker-compose.yml` | Updated — add `worker` service running `emailWorker.js` |

---

## Checklist

- [ ] Step 1 — `createBullConnection` sets `maxRetriesPerRequest: null`; can explain why this is required
- [ ] Step 1 — Bull connections are separate from the data `redis` client — can explain why
- [ ] Step 2 — `emailQueue` sets `defaultJobOptions` with `attempts: 3` and exponential backoff
- [ ] Step 2 — `removeOnComplete: { count: 100 }` and `removeOnFail: { count: 500 }` prevent unbounded Redis growth
- [ ] Step 3 — Worker runs as a separate process with its own `dotenv/config` import
- [ ] Step 3 — `concurrency: 5` — can explain why > 1 is correct for I/O-bound jobs
- [ ] Step 3 — `worker.on('failed')` logs `job.attemptsMade` — shows which retry failed
- [ ] Step 3 — Graceful shutdown calls `worker.close()` before `process.exit`
- [ ] Step 4 — `emailQueue.add` replaces direct `sendVerificationEmail` calls in all three authService functions
- [ ] Step 4 — `await emailQueue.add(...)` awaits the Redis write (fast), not the email delivery
- [ ] Step 5 — `worker` service in docker-compose has no `mongo` dependency
- [ ] Step 5 — Worker downtime does not lose jobs — they remain queued in Redis
- [ ] Verification — Registration response time drops significantly (no SMTP round-trip)
- [ ] Verification — Failed jobs appear in Bull Board and can be manually retried
- [ ] Verification — Jobs queued during worker downtime are processed when worker restarts
- [ ] Knowledge check — Can explain the three arguments for running the worker as a separate process
- [ ] Knowledge check — Can explain what `maxRetriesPerRequest: null` does and why BullMQ requires it
- [ ] Knowledge check — Can explain why `await emailQueue.add(...)` is fast even though it awaits
- [ ] Knowledge check — Can explain the exponential backoff delays (5s → 25s → 125s) and why exponential is preferred over fixed intervals
