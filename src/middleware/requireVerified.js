import { ForbiddenError } from "../errors/AppError";

export function requireVerified(req, _res, next) {
    if(!req.user.verified){
        throw new ForbiddenError(
            'Email address not verified. Check your inbox or call POST /auth/resend-verification.',
            'UNVERIFIED'
        )
    }
    next();
}