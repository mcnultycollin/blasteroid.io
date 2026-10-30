// Entry point (`npm start`). Kept at the repository root so hosts that run
// `node server.js` by default (e.g. Elastic Beanstalk) keep working.
import { config } from './server/config.js';
import { log } from './server/log.js';
import { startServer } from './server/index.js';

let app;
try {
  app = await startServer();
} catch (err) {
  if (err.code !== 'EADDRINUSE') throw err;
  const port = err.port ?? config.port;
  const airplay = process.platform === 'darwin' && (port === 5000 || port === 7000);
  log.error(
    `Port ${port} is already in use${airplay ? ' (on macOS, AirPlay Receiver listens on 5000 and 7000)' : ''}. ` +
      `Start on another port with: PORT=${port + 1} npm start`,
  );
  process.exit(1);
}

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
