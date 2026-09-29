// Settings repository: typed key/value over the settings table.

import { eq } from 'drizzle-orm';
import type { Db } from './client.js';
import { settings } from './schema.js';

export interface ToolkitSettings {
  syncCron: string;
  checkCron: string;
  cronTimezone: string;
  globalPaused: boolean;
  coolifyVersion: string | null;
  appriseLastTest: { ok: boolean; at: number; error: string | null } | null;
}

export const DEFAULT_SETTINGS: ToolkitSettings = {
  syncCron: '*/5 * * * *',
  checkCron: '0 0 * * *',
  cronTimezone: 'UTC',
  globalPaused: false,
  coolifyVersion: null,
  appriseLastTest: null,
};

const KEY = 'toolkit.settings';

export class SettingsRepo {
  constructor(private readonly db: Db) {}

  get(): ToolkitSettings {
    const row = this.db.select().from(settings).where(eq(settings.key, KEY)).get();
    if (row == null) return { ...DEFAULT_SETTINGS };
    return { ...DEFAULT_SETTINGS, ...(row.value as Partial<ToolkitSettings>) };
  }

  patch(patch: Partial<ToolkitSettings>): ToolkitSettings {
    const next = { ...this.get(), ...patch };
    const now = Date.now();
    this.db
      .insert(settings)
      .values({ key: KEY, value: next, updatedAt: now })
      .onConflictDoUpdate({ target: settings.key, set: { value: next, updatedAt: now } })
      .run();
    return next;
  }

  getMeta<T>(key: string): T | null {
    const row = this.db
      .select()
      .from(settings)
      .where(eq(settings.key, `meta.${key}`))
      .get();
    return row == null ? null : (row.value as T);
  }

  setMeta(key: string, value: unknown): void {
    const fullKey = `meta.${key}`;
    const now = Date.now();
    this.db
      .insert(settings)
      .values({ key: fullKey, value, updatedAt: now })
      .onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: now } })
      .run();
  }
}
