/**
 * HTTP server entry — `npm run api` (dev) and `npm start` (built dist).
 *
 * WHAT: loads env config, builds the app with logging on, binds HOST:PORT,
 *   and closes gracefully on SIGINT/SIGTERM.
 * CONNECTS TO M0-M4: none directly — everything goes through buildApp().
 */

import { buildApp } from './app.js';
import { loadConfig } from './config.js';

async function main(): Promise<void> {
  const cfg = loadConfig();
  const app = buildApp({ config: cfg, logger: true });

  let closing = false;
  const shutdown = (signal: string): void => {
    if (closing) return;
    closing = true;
    app.log.info({ signal }, 'shutting down');
    void app.close().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  await app.listen({ host: cfg.host, port: cfg.port });
  app.log.info(
    { url: `http://${cfg.host}:${cfg.port}` },
    'aero-search api listening',
  );
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
