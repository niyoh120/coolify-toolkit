// Server entry: env guard → config → db → deps → scheduler → http.
import './sdk-env.js'; // MUST stay first: fixes SDK retry env before SDK loads.
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { serve } from '@hono/node-server';
import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { migrate, openDatabase } from './db/client.js';
import { buildDeps } from './deps.js';
import { Scheduler } from './scheduler/index.js';
import { lockPathFor, SingleInstanceLock } from './single-instance.js';

async function main(): Promise<void> {
  const cfg = loadConfig();
  mkdirSync(path.dirname(lockPathFor(cfg.databasePath)), { recursive: true });
  const lock = new SingleInstanceLock(lockPathFor(cfg.databasePath));
  lock.acquire();

  const { db, close } = openDatabase(cfg.databasePath);
  migrate(db); // failure stops startup by design

  const deps = buildDeps(cfg, db);

  // Recover in-flight work before schedules resume.
  const reconciled = await deps.executor.reconcileOnBoot();
  console.log(
    `[toolkit] reconcile: requeued=${reconciled.requeued} resolved=${reconciled.resolved} unknown=${reconciled.unknown}`,
  );

  const scheduler = new Scheduler(deps);
  scheduler.start();
  // Live cron reload after settings edits (routes call applySchedule).
  deps.applySchedule = () => scheduler.reloadFromSettings();
  deps.applyResourceSchedules = () => scheduler.reloadResourceSchedules();

  const app = createApp(deps);
  const server = serve({ fetch: app.fetch, port: cfg.port }, (info) => {
    console.log(`[toolkit] listening on http://0.0.0.0:${info.port} (db: ${cfg.databasePath})`);
  });

  const shutdown = (signal: string) => {
    console.log(`[toolkit] received ${signal}; shutting down`);
    scheduler.stop();
    server.close(() => {
      lock.release();
      close();
      process.exit(0);
    });
    // Hard exit guard if sockets linger.
    setTimeout(() => {
      lock.release();
      close();
      process.exit(0);
    }, 5_000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error('[toolkit] startup failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
