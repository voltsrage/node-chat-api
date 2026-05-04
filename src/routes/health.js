import { Router } from "express";
import { liveness, readiness } from "../controllers/healthController.js";

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