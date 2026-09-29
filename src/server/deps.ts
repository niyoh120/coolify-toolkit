// Server dependencies assembled once; createApp stays test-friendly.

import type { AppConfig } from './config.js';
import type { Db } from './db/client.js';
import { SettingsRepo } from './db/settings-repo.js';
import { AppriseClient } from './integrations/apprise/client.js';
import { CoolifyClient } from './integrations/coolify/client.js';
import { tagLastPushedAt } from './integrations/registry/adapter.js';
import { InventorySync } from './modules/inventory/sync.js';
import { Outbox } from './modules/notifications/outbox.js';
import { UpdateChecker } from './modules/updates/checker.js';
import { UpdateExecutor } from './modules/updates/executor.js';
import { JobsService } from './modules/updates/jobs.js';

export interface Deps {
  cfg: AppConfig;
  db: Db;
  coolify: CoolifyClient;
  apprise: AppriseClient | null;
  settings: SettingsRepo;
  sync: InventorySync;
  checker: UpdateChecker;
  jobs: JobsService;
  executor: UpdateExecutor;
  outbox: Outbox;
  /** Set by the entrypoint after scheduler construction: live cron reload. */
  applySchedule?: () => void;
  applyResourceSchedules?: () => void;
}

export function buildDeps(cfg: AppConfig, db: Db): Deps {
  const coolify = new CoolifyClient({
    baseUrl: cfg.coolifyBaseUrl,
    apiKey: cfg.coolifyApiKey,
    verifyTls: cfg.coolifyVerifyTls,
  });
  const apprise =
    cfg.apprise.apiUrl != null && cfg.apprise.configKey != null
      ? new AppriseClient({
          apiUrl: cfg.apprise.apiUrl,
          configKey: cfg.apprise.configKey,
          tag: cfg.apprise.tag,
          user: cfg.apprise.user,
          password: cfg.apprise.password,
        })
      : null;
  const settings = new SettingsRepo(db);
  const outbox = new Outbox(db, () => apprise);
  const jobs = new JobsService(db, settings);
  const sync = new InventorySync(db, coolify, cfg, settings);
  const checker = new UpdateChecker(db, cfg, settings, outbox, jobs, undefined, tagLastPushedAt);
  const executor = new UpdateExecutor(db, coolify, jobs, outbox, settings, cfg);
  return { cfg, db, coolify, apprise, settings, sync, checker, jobs, executor, outbox };
}
