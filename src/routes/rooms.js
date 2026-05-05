import { Router } from "express";
import {authenticate} from '../middleware/authenticate.js';
import * as roomController from '../controllers/roomController.js';
import * as messageController from '../controllers/messageController.js';
import * as presenceController from '../controllers/presenceController.js';
import {requireVerified} from '../middleware/requireVerified.js'
import { requireMember } from "../middleware/requireMember.js";

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
roomsRouter.post('/', requireVerified, roomController.createRoom);

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
 * /rooms/join-invite:
 *   post:
 *     summary: Join a room via invite token
 *     tags: [Rooms]
 *     parameters:
 *       - name: token
 *         in: query
 *         required: true
 *         description: Single-use invite token from an invite URL
 *         schema: { type: string }
 *     responses:
 *       '200': { description: Joined room successfully }
 *       '400': { description: Missing, invalid, or expired invite token }
 *       '404': { description: Room no longer exists }
 */
roomsRouter.post('/join-invite', requireVerified, roomController.joinViaInvite);

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
roomsRouter.get('/:id',requireMember, roomController.getRoomById);

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
roomsRouter.post('/:id/join', requireMember, requireVerified, roomController.joinRoom);

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
roomsRouter.post('/:id/leave',requireMember, roomController.leaveRoom);

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
roomsRouter.get('/:id/members', requireMember, roomController.listMembers);

/**
 * @openapi
 * /rooms/{id}/messages:
 *   get:
 *     summary: Paginated message history (cursor-based)
 *     tags: [Rooms]
 *     parameters:
 *       - { name: id,     in: path,  required: true, schema: { type: string } }
 *       - name: before
 *         in: query
 *         description: ISO 8601 timestamp — return messages older than this point
 *         schema: { type: string, format: date-time }
 *       - { name: limit, in: query, schema: { type: integer, default: 50, maximum: 100 } }
 *     responses:
 *       '200':
 *         description: Message page
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 items:      { type: array }
 *                 nextCursor: { type: string, nullable: true }
 *                 hasMore:    { type: boolean }
 *       '404': { description: Room not found }
 */
roomsRouter.get('/:id/messages',requireMember, messageController.getMessageHistory)

/**
 * @openapi
 * /rooms/{id}/presence:
 *   get:
 *     summary: List users currently online in the room
 *     tags: [Rooms]
 *     parameters:
 *       - { name: id, in: path, required: true, schema: { type: string } }
 *     responses:
 *       '200':
 *         description: Active users in the room
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 users: { type: array }
 *                 count: { type: integer }
 */
roomsRouter.get('/:id/presence',requireMember, presenceController.getRoomPresence);

/**
 * @openapi
 * /rooms/{id}/invite:
 *   post:
 *     summary: Create an invite link for a room
 *     description: Generates a single-use invite token valid for 48 hours. Only room members can create invites. Returns 403 for both non-existent rooms and non-members to avoid leaking whether a private room exists.
 *     tags: [Rooms]
 *     parameters:
 *       - { name: id, in: path, required: true, schema: { type: string } }
 *     responses:
 *       '200':
 *         description: Invite created
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 token:     { type: string }
 *                 inviteUrl: { type: string }
 *                 expiresIn: { type: string, example: '48 hours' }
 *       '403': { description: Room not found or caller is not a member }
 */
roomsRouter.post('/:id/invite', requireMember, requireVerified, roomController.createInvite);