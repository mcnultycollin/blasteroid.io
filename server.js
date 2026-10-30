// Entry point (`npm start`). Kept at the repository root so hosts that run
// `node server.js` by default (e.g. Elastic Beanstalk) keep working.
import { log } from './server/log.js';
import { startServer } from './server/index.js';

const app = await startServer();

let stopping = false;
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    if (stopping) return;
    stopping = true;
    log.info(`${signal} received, shutting down`);
    await app.close();
    process.exit(0);
  });
}
