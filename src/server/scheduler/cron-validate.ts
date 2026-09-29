import { Cron } from 'croner';

/**
 * 校验 cron 表达式与时区能否被 Croner 实际调度。
 * 无回调构造对非法 IANA 时区静默通过（惰性求值），必须触发 nextRun() 才暴露；
 * 坏值落库会让 scheduler.start() 抛错并造成重启崩溃循环，因此写入前强制校验。
 */
export function assertCronValid(expr: string, timezone: string): void {
  try {
    // nextRun() 强制求值：pattern 与 timezone 都会被实际验证。
    new Cron(expr, { timezone }).nextRun();
  } catch {
    throw new Error(`Invalid cron expression or timezone: ${JSON.stringify({ expr, timezone })}`);
  }
}
