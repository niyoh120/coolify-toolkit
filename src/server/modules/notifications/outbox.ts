// Notification outbox: durable enqueue with dedupe + stateful retry processing.
// Sending is independent of update results; a failed send never mutates
// deployment evidence or job outcomes.

import { and, asc, eq, inArray, lte } from 'drizzle-orm';
import type { NotificationEventType } from '../../../shared/types.js';
import type { Db } from '../../db/client.js';
import { notificationOutbox } from '../../db/schema.js';
import type {
  AppriseClient,
  AppriseMessageType,
  NotifyPayload,
} from '../../integrations/apprise/client.js';
import { APPRISE_MAX_ATTEMPTS } from '../../integrations/apprise/client.js';

const BASE_BACKOFF_MS = 30_000;

export interface EnqueueInput {
  eventType: NotificationEventType;
  resourceId: number | null;
  dedupeKey: string;
  payload: NotifyPayload;
}

export class Outbox {
  constructor(
    private readonly db: Db,
    private readonly apprise: () => AppriseClient | null,
  ) {}

  /** Insert if absent; dedupe identity is the caller-composed key (§7). */
  enqueue(input: EnqueueInput): number | null {
    const now = Date.now();
    const res = this.db
      .insert(notificationOutbox)
      .values({
        eventType: input.eventType,
        resourceId: input.resourceId,
        dedupeKey: input.dedupeKey,
        title: input.payload.title,
        body: input.payload.body,
        status: 'pending',
        nextAttemptAt: now,
        createdAt: now,
      })
      .onConflictDoNothing({ target: notificationOutbox.dedupeKey })
      .returning({ id: notificationOutbox.id })
      .get();
    return res?.id ?? null;
  }

  pendingCount(): number {
    return this.db
      .select({ id: notificationOutbox.id })
      .from(notificationOutbox)
      .where(inArray(notificationOutbox.status, ['pending', 'failed']))
      .all().length;
  }

  /** Process due notifications. Returns processed count. */
  async processNow(limit = 20): Promise<number> {
    const client = this.apprise();
    if (client == null) return 0; // not configured: keep queue durable
    const now = Date.now();
    const due = this.db
      .select()
      .from(notificationOutbox)
      .where(
        and(
          inArray(notificationOutbox.status, ['pending', 'failed']),
          lte(notificationOutbox.nextAttemptAt, now),
        ),
      )
      .orderBy(asc(notificationOutbox.id))
      .limit(limit)
      .all();

    let processed = 0;
    for (const item of due) {
      processed += 1;
      const result = await client.notify({
        title: item.title,
        body: item.body,
        type: typeFor(item.eventType),
      });
      if (result.ok) {
        this.db
          .update(notificationOutbox)
          .set({ status: 'sent', sentAt: Date.now(), lastError: null, attempts: item.attempts + 1 })
          .where(eq(notificationOutbox.id, item.id))
          .run();
        continue;
      }
      const attempts = item.attempts + 1;
      const permanent = result.retryable === false;
      const exhausted = attempts >= APPRISE_MAX_ATTEMPTS;
      if (permanent || exhausted) {
        this.db
          .update(notificationOutbox)
          .set({
            status: permanent ? 'paused' : 'failed',
            lastError: result.message,
            attempts,
            nextAttemptAt: Date.now(),
          })
          .where(eq(notificationOutbox.id, item.id))
          .run();
      } else {
        const backoff = BASE_BACKOFF_MS * 2 ** (attempts - 1);
        const extra =
          result.kind === 'rate_limited' && result.retryAfterSeconds != null
            ? result.retryAfterSeconds * 1000
            : 0;
        this.db
          .update(notificationOutbox)
          .set({
            status: 'pending',
            lastError: result.message,
            attempts,
            nextAttemptAt: Date.now() + Math.max(backoff, extra),
          })
          .where(eq(notificationOutbox.id, item.id))
          .run();
      }
    }
    return processed;
  }

  /** Manual re-send entry for paused/failed items. */
  async redeliver(id: number): Promise<boolean> {
    const client = this.apprise();
    if (client == null) return false;
    const item = this.db
      .select()
      .from(notificationOutbox)
      .where(eq(notificationOutbox.id, id))
      .get();
    if (item == null) return false;
    const result = await client.notify({
      title: item.title,
      body: item.body,
      type: typeFor(item.eventType),
    });
    if (result.ok) {
      this.db
        .update(notificationOutbox)
        .set({ status: 'sent', sentAt: Date.now(), lastError: null })
        .where(eq(notificationOutbox.id, item.id))
        .run();
      return true;
    }
    this.db
      .update(notificationOutbox)
      .set({ status: result.retryable ? 'pending' : 'paused', lastError: result.message })
      .where(eq(notificationOutbox.id, item.id))
      .run();
    return false;
  }
}

function typeFor(eventType: NotificationEventType): AppriseMessageType {
  switch (eventType) {
    case 'update_success':
      return 'success';
    case 'update_failed':
      return 'failure';
    case 'submit_unknown':
      return 'warning';
    case 'candidate_found':
    case 'upstream_changed':
      return 'info';
  }
}
