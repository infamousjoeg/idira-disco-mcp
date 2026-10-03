#!/usr/bin/env node
import { buildApp } from './app.js';
import { ConfigError, loadConfig } from './config.js';
import { createLogger } from './logger.js';
import { SERVER_NAME, SERVER_VERSION } from './server.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config.logLevel);
  const { app, handler } = await buildApp(config, { logger });

  const listener = app.listen(config.port, config.host, () => {
    logger.info('listening', {
      server: SERVER_NAME,
      version: SERVER_VERSION,
      bind: `${config.host}:${config.port}`,
      publicUrl: config.publicUrl.href,
      upstream: config.idira.graphqlUrl,
    });
  });
  listener.on('error', (error) => {
    logger.error('could not start listening', { error: error.message });
    process.exit(1);
  });

  const shutdown = (signal: string): void => {
    logger.info('shutting down', { signal });
    listener.close(() => {
      void handler.close().finally(() => process.exit(0));
    });
    // Do not let a stuck connection keep the process alive.
    setTimeout(() => process.exit(0), 10_000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((error: unknown) => {
  const message = error instanceof ConfigError ? error.message : `Startup failed: ${(error as Error).message}`;
  process.stderr.write(`${message}\n`);
  process.exit(1);
});
