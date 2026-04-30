import 'dotenv/config'
import {app} from './app.js'
import {connectDB} from './db/connect.js'
import { logger } from './utils/logger.js'

const PORT = process.env.PORT || 3090;

async function start() {
    await connectDB();
    app.listen(PORT, () => logger.info({port: PORT}, 'Server started'))
}

start().catch(err => {
    logger.err(err, 'Failed to start server')
    process.exit(1);
})