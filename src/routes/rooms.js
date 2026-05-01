import { Router } from "express";
import {authenticate} from '../middleware/authenticate.js';
import * as roomController from '../controllers/roomController.js';

export const roomsRouter = Router();
roomsRouter.use(authenticate);

/**
 * @openapi
 * /rooms:
 *   post:
 *     summary: Create a room
 *     tags: [Rooms]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [name]
 *             properties:
 *               name:        { type: string }
 *               description: { type: string }
 *     responses:
 *       '201': { description: Room created }
 *       '409': { description: Room name already taken }
 */
roomsRouter.post('/', roomController.createRoom);

/**
 * @openapi
 * /rooms:
 *   get:
 *     summary: List all rooms (paginated)
 *     tags: [Rooms]
 *     parameters:
 *       - { name: page,     in: query, schema: { type: integer, default: 1 } }
 *       - { name: pageSize, in: query, schema: { type: integer, default: 20 } }
 *     responses:
 *       '200': { description: Paginated room list }
 */
roomsRouter.get('/', roomController.listRooms);

/**
 * @openapi
 * /rooms/{id}:
 *   get:
 *     summary: Get room details
 *     tags: [Rooms]
 *     parameters:
 *       - { name: id, in: path, required: true, schema: { type: string } }
 *     responses:
 *       '200': { description: Room details }
 *       '404': { description: Room not found }
 */
roomsRouter.get('/:id', roomController.getRoomById);

/**
 * @openapi
 * /rooms/{id}/join:
 *   post:
 *     summary: Join a room
 *     tags: [Rooms]
 *     parameters:
 *       - { name: id, in: path, required: true, schema: { type: string } }
 *     responses:
 *       '200': { description: Joined room }
 *       '404': { description: Room not found }
 */
roomsRouter.post('/:id/join', roomController.joinRoom);

/**
 * @openapi
 * /rooms/{id}/leave:
 *   post:
 *     summary: Leave a room
 *     tags: [Rooms]
 *     parameters:
 *       - { name: id, in: path, required: true, schema: { type: string } }
 *     responses:
 *       '200': { description: Left room }
 *       '404': { description: Room not found }
 */
roomsRouter.post('/:id/leave', roomController.leaveRoom);

/**
 * @openapi
 * /rooms/{id}/members:
 *   get:
 *     summary: List room members (paginated)
 *     tags: [Rooms]
 *     parameters:
 *       - { name: id,       in: path,  required: true, schema: { type: string } }
 *       - { name: page,     in: query, schema: { type: integer, default: 1 } }
 *       - { name: pageSize, in: query, schema: { type: integer, default: 20 } }
 *     responses:
 *       '200': { description: Paginated member list }
 *       '404': { description: Room not found }
 */
roomsRouter.get('/:id/members', roomController.listMembers);