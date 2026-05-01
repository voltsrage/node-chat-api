import { AppError } from "../errors/AppError.js";
import { ApiResponse } from "../utils/ApiResponse.js";

export function errorHandler(err, req, res, next) {
    if (err instanceof AppError) {
        req.log.warn({ err }, err.message);
        return res
            .status(err.statusCode)
            .json(ApiResponse.error(err.message, err.code, err.statusCode));
    }

    if (err.code === 11000) {
        const field = Object.keys(err.keyValue ?? {})[0] ?? 'field';
        const value = err.keyValue?.[field];
        req.log.warn({ err }, 'Duplicate key violation');
        return res
            .status(409)
            .json(ApiResponse.error(`${field} '${value}' is already taken.`, 'ALREADY_EXISTS', 409));
    }

    req.log.error({ err }, 'Unhandled error');
    res
        .status(500)
        .json(ApiResponse.error('Internal server error.'), 'INTERNAL_ERROR', 500)
}