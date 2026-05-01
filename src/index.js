import 'dotenv/config';
import {createServer} from 'http';
import {app} from './app.js';
import {connectDB} from './db/connect.js';
import {createSocketServer} from './socket/index.js';
import { logger } from './utils/logger.js';

const PORT = process.env.PORT || 3090;

async function start() {
    await connectDB();

    const httpServer = createServer(app);
    const io = createSocketServer(httpServer);

    // Make io accessible in controllers via req.app.get('io')
    app.set('io',io);

    httpServer.listen(PORT, () => logger.info({port: PORT}, 'Server started'))
}

start().catch(err => {
    logger.error(err, 'Failed to start server')
    process.exit(1);
})