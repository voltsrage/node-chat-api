import { Router } from 'express'
import * as authController from '../controllers/authController.js'
import { authRateLimiter } from '../middleware/rateLimiter.js';
import {authenticate } from '../middleware/authenticate.js';

export const authRouter = Router();

/**
 * @openapi
 * /auth/register:
 *   post:
 *     summary: Register a new user
 *     tags: [Auth]
 *     security: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [username, email, password]
 *             properties:
 *               username: { type: string }
 *               email:    { type: string, format: email }
 *               password: { type: string, minLength: 8 }
 *     responses:
 *       '201': { description: Account created }
 *       '409': { description: Username or email already taken }
 *       '422': { description: Missing or invalid fields }
 */
authRouter.post('/register', authRateLimiter, authController.register);

/**
 * @openapi
 * /auth/login:
 *   post:
 *     summary: Authenticate and receive tokens
 *     tags: [Auth]
 *     security: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [email, password]
 *             properties:
 *               email:    { type: string }
 *               password: { type: string }
 *     responses:
 *       '200': { description: Tokens issued }
 *       '401': { description: Invalid credentials }
 */
authRouter.post('/login', authRateLimiter, authController.login);

/**
 * @openapi
 * /auth/refresh:
 *   post:
 *     summary: Exchange a refresh token for a new access token
 *     tags: [Auth]
 *     security: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [refreshToken]
 *             properties:
 *               refreshToken: { type: string }
 *     responses:
 *       '200': { description: New tokens issued }
 *       '401': { description: Invalid or expired refresh token }
 */
authRouter.post('/refresh', authController.refresh);

/**
 * @openapi
 * /auth/logout:
 *   post:
 *     summary: Revoke the refresh token
 *     tags: [Auth]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [refreshToken]
 *             properties:
 *               refreshToken: { type: string }
 *     responses:
 *       '200': { description: Logged out }
 */
authRouter.post('/logout', authenticate,  authController.logout);