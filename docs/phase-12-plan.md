# Phase 12 — GitLab CI/CD Pipeline

## What exists

From Phase 11:
- Complete application code — all phases implemented
- `Dockerfile` — multi-stage build
- `docker-compose.yml` — 5 services, `deploy.replicas: 2` for api
- GCP VM with Docker installed and `~/teamchat` directory set up

## What needs to be built

Six steps. Four pipeline stages that gate each other: code that does not lint does not get tested; code that does not pass tests does not get built; code that does not build does not get deployed.

```
lint → test → build → deploy
         ↑               ↑
    (services:        (only: main
   mongo, redis)      + SSH to VM)
```

---

## Step 1 — ESLint

Install and configure ESLint. The lint job fails the pipeline on any error — warnings do not block.

```bash
npm install --save-dev eslint @eslint/js
```

**`eslint.config.js`:**

```js
import js from '@eslint/js';

export default [
  js.configs.recommended,
  {
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      'no-console':     'warn',
      'eqeqeq':         'error',
    },
    languageOptions: {
      ecmaVersion: 2022,
      sourceType:  'module',
      globals: {
        process: 'readonly',
      },
    },
  },
  {
    // Test files may use describe/it/expect without imports
    files: ['tests/**/*.js'],
    languageOptions: {
      globals: {
        describe:   'readonly',
        it:         'readonly',
        expect:     'readonly',
        beforeAll:  'readonly',
        afterAll:   'readonly',
        beforeEach: 'readonly',
        afterEach:  'readonly',
      },
    },
  },
];
```

**`package.json`** — add scripts:

```json
{
  "scripts": {
    "lint":          "eslint src",
    "lint:fix":      "eslint src --fix",
    "test":          "node --experimental-vm-modules node_modules/.bin/jest",
    "test:coverage": "node --experimental-vm-modules node_modules/.bin/jest --coverage"
  }
}
```

---

## Step 2 — Jest and test files

Install Jest and a MongoDB in-memory server for integration tests:

```bash
npm install --save-dev jest @jest/globals mongodb-memory-server
```

**`jest.config.js`:**

```js
export default {
  testEnvironment: 'node',
  testMatch: ['**/tests/**/*.test.js'],
  coverageThreshold: {
    global: {
      lines:     70,
      functions: 70,
      branches:  60,
    },
  },
  collectCoverageFrom: [
    'src/**/*.js',
    '!src/index.js',       // entry point — not unit-testable
    '!src/db/**',          // database connections — tested via integration
    '!src/utils/logger.js',
  ],
};
```

The `--experimental-vm-modules` flag is required because Jest's module system does not natively support ESM (`"type": "module"` in `package.json`). This flag enables ESM support in Jest without a Babel transform.

---

### Unit tests — auth service

Mocks the User model and Redis client so no real database is needed.

**`tests/unit/authService.test.js`:**

```js
import { jest } from '@jest/globals';

// ESM mock — must be called before importing the module under test
jest.unstable_mockModule('../../src/models/User.js', () => ({
  User: {
    findOne: jest.fn(),
    create:  jest.fn(),
  },
}));

jest.unstable_mockModule('../../src/db/redis.js', () => ({
  redis: {
    set: jest.fn().mockResolvedValue('OK'),
    get: jest.fn().mockResolvedValue(null),
    del: jest.fn().mockResolvedValue(1),
  },
}));

// Dynamic import AFTER mock registration
const { register, login } = await import('../../src/services/authService.js');
const { User }            = await import('../../src/models/User.js');

describe('authService.register', () => {
  it('throws ConflictError when username is already taken', async () => {
    User.findOne.mockResolvedValueOnce({ _id: 'existing-user' });

    await expect(register({ username: 'alice', email: 'a@a.com', password: 'pass' }))
      .rejects.toMatchObject({ code: 'USERNAME_TAKEN' });
  });

  it('hashes the password before saving', async () => {
    User.findOne.mockResolvedValue(null);
    User.create.mockResolvedValueOnce({
      _id: 'new-id', username: 'alice', email: 'a@a.com',
    });

    await register({ username: 'alice', email: 'a@a.com', password: 'secret' });

    const createCall = User.create.mock.calls[0][0];
    // Password must be hashed — never stored as plaintext
    expect(createCall.passwordHash).toBeDefined();
    expect(createCall.passwordHash).not.toBe('secret');
    expect(createCall.password).toBeUndefined();
  });
});

describe('authService.login', () => {
  it('throws UnauthorizedError for unknown username', async () => {
    User.findOne.mockResolvedValue(null);

    await expect(login({ username: 'nobody', password: 'x' }))
      .rejects.toMatchObject({ code: 'INVALID_CREDENTIALS' });
  });
});
```

---

### Unit tests — rate limiter

**`tests/unit/rateLimiter.test.js`:**

```js
import { jest } from '@jest/globals';

const mockEval = jest.fn();
const mockTtl  = jest.fn();

jest.unstable_mockModule('../../src/db/redis.js', () => ({
  redis: { eval: mockEval, ttl: mockTtl },
}));

const { createRateLimiter } = await import('../../src/middleware/rateLimiter.js');

describe('createRateLimiter', () => {
  const next = jest.fn();

  it('calls next() when under the limit', async () => {
    mockEval.mockResolvedValue(1); // first request

    const limiter = createRateLimiter({ windowSec: 60, max: 10, keyPrefix: 'test' });
    await limiter({ ip: '127.0.0.1' }, {}, next);

    expect(next).toHaveBeenCalledWith(); // no arguments = no error
  });

  it('throws TooManyRequestsError when over the limit', async () => {
    mockEval.mockResolvedValue(11); // over max of 10
    mockTtl.mockResolvedValue(45);

    const limiter = createRateLimiter({ windowSec: 60, max: 10, keyPrefix: 'test' });

    await expect(limiter({ ip: '127.0.0.1' }, {}, next))
      .rejects.toMatchObject({ code: 'TOO_MANY_REQUESTS' });
  });

  it('keys on req.ip — two IPs have separate counters', async () => {
    mockEval.mockResolvedValue(1);

    const limiter = createRateLimiter({ windowSec: 60, max: 10, keyPrefix: 'test' });
    await limiter({ ip: '1.2.3.4' }, {}, jest.fn());
    await limiter({ ip: '5.6.7.8' }, {}, jest.fn());

    const keys = mockEval.mock.calls.map(call => call[2]); // third arg is the Redis key
    expect(keys[0]).toContain('1.2.3.4');
    expect(keys[1]).toContain('5.6.7.8');
    expect(keys[0]).not.toBe(keys[1]);
  });
});
```

---

### Integration tests — message service

Uses `mongodb-memory-server` for a real in-process MongoDB. No mocks — tests the actual query logic including the compound index and cursor pagination.

**`tests/integration/messageService.test.js`:**

```js
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import { jest } from '@jest/globals';

// Redis is not used by messageService — mock it to avoid a real connection
jest.unstable_mockModule('../../src/db/redis.js', () => ({
  redis: { get: jest.fn(), set: jest.fn(), del: jest.fn() },
}));

let mongod;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

afterEach(async () => {
  await mongoose.connection.db.dropDatabase();
});

const { createMessage, getMessageHistory } = await import('../../src/services/messageService.js');
const { Room }    = await import('../../src/models/Room.js');
const { Message } = await import('../../src/models/Message.js');

const ROOM_ID   = new mongoose.Types.ObjectId().toString();
const SENDER_ID = new mongoose.Types.ObjectId().toString();

async function seedRoom() {
  await Room.create({ _id: ROOM_ID, name: 'test', memberIds: [SENDER_ID], createdBy: SENDER_ID });
}

describe('getMessageHistory — cursor pagination', () => {
  it('returns newest messages first', async () => {
    await seedRoom();
    for (let i = 0; i < 5; i++) {
      await Message.create({ roomId: ROOM_ID, senderId: SENDER_ID, senderUsername: 'alice',
        content: `msg ${i}`, type: 'text' });
    }

    const result = await getMessageHistory(ROOM_ID, { limit: 3 });

    expect(result.items).toHaveLength(3);
    expect(result.hasMore).toBe(true);
    expect(result.nextCursor).toBeTruthy();

    // Items should be in descending createdAt order
    const timestamps = result.items.map(m => new Date(m.createdAt).getTime());
    expect(timestamps[0]).toBeGreaterThanOrEqual(timestamps[1]);
  });

  it('page 2 contains no overlap with page 1', async () => {
    await seedRoom();
    for (let i = 0; i < 6; i++) {
      await Message.create({ roomId: ROOM_ID, senderId: SENDER_ID, senderUsername: 'alice',
        content: `msg ${i}`, type: 'text' });
    }

    const page1 = await getMessageHistory(ROOM_ID, { limit: 3 });
    const page2 = await getMessageHistory(ROOM_ID, { limit: 3, before: page1.nextCursor });

    const ids1 = new Set(page1.items.map(m => m.id.toString()));
    const ids2 = page2.items.map(m => m.id.toString());

    expect(ids2.some(id => ids1.has(id))).toBe(false); // no overlap
    expect(page2.hasMore).toBe(false);
    expect(page2.nextCursor).toBeNull();
  });

  it('returns [deleted] for soft-deleted messages', async () => {
    await seedRoom();
    await Message.create({ roomId: ROOM_ID, senderId: SENDER_ID, senderUsername: 'alice',
      content: 'secret', type: 'text', deletedAt: new Date() });

    const result = await getMessageHistory(ROOM_ID);

    expect(result.items[0].content).toBe('[deleted]');
  });
});
```

---

## Step 3 — Update docker-compose.yml for image-based deploys

In production, the CI pipeline builds and pushes the image; the deploy job pulls it. The `api` service needs an `image:` field pointing to the registry. An environment variable (`API_IMAGE`) lets the deploy script override the tag without editing the file.

**`docker-compose.yml`** — update the `api` service:

```yaml
api:
  image: ${API_IMAGE:-teamchat-api:local}
  build: .    # Used locally — 'docker compose build api' tags the image as API_IMAGE
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
```

When `API_IMAGE` is set (production deploy), `docker compose up -d api` pulls and uses the specified image. When it is not set (local development), it defaults to `teamchat-api:local` built from the `Dockerfile`.

---

## Step 4 — .gitlab-ci.yml

**`.gitlab-ci.yml`:**

```yaml
stages:
  - lint
  - test
  - build
  - deploy

variables:
  IMAGE_NAME: $CI_REGISTRY_IMAGE:$CI_COMMIT_SHA

# ── Lint ──────────────────────────────────────────────────────────────────────
lint:
  stage: lint
  image: node:20-alpine
  cache:
    key: $CI_COMMIT_REF_SLUG
    paths:
      - node_modules/
  script:
    - npm ci
    - npm run lint

# ── Test ──────────────────────────────────────────────────────────────────────
test:
  stage: test
  image: node:20-alpine
  services:
    - name: mongo:7
      alias: mongo
    - name: redis:7-alpine
      alias: redis
  variables:
    # These override the .env file — safe to hardcode in CI
    MONGO_URI:           mongodb://mongo/teamchat_test
    REDIS_URL:           redis://redis:6379
    JWT_SECRET:          ci-test-secret-not-used-in-production
    JWT_REFRESH_SECRET:  ci-test-refresh-secret-not-used-in-production
    NODE_ENV:            test
  cache:
    key: $CI_COMMIT_REF_SLUG
    paths:
      - node_modules/
  script:
    - npm ci
    - npm run test:coverage
  coverage: '/Lines\s*:\s*(\d+\.?\d*)%/'
  artifacts:
    when: always
    reports:
      coverage_report:
        coverage_format: cobertura
        path: coverage/cobertura-coverage.xml
    paths:
      - coverage/

# ── Build ─────────────────────────────────────────────────────────────────────
build:
  stage: build
  image: docker:24
  services:
    - docker:24-dind
  variables:
    DOCKER_TLS_CERTDIR: '/certs'
  script:
    - docker login -u $CI_REGISTRY_USER -p $CI_REGISTRY_PASSWORD $CI_REGISTRY
    - docker build -t $IMAGE_NAME -t $CI_REGISTRY_IMAGE:latest .
    - docker push $IMAGE_NAME
    - docker push $CI_REGISTRY_IMAGE:latest
  only:
    - main

# ── Deploy ────────────────────────────────────────────────────────────────────
deploy:
  stage: deploy
  image: alpine:3.19
  before_script:
    - apk add --no-cache openssh-client
    - eval $(ssh-agent -s)
    - echo "$SSH_PRIVATE_KEY" | tr -d '\r' | ssh-add -
    - mkdir -p ~/.ssh && chmod 700 ~/.ssh
    - ssh-keyscan -H "$VM_HOST" >> ~/.ssh/known_hosts
  script:
    - |
      ssh $VM_USER@$VM_HOST << EOF
        docker login -u "$CI_REGISTRY_USER" -p "$CI_REGISTRY_PASSWORD" "$CI_REGISTRY"
        docker pull "$IMAGE_NAME"
        cd ~/teamchat
        export API_IMAGE="$IMAGE_NAME"
        docker compose up -d api
        docker image prune -f
      EOF
  only:
    - main
  environment:
    name: production
    url: http://$VM_HOST
```

**Stage notes:**

| Stage | Runs on | Condition |
|---|---|---|
| `lint` | every push | always |
| `test` | every push | always; spins up real mongo + redis via `services:` |
| `build` | every push to `main` | `only: main` — no point pushing images for every feature branch |
| `deploy` | every push to `main` | `only: main` — the production gate |

**`cache:`** — both `lint` and `test` share a `node_modules` cache keyed to the branch name. A cache hit skips `npm ci` on repeated pushes to the same branch.

**`tr -d '\r'`** in the deploy `before_script` — SSH private keys copied from Windows environments may have CRLF line endings. OpenSSH rejects keys with `\r` in them. Stripping `\r` before `ssh-add` prevents a silent "invalid key format" failure.

---

## Step 5 — GitLab CI/CD variables

Set in **Settings → CI/CD → Variables**. Mark sensitive values as **Masked** (hidden in job logs) and **Protected** (only available on protected branches like `main`).

| Variable | Value | Masked | Protected | Notes |
|---|---|---|---|---|
| `SSH_PRIVATE_KEY` | Private key content | Yes | Yes | `cat ~/.ssh/id_rsa` — the key whose public half is in `~/.ssh/authorized_keys` on the VM |
| `VM_HOST` | GCP VM external IP | Yes | Yes | Used in `ssh-keyscan` and `ssh` command |
| `VM_USER` | `ubuntu` (or your user) | No | No | Not sensitive |

GitLab provides these automatically — no action needed:

| Variable | Provided by | Used for |
|---|---|---|
| `CI_REGISTRY` | GitLab | Docker login URL |
| `CI_REGISTRY_USER` | GitLab | Docker login username |
| `CI_REGISTRY_PASSWORD` | GitLab | Docker login password (job token) |
| `CI_REGISTRY_IMAGE` | GitLab | Full path: `registry.gitlab.com/<namespace>/<project>` |
| `CI_COMMIT_SHA` | GitLab | Image tag for traceability |

**Generating the SSH key pair:**

```bash
# On your local machine — do not use an existing key
ssh-keygen -t ed25519 -C "gitlab-ci-deploy" -f ~/.ssh/gitlab_deploy

# Copy the PUBLIC key to the VM's authorized_keys
ssh-copy-id -i ~/.ssh/gitlab_deploy.pub $VM_USER@$VM_HOST

# Paste the PRIVATE key content into GitLab CI/CD variable SSH_PRIVATE_KEY
cat ~/.ssh/gitlab_deploy
```

---

## Verification

**1. Pipeline runs all four stages on a push to main:**

```
lint    ✓  ~30s
test    ✓  ~90s (mongodb-memory-server download on first run)
build   ✓  ~2m  (image layers cached after first build)
deploy  ✓  ~30s
```

**2. Lint failure blocks the pipeline:**

```bash
# Introduce an unused variable in src/app.js:
const unused = 'hello';

# Push to any branch
# Expected: lint stage fails, test/build/deploy do not run
```

**3. Test failure blocks build and deploy:**

```bash
# Break a test assertion temporarily
# Push to main
# Expected: test stage fails, build and deploy do not run
# The broken image is never pushed to the registry
```

**4. Coverage below threshold blocks the pipeline:**

```bash
# Lower the threshold temporarily to confirm it fires:
# In jest.config.js, set lines: 90 (above current coverage)
# Push — expected: test stage exits with non-zero (coverage check failed)
```

**5. Confirm the deployed image matches the commit:**

```bash
# After a successful deploy, SSH into the VM:
docker inspect <api-container-id> | grep '"Image"'
# Expected: registry.gitlab.com/<namespace>/teamchat:<commit-sha>
# The SHA in the image tag must match the GitLab pipeline's $CI_COMMIT_SHA
```

**6. Confirm the deploy only runs on main:**

```bash
# Push to a feature branch
# Expected: lint + test run; build and deploy do not appear in the pipeline
```

**7. Rollback — deploy a previous image:**

```bash
# If the latest deploy causes issues, roll back by redeploying the previous SHA:
ssh $VM_USER@$VM_HOST
docker pull registry.gitlab.com/<namespace>/teamchat:<previous-sha>
export API_IMAGE=registry.gitlab.com/<namespace>/teamchat:<previous-sha>
docker compose up -d api
```

---

## File map

| File | Status |
|---|---|
| `eslint.config.js` | New — flat config; `no-unused-vars`, `eqeqeq`; separate globals for test files |
| `jest.config.js` | New — ESM mode; coverage thresholds 70% lines/functions, 60% branches |
| `tests/unit/authService.test.js` | New — register hashing, login rejection; mocks User + Redis |
| `tests/unit/rateLimiter.test.js` | New — under/over limit, per-IP isolation; mocks Redis |
| `tests/integration/messageService.test.js` | New — cursor pagination, no overlap, soft delete; uses `mongodb-memory-server` |
| `.gitlab-ci.yml` | New — lint → test (with services) → build (main only) → deploy (main only) |
| `docker-compose.yml` | Updated — `image: ${API_IMAGE:-teamchat-api:local}` on api service |
| `package.json` | Updated — `lint`, `test`, `test:coverage` scripts |

---

## Checklist

- [ ] Step 1 — `eslint.config.js` uses `@eslint/js` recommended rules; `no-unused-vars` allows `_` prefix
- [ ] Step 1 — `npm run lint` fails with exit code 1 on any ESLint error
- [ ] Step 2 — `jest.config.js` uses `--experimental-vm-modules` (set in `package.json` test script)
- [ ] Step 2 — Coverage thresholds defined; pipeline fails if coverage drops below them
- [ ] Step 2 — Auth unit tests mock User model and Redis; do not require a real database
- [ ] Step 2 — Message integration tests use `mongodb-memory-server`; test cursor pagination no-overlap property
- [ ] Step 3 — `docker-compose.yml` api service has `image: ${API_IMAGE:-teamchat-api:local}`
- [ ] Step 4 — `.gitlab-ci.yml` has four stages in order: lint, test, build, deploy
- [ ] Step 4 — `test` job has `services:` for mongo and redis; connection vars set via `variables:`
- [ ] Step 4 — `build` and `deploy` have `only: main`
- [ ] Step 4 — `deploy` job uses `ssh-agent` and `tr -d '\r'` on the private key
- [ ] Step 4 — Image tagged with `$CI_COMMIT_SHA` for traceability; also tagged `:latest`
- [ ] Step 4 — `docker image prune -f` runs after deploy to clean up old images on the VM
- [ ] Step 5 — `SSH_PRIVATE_KEY`, `VM_HOST` set as masked + protected variables in GitLab
- [ ] Step 5 — SSH key is a dedicated deploy key — not a personal key reused for other purposes
- [ ] Verification — Lint failure stops the pipeline before test runs
- [ ] Verification — Test failure stops the pipeline before build runs
- [ ] Verification — Deployed container image tag matches the pipeline's commit SHA
- [ ] Verification — Feature branch push does not trigger build or deploy
- [ ] Knowledge check — Can explain why `tr -d '\r'` is needed on the SSH key
- [ ] Knowledge check — Can explain what `CI_REGISTRY_PASSWORD` is (a scoped job token, not your GitLab password)
- [ ] Knowledge check — Can explain how to roll back a bad deploy using the image tag
