import { loadConfig } from './config.js';
import { errorMessage, jsonLogger } from './logger.js';
import { startFlockServer } from './server.js';

async function main(): Promise<void> {
  const config = loadConfig(process.env, process.cwd());
  const server = await startFlockServer({ ...config, logger: jsonLogger });
  let stopping = false;
  const stop = (signal: string): void => {
    if (stopping) return;
    stopping = true;
    jsonLogger.info('shutting down', { signal });
    server.close().then(
      () => process.exit(0),
      (err: unknown) => {
        jsonLogger.error('shutdown failed', { error: errorMessage(err) });
        process.exit(1);
      },
    );
  };
  process.on('SIGINT', () => {
    stop('SIGINT');
  });
  process.on('SIGTERM', () => {
    stop('SIGTERM');
  });
}

main().catch((err: unknown) => {
  jsonLogger.error('failed to start', { error: errorMessage(err) });
  process.exit(1);
});
