import { Router } from "express";
import { authenticate } from "../middleware/authenticate.js";
import * as userController from '../controllers/userController.js';

export const usersRouter = Router();
usersRouter.use(authenticate);


/**
 * @openapi
 * /users/me/unread:
 *   get:
 *     summary: Get unread message counts for all rooms
 *     tags: [Users]
 *     responses:
 *       '200':
 *         description: Map of roomId to unread count (only rooms with count > 0)
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 counts:
 *                   type: object
 *                   additionalProperties: { type: integer }
 *             example:
 *               counts: { "roomId1": 5, "roomId2": 12 }
 */
usersRouter.get('me/unread', userController.getUnreadCounts);

/**
 * @openapi
 * /users/me:
 *   get:
 *     summary: Get own profile
 *     tags: [Users]
 *     responses:
 *       '200': { description: Own profile including email }
 */
usersRouter.get('/me', userController.getMe);

/**
 * @openapi
 * /users/me:
 *   put:
 *     summary: Update display name or avatar URL
 *     tags: [Users]
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               displayName: { type: string }
 *               avatarUrl:   { type: string }
 *     responses:
 *       '200': { description: Updated profile }
 *       '422': { description: No updatable fields provided }
 */
usersRouter.put('/me', userController.updateMe);

/**
 * @openapi
 * /users/{id}:
 *   get:
 *     summary: Get another user's public profile
 *     tags: [Users]
 *     parameters:
 *       - { name: id, in: path, required: true, schema: { type: string } }
 *     responses:
 *       '200': { description: Public profile — no email }
 *       '404': { description: User not found }
 */
usersRouter.get('/:id', userController.getUserById);