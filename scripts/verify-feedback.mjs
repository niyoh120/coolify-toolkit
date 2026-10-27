#!/usr/bin/env node
// Action-feedback browser regression, driven by the existing agent-browser CLI.
//
//   npm run test:feedback   (= npm run build:web && node scripts/verify-feedback.mjs)
//
// Serves the compiled frontend from dist/web plus the in-memory /api fixture in
// tests/fixtures/responsive-ui.mjs on a random 127.0.0.1 port, then runs the
// operation-feedback scenario groups against a real Chromium:
//   A. shared sync lifecycle: one request + one toast across entries (desktop
//      sidebar / overview / resources tab bar), pending labels, busy disable,
//      route switch mid-sync still lands the result toast, no leftover loading
//   B. failure paths: JSON 502, HTML 503, rate-limit with/without seconds,
//      network destroy — error visible, button recovers (finally)
//   C. business outcomes: partial sync errors, probe ok:false, redeliver
//      ok:false, settings save/test-notify, overview check; success paths show
//      real summaries; local-scope errors stay inline (no global duplicate)
//   D. copy: delayed promise busy + de-dupe, success content, rejection and
//      missing-clipboard-API feedback, no unhandled rejections
//
// Exit codes: 0 = all assertions passed, 1 = at least one assertion failed,
// 2 = environment blocked (no CLI/browser/fixture). Artifacts (screenshots,
// results.json) are written to a temp directory (override with --shots DIR).

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';
import { createResponsiveFixtureServer } from '../tests/fixtures/responsive-ui.mjs';

const exec = promisify(execFile);

// --- CLI -------------------------------------------------------------------------

const argv = process.argv.slice(2);
function argValue(flag) {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
}
const shotsDir = path.resolve(
  argValue('--shots') ?? path.join(os.tmpdir(), `coolify-feedback-${Date.now()}`),
);
fs.mkdirSync(shotsDir, { recursive: true });

// --- agent-browser helpers --------------------------------------------------------

const SESSION = 'feedback-verify';
const AB_TIMEOUT = 60_000;

async function ab(args, { timeout = AB_TIMEOUT, retry = true } = {}) {
  const baseEnv = {
    ...process.env,
    AGENT_BROWSER_ALLOWED_DOMAINS: '127.0.0.1,localhost',
  };
  try {
    const { stdout } = await exec('agent-browser', ['--session', SESSION, ...args], {
      timeout,
      maxBuffer: 16 * 1024 * 1024,
      env: baseEnv,
    });
    return stdout;
  } catch (err) {
    if (!retry) throw err;
    try {
      await exec('agent-browser', ['close', '--all'], { timeout: 30_000 });
    } catch {
      // best effort; the retry below will surface the real error
    }
    const { stdout } = await exec('agent-browser', ['--session', SESSION, ...args], {
      timeout,
      maxBuffer: 16 * 1024 * 1024,
      env: baseEnv,
    });
    return stdout;
  }
}

/** Evaluate an async IIFE and await its resolved JSON. agent-browser prints the
 *  return value JSON-serialized (plain promises serialize to "{}"), so the
 *  expression must resolve its own promise and stringify the result there. */
async function evalJson(expression) {
  // `${expression}` 本身就是 async IIFE；在浏览器侧 .then 内 stringify 结果。
  const out = (await ab(['eval', `${expression}.then((r) => JSON.stringify(r))`])).trim();
  let once;
  try {
    once = JSON.parse(out);
  } catch {
    throw new Error(`eval returned unparsable output: ${out.slice(0, 200)}`);
  }
  if (typeof once === 'string') {
    try {
      return JSON.parse(once);
    } catch {
      return once;
    }
  }
  return once;
}

async function pollAppReady({ attempts = 60, intervalMs = 250, label = 'app ready' } = {}) {
  for (let t = 0; t < attempts; t++) {
    try {
      const r = await evalJson(`(async () => {
        const m = document.querySelector('main');
        return m != null && m.children.length > 0 && !m.textContent.includes('加载中');
      })()`);
      if (r === true) return;
    } catch {
      // page mid-navigation; poll again
    }
    await sleep(intervalMs);
  }
  throw new Error(`page not ready: ${label}`);
}

async function goto(baseUrl, hash) {
  await ab(['open', `${baseUrl}/${hash.replace(/^#/, '#')}`]);
  await ab(['reload']);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await pollAppReady({ label: `${baseUrl}/${hash}` });
      return;
    } catch {
      // retry below after one more reload
    }
    if (attempt === 0) await ab(['reload']);
  }
  throw new Error(`page not ready: ${baseUrl}/${hash}`);
}

/** Poll an async expression until it is truthy. */
async function waitFor(expression, { timeoutMs = 6000, label = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try {
      last = await evalJson(expression);
      if (last) return last;
    } catch {
      // retry until deadline
    }
    await sleep(200);
  }
  throw new Error(`timeout waiting for ${label}: last=${JSON.stringify(last)}`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// --- reporting --------------------------------------------------------------------

const results = [];
let hadFailure = false;

function record(group, name, pass, details) {
  results.push({ group, name, pass, details: pass ? null : details });
  if (!pass) hadFailure = true;
  console.log(
    `  ${pass ? '✓' : '✗'} ${group} › ${name}${pass ? '' : ` — ${JSON.stringify(details)}`}`,
  );
}

/** Run a scenario. The scenario returns an object of named booleans; every
 *  entry must be exactly true for the check to pass (fail-closed: a missing
 *  key or a non-boolean fails the check instead of silently passing). */
async function expect(group, name, fn) {
  let outcome;
  try {
    outcome = await fn();
  } catch (err) {
    record(group, name, false, { error: err instanceof Error ? err.message : String(err) });
    try {
      await ab([
        'screenshot',
        path.join(shotsDir, `fail-${group}-${name}.png`.replace(/\s/g, '_')),
      ]);
    } catch {
      // screenshot is best-effort
    }
    return;
  }
  if (outcome == null || typeof outcome !== 'object') {
    record(group, name, false, { error: 'scenario returned no boolean map', outcome });
    return;
  }
  // 空断言对象视为缺陷：场景必须至少声明一项可观察断言（F16 回归）。
  if (Object.keys(outcome).length === 0) {
    record(group, name, false, { error: 'scenario returned an empty assertion map' });
    return;
  }
  const failed = Object.entries(outcome).filter(([, v]) => v !== true);
  record(group, name, failed.length === 0, failed.length === 0 ? null : Object.fromEntries(failed));
}

/** Assert a boolean map collected in-page; used inside expect() scenarios. */
function allTrue(map) {
  return Object.fromEntries(Object.entries(map).map(([k, v]) => [k, v === true]));
}

// --- in-page snippets (async IIFEs) ------------------------------------------------

const TOASTS = `(async () => {
  const items = Array.from(document.querySelectorAll('[data-sonner-toast]')).filter(
    (t) => t.getAttribute('data-removed') !== 'true',
  );
  return {
    count: items.length,
    types: items.map((t) => t.getAttribute('data-type')),
    texts: items.map((t) => (t.textContent ?? '').trim()),
  };
})()`;

const SYNC_CONTROL = (body) => `(async () => {
  const r = await fetch('/api/__fixture/sync-control', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(${JSON.stringify(body)}),
  });
  return r.json();
})()`;

const ACTION_CONTROL = (body) => `(async () => {
  const r = await fetch('/api/__fixture/action-control', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(${JSON.stringify(body)}),
  });
  return r.json();
})()`;

const SYNC_HITS = `(async () => {
  const r = await fetch('/api/__fixture/sync-control', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });
  const j = await r.json();
  return j.control.hits;
})()`;

const SYNC_BUTTON_CLICK = `(async () => {
  const b = Array.from(document.querySelectorAll('aside button')).find((x) =>
    x.textContent.includes('重新同步'),
  );
  if (b == null) return false;
  b.click();
  return true;
})()`;

/** unhandled rejection / error 捕获（复制场景回归）。 */
const INSTALL_ERROR_TRAP = `(async () => {
  window.__feedbackErrors = [];
  window.addEventListener('unhandledrejection', (e) => window.__feedbackErrors.push(String(e.reason)));
  window.addEventListener('error', (e) => window.__feedbackErrors.push(String(e.message)));
  return true;
})()`;

// --- scenarios --------------------------------------------------------------------

async function main() {
  const webRoot = path.resolve('dist/web');
  if (!fs.existsSync(path.join(webRoot, 'index.html'))) {
    console.error('dist/web/index.html missing — run npm run build:web first.');
    process.exit(2);
  }
  const fixture = createResponsiveFixtureServer({ webRoot });
  const { url, close } = await fixture.start();
  console.log(`fixture: ${url}`);

  try {
    await ab(['set', 'viewport', '1280', '900']);

    // --- A. 共享同步生命周期 -----------------------------------------------------
    await goto(url, '#/');
    await expect(
      'A',
      '桌面侧栏触发同步：忙碌禁用 + loading 提示 + 仅一个请求 + 无遗留 loading',
      async () => {
        await evalJson(SYNC_CONTROL({ delayMs: 800, mode: 'ok', resetHits: true }));
        await evalJson(SYNC_BUTTON_CLICK);
        const busyDuring = await waitFor(
          `(async () => {
        const b = Array.from(document.querySelectorAll('aside button')).find((x) => x.textContent.includes('同步中…'));
        return b != null && b.disabled === true;
      })()`,
          { label: 'sidebar busy' },
        );
        const loadingDuring = await waitFor(
          `(async () => {
        return document.querySelectorAll('[data-sonner-toast][data-type="loading"]').length === 1;
      })()`,
          { label: 'single loading toast' },
        );
        // 完成后：结果 toast 原地替换 loading，loading 数必须归零（F1 回归）。
        await waitFor(
          `(async () => {
        const t = await ${TOASTS};
        return t.types.includes('success') && !t.types.includes('loading');
      })()`,
          { label: 'success replaces loading' },
        );
        const toastsAfter = await evalJson(TOASTS);
        const hits = await evalJson(SYNC_HITS);
        return allTrue({
          busyDuring,
          loadingDuring,
          successShown: toastsAfter.types.includes('success'),
          noLeftoverLoading: !toastsAfter.types.includes('loading'),
          singleRequest: hits === 1,
        });
      },
    );

    await expect('A', '成功 toast 展示真实摘要', async () => {
      const t = await evalJson(TOASTS);
      const text = t.texts.join(' ');
      return allTrue({
        summary: text.includes('资源同步完成') && text.includes('扫描'),
      });
    });

    await expect(
      'A',
      '概览入口与侧栏入口共享忙碌态（重复点击仅一个请求、一个 loading）',
      async () => {
        await evalJson(SYNC_CONTROL({ delayMs: 1500, mode: 'ok', resetHits: true }));
        await evalJson(`(async () => {
        const all = Array.from(document.querySelectorAll('button'));
        const pick = (s) => all.find((b) => b.textContent.trim().startsWith(s));
        pick('同步资源')?.click();
        pick('同步中…')?.click();
        pick('重新同步')?.click();
        return true;
      })()`);
        await waitFor(
          `(async () => {
        return document.querySelectorAll('[data-sonner-toast][data-type="loading"]').length === 1;
      })()`,
          { label: 'single loading across entries' },
        );
        const busy = await evalJson(`(async () => {
        const all = Array.from(document.querySelectorAll('button'));
        return {
          overviewBusy: all.some((b) => b.closest('main') != null && b.textContent.trim() === '同步中…'),
          sidebarBusy: all.some((b) => b.closest('aside') != null && b.textContent.trim() === '同步中…'),
        };
      })()`);
        await waitFor(
          `(async () => {
        const t = await ${TOASTS};
        return t.types.includes('success') && !t.types.includes('loading');
      })()`,
          { label: 'sync completes' },
        );
        const hits = await evalJson(SYNC_HITS);
        return allTrue({ ...busy, singleRequest: hits === 1, noLeftoverLoading: true });
      },
    );

    await expect('A', '同步中途切换路由仍收到完成反馈', async () => {
      await goto(url, '#/');
      await evalJson(SYNC_CONTROL({ delayMs: 1200, mode: 'ok', resetHits: true }));
      await evalJson(SYNC_BUTTON_CLICK);
      await waitFor(
        `(async () => document.querySelectorAll('[data-sonner-toast][data-type="loading"]').length === 1)()`,
        { label: 'loading toast' },
      );
      await ab(['open', `${url}/#/settings`]);
      const done = await waitFor(
        `(async () => {
        const t = await ${TOASTS};
        return t.types.includes('success') && !t.types.includes('loading');
      })()`,
        { label: 'success after route change' },
      );
      return allTrue({ done });
    });

    // --- B. 失败路径 -------------------------------------------------------------
    const failureCases = [
      { mode: 'json502', expectText: '服务暂时不可用（HTTP 502）' },
      { mode: 'html503', expectText: '服务暂时不可用（HTTP 503）' },
      { mode: 'rate-limit', expectText: 'Coolify 请求过于频繁', expectDetail: '45 秒' },
      { mode: 'rate-limit-no-retry', expectText: 'Coolify 请求过于频繁', expectDetail: '稍后重试' },
      { mode: 'network', expectText: '网络异常' },
    ];
    for (const tc of failureCases) {
      await expect('B', `同步失败可见且按钮恢复：${tc.mode}`, async () => {
        await goto(url, '#/');
        await evalJson(SYNC_CONTROL({ delayMs: 100, mode: tc.mode, resetHits: true }));
        await evalJson(SYNC_BUTTON_CLICK);
        const shown = await waitFor(
          `(async () => {
          const t = await ${TOASTS};
          const text = t.texts.join(' ');
          return text.includes('${tc.expectText}')${tc.expectDetail ? ` && text.includes('${tc.expectDetail}')` : ''};
        })()`,
          { label: `error toast ${tc.mode}` },
        );
        const recovered = await waitFor(
          `(async () => {
          const b = Array.from(document.querySelectorAll('aside button')).find((x) => x.textContent.includes('重新同步'));
          return b != null && b.disabled === false;
        })()`,
          { label: 'sidebar recovered' },
        );
        const t = await evalJson(TOASTS);
        return allTrue({
          shown,
          recovered,
          errorType: t.types.includes('error'),
          noLeftoverLoading: !t.types.includes('loading'),
        });
      });
    }

    // --- C. 业务结果 -------------------------------------------------------------
    await expect('C', 'errors 非空显示部分完成而非成功', async () => {
      await goto(url, '#/');
      await evalJson(SYNC_CONTROL({ delayMs: 100, mode: 'partial', resetHits: true }));
      await evalJson(SYNC_BUTTON_CLICK);
      const shown = await waitFor(
        `(async () => {
        const t = await ${TOASTS};
        const text = t.texts.join(' ');
        return text.includes('同步部分完成') && !text.includes('资源同步完成') && t.types.includes('error');
      })()`,
        { label: 'partial completion toast' },
      );
      const t = await evalJson(TOASTS);
      return allTrue({
        shown,
        errorType: t.types.includes('error'),
        noSuccess: !t.texts.some((x) => x.includes('资源同步完成')),
      });
    });

    await expect('C', '设置保存成功提示且按钮忙碌态可见', async () => {
      await goto(url, '#/settings');
      await evalJson(`(async () => {
        const b = Array.from(document.querySelectorAll('button')).find((x) => x.textContent.trim() === '保存');
        if (b == null) return false;
        b.click();
        return true;
      })()`);
      const busySeen = await waitFor(
        `(async () => {
        const b = Array.from(document.querySelectorAll('button')).find((x) => x.textContent.trim() === '保存中…');
        return b != null && b.disabled === true;
      })()`,
        { label: 'save busy label', timeoutMs: 2000 },
      ).catch(() => false);
      const done = await waitFor(
        `(async () => {
        const t = await ${TOASTS};
        return t.texts.some((x) => x.includes('设置已保存'));
      })()`,
        { label: 'save success toast' },
      );
      return allTrue({ busySeen, done });
    });

    await expect('C', '设置探测 ok:false 显示连接失败（业务失败不显成功）', async () => {
      await goto(url, '#/settings');
      await evalJson(ACTION_CONTROL({ probeOk: false }));
      await evalJson(`(async () => {
        const b = Array.from(document.querySelectorAll('button')).find((x) => x.textContent.trim() === '测试连接');
        b?.click();
        return true;
      })()`);
      const shown = await waitFor(
        `(async () => {
        const t = await ${TOASTS};
        return t.texts.some((x) => x.includes('Coolify 连接失败')) && !t.texts.some((x) => x.includes('连接正常'));
      })()`,
        { label: 'probe failure toast' },
      );
      return allTrue({ shown });
    });

    await expect('C', '设置探测 ok:true 显示成功', async () => {
      await evalJson(ACTION_CONTROL({ probeOk: true }));
      await evalJson(`(async () => {
        const b = Array.from(document.querySelectorAll('button')).find((x) => x.textContent.trim() === '测试连接');
        b?.click();
        return true;
      })()`);
      const shown = await waitFor(
        `(async () => {
        const t = await ${TOASTS};
        return t.texts.some((x) => x.includes('Coolify 连接正常'));
      })()`,
        { label: 'probe success toast' },
      );
      return allTrue({ shown });
    });

    await expect('C', '通知补发 ok:false 显示失败且队列已刷新（尝试次数 +1）', async () => {
      await goto(url, '#/notifications');
      await evalJson(ACTION_CONTROL({ redeliverOk: false }));
      // 记录目标行补发前的尝试次数（fixture 的行有 attempts 列）。
      // 第一行可能是 sent（无补发按钮），找第一个带补发按钮的行。
      const before = await evalJson(`(async () => {
        const region = document.querySelector('[role="region"][aria-label="通知队列"]');
        if (region == null) return null;
        for (const row of region.querySelectorAll('tbody tr')) {
          const btn = Array.from(row.querySelectorAll('button')).find((x) => x.textContent.includes('补发'));
          if (btn != null) {
            const cells = Array.from(row.querySelectorAll('td')).map((c) => c.textContent.trim());
            return { attempts: Number.parseInt(cells[4] ?? '-1', 10), status: cells[3] };
          }
        }
        return null;
      })()`);
      const hadButton = before != null;
      await evalJson(`(async () => {
        const region = document.querySelector('[role="region"][aria-label="通知队列"]');
        if (region == null) return false;
        for (const row of region.querySelectorAll('tbody tr')) {
          const btn = Array.from(row.querySelectorAll('button')).find((x) => x.textContent.includes('补发'));
          if (btn != null) {
            btn.click();
            return true;
          }
        }
        return false;
      })()`);
      const shown = await waitFor(
        `(async () => {
        const t = await ${TOASTS};
        return t.texts.some((x) => x.includes('补发失败')) && !t.texts.some((x) => x.includes('已重新发送'));
      })()`,
        { label: 'redeliver failure toast' },
      );
      // 队列真实刷新：目标行 attempts +1（fixture n.attempts += 1 后被前端重读）。
      // 状态变 pending 后补发按钮消失，扫描全表找 attempts === before+1 的行。
      const refreshed = await waitFor(
        `(async () => {
        const region = document.querySelector('[role="region"][aria-label="通知队列"]');
        if (region == null) return false;
        const target = ${'__BEFORE__'} + 1;
        for (const row of region.querySelectorAll('tbody tr')) {
          const cells = Array.from(row.querySelectorAll('td')).map((c) => c.textContent.trim());
          if (Number.parseInt(cells[4] ?? '-1', 10) === target) return true;
        }
        return false;
      })()`.replace('__BEFORE__', String(before?.attempts ?? -1)),
        { label: 'attempts incremented after refresh' },
      );
      return allTrue({ hadButton, shown, refreshed });
    });

    await expect('C', '概览立即检查展示处理数（不宣称全部成功）', async () => {
      await goto(url, '#/');
      await evalJson(`(async () => {
        const b = Array.from(document.querySelectorAll('button')).find((x) => x.textContent.trim() === '立即检查');
        b?.click();
        return true;
      })()`);
      const shown = await waitFor(
        `(async () => {
        const t = await ${TOASTS};
        return t.texts.some((x) => x.includes('检查请求已完成') && x.includes('处理'));
      })()`,
        { label: 'check summary toast' },
      );
      const t = await evalJson(TOASTS);
      return allTrue({
        shown,
        noOverclaim: !t.texts.some((x) => x.includes('全部检查成功')),
      });
    });

    await expect('C', '设置保存失败：全局错误带操作名且值未落库', async () => {
      await goto(url, '#/settings');
      await evalJson(`(async () => {
        const r = await fetch('/api/__fixture/settings-control', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ failSave: true }),
        });
        return r.json();
      })()`);
      await evalJson(`(async () => {
        const b = Array.from(document.querySelectorAll('button')).find((x) => x.textContent.trim() === '保存');
        b?.click();
        return b != null;
      })()`);
      const shown = await waitFor(
        `(async () => {
        const t = await ${TOASTS};
        // C3：全局错误标题携带操作名「保存设置」。
        return t.types.includes('error') && t.texts.some((x) => x.includes('保存设置失败'));
      })()`,
        { label: 'save failure toast with action name' },
      );
      // 复位故障注入：后续场景的 PATCH（暂停/恢复）需要正常保存路径。
      await evalJson(`(async () => {
        await fetch('/api/__fixture/settings-control', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ failSave: false }),
        });
        return true;
      })()`);
      return allTrue({ shown });
    });

    await expect('C', '测试通知成功与失败分别反馈，失败后「上次测试」立即刷新', async () => {
      await goto(url, '#/settings');
      await evalJson(ACTION_CONTROL({ notifyTestOk: false }));
      await evalJson(`(async () => {
        const b = Array.from(document.querySelectorAll('button')).find((x) => x.textContent.trim() === '发送测试');
        b?.click();
        return b != null;
      })()`);
      const failShown = await waitFor(
        `(async () => {
        const t = await ${TOASTS};
        return t.texts.some((x) => x.includes('测试通知发送失败'));
      })()`,
        { label: 'notify failure toast' },
      );
      // onSettled 刷新：上次测试错误文案应出现在页面（fixture 落库的失败信息）。
      const refreshedAfterFail = await waitFor(
        `(async () => {
        return document.body.textContent.includes('fixture: apprise unreachable');
      })()`,
        { label: 'lastTest refreshed after failure' },
      );
      await evalJson(ACTION_CONTROL({ notifyTestOk: true }));
      await evalJson(`(async () => {
        const b = Array.from(document.querySelectorAll('button')).find((x) => x.textContent.trim() === '发送测试');
        b?.click();
        return true;
      })()`);
      const successShown = await waitFor(
        `(async () => {
        const t = await ${TOASTS};
        return t.texts.some((x) => x.includes('测试通知已发送'));
      })()`,
        { label: 'notify success toast' },
      );
      return allTrue({ failShown, refreshedAfterFail, successShown });
    });

    await expect('C', '暂停/恢复自动更新有明确结果反馈', async () => {
      await goto(url, '#/');
      // 按钮初始方向取决于当前 globalPaused 状态，两个方向都验证反馈。
      await evalJson(`(async () => {
        const b = Array.from(document.querySelectorAll('button')).find((x) => x.textContent.includes('恢复自动更新'));
        b?.click();
        return true;
      })()`);
      const resumed = await waitFor(
        `(async () => {
        const t = await ${TOASTS};
        return t.texts.some((x) => x.includes('已恢复自动更新'));
      })()`,
        { label: 'resumed toast' },
      );
      const flippedToPause = await waitFor(
        `(async () => {
        return Array.from(document.querySelectorAll('button')).some((x) => x.textContent.includes('全局暂停自动更新'));
      })()`,
        { label: 'pause button after resume' },
      );
      await evalJson(`(async () => {
        const b = Array.from(document.querySelectorAll('button')).find((x) => x.textContent.includes('全局暂停自动更新'));
        b?.click();
        return true;
      })()`);
      const paused = await waitFor(
        `(async () => {
        const t = await ${TOASTS};
        return t.texts.some((x) => x.includes('已全局暂停自动更新'));
      })()`,
        { label: 'paused toast' },
      );
      return allTrue({
        resumed,
        flippedToPause,
        paused,
      });
    });

    await expect('C', '详情页确认更新：202 语义为「任务已提交」而非部署成功', async () => {
      await goto(url, '#/resources');
      // 打开第一个有追踪的应用详情。
      const opened = await evalJson(`(async () => {
        const region = document.querySelector('[role="region"][aria-label="应用列表"]');
        const nameCell = region?.querySelector('tbody button');
        if (nameCell == null) return false;
        nameCell.click();
        return true;
      })()`);
      if (!opened) return allTrue({ opened, fixtureHasAppRow: false });
      // 需要新鲜观察才有预览：先检查更新，再预览，再提交。
      await waitFor(`(async () => document.body.textContent.includes('检查更新'))()`, {
        label: 'detail page',
      });
      await evalJson(`(async () => {
        const b = Array.from(document.querySelectorAll('button')).find((x) => x.textContent.includes('检查更新'));
        b?.click();
        return true;
      })()`);
      await sleep(800);
      await evalJson(`(async () => {
        const b = Array.from(document.querySelectorAll('button')).find((x) => x.textContent.includes('预览更新'));
        b?.click();
        return true;
      })()`);
      const confirmBtn = await waitFor(
        `(async () => {
        const b = Array.from(document.querySelectorAll('button')).find((x) => x.textContent.startsWith('确认更新到'));
        return b != null;
      })()`,
        { label: 'confirm update button', timeoutMs: 4000 },
      ).catch(() => false);
      if (confirmBtn !== true) return allTrue({ opened: true, confirmBtn });
      await evalJson(`(async () => {
        const b = Array.from(document.querySelectorAll('button')).find((x) => x.textContent.startsWith('确认更新到'));
        b?.click();
        return true;
      })()`);
      const submitted = await waitFor(
        `(async () => {
        const t = await ${TOASTS};
        // 202 语义：任务已提交 + 提示部署结果见任务历史；不宣称部署成功。
        return t.texts.some((x) => x.includes('更新任务已提交') && x.includes('部署结果见任务历史'))
          && !t.texts.some((x) => x.includes('部署成功'));
      })()`,
        { label: '202 submitted toast' },
      );
      return allTrue({ opened: true, confirmBtn, submitted });
    });

    await expect(
      'C',
      '写操作成功伴随活跃列表刷新失败：写到达、失败仅入错误框、无 toast',
      async () => {
        // 资源页上 /api/resources 是活跃查询：注入失败才能真正作用于刷新。
        const hitsBefore = (
          await evalJson(`(async () => {
        const r = await fetch('/api/__fixture/update-hits');
        return r.json();
      })()`)
        ).hits;
        await goto(url, '#/resources');
        await evalJson(`(async () => {
        const r = await fetch('/api/__fixture/resources-control', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ failRequests: 6 }),
        });
        return r.json();
      })()`);
        // 行内「执行更新」（skipPreview）触发 useUpdateOne：写成功后 refresh 注入
        // 失败 → 列表查询 error → 页面切换为 ErrorBox（应用真实行为）。
        const clicked = await evalJson(`(async () => {
        const region = document.querySelector('[role="region"][aria-label="应用列表"]');
        if (region == null) return false;
        const b = Array.from(region.querySelectorAll('tbody button')).find(
          (x) => x.textContent.trim() === '执行更新' && x.disabled !== true,
        );
        if (b == null) return false;
        b.click();
        return true;
      })()`);
        // 写操作确实到达服务端（fixture update POST 计数 +1）。
        const writeHappened = await waitFor(
          `(async () => {
        const r = await fetch('/api/__fixture/update-hits');
        const j = await r.json();
        return j.hits === ${hitsBefore + 1};
      })()`,
          { label: 'update POST received' },
        );
        // 刷新失败证据：页面错误框出现（读取失败以 ErrorBox 呈现）。
        const errorBox = await waitFor(
          `(async () => document.body.textContent.includes('出错：'))()`,
          { label: 'refresh failure ErrorBox' },
        );
        await sleep(600);
        // F22/F24 回归：错误框与已完成的操作反馈必须同时可见（读取失败不遮蔽写
        // 结果），且文案是确定的业务结果——本场景目标行有新鲜观察，fixture 必走
        // 「已提交」路径（skipped:false）；「提交失败」文本绝不能出现。
        const pageWriteResult = await evalJson(
          `(async () => {
        const text = document.body.textContent ?? '';
        return {
          submitted: text.includes('更新任务已提交'),
          skipped: text.includes('无更新，已跳过'),
          failed: text.includes('提交失败'),
        };
      })()`,
        );
        // 目标行按钮 enabled 即有新鲜观察（updateBlockedHint 过滤），fixture
        // 必走「已提交」路径：skipped/failed 出现都说明实现误报。
        const feedbackKept =
          pageWriteResult != null &&
          pageWriteResult.submitted === true &&
          pageWriteResult.skipped === false &&
          pageWriteResult.failed === false;
        const t = await evalJson(TOASTS);
        await evalJson(`(async () => {
        await fetch('/api/__fixture/resources-control', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ failRequests: 0 }),
        });
        return true;
      })()`);
        return allTrue({
          clicked,
          writeHappened,
          refreshFailureVisible: errorBox,
          feedbackKept,
          // 刷新失败不污染全局 toast；写成功也不因刷新失败改弹错误。
          noErrorToasts: !t.types.includes('error'),
        });
      },
    );

    await expect(
      'C',
      'toast 与弹窗共存：层级高于弹窗、toast 可被真实键盘 Escape 关闭',
      async () => {
        // 概览页：触发真实成功 toast（立即检查），随后打开 window.confirm 不可控，
        // 改为验证「toast 存在时」的层级 + Sonner 原生键盘交互。
        await goto(url, '#/');
        await evalJson(`(async () => {
        const b = Array.from(document.querySelectorAll('button')).find((x) => x.textContent.trim() === '立即检查');
        b?.click();
        return true;
      })()`);
        const toastShown = await waitFor(
          `(async () => {
        const t = await ${TOASTS};
        return t.texts.some((x) => x.includes('检查请求已完成'));
      })()`,
          { label: 'real toast visible' },
        );
        // 键盘断言使用 10s 生命周期的错误 toast（成功 toast 4s 自动过期，
        // 会让「过期」冒充「键盘关闭」）：触发一次同步失败（限流模式，10s 后才过期）。
        await evalJson(`(async () => {
        await fetch('/api/__fixture/sync-control', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ delayMs: 50, mode: 'rate-limit-no-retry', resetHits: true }),
        });
        return true;
      })()`);
        await evalJson(`(async () => {
        const b = Array.from(document.querySelectorAll('aside button')).find((x) =>
          x.textContent.includes('重新同步'),
        );
        b?.click();
        return true;
      })()`);
        const errorToastShown = await waitFor(
          `(async () => {
        const t = await ${TOASTS};
        return t.texts.some((x) => x.includes('Coolify 请求过于频繁'));
      })()`,
          { label: 'long-lived error toast visible' },
        );
        // 层级：ol[data-sonner-toaster] 是 fixed + z-index 999999999，严格高于 Modal 的 z-50。
        const layer = await evalJson(`(async () => {
        const ol = document.querySelector('ol[data-sonner-toaster]');
        if (ol == null) return { toaster: false };
        const cs = getComputedStyle(ol);
        const z = Number.parseInt(cs.zIndex ?? '0', 10);
        // 同时确认 toast 几何可见（viewport 内、非透明）。
        const li = document.querySelector('[data-sonner-toast]');
        const rect = li?.getBoundingClientRect();
        return {
          toaster: true,
          aboveModal: z > 50 && cs.position === 'fixed',
          zIndex: z,
          toastInViewport: rect != null && rect.width > 0 && rect.height > 0 && rect.top >= 0,
        };
      })()`);
        // Sonner 的 Escape 处理只折叠列表，关闭需经 toast 内的关闭按钮。
        // 目标是 10s 生命周期的错误 toast：用真实键盘 Tab 将焦点移到关闭按钮
        // （原生 <button>），再按 Enter 触发原生 click → dismiss。
        // Escape 前确认 toast 仍在（排除过期）；关闭后 1.5s 内消失——远短于
        // 其剩余寿命，只能是键盘触发。
        const stillAlive = await evalJson(`(async () => {
        return document.body.textContent.includes('Coolify 请求过于频繁');
      })()`);
        // agent-browser 真实键盘：Tab 移动焦点直到关闭按钮获得焦点（最多 12 次）。
        let closeFocused = false;
        for (let i = 0; i < 12; i++) {
          await ab(['press', 'Tab']);
          const focused = await evalJson(`(async () => {
          const el = document.activeElement;
          return el != null && el.matches('[data-sonner-toast] [data-close-button]');
        })()`);
          if (focused === true) {
            closeFocused = true;
            break;
          }
        }
        await ab(['press', 'Enter']);
        await sleep(1500);
        const toastClosedByKeyboard =
          closeFocused &&
          (await evalJson(`(async () => {
        const t = await ${TOASTS};
        // 错误 toast 已消失（其 10s 寿命远未到）。
        return !t.texts.some((x) => x.includes('Coolify 请求过于频繁'));
      })()`));
        // 第 2 步：真实共存——页内导航（点击侧栏，无 reload）到详情页打开
        // 真实 Modal，此时错误 toast（10s 寿命）仍在 DOM：断言两者同时存在、
        // toast 层级仍高于弹窗。
        const navOk = await evalJson(`(async () => {
          const b = Array.from(document.querySelectorAll('aside button')).find(
            (x) => x.textContent.trim() === '资源',
          );
          b?.click();
          return true;
        })()`);
        await waitFor(
          `(async () => document.querySelector('[role="region"][aria-label="应用列表"]') != null)()`,
          { label: 'resources page via in-app nav', timeoutMs: 8000 },
        );
        // 资源页 Tab 栏的「刷新」按钮共享同一 runSync：在详情页打开弹窗前
        // 重新触发一次失败，刷新错误 toast 的 10s 寿命计时，保证共存窗口。
        await evalJson(`(async () => {
        await fetch('/api/__fixture/sync-control', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ delayMs: 50, mode: 'rate-limit-no-retry', resetHits: true }),
        });
        return true;
      })()`);
        await evalJson(`(async () => {
        const b = Array.from(document.querySelectorAll('button')).find(
          (x) => x.textContent.trim() === '刷新' || x.textContent.trim() === '同步中…',
        );
        b?.click();
        return b != null;
      })()`);
        const refreshedError = await waitFor(
          `(async () => {
        const t = await ${TOASTS};
        return t.texts.some((x) => x.includes('Coolify 请求过于频繁'));
      })()`,
          { label: 'error toast refreshed on resources page', timeoutMs: 6000 },
        );
        await evalJson(`(async () => {
        const regions = Array.from(document.querySelectorAll('[role="region"]'));
        const list = regions.find((r) => r.querySelector('tbody button') != null);
        const nameCell = list?.querySelector('tbody button');
        nameCell?.click();
        return nameCell != null;
      })()`);
        await waitFor(`(async () => document.body.textContent.includes('重置追踪并忽略'))()`, {
          label: 'detail page',
        });
        await evalJson(`(async () => {
        const b = Array.from(document.querySelectorAll('button')).find((x) =>
          x.textContent.includes('重置追踪并忽略'),
        );
        b?.click();
        return true;
      })()`);
        const modalOpen = await waitFor(
          `(async () => document.querySelector('[role="dialog"][aria-modal="true"]') != null)()`,
          { label: 'reset modal open' },
        );
        // 共存断言：弹窗开着时错误 toast 仍在（10s 寿命内完成前述步骤）。
        const coexisted = await evalJson(`(async () => {
          const t = await (${TOASTS});
          return (
            t.texts.some((x) => x.includes('Coolify 请求过于频繁')) &&
            document.querySelector('[role="dialog"][aria-modal="true"]') != null
          );
        })()`);
        // 共存时 toast 容器 z-index 仍严格高于弹窗（点击层级）。
        const coexistLayer = await evalJson(`(async () => {
          const ol = document.querySelector('ol[data-sonner-toaster]');
          if (ol === null) return false;
          return Number.parseInt(getComputedStyle(ol).zIndex ?? '0', 10) > 50;
        })()`);
        // 共存交互验收（F18）：弹窗打开时 Modal 应持有焦点；toast 的关闭按钮
        // 仍可被真实点击命中（elementFromPoint 命中的是最顶层元素即关闭按钮）；
        // 点击后 toast 消失而弹窗保持打开。
        const modalHasFocus = await evalJson(`(async () => {
          const dialog = document.querySelector('[role="dialog"][aria-modal="true"]');
          return dialog != null && dialog.contains(document.activeElement);
        })()`);
        const closeBtnClickable = await evalJson(`(async () => {
          const btn = document.querySelector('[data-sonner-toast] [data-close-button]');
          if (btn == null) return false;
          const rect = btn.getBoundingClientRect();
          const cx = rect.left + rect.width / 2;
          const cy = rect.top + rect.height / 2;
          const top = document.elementFromPoint(cx, cy);
          return top === btn || btn.contains(top);
        })()`);
        await evalJson(`(async () => {
          document.querySelector('[data-sonner-toast] [data-close-button]')?.click();
          return true;
        })()`);
        await sleep(1000);
        const toastGoneModalStays = await evalJson(`(async () => {
          const t = await (${TOASTS});
          return (
            !t.texts.some((x) => x.includes('Coolify 请求过于频繁')) &&
            document.querySelector('[role="dialog"][aria-modal="true"]') != null
          );
        })()`);
        await ab(['press', 'Escape']);
        const modalClosed = await waitFor(
          `(async () => document.querySelector('[role="dialog"][aria-modal="true"]') == null)()`,
          { label: 'modal closed by real Escape' },
        );
        return allTrue({
          toastShown,
          errorToastShown,
          stillAlive,
          navOk,
          refreshedError,
          coexisted,
          coexistLayer,
          modalHasFocus,
          closeBtnClickable,
          toastGoneModalStays,
          layerAboveModal:
            layer === true ||
            (layer != null && layer.toaster === true && layer.aboveModal === true),
          toastInViewport: layer != null && layer.toastInViewport === true,
          toastClosedByKeyboard,
          modalOpen,
          modalClosed,
        });
      },
    );

    await expect('C', 'History 局部错误仅内联展示（全局 toast 零重复）', async () => {
      await goto(url, '#/history');
      // fixture：待同步确认资源的重试被 409 拒绝（与真实 JobsService 守卫一致）。
      const clicked = await evalJson(`(async () => {
        const region = document.querySelector('[role="region"][aria-label="更新历史"]');
        if (region == null) return false;
        const b = Array.from(region.querySelectorAll('tbody button')).find((x) => x.textContent.trim() === '重试');
        if (b == null) return false;
        b.click();
        return true;
      })()`);
      const inline = await waitFor(
        `(async () => {
        return document.body.textContent.includes('本次重试未执行：');
      })()`,
        { label: 'inline action error' },
      );
      await sleep(800); // 给全局兑底留出误弹窗口
      const t = await evalJson(TOASTS);
      // 严格判定（F14）：任何 error toast，无论文案被格式化成什么样，都算
      // 全局重复——按「重试+失败」子串匹配会漏报「操作失败：待同步确认…（409）」。
      return allTrue({
        clicked,
        inline,
        noGlobalErrorToast: !t.types.includes('error'),
        noExtraToasts: t.count === 0,
      });
    });

    await expect('C', '周期轮询失败不弹周期 toast（观察完整 10s 轮询周期）', async () => {
      // fixture 增加 resources GET 计数，观察至少一个完整 10s 轮询周期。
      // 关键（F23）：基线在页面加载与初始重试稳定之后采集——之后的 GET 增量
      // 只能来自 refetchInterval 定时器，初始加载/重试无法贡献。
      await goto(url, '#/resources');
      await sleep(3000); // 初载 + 1 次重试 + 缓冲（staleTime 5s 内不再触发额外请求）
      const base = await evalJson(`(async () => {
        const probe = await fetch('/api/__fixture/resources-control', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{}',
        });
        const probeHits = (await probe.json()).control.getHits;
        const inject = await fetch('/api/__fixture/resources-control', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ failRequests: 999999 }),
        });
        const injected = await inject.json();
        return { hitsBefore: probeHits, injected: injected.control.failRequests };
      })()`);
      const hitsBefore = base.hitsBefore;
      // refetchInterval = 10s（main.tsx）。本场景内需观察到 ≥4 次增量 GET：
      // 初次加载 1 + react-query 重试 1 + 至少一个完整 10s 周期轮询 ≥2（重试）。
      const reqsSeen = await waitFor(
        `(async () => {
        const r = await fetch('/api/__fixture/resources-control', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{}',
        });
        const j = await r.json();
        return j.control.getHits - ${hitsBefore} >= 2;
      })()`,
        { label: '基线后 ΔGETs ≥ 2（仅可能来自 10s 周期轮询及其重试）', timeoutMs: 25_000 },
      );
      // 周期请求发生且页面已显示读取错误（ErrorBox），全程 toast 为零。
      const errorBox = await waitFor(
        `(async () => document.body.textContent.includes('出错：'))()`,
        { label: 'refresh failure ErrorBox', timeoutMs: 8000 },
      );
      const t = await evalJson(TOASTS);
      await evalJson(`(async () => {
        await fetch('/api/__fixture/resources-control', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ failRequests: 0 }),
        });
        return true;
      })()`);
      return allTrue({
        controlSet: base?.injected === 999999,
        reqsSeen,
        noToast: t.count === 0,
        errorBox,
      });
    });

    // --- D. 复制 -----------------------------------------------------------------
    await expect('D', '复制成功：内容一致、busy 防重、无 unhandled rejection', async () => {
      await goto(url, '#/history');
      await evalJson(INSTALL_ERROR_TRAP);
      await evalJson(`(async () => {
        window.__copied = [];
        window.__copyResolve = null;
        window.__copyGate = new Promise((resolve) => { window.__copyResolve = resolve; });
        Object.defineProperty(window.navigator, 'clipboard', {
          value: { writeText: (t) => { window.__copied.push(t); return window.__copyGate; } },
          configurable: true,
        });
        return true;
      })()`);
      await evalJson(`(async () => {
        const btn = document.querySelector('[role="region"][aria-label="更新历史"] tbody button.mono');
        btn?.click();
        return btn != null;
      })()`);
      const busyDuring = await waitFor(
        `(async () => {
        const btn = document.querySelector('[role="region"][aria-label="更新历史"] tbody button.mono');
        return btn != null && btn.disabled === true;
      })()`,
        { label: 'copy busy' },
      );
      await evalJson(`(async () => { window.__copyResolve(); return true; })()`);
      await waitFor(
        `(async () => {
        const t = await ${TOASTS};
        return t.texts.some((x) => x.includes('已复制'));
      })()`,
        { label: 'copied toast' },
      );
      const copied = await evalJson(`(async () => window.__copied)()`);
      const btnAfter = await evalJson(`(async () => {
        const btn = document.querySelector('[role="region"][aria-label="更新历史"] tbody button.mono');
        return btn?.disabled ?? null;
      })()`);
      const errors = await evalJson(`(async () => window.__feedbackErrors)()`);
      return allTrue({
        busyDuring,
        busyCleared: btnAfter === false,
        singleWrite: copied?.length === 1,
        contentShown: await waitFor(
          `(async () => {
          const t = await ${TOASTS};
          return t.texts.some((x) => x.includes(copied?.[0] ?? '__never__'));
        })()`.replace(/copied\?\.\[0\]/, JSON.stringify(copied?.[0] ?? '')),
          { label: 'content in toast' },
        ).catch(() => false),
        successShown: true,
        noRejections: errors?.length === 0,
      });
    });

    await expect('D', '复制拒绝：失败提示且无 unhandled rejection', async () => {
      await evalJson(`(async () => {
        Object.defineProperty(window.navigator, 'clipboard', {
          value: { writeText: () => Promise.reject(new DOMException('denied', 'NotAllowedError')) },
          configurable: true,
        });
        return true;
      })()`);
      await evalJson(`(async () => {
        document.querySelector('[role="region"][aria-label="更新历史"] tbody button.mono')?.click();
        return true;
      })()`);
      const shown = await waitFor(
        `(async () => {
        const t = await ${TOASTS};
        return t.texts.some((x) => x.includes('复制失败'));
      })()`,
        { label: 'copy failure toast' },
      );
      const errors = await evalJson(`(async () => window.__feedbackErrors)()`);
      return allTrue({ shown, noRejections: errors?.length === 0 });
    });

    await expect('D', 'Clipboard API 缺失：明确提示环境不可用', async () => {
      await evalJson(`(async () => {
        Object.defineProperty(window.navigator, 'clipboard', { value: undefined, configurable: true });
        return true;
      })()`);
      await evalJson(`(async () => {
        document.querySelector('[role="region"][aria-label="更新历史"] tbody button.mono')?.click();
        return true;
      })()`);
      const shown = await waitFor(
        `(async () => {
        const t = await ${TOASTS};
        return t.texts.some((x) => x.includes('无法复制'));
      })()`,
        { label: 'unavailable toast' },
      );
      return allTrue({ shown });
    });

    await expect('D', '延迟复制期间同轮重复点击仅写入一次', async () => {
      await evalJson(`(async () => {
        window.__copied = [];
        Object.defineProperty(window.navigator, 'clipboard', {
          value: { writeText: (t) => { window.__copied.push(t); return new Promise((r) => setTimeout(() => r(), 500)); } },
          configurable: true,
        });
        return true;
      })()`);
      // 同一轮脚本内连点三次：防重依赖同步 ref（state 更新异步，闭包读旧值）。
      await evalJson(`(async () => {
        const btn = document.querySelector('[role="region"][aria-label="更新历史"] tbody button.mono');
        btn?.click();
        btn?.click();
        btn?.click();
        return true;
      })()`);
      await sleep(1000);
      const copied = await evalJson(`(async () => window.__copied)()`);
      return allTrue({ once: copied?.length === 1, copiedCount: copied?.length === 1 });
    });

    // 移动端宽度冒烟：顶栏同步入口存在且共享同一忙碌态。
    await expect('D', '375px 宽度下同步入口可用、错误可见且 toast 不溢出', async () => {
      await ab(['set', 'viewport', '375', '720']);
      await goto(url, '#/');
      await evalJson(SYNC_CONTROL({ delayMs: 600, mode: 'json502', resetHits: true }));
      await evalJson(`(async () => {
        const all = Array.from(document.querySelectorAll('button'));
        const b = all.find((x) => x.textContent.includes('重新同步'));
        b?.click();
        return b != null;
      })()`);
      const shown = await waitFor(
        `(async () => {
        const t = await ${TOASTS};
        return t.texts.some((x) => x.includes('服务暂时不可用'));
      })()`,
        { label: 'mobile error toast' },
      );
      const overflow = await evalJson(`(async () => ({
        dx: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      }))()`);
      await ab(['set', 'viewport', '1280', '900']);
      return allTrue({ shown, noOverflow: overflow.dx <= 0 });
    });
  } finally {
    await close().catch(() => undefined);
    await ab(['close', '--session', SESSION], { retry: false }).catch(() => undefined);
  }

  fs.writeFileSync(
    path.join(shotsDir, 'results.json'),
    JSON.stringify({ results, failures: results.filter((r) => !r.pass) }, null, 2),
  );
  const failed = results.filter((r) => !r.pass);
  console.log(
    `\n${results.length - failed.length}/${results.length} checks passed; artifacts: ${shotsDir}`,
  );
  process.exit(hadFailure ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});
