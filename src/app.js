import 'express-async-errors'
import express from 'express'
import PinoHttp, { pinoHttp } from 'pino-http'
import { logger } from './utils/logger.js'
import { correlationIdMiddleware } from './middleware/correlationId.js'
import { errorHandler } from './middleware/errorHandler.js'
import { ApiResponse } from './utils/ApiResponse.js'
import { swaggerRouter } from './swagger.js'

export const app = express();

// Trust the first proxy (Nginx). Required for req.ip to return the real
// client IP instead of Nginx's internal container IP.
app.set('trust proxy', 1);

// 1. Request logging — must be first so every request is captured including those
//    that fail body parsing or hit unmatched routes.
app.use(pinoHttp({ logger }));

// 2. Body parsing
app.use(express.json());

// 3. Correlation ID — after pinoHttp so req.log exists for child logger creation
app.use(correlationIdMiddleware);

// 4. Swagger UI - development only
if (process.env.NODE_ENV != 'production') {
    app.use('/swagger', swaggerRouter)
}

// 5. Routes are mounted here in later phases
import { authRouter } from './routes/auth.js'
import { roomsRouter } from './routes/rooms.js'
import { usersRouter } from './routes/users.js'
import { healthRouter } from './routes/health.js'

app.use('/api/v1/auth',  authRouter);
app.use('/api/v1/rooms', roomsRouter);
app.use('/api/v1/users', usersRouter);
app.use('/health', healthRouter)


// 6. Catch-all for unmatched routes — after all valid routes, before error handler
app.use((req, res) => {
    res.status(404).json(ApiResponse.error('Route not found.', 'NOT_FOUND', 404));
});

// 7. Global error handler — must be registered last, four-argument signature required
app.use(errorHandler);