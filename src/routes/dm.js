import {Router} from 'express';
import {authenticate} from '../middleware/authenticate.js';
import {requireVerified} from '../middleware/requireVerified.js';
import * as dmController from '../controllers/dmController.js';

export const dmRouter = Router();
dmRouter.use(authenticate, requireVerified);

/**
 * @openapi
 * /dm:
 *   post:
 *     summary: Find or create a DM conversation with another user
 *     tags: [DM]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [targetUserId]
 *             properties:
 *               targetUserId: { type: string }
 *     responses:
 *       '200': { description: Existing or newly created DM room }
 *       '404': { description: Target user not found }
 *       '422': { description: Cannot DM yourself }
 */
dmRouter.post('/', dmController.findOrCreateDm);

/**
 * @openapi
 * /dm:
 *   get:
 *     summary: List all DM conversations for the authenticated user
 *     tags: [DM]
 *     responses:
 *       '200': { description: Array of DM room objects }
 */
dmRouter.get('/', dmController.listDms);