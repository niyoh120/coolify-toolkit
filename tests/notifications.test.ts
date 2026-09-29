// Notification outbox: dedupe, retry classification, evidence independence.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migrate, type OpenDbResult, openDatabase } from '../src/server/db/client.js';
import { imageTracks, notificationOutbox, resources, updateJobs } from '../src/server/db/schema.js';
import type { AppriseClient } from '../src/server/integrations/apprise/client.js';
import { Outbox } from '../src/server/modules/notifications/outbox.js';

let h: OpenDbResult;
let dir: string;
let outbox: Outbox;
let appriseMode: 'ok' | 'fail404' | 'fail401' | 'fail500' | 'fail429' = 'ok';
let notifyCalls = 0;

function fakeApprise(): AppriseClient {
  const self = {
    notify: async () => {
      notifyCalls += 1;
      switch (appriseMode) {
        case 'ok':
          return { ok: true } as const;
        case 'fail404':
          return {
            ok: false,
            kind: 'missing_config',
            message: 'not found',
            retryable: false,
          } as const;
        case 'fail401':
          return {
            ok: false,
            kind: 'config_error',
            message: 'unauthorized',
            retryable: false,
          } as const;
        case 'fail500':
          return { ok: false, kind: 'transient', message: 'boom', retryable: true } as const;
        case 'fail429':
          return {
            ok: false,
            kind: 'rate_limited',
            message: 'limited',
            retryAfterSeconds: 1,
            retryable: true,
          } as const;
      }
    },
    test: async () => ({ ok: true }) as const,
  };
  return self as unknown as AppriseClient;
}

beforeEach(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'toolkit-notify-'));
  h = openDatabase(path.join(dir, 'db.sqlite'));
  migrate(h.db);

  outbox = new Outbox(h.db, () => fakeApprise());
  appriseMode = 'ok';
  notifyCalls = 0;
});

afterEach(() => {
  h.close();
  rmSync(dir, { recursive: true, force: true });
});

function seedJob(): number {
  const now = Date.now();
  h.db
    .insert(resources)
    .values({
      kind: 'application',
      coolifyUuid: 'app-x',
      name: 'app',
      createdAt: now,
      updatedAt: now,
    })
    .run();
  const job = h.db
    .insert(updateJobs)
    .values({
      resourceId: 1,
      kind: 'update',
      trigger: 'manual',
      candidateDigest: `sha256:${'b'.repeat(64)}`,
      candidateReference: 'app:sha256-b',
      status: 'success',
      stage: 'done',
      idempotencyKey: 'manual:1:b:0',
      log: [],
      createdAt: now,
      updatedAt: now,
    })
    .returning()
    .get();
  h.db
    .insert(imageTracks)
    .values({
      resourceId: 1,
      sourceRegistry: 'docker.io',
      sourceRepository: 'library/app',
      sourceRepositoryAuthored: 'app',
      sourceTag: 'latest',
      createdAt: now,
      updatedAt: now,
    })
    .run();
  return job.id;
}

describe('outbox', () => {
  it('dedupes identical candidates across repeated checks', () => {
    seedJob(); // also seeds the referenced resource row
    const input = {
      eventType: 'candidate_found' as const,
      resourceId: 1,
      dedupeKey: 'candidate:1:sha256:x',
      payload: { title: 't', body: 'b', type: 'info' as const },
    };
    expect(outbox.enqueue(input)).not.toBeNull();
    expect(outbox.enqueue(input)).toBeNull();
    expect(h.db.select().from(notificationOutbox).all()).toHaveLength(1);
  });

  it('sends pending notifications and marks them sent', async () => {
    seedJob();
    outbox.enqueue({
      eventType: 'update_success',
      resourceId: 1,
      dedupeKey: 'u:1',
      payload: { title: 't', body: 'b', type: 'success' },
    });
    const processed = await outbox.processNow();
    expect(processed).toBe(1);
    const rows = h.db.select().from(notificationOutbox).all();
    expect(rows[0]).toMatchObject({ status: 'sent' });
    expect(rows[0]?.sentAt).not.toBeNull();
  });

  it('pauses permanently on 404/config errors, keeps deployment evidence intact', async () => {
    const jobId = seedJob();
    outbox.enqueue({
      eventType: 'update_failed',
      resourceId: 1,
      dedupeKey: 'f:1',
      payload: { title: 't', body: 'b', type: 'failure' },
    });
    appriseMode = 'fail404';
    await outbox.processNow();
    const rows = h.db.select().from(notificationOutbox).all();
    expect(rows[0]).toMatchObject({ status: 'paused', attempts: 1 });
    // Update evidence untouched by notification handling.
    const job = h.db.select().from(updateJobs).where(eq(updateJobs.id, jobId)).get();
    expect(job?.status).toBe('success');
    const track = h.db.select().from(imageTracks).all();
    expect(track[0]?.lastSuccessfulDigest).toBeNull();
    // processNow skips paused items.
    expect(await outbox.processNow()).toBe(0);
  });

  it('retries transient failures with backoff within the attempt budget', async () => {
    seedJob();
    outbox.enqueue({
      eventType: 'candidate_found',
      resourceId: 1,
      dedupeKey: 'c:1',
      payload: { title: 't', body: 'b', type: 'info' },
    });
    appriseMode = 'fail500';
    const makeDue = (): void => {
      h.db
        .update(notificationOutbox)
        .set({ nextAttemptAt: Date.now() - 1 })
        .run();
    };
    await outbox.processNow();
    expect(h.db.select().from(notificationOutbox).all()[0]).toMatchObject({
      status: 'pending',
      attempts: 1,
    });
    makeDue();
    await outbox.processNow();
    expect(h.db.select().from(notificationOutbox).all()[0]).toMatchObject({
      status: 'pending',
      attempts: 2,
    });
    // Third attempt exhausts the budget -> failed (still retryable via redeliver).
    makeDue();
    await outbox.processNow();
    expect(h.db.select().from(notificationOutbox).all()[0]).toMatchObject({
      status: 'failed',
      attempts: 3,
    });
    expect(notifyCalls).toBe(3);

    // Recovery: redeliver after service is back.
    appriseMode = 'ok';
    const rows = h.db.select().from(notificationOutbox).all();
    expect(await outbox.redeliver(rows[0]!.id)).toBe(true);
    expect(h.db.select().from(notificationOutbox).all()[0]).toMatchObject({ status: 'sent' });
  });

  it('keeps rate-limited items pending with Retry-After honored', async () => {
    seedJob();
    outbox.enqueue({
      eventType: 'candidate_found',
      resourceId: 1,
      dedupeKey: 'c:2',
      payload: { title: 't', body: 'b', type: 'info' },
    });
    appriseMode = 'fail429';
    await outbox.processNow();
    const row = h.db.select().from(notificationOutbox).all()[0];
    expect(row).toMatchObject({ status: 'pending', attempts: 1 });
    expect(row!.nextAttemptAt).toBeGreaterThanOrEqual(Date.now() + 900);
  });

  it('keeps the queue durable when apprise is not configured', async () => {
    seedJob();
    const absent = new Outbox(h.db, () => null);
    absent.enqueue({
      eventType: 'candidate_found',
      resourceId: 1,
      dedupeKey: 'c:3',
      payload: { title: 't', body: 'b', type: 'info' },
    });
    expect(await absent.processNow()).toBe(0);
    expect(h.db.select().from(notificationOutbox).all()).toHaveLength(1);
  });
});
