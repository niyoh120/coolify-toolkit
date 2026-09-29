// Croner-driven schedules + in-process worker loops.
import { Cron } from 'croner';
import { resources } from '../db/schema.js';
import type { Deps } from '../deps.js';

export interface SchedulerHandle {
  stop(): void;
}

export class Scheduler {
  private jobs: Cron[] = [];
  /** resourceId → 资源级检查任务（check_cron 覆盖全局默认的资源）。 */
  private resourceJobs = new Map<number, Cron>();
  /** 资源级任务当前使用的时区；设置页改时区后需整体重建。 */
  private resourceJobsTimezone: string | null = null;
  private syncRunning = false;
  private checkRunning = false;
  private workerTimer: NodeJS.Timeout | null = null;
  private outboxTimer: NodeJS.Timeout | null = null;
  private stopped = false;

  constructor(private readonly deps: Deps) {}

  start(): void {
    const { settings } = this.deps;

    this.replaceJobs(
      settings.get().syncCron,
      settings.get().checkCron,
      settings.get().cronTimezone,
    );
    this.reloadResourceSchedules();

    // Worker: drains the update queue (concurrency honored inside executor).
    this.workerTimer = setInterval(() => {
      if (this.stopped) return;
      void this.deps.executor.processQueue().catch(() => undefined);
    }, 5_000);

    // Outbox: retry due notifications.
    this.outboxTimer = setInterval(() => {
      if (this.stopped) return;
      void this.deps.outbox.processNow().catch(() => undefined);
    }, 15_000);
  }

  /** Re-read schedules from persisted settings (settings PATCH calls this). */
  reloadFromSettings(): void {
    const s = this.deps.settings.get();
    this.replaceJobs(s.syncCron, s.checkCron, s.cronTimezone);
    this.reloadResourceSchedules();
  }

  /** 重建资源级检查任务：资源新增/删除/修改 check_cron 后调用。 */
  reloadResourceSchedules(): void {
    if (this.stopped) return;
    const { db, checker } = this.deps;
    const rows = db
      .select({ id: resources.id, checkCron: resources.checkCron, status: resources.status })
      .from(resources)
      .all();
    const timezone = this.deps.settings.get().cronTimezone;
    if (this.resourceJobsTimezone != null && this.resourceJobsTimezone !== timezone) {
      // 时区变化：旧任务的触发时刻全部失效，全部停掉重建。
      for (const job of this.resourceJobs.values()) job.stop();
      this.resourceJobs.clear();
    }
    this.resourceJobsTimezone = timezone;
    const wanted = new Map<number, string>();
    for (const r of rows) {
      if (r.checkCron != null && r.checkCron !== '' && r.status === 'active') {
        wanted.set(r.id, r.checkCron);
      }
    }
    // 停掉已移除/已改动的
    for (const [id, job] of this.resourceJobs) {
      if (wanted.get(id) !== (job.getPattern() as string)) {
        job.stop();
        this.resourceJobs.delete(id);
      }
    }
    // 新建缺失的
    for (const [id, cron] of wanted) {
      if (this.resourceJobs.has(id)) continue;
      try {
        const job = new Cron(cron, { timezone, name: `resource-check-${id}` }, () => {
          if (this.stopped) return;
          void checker.checkResource(id, 'scheduled').catch(() => undefined);
        });
        this.resourceJobs.set(id, job);
      } catch {
        // 非法表达式在保存时已校验；运行期兜底跳过。
      }
    }
  }

  /** Replace cron jobs after settings edits (UI can call this live). */
  replaceJobs(syncCron: string, checkCron: string, timezone: string): void {
    for (const j of this.jobs) j.stop();
    this.jobs = [];
    // 兜底防御：写入路径已校验，但历史坏值/手工改库仍可能到达这里；
    // 单个任务失败只跳过该任务，避免服务重启进入崩溃循环。
    for (const [expr, name, run] of [
      [syncCron, 'inventory-sync', () => this.runSync()] as const,
      [checkCron, 'update-check', () => this.runCheck()] as const,
    ]) {
      try {
        this.jobs.push(new Cron(expr, { timezone, name }, run));
      } catch (err) {
        console.error(`[scheduler] invalid schedule "${name}" (${expr}), job skipped`, err);
      }
    }
  }

  private async runSync(): Promise<void> {
    if (this.syncRunning || this.stopped) return;
    this.syncRunning = true;
    try {
      await this.deps.sync.run();
    } catch {
      // Isolation: a failed round leaves existing rows intact; next cron retries.
    } finally {
      this.syncRunning = false;
    }
  }

  private async runCheck(): Promise<void> {
    if (this.checkRunning || this.stopped) return;
    this.checkRunning = true;
    try {
      await this.deps.checker.checkAll('scheduled');
    } catch {
      // ditto
    } finally {
      this.checkRunning = false;
    }
  }

  stop(): void {
    this.stopped = true;
    for (const j of this.jobs) j.stop();
    this.jobs = [];
    for (const j of this.resourceJobs.values()) j.stop();
    this.resourceJobs.clear();
    if (this.workerTimer != null) clearInterval(this.workerTimer);
    if (this.outboxTimer != null) clearInterval(this.outboxTimer);
  }
}
