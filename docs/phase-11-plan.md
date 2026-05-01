# Phase 11 — Docker Compose, Nginx, and GCP VM Deployment

## What exists

From Phase 10:
- Complete application code — all routes, socket handlers, services, middleware
- `Dockerfile` with `HEALTHCHECK` directive (basic single-stage version from Phase 10)
- `nginx/nginx.conf` — skeleton written in Phase 8; completed here
- `src/app.js` — Express app; needs `trust proxy` added (see Step 5)

## What needs to be built

Six steps. Three concepts to internalize before writing any config:

1. **Multi-stage Docker build** — the builder stage installs all dependencies; the production stage copies only what the running process needs. The goal is a small, clean image with no dev tooling or test files.
2. **Internal network isolation** — `mongo` and `redis` must not publish ports to the host. Only `nginx` faces the outside world. Any service that publishes a host port is an exposed attack surface.
3. **`trust proxy` in Express** — without this, `req.ip` returns Nginx's internal container IP, not the client's real IP. The auth rate limiter would then bucket all clients together and trigger after 10 total requests from anyone. This is a silent bug that only manifests behind a reverse proxy.

---

## Step 1 — Multi-stage Dockerfile

Two stages:

- **`deps` stage** — copies `package*.json` and runs `npm ci --omit=dev`. The result is a `node_modules` directory containing only production packages.
- **`production` stage** — starts from a clean base image, copies `node_modules` from the `deps` stage, then copies `src`. Source code changes do not invalidate the `node_modules` layer.

This separation means a code-only change (`src/**`) rebuilds in seconds — Docker reuses the cached `node_modules` layer from `deps`.

**`Dockerfile`:**

```dockerfile
# ── Stage 1: install production dependencies ──────────────────────────────────
FROM node:20-alpine AS deps
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev

# ── Stage 2: production image ─────────────────────────────────────────────────
FROM node:20-alpine
WORKDIR /app

# Copy pre-built node_modules from the deps stage — no npm install needed here
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
  CMD wget -qO- http://localhost:3000/health || exit 1

CMD ["node", "src/index.js"]
```

**Why not a single-stage build?**

A single-stage build that runs `npm ci` and then `COPY src` works, but every source change rebuilds `node_modules` because Docker invalidates all layers after the first changed layer. With two stages, `node_modules` is built once per `package.json` change, not per source file change.

---

## Step 2 — .dockerignore

Without `.dockerignore`, the build context sent to Docker includes `node_modules` (hundreds of MB), `.env`, test files, and git history. The `COPY src` instruction would still only copy `src/`, but Docker transfers the full context to the daemon before evaluating the Dockerfile.

**`.dockerignore`:**

```
node_modules
.env
.env.*
*.log
coverage
.git
docs
scripts
nginx
```

---

## Step 3 — docker-compose.yml

Five services on one internal bridge network. Only `nginx` publishes a host port. `mongo` and `redis` are reachable by other containers via their service names but are not reachable from outside the VM.

`depends_on` with `condition: service_healthy` ensures the API does not start until MongoDB and Redis pass their health checks — avoids a race where the app starts, tries to connect, and crashes before the DB is ready.

**`docker-compose.yml`:**

```yaml
services:
  api:
    build: .
    env_file: .env
    environment:
      - NODE_ENV=production
    depends_on:
      mongo:
        condition: service_healthy
      redis:
        condition: service_healthy
    networks:
      - internal
    deploy:
      replicas: 2
    restart: unless-stopped

  mongo:
    image: mongo:7
    # No 'ports' — not reachable from outside the VM
    volumes:
      - mongo_data:/data/db
    networks:
      - internal
    healthcheck:
      test: ["CMD", "mongosh", "--eval", "db.adminCommand('ping')"]
      interval: 10s
      timeout: 5s
      retries: 5
      start_period: 10s
    restart: unless-stopped

  redis:
    image: redis:7-alpine
    # No 'ports' — not reachable from outside the VM
    volumes:
      - redis_data:/data
    networks:
      - internal
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 10s
      timeout: 5s
      retries: 5
    restart: unless-stopped

  nginx:
    image: nginx:alpine
    ports:
      - "80:80"        # Only nginx faces the internet
    volumes:
      - ./nginx/nginx.conf:/etc/nginx/nginx.conf:ro
    depends_on:
      - api
    networks:
      - internal
    restart: unless-stopped

  seq:
    image: datalust/seq
    environment:
      - ACCEPT_EULA=Y
    ports:
      - "5341:5341"    # Ingestion endpoint — Pino sends logs here
      - "5380:80"      # Seq web UI — access at http://<vm-ip>:5380
    volumes:
      - seq_data:/data
    networks:
      - internal
    restart: unless-stopped

volumes:
  mongo_data:
  redis_data:
  seq_data:

networks:
  internal:
    driver: bridge
```

**Why `seq` publishes ports but `mongo` and `redis` do not:**

Seq's web UI is something you access from a browser to inspect logs — it needs a host port. MongoDB and Redis hold application data; no human or external tool needs to reach them directly on the VM. Exposing them would require securing another authentication layer against brute-force attacks.

**`deploy.replicas: 2` with plain Compose:**

`deploy.replicas` is honoured by `docker compose up` as of Docker Compose v2. Docker assigns both containers to the `internal` network under the service name `api`. Docker's internal DNS resolver returns both IPs when `api` is looked up, so Nginx's upstream sees two backends.

---

## Step 4 — nginx/nginx.conf

Three concerns handled here:

1. **Sticky sessions** (`ip_hash`) — required for the Socket.io handshake (explained in Phase 8)
2. **WebSocket upgrade headers** — required for the HTTP → WebSocket protocol upgrade
3. **Nginx-layer rate limiting** on auth endpoints — a second line of defence in front of the Redis rate limiter built in Phase 9

`limit_req_zone` defines a shared memory zone (`auth_limit`) that tracks request rates per IP. `limit_req` applies it to specific locations. The `burst=5 nodelay` setting allows a short burst without queuing.

**`nginx/nginx.conf`:**

```nginx
# Shared memory zone for auth rate limiting — 10 MB stores ~160,000 IP entries
limit_req_zone $binary_remote_addr zone=auth_limit:10m rate=10r/m;

upstream api {
    ip_hash;            # Sticky sessions — routes same IP to same instance
    server api:3000;    # Docker DNS resolves 'api' to both replica IPs
}

server {
    listen 80;

    # ── Socket.io ─────────────────────────────────────────────────────────────
    # Nginx strips hop-by-hop headers (Upgrade, Connection) by default.
    # Without these two proxy_set_header directives the WebSocket handshake
    # fails silently and the client falls back to HTTP long-polling.
    location /socket.io/ {
        proxy_pass         http://api;
        proxy_http_version 1.1;
        proxy_set_header   Upgrade         $http_upgrade;
        proxy_set_header   Connection      "upgrade";
        proxy_set_header   Host            $host;
        proxy_set_header   X-Real-IP       $remote_addr;
        proxy_set_header   X-Forwarded-For $proxy_add_x_forwarded_for;
    }

    # ── Auth endpoints — rate limited at the proxy layer ──────────────────────
    location /api/v1/auth/login {
        limit_req zone=auth_limit burst=5 nodelay;
        proxy_pass       http://api;
        proxy_set_header Host            $host;
        proxy_set_header X-Real-IP       $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }

    location /api/v1/auth/register {
        limit_req zone=auth_limit burst=5 nodelay;
        proxy_pass       http://api;
        proxy_set_header Host            $host;
        proxy_set_header X-Real-IP       $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }

    # ── All other API traffic ─────────────────────────────────────────────────
    location / {
        proxy_pass       http://api;
        proxy_set_header Host            $host;
        proxy_set_header X-Real-IP       $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }
}
```

**`X-Forwarded-For` and `X-Real-IP`:**

Both headers pass the real client IP through to the Express app. Without them, every request appears to come from Nginx's container IP (`172.x.x.x`) — the rate limiter and logs would show Nginx's IP, not the client's.

---

## Step 5 — trust proxy in Express

`req.ip` in Express reads from the socket address by default — behind Nginx, that is Nginx's container IP. Setting `trust proxy` tells Express to read `req.ip` from the `X-Forwarded-For` header instead.

Without this, the Phase 9 auth rate limiter keys on `req.ip` and buckets every client under the same Nginx IP. The 10-request limit fires after 10 total requests from any user.

**`src/app.js`** — add one line after `const app = express()`:

```js
const app = express();

// Trust the first proxy (Nginx). Required for req.ip to return the real
// client IP instead of Nginx's internal container IP.
app.set('trust proxy', 1);
```

`1` means trust one hop — the immediate upstream proxy (Nginx). Setting it to `true` would trust all `X-Forwarded-For` entries in the chain, which is incorrect here and opens the app to IP spoofing via a forged header.

---

## Step 6 — GCP VM deployment

**Prerequisites on the VM (one-time):**

```bash
# Install Docker
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER
newgrp docker

# Verify
docker --version
docker compose version
```

**Deploy:**

```bash
# 1. Copy project files to the VM (from local machine)
gzip -c - | ssh <user>@<vm-ip> 'mkdir -p ~/teamchat && tar -xz -C ~/teamchat'
# Or: git clone directly on the VM if the repo is remote

# 2. SSH into the VM
ssh <user>@<vm-ip>
cd ~/teamchat

# 3. Create .env (never commit this file)
cat > .env <<'EOF'
NODE_ENV=production
PORT=3000
MONGO_URI=mongodb://mongo:27017/teamchat
REDIS_URL=redis://redis:6379
JWT_SECRET=<generate-with-openssl-rand-hex-64>
JWT_REFRESH_SECRET=<generate-with-openssl-rand-hex-64>
SEQ_URL=http://seq:5341
EOF

# Generate secrets:
# openssl rand -hex 64

# 4. Build and start all services
docker compose up -d --build

# 5. Check status
docker compose ps
docker compose logs api --tail=50
```

**GCP firewall rules** — allow inbound on these ports only:

| Port | Service | Who needs it |
|---|---|---|
| 22 | SSH | Your IP only (restrict source) |
| 80 | Nginx | Public |
| 5380 | Seq web UI | Your IP only |
| 5341 | Seq ingestion | Internal only — do not open this to the internet |

```bash
# Allow HTTP (nginx)
gcloud compute firewall-rules create allow-http \
  --allow tcp:80 --target-tags teamchat-vm

# Allow Seq UI from your IP only
gcloud compute firewall-rules create allow-seq-ui \
  --allow tcp:5380 --source-ranges <your-ip>/32 --target-tags teamchat-vm
```

**Rolling update after a code change:**

```bash
# On the VM — rebuild and restart only the api service
docker compose up -d --build api

# Confirm new containers are running
docker compose ps
```

---

## Verification

**1. All containers start healthy:**

```bash
docker compose ps
# Expected: all services show "running" or "healthy"
# api should show two replicas
```

**2. API reachable through Nginx:**

```bash
curl -s http://localhost/health
# Expected: { "status": "ok" }

curl -s http://localhost/health/ready
# Expected: { "status": "ok", "checks": { "mongodb": "ok", "redis": "ok" } }
```

**3. mongo and redis are NOT reachable from the host:**

```bash
# These should all fail or time out
curl http://localhost:27017
curl http://localhost:6379
# Expected: connection refused — ports are not published
```

**4. Socket.io handshake completes through Nginx:**

```bash
# Connect a test client through port 80 (Nginx), not 3000 (direct)
# In the test client:
const socket = io('http://<vm-ip>', { auth: { token: TOKEN } });
socket.on('connect', () => console.log('connected via Nginx'));
# Expected: connection established, transport = websocket (not polling)
```

**5. Sticky sessions — same client always reaches same instance:**

```bash
# Watch the api logs while connecting:
docker compose logs -f api

# Send a message — the log line showing "Socket connected" should
# appear on the SAME instance every time from the same client IP
```

**6. trust proxy — req.ip is the real client IP:**

```bash
# Trigger the auth rate limiter from one IP, then from a second IP
# Each should have its own independent counter — confirms req.ip
# is the real client IP, not Nginx's container IP

# From client 1: exhaust the limit (10 requests)
# From client 2: first request should succeed — not blocked
```

**7. Nginx rate limiting on auth (second layer):**

```bash
# Rapid-fire login requests through port 80
for i in $(seq 1 20); do
  curl -s -o /dev/null -w "%{http_code}\n" -X POST http://localhost/api/v1/auth/login \
    -H 'Content-Type: application/json' \
    -d '{"username":"x","password":"x"}'
done
# Expected: some responses are 503 (Nginx limit_req rejection)
# before the Express 429 (Redis rate limiter) fires
```

**8. Seq receives logs:**

```bash
# Open http://<vm-ip>:5380 in a browser
# Make a few API requests and confirm structured log entries appear
# Search by correlationId or userId in the Seq UI
```

**9. Confirm Docker HEALTHCHECK marks api healthy:**

```bash
docker inspect <api-container-id> | grep -A5 '"Health"'
# Expected: "Status": "healthy"
```

---

## File map

| File | Status |
|---|---|
| `Dockerfile` | Updated — two-stage build (`deps` + `production`); `HEALTHCHECK` unchanged |
| `.dockerignore` | New — excludes `node_modules`, `.env`, `coverage`, `.git`, `docs` |
| `docker-compose.yml` | New — 5 services; only nginx publishes port 80; `deploy.replicas: 2` for api |
| `nginx/nginx.conf` | Updated — completes Phase 8 skeleton; adds `limit_req` on auth, `X-Forwarded-For` |
| `src/app.js` | Updated — `app.set('trust proxy', 1)` |

---

## Checklist

- [ ] Step 1 — Dockerfile has two stages: `deps` (npm ci --omit=dev) and `production` (COPY --from=deps)
- [ ] Step 1 — Can explain why two stages improve build cache hit rate on source-only changes
- [ ] Step 2 — `.dockerignore` excludes `node_modules`, `.env`, and `.git`
- [ ] Step 3 — `mongo` and `redis` have no `ports` directive — not reachable from outside the VM
- [ ] Step 3 — `depends_on` uses `condition: service_healthy` for mongo and redis
- [ ] Step 3 — `api` has `deploy.replicas: 2`
- [ ] Step 3 — Only `nginx` publishes port 80 to the host
- [ ] Step 4 — `upstream api` has `ip_hash`
- [ ] Step 4 — `location /socket.io/` sets `proxy_http_version 1.1`, `Upgrade`, and `Connection`
- [ ] Step 4 — `limit_req_zone` defined; `limit_req` applied to `/api/v1/auth/login` and `/register`
- [ ] Step 4 — All proxy locations set `X-Real-IP` and `X-Forwarded-For`
- [ ] Step 5 — `app.set('trust proxy', 1)` added to `src/app.js`
- [ ] Step 5 — Can explain why `trust proxy` is required for the rate limiter to work correctly behind Nginx
- [ ] Step 5 — Can explain why `1` (not `true`) is the correct value
- [ ] Step 6 — `.env` is never committed; secrets generated with `openssl rand -hex 64`
- [ ] Step 6 — GCP firewall allows port 80 publicly; port 5380 restricted to your IP; port 5341 not opened
- [ ] Verification — `mongo` and `redis` are unreachable from the host (`connection refused` on their ports)
- [ ] Verification — Socket.io connects via Nginx on port 80 using WebSocket transport (not long-polling)
- [ ] Verification — Rate limiting from two different IPs is independent (trust proxy working)
- [ ] Knowledge check — Can explain what `ip_hash` does and why round-robin breaks Socket.io
- [ ] Knowledge check — Can explain why Nginx strips `Upgrade` and `Connection` by default
- [ ] Knowledge check — Can explain the trust proxy setting and what goes wrong without it
