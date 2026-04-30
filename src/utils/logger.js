import pino  from "pino";

export const logger = pino({
    level: process.LOG_LEVEL || 'info',
    ...(process.env.NODE_ENV != 'production' && {
        transport : {
            target: 'pino-pretty',
            options: {colorize: true}
        }
    })
});