# Phase 2 — Express Setup, Middleware, and Swagger

## What exists

From Phase 1:
- Three Mongoose models: `User`, `Room`, `Message` with indexes verified via `.explain()`
- `src/db/connect.js` — Mongoose connection helper
- `src/seed/seed.js` — seed data
- `package.json` with `mongoose` and `dotenv`

## What needs to be built

Seven steps. The most important concept in this phase is **middleware order** — in Express, the sequence of `app.use()` calls is the application's execution model, not a convention. The error handler being last is mechanically required, not stylistic. Understand why before moving on.

---

## Step 1 — Install dependencies

```bash
npm install express pino pino-http uuid swagger-jsdoc swagger-ui-express express-async-errors
npm install --save-dev pino-pretty
```

Also add `"type": "module"` to `package.json` to use ES module `import` syntax consistently across the project:

**`package.json`** — key additions:

```json
{
  "type": "module",
  "scripts": {
    "dev":  "nodemon src/index.js",
    "start": "node src/index.js",
    "seed": "node src/seed/seed.js"
  }
}
```

`express-async-errors` patches Express's router so that async route handlers automatically forward thrown errors to the next error-handling middleware. Without it, an `async` handler that throws bypasses `next(err)` and the error silently disappears — Express never sees it.

---

## Step 2 — Pino logger

The shared logger instance is created once and imported wherever structured logging is needed. `pino-pretty` is used in development only — in production, Pino outputs newline-delimited JSON for Seq to ingest.

**`src/utils/logger.js`:**

```js
import pino from 'pino';

export const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  ...(process.env.NODE_ENV !== 'production' && {
    transport: {
      target: 'pino-pretty',
      options: { colorize: true },
    },
  }),
});
```

---

## Step 3 — Standard response envelope

Every endpoint returns the same envelope shape. Centralizing it here means a single change fixes the shape everywhere.

**`src/utils/ApiResponse.js`:**

```js
export class ApiResponse {
  static success(data, statusCode = 200) {
    return { success: true, statusCode, data, error: null };
  }

  static created(data) {
    return { success: true, statusCode: 201, data, error: null };
  }

  static error(message, code, statusCode) {
    return { success: false, statusCode, data: null, error: { message, code } };
  }
}
```

---

## Step 4 — Custom error classes

These let the error handler distinguish between expected domain errors (throw a 404, return it cleanly) and unexpected crashes (log as error, return 500). Route handlers throw these directly — no `try/catch` blocks needed because `express-async-errors` forwards them automatically.

**`src/errors/AppError.js`:**

```js
export class AppError extends Error {
  constructor(message, statusCode, code) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
  }
}

export class NotFoundError extends AppError {
  constructor(message = 'Not found.', code = 'NOT_FOUND') {
    super(message, 404, code);
  }
}

export class ValidationError extends AppError {
  constructor(message = 'Validation failed.', code = 'VALIDATION_ERROR') {
    super(message, 422, code);
  }
}

export class ConflictError extends AppError {
  constructor(message = 'Conflict.', code = 'CONFLICT') {
    super(message, 409, code);
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = 'Unauthorized.', code = 'UNAUTHORIZED') {
    super(message, 401, code);
  }
}

export class TooManyRequestsError extends AppError {
  constructor(message = 'Too many requests.', code = 'RATE_LIMITED') {
    super(message, 429, code);
  }
}
```

---

## Step 5 — Correlation ID middleware

`pino-http` creates `req.log` as part of its middleware. The correlation ID middleware runs after it and creates a child logger that inherits all of pino-http's request properties plus the correlation ID. Every `req.log.info(...)` call in a route handler automatically includes the ID.

Accept an incoming `x-correlation-id` header so callers can trace a request from their side through to the server logs.

**`src/middleware/correlationId.js`:**

```js
import { v4 as uuidv4 } from 'uuid';

export function correlationIdMiddleware(req, res, next) {
  const id = req.headers['x-correlation-id'] || uuidv4();
  req.correlationId = id;
  req.log = req.log.child({ correlationId: id });
  res.setHeader('x-correlation-id', id);
  next();
}
```

---

## Step 6 — Global error handler

The four-argument signature `(err, req, res, next)` is how Express identifies an error-handling middleware. Three arguments and it is a regular middleware — it will never be called for errors. This is not configurable; it is how Express works internally.

Distinguish between `AppError` instances (expected, log as `warn`) and everything else (unexpected, log as `error`). Never leak internal error details in a 500 response.

**`src/middleware/errorHandler.js`:**

```js
import { AppError } from '../errors/AppError.js';
import { ApiResponse } from '../utils/ApiResponse.js';

export function errorHandler(err, req, res, next) {
  if (err instanceof AppError) {
    req.log.warn({ err }, err.message);
    return res
      .status(err.statusCode)
      .json(ApiResponse.error(err.message, err.code, err.statusCode));
  }

  req.log.error({ err }, 'Unhandled error');
  res
    .status(500)
    .json(ApiResponse.error('Internal server error.', 'INTERNAL_ERROR', 500));
}
```

---

## Step 7 — Swagger setup

JSDoc annotations on route files generate the OpenAPI spec. Add the `apis` glob to pick up all route files automatically as they are added in later phases.

**`src/swagger.js`:**

```js
import { Router } from 'express';
import swaggerJsdoc from 'swagger-jsdoc';
import swaggerUi from 'swagger-ui-express';

const options = {
  definition: {
    openapi: '3.0.0',
    info: {
      title: 'Team Chat API',
      version: '1.0.0',
    },
    servers: [{ url: '/api/v1' }],
    components: {
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT',
        },
      },
    },
    security: [{ bearerAuth: [] }],
  },
  apis: ['./src/routes/**/*.js'],
};

const spec = swaggerJsdoc(options);

export const swaggerRouter = Router();
swaggerRouter.use('/', swaggerUi.serve);
swaggerRouter.get('/', swaggerUi.setup(spec));
```

---

## Step 8 — Express app and entry point

The middleware order here is the deliverable for this phase. Read it as a pipeline: every request flows through each `app.use()` in registration order.

**`src/app.js`:**

```js
import 'express-async-errors';
import express from 'express';
import pinoHttp from 'pino-http';
import { logger } from './utils/logger.js';
import { correlationIdMiddleware } from './middleware/correlationId.js';
import { errorHandler } from './middleware/errorHandler.js';
import { ApiResponse } from './utils/ApiResponse.js';
import { swaggerRouter } from './swagger.js';

export const app = express();

// 1. Request logging — must be first so every request is captured including those
//    that fail body parsing or hit unmatched routes.
app.use(pinoHttp({ logger }));

// 2. Body parsing
app.use(express.json());

// 3. Correlation ID — after pinoHttp so req.log exists for child logger creation
app.use(correlationIdMiddleware);

// 4. Swagger UI — development only
if (process.env.NODE_ENV !== 'production') {
  app.use('/swagger', swaggerRouter);
}

// 5. Routes are mounted here in later phases
// app.use('/api/v1/auth',  authRouter);
// app.use('/api/v1/users', usersRouter);
// app.use('/api/v1/rooms', roomsRouter);

// 6. Catch-all for unmatched routes — after all valid routes, before error handler
app.use((req, res) => {
  res.status(404).json(ApiResponse.error('Route not found.', 'NOT_FOUND', 404));
});

// 7. Global error handler — must be registered last, four-argument signature required
app.use(errorHandler);
```

**`src/index.js`:**

```js
import 'dotenv/config';
import { app } from './app.js';
import { connectDB } from './db/connect.js';
import { logger } from './utils/logger.js';

const PORT = process.env.PORT || 3000;

async function start() {
  await connectDB();
  app.listen(PORT, () => logger.info({ port: PORT }, 'Server started'));
}

start().catch(err => {
  logger.error(err, 'Failed to start server');
  process.exit(1);
});
```

---

## Verification

Start the server and confirm the following before closing this phase:

```bash
npm run dev
```

**1. Server starts and MongoDB connects** — no errors in the terminal.

**2. Unknown route returns the standard envelope:**

```bash
curl http://localhost:3000/api/v1/does-not-exist
# Expected: { "success": false, "statusCode": 404, "data": null, "error": { "message": "Route not found.", "code": "NOT_FOUND" } }
```

**3. Swagger UI loads:**

Open `http://localhost:3000/swagger` in a browser. The page should render with the "Team Chat API" title and no errors in the browser console.

**4. Correlation ID is returned in the response header:**

```bash
curl -I http://localhost:3000/swagger
# Look for: x-correlation-id: <uuid>
```

**5. Thrown `AppError` is handled correctly** — add a temporary test route, hit it, then remove it:

```js
// Temporarily add to app.js before the 404 handler
app.get('/test-error', () => {
  throw new NotFoundError('Test error.');
});
```

```bash
curl http://localhost:3000/test-error
# Expected: { "success": false, "statusCode": 404, ... }
# Should NOT return a 500
```

---

## File map

| File | Status |
|---|---|
| `package.json` | Updated — `"type": "module"`, scripts, new dependencies |
| `src/utils/logger.js` | New — Pino logger, pretty in dev / JSON in prod |
| `src/utils/ApiResponse.js` | New — `success`, `created`, `error` envelope helpers |
| `src/errors/AppError.js` | New — `AppError` base + `NotFoundError`, `ValidationError`, `ConflictError`, `UnauthorizedError`, `TooManyRequestsError` |
| `src/middleware/correlationId.js` | New — UUID per request, child logger, response header |
| `src/middleware/errorHandler.js` | New — four-argument global error handler |
| `src/swagger.js` | New — swagger-jsdoc spec + swagger-ui router |
| `src/app.js` | New — Express app with middleware in correct order |
| `src/index.js` | New — server entry point |

---

## Checklist

- [ ] Step 1 — `express`, `pino`, `pino-http`, `uuid`, `swagger-jsdoc`, `swagger-ui-express`, `express-async-errors` installed
- [ ] Step 1 — `"type": "module"` added to `package.json`; `dev`, `start`, `seed` scripts added
- [ ] Step 2 — `src/utils/logger.js` created; `pino-pretty` used in dev, plain JSON in production
- [ ] Step 3 — `ApiResponse.success`, `ApiResponse.created`, `ApiResponse.error` all return the correct envelope shape
- [ ] Step 4 — All six error classes created in `src/errors/AppError.js`
- [ ] Step 5 — `correlationIdMiddleware` reads `x-correlation-id` header or generates UUID; attaches child logger to `req.log`; sets response header
- [ ] Step 6 — `errorHandler` has exactly four arguments; `AppError` returns the correct status code; unknown errors return 500 without leaking details
- [ ] Step 7 — Swagger UI accessible at `GET /swagger` in dev; `apis` glob points to route files
- [ ] Step 8 — Middleware registered in order: pino-http → json → correlationId → swagger → routes → 404 → errorHandler
- [ ] Verification — unknown route returns `{ success: false, statusCode: 404 }` envelope
- [ ] Verification — `x-correlation-id` header present in every response
- [ ] Verification — thrown `AppError` returns correct status code, not 500
- [ ] Verification — Swagger UI loads in browser without console errors
