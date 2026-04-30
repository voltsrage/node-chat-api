import { AppError } from "../errors/AppError.js";
import { ApiResponse } from "../utils/ApiResponse.js";

export function errorHandler(err, req, res, next){
    if(err instanceof AppError){
        req.log.warn({err}, err.message);
        return res
            .status(err.statusCode)
            .json(ApiResponse.error(err.message, err.code, err.statusCode));
    }

    req.log.error({err}, 'Unhandled error');
    res
        .status(500)
        .json(ApiResponse.error('Internal server error.'), 'INTERNAL_ERROR', 500)
}