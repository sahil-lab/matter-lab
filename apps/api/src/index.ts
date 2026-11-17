import { createApp } from './app.js';
import { closeContext, createContext } from './context.js';
import { loadConfig } from './config.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const ctx = await createContext(config);
  const app = createApp(ctx);

  const server = app.listen(config.port, config.host, () => {
    // eslint-disable-next-line no-console
    console.log(`matterlab lab API listening on http://${config.host}:${config.port}`);
  });

  const shutdown = async (signal: string): Promise<void> => {
    // eslint-disable-next-line no-console
    console.log(`${signal} received, shutting down`);
    server.close(() => {
      closeContext(ctx).finally(() => process.exit(0));
    });
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((error: unknown) => {
  // eslint-disable-next-line no-console
  console.error('matterlab lab API failed to start', error);
  process.exitCode = 1;
});
