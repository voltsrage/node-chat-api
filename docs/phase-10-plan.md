# Phase 10 — Health Checks

## What exists

From Phase 9:
- `src/app.js` — Express app with middleware chain, all routes mounted
- `src/db/connect.js` — Mongoose connection (`mongoose.connection`)
- `src/db/redis.js` — `ioredis` client (`redis`)
- `ApiResponse` — standard envelope; deliberately NOT used for health endpoints (see Step 1)

## What needs to be built

Four steps. The central concept is the **liveness vs readiness distinction** — two endpoints that answer two different questions and are consumed by two different systems.

| Endpoint | Question | Consumer | Failure action |
|---|---|---|---|
| `GET /health` | Is the process alive? | Docker `HEALTHCHECK`, uptime monitors | Restart the container |
| `GET /health/ready` | Is the app ready to serve traffic? | Load balancer, Nginx upstream, Kubernetes readiness probe | Remove from the upstream pool |

These must be separate because the failure actions are different. If the database goes down, the API process is still alive and will recover when the DB comes back — Docker should not restart it. But the load balancer should stop sending new requests to it. Using the same endpoint for both wires the wrong action to the wrong signal.

---

## Step 1 — Health controller

Health endpoints do **not** use `ApiResponse`. Orchestrators and load balancers parse status codes and expect a simple body shape — wrapping in `{ data: { ... } }` is unconventional and forces clients to unwrap unnecessarily.

The readiness check wraps each dependency in its own `try/catch` so one failure does not prevent the other from being checked. The response always enumerates all checks, whether passing or failing — this is more useful for debugging than a single `503` with no body.

A 2-second `Promise.race` timeout guards against a dependency that hangs instead of failing fast. Without it, the request handler could hang for the full TCP timeout (up to 2 minutes), blocking the health check from responding.

**`src/controllers/healthController.js`:**

```js
import mongoose from 'mongoose';
import { redis } from '../db/redis.js';
import { logger } from '../utils/logger.js';

const withTimeout = (promise, ms) =>
  Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms)
    ),
  ]);

export function liveness(_req, res) {
  // No dependency checks — this endpoint must always return 200
  // as long as the Node.js process is running
  res.json({ status: 'ok' });
}

export async function readiness(_req, res) {
  const checks = {};
  let healthy = true;

  try {
    await withTimeout(mongoose.connection.db.admin().ping(), 2000);
    checks.mongodb = 'ok';
  } catch (err) {
    logger.warn({ err }, 'Readiness check: MongoDB ping failed');
    checks.mongodb = 'error';
    healthy = false;
  }

  try {
    await withTimeout(redis.ping(), 2000);
    checks.redis = 'ok';
  } catch (err) {
    logger.warn({ err }, 'Readiness check: Redis ping failed');
    checks.redis = 'error';
    healthy = false;
  }

  res.status(healthy ? 200 : 503).json({
    status: healthy ? 'ok' : 'degraded',
    checks,
  });
}
```

**Response shapes:**

```json
// 200 — all dependencies reachable
{ "status": "ok", "checks": { "mongodb": "ok", "redis": "ok" } }

// 503 — MongoDB unreachable
{ "status": "degraded", "checks": { "mongodb": "error", "redis": "ok" } }
```

---

## Step 2 — Health router

No auth middleware — health endpoints must be reachable before authentication is possible (the auth system itself may be down). Mounting them on a dedicated router without `authenticate` keeps the intent explicit.

**`src/routes/health.js`:**

```js
import { Router } from 'express';
import { liveness, readiness } from '../controllers/healthController.js';

export const healthRouter = Router();

/**
 * @openapi
 * /health:
 *   get:
 *     summary: Liveness probe — is the process alive?
 *     tags: [Health]
 *     responses:
 *       '200': { description: Process is running }
 */
healthRouter.get('/', liveness);

/**
 * @openapi
 * /health/ready:
 *   get:
 *     summary: Readiness probe — are all dependencies reachable?
 *     tags: [Health]
 *     responses:
 *       '200': { description: All dependencies healthy }
 *       '503': { description: One or more dependencies unreachable }
 */
healthRouter.get('/ready', readiness);
```

---

## Step 3 — Mount in app.js

Health routes are mounted **before** all other routes and before `authenticate`. This ensures `GET /health` responds even when the auth system is degraded, and ensures load balancers that hit these endpoints before the app is fully warmed up do not receive 401s.

**`src/app.js`** — add before the auth and rooms routers:

```js
import { healthRouter } from './routes/health.js';

// Health checks — no auth, no rate limiting, mounted first
app.use('/health', healthRouter);

// All other routes below...
app.use('/api/v1/auth',  authRouter);
app.use('/api/v1/rooms', roomsRouter);
app.use('/api/v1/users', usersRouter);
```

---

## Step 4 — Dockerfile HEALTHCHECK

The `HEALTHCHECK` instruction tells Docker's container runtime how to determine whether a container is healthy. A container that fails health checks is marked `(unhealthy)` in `docker ps` and can be automatically restarted by restart policies.

**Why `GET /health` (liveness), not `GET /health/ready` (readiness):**

`HEALTHCHECK` failure triggers a container restart. If `/health/ready` is used and MongoDB goes down, Docker marks the API container unhealthy and restarts it — but the API process itself is fine and will recover automatically when MongoDB comes back. Restarting the API accomplishes nothing except losing in-memory state and active socket connections. Use the liveness probe here.

**`Dockerfile`** — add to the final stage:

```dockerfile
FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY src ./src

EXPOSE 3000

# curl is not in alpine by default — wget is
HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
  CMD wget -qO- http://localhost:3000/health || exit 1

CMD ["node", "src/index.js"]
```

| Flag | Value | Purpose |
|---|---|---|
| `--interval=30s` | 30 seconds | How often Docker checks health |
| `--timeout=10s` | 10 seconds | Max time the check command is allowed to run |
| `--start-period=15s` | 15 seconds | Grace period after container starts before failures count |
| `--retries=3` | 3 | Consecutive failures required before marking `(unhealthy)` |

`--start-period` is important: without it, health checks begin immediately at container start. The Node.js process takes a few seconds to connect to MongoDB and Redis, so the first check would fail and count against the retry limit.

---

## Verification

**1. Both endpoints return 200 when healthy:**

```bash
curl -s http://localhost:3000/health
# Expected: { "status": "ok" }

curl -s http://localhost:3000/health/ready
# Expected: { "status": "ok", "checks": { "mongodb": "ok", "redis": "ok" } }
```

**2. Readiness returns 503 when MongoDB is stopped:**

```bash
# Stop the MongoDB container
docker stop <mongo-container-name>

curl -s http://localhost:3000/health/ready
# Expected: 503 { "status": "degraded", "checks": { "mongodb": "error", "redis": "ok" } }

# Liveness is unaffected — the process is still running
curl -s http://localhost:3000/health
# Expected: 200 { "status": "ok" }
```

**3. Readiness returns 503 when Redis is stopped:**

```bash
docker stop <redis-container-name>

curl -s http://localhost:3000/health/ready
# Expected: 503 { "status": "degraded", "checks": { "mongodb": "ok", "redis": "error" } }
```

**4. Confirm the 2-second timeout fires (simulate a hanging dependency):**

```bash
# Add a temporary delay in mongosh to simulate a slow primary election:
# This is harder to simulate in practice — the key thing to verify is that
# /health/ready responds within ~2 seconds even when a dependency is unreachable,
# rather than hanging for 30+ seconds on a TCP timeout
time curl -s http://localhost:3000/health/ready
# Expected: real time < 3s even with MongoDB stopped
```

**5. Docker health status:**

```bash
# Build and start containers
docker compose up -d

# Check health status
docker ps
# Expected: api container shows "(healthy)" after ~45s (start-period + interval)

# Stop MongoDB
docker compose stop mongo

# Wait 30–90 seconds (3 retries × 30s interval)
docker ps
# Expected: api container shows "(unhealthy)"

# Restart MongoDB
docker compose start mongo

# Wait 30s
docker ps
# Expected: api container returns to "(healthy)"
```

**6. Confirm health endpoints require no auth token:**

```bash
# No Authorization header — should succeed
curl -s http://localhost:3000/health
# Expected: 200 — no 401

curl -s http://localhost:3000/health/ready
# Expected: 200 — no 401
```

---

## File map

| File | Status |
|---|---|
| `src/controllers/healthController.js` | New — `liveness`, `readiness`; `withTimeout` wrapper; no `ApiResponse` |
| `src/routes/health.js` | New — `GET /` and `GET /ready`; no auth; Swagger JSDoc |
| `src/app.js` | Updated — `healthRouter` mounted at `/health` before all other routes |
| `Dockerfile` | Updated — `HEALTHCHECK` using `wget` on `GET /health` |

---

## Checklist

- [ ] Step 1 — `liveness` returns `200` with no dependency checks — always succeeds while the process runs
- [ ] Step 1 — `readiness` wraps MongoDB and Redis in separate `try/catch` blocks so one failure does not skip the other check
- [ ] Step 1 — `withTimeout` wraps each ping in a `Promise.race` with a 2-second timeout
- [ ] Step 1 — Response body is `{ status, checks }` — NOT wrapped in `ApiResponse`
- [ ] Step 1 — `503` status code returned when any check fails
- [ ] Step 2 — Health router has no `authenticate` middleware
- [ ] Step 3 — `healthRouter` mounted before `authRouter`, `roomsRouter`, and `usersRouter` in `app.js`
- [ ] Step 4 — `HEALTHCHECK` uses `GET /health` (liveness), not `GET /health/ready` (readiness)
- [ ] Step 4 — `--start-period=15s` gives the process time to connect before failures count
- [ ] Step 4 — Can explain why using `/health/ready` for Docker `HEALTHCHECK` causes incorrect container restarts
- [ ] Verification — `GET /health` returns `200` with MongoDB stopped
- [ ] Verification — `GET /health/ready` returns `503` with MongoDB stopped; body identifies `mongodb` as the failing check
- [ ] Verification — Both endpoints return `200` without an `Authorization` header
- [ ] Verification — `GET /health/ready` responds in under 3 seconds when a dependency is unreachable (timeout fires)
- [ ] Knowledge check — Can explain liveness vs readiness and when each probe should fail
- [ ] Knowledge check — Can explain why the Docker `HEALTHCHECK` should use the liveness probe, not the readiness probe
