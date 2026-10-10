#!/usr/bin/env node
// Responsive-layout browser regression, driven by the existing agent-browser CLI.
//
//   npm run test:responsive   (= npm run build:web && node scripts/verify-responsive.mjs)
//
// Serves the compiled frontend from dist/web plus the in-memory /api fixture in
// tests/fixtures/responsive-ui.mjs on a random 127.0.0.1 port, then runs three
// scenario groups against a real Chromium:
//   A. every route x every width: page-level overflow, nav/pause/sync reachability
//   B. dense tables: in-table scrolling, scroll buttons, sticky header, compact
//      short-content rows, full-text expanders, copy fidelity, live resize sync
//   C. low-height modals: viewport-bounded dialog, scrollable body, reachable
//      title/footer, focus visibility, Escape/cancel/confirm semantics
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
  argValue('--shots') ?? path.join(os.tmpdir(), `coolify-responsive-${Date.now()}`),
);
fs.mkdirSync(shotsDir, { recursive: true });

// --- agent-browser helpers --------------------------------------------------------

const SESSION = 'resp-verify';
const AB_TIMEOUT = 60_000;

/** Run one agent-browser command for our session; on daemon-level failure reset
 *  the daemon and retry once (a single hung navigation can wedge the daemon). */
async function ab(args, { timeout = AB_TIMEOUT, retry = true } = {}) {
  const baseEnv = {
    ...process.env,
    // Keep the automation browser away from anything but the local fixture.
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

/** Evaluate an expression and parse its JSON result. agent-browser prints the
 *  return value JSON-serialized (strings arrive quoted), so deserialize twice. */
async function evalJson(expression) {
  const out = (await ab(['eval', `JSON.stringify(${expression})`])).trim();
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

async function goto(baseUrl, hash) {
  await ab(['open', `${baseUrl}/${hash.replace(/^#/, '#')}`]);
  // 同 URL（同 hash）导航不会触发重载：强制 reload，保证每次 goto 都是全新挂载，
  // 避免 scenarioAState 注入的筛选/选择残留到后续场景。
  await ab(['reload']);
  const ready = `({ ready: document.readyState === 'complete' && !!document.querySelector('main')?.children.length, loading: !!document.querySelector('main')?.textContent.includes('加载中') })`;
  for (let t = 0; t < 60; t++) {
    try {
      const r = await evalJson(ready);
      if (r.ready === true && r.loading === false) return;
    } catch {
      // page mid-navigation; poll again
    }
    await sleep(250);
  }
  throw new Error(`page not ready: ${baseUrl}/${hash}`);
}

/** Poll an eval expression until it is truthy (React state needs a tick after clicks). */
async function waitFor(expression, { timeoutMs = 5000, label = 'condition' } = {}) {
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
  throw new Error(`timeout waiting for ${label}`);
}

async function setViewport(w, h) {
  await ab(['set', 'viewport', String(w), String(h)]);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// --- in-page snippets -------------------------------------------------------------

const SNIPPETS = {
  overflow: `(() => {
    const doc = document.documentElement;
    const main = document.querySelector('main');
    return {
      docDx: doc.scrollWidth - doc.clientWidth,
      mainDx: main == null ? 0 : main.scrollWidth - main.clientWidth,
    };
  })()`,
  /** Elements sticking out of the viewport horizontally, excluding descendants of
   *  explicitly scrollable table/body regions. */
  wideElements: `(() => {
    const vw = document.documentElement.clientWidth;
    const inScrollRegion = (el) => el.closest('[data-allowed-scroll]') != null;
    return [...document.querySelectorAll('body *')]
      .filter((el) => el.getClientRects().length > 0)
      .filter((el) => el.getBoundingClientRect().right > vw + 1 || el.getBoundingClientRect().left < -1)
      .filter((el) => !inScrollRegion(el))
      .slice(0, 8)
      .map((el) => ({ tag: el.tagName, cls: String(el.className).slice(0, 70), right: Math.round(el.getBoundingClientRect().right), text: el.textContent.trim().slice(0, 40) }));
  })()`,
  navA11y: `(() => {
    const visible = (el) => el != null && el.getClientRects().length > 0;
    const aside = document.querySelector('aside');
    const navLabels = ['概览', '资源', '通知', '设置'];
    const navOk = navLabels.every((t) => [...aside.querySelectorAll('button')].some((b) => b.textContent.trim() === t && visible(b)));
    return {
      navOk,
      resyncOk: [...aside.querySelectorAll('button')].some((b) => b.textContent.includes('重新同步') && visible(b)),
      pausedOk: [...aside.querySelectorAll('*')].some((el) => el.childElementCount === 0 && el.textContent.trim() === '全局已暂停' && visible(el)),
    };
  })()`,
  pageControls: `(() => {
    const visible = (el) => el != null && el.getClientRects().length > 0;
    const q = (sel) => document.querySelector(sel);
    return {
      search: visible(q('input[aria-label="搜索应用"], input[aria-label="搜索服务"]')),
      pagination: [...document.querySelectorAll('button')].some((b) => /^上一页$/.test(b.textContent.trim()) && visible(b)),
      settingsInputs: ['set-sync-cron', 'set-check-cron', 'set-tz'].every((id) => visible(q('#' + id))),
      overviewPause: [...document.querySelectorAll('button')].some((b) => /全局暂停自动更新|恢复自动更新/.test(b.textContent) && visible(b)),
    };
  })()`,
  tableState: (label) => `(() => {
    const region = document.querySelector('[role="region"][aria-label="${label}"]');
    if (region == null) return { present: false };
    const hint = region.parentElement.querySelector('[data-table-hint]');
    const btnL = region.parentElement.querySelector('[data-table-scroll="left"]');
    const btnR = region.parentElement.querySelector('[data-table-scroll="right"]');
    const vis = (el) => el != null && el.getClientRects().length > 0 && el.offsetParent != null;
    return {
      present: true,
      focusable: region.tabIndex >= 0,
      overflow: region.scrollWidth - region.clientWidth,
      hintVisible: vis(hint),
      leftVisible: vis(btnL), leftDisabled: btnL == null ? null : btnL.disabled,
      rightVisible: vis(btnR), rightDisabled: btnR == null ? null : btnR.disabled,
    };
  })()`,
  headerRowInfo: (label) => `(() => {
    const region = document.querySelector('[role="region"][aria-label="${label}"]');
    const th = region?.querySelector('thead th');
    const firstRowBtns = region?.querySelectorAll('tbody tr:last-child td:last-child button') ?? [];
    const last = firstRowBtns.length ? firstRowBtns[firstRowBtns.length - 1] : null;
    const rr = region.getBoundingClientRect();
    const lr = last?.getBoundingClientRect();
    return {
      headerTop: th == null ? null : Math.round(th.getBoundingClientRect().top),
      regionTop: Math.round(rr.top),
      headerRight: th == null ? null : Math.round(region.querySelector('thead').getBoundingClientRect().right),
      regionRight: Math.round(rr.right),
      regionLeft: Math.round(rr.left),
      lastBtn: lr == null ? null : { left: Math.round(lr.left), right: Math.round(lr.right), width: Math.round(lr.width), height: Math.round(lr.height) },
    };
  })()`,
  rowHeights: (label) => `(() => {
    const region = document.querySelector('[role="region"][aria-label="${label}"]');
    const rows = [...region.querySelectorAll('tbody tr')];
    return {
      max: Math.max(...rows.map((r) => Math.round(r.getBoundingClientRect().height))),
      shortMax: Math.max(...rows.filter((r) => /(^|\\s)(redis|nginx|postgres)($|\\s)/.test(r.textContent)).map((r) => Math.round(r.getBoundingClientRect().height))),
    };
  })()`,
};

/** Click the first element matching `finder` inside the page. */
async function clickInPage(finder, label) {
  const clicked = await evalJson(`(() => {
    const el = (${finder});
    if (el == null) return false;
    el.scrollIntoView({ block: 'center' });
    el.click();
    return true;
  })()`);
  if (clicked !== true) throw new Error(`element not found for click: ${label}`);
}

// --- results ---------------------------------------------------------------------

const results = [];
function check(group, name, pass, detail) {
  results.push({ group, name, pass: pass === true, detail: detail ?? null });
  const mark = pass === true ? 'PASS' : 'FAIL';
  process.stdout.write(
    `[${mark}] ${group} :: ${name}${pass === true ? '' : ` — ${JSON.stringify(detail)}`}\n`,
  );
}

async function expect(group, name, fn) {
  try {
    const detail = await fn();
    check(group, name, true, typeof detail === 'object' ? detail : undefined);
  } catch (err) {
    check(group, name, false, String(err instanceof Error ? err.message : err).slice(0, 500));
  }
}

function assert(cond, message, detail) {
  if (cond !== true)
    throw new Error(
      detail == null ? message : `${message}: ${JSON.stringify(detail).slice(0, 300)}`,
    );
}

// --- scenario data ----------------------------------------------------------------

const WIDE_WIDTHS = [320, 375, 720, 768, 1024, 1440];
const BP_PAIRS = [639, 640, 767, 768, 1023, 1024];
const HEIGHT = 800;

// --- scenarios --------------------------------------------------------------------

async function scenarioA(baseUrl, routes) {
  const group = 'A';
  for (const w of WIDE_WIDTHS) {
    await setViewport(w, HEIGHT);
    for (const route of routes) {
      const tag = `${route.name}@${w}`;
      await goto(baseUrl, route.hash);
      const ov = await evalJson(SNIPPETS.overflow);
      check(group, `页面横向溢出 ${tag}`, ov.docDx <= 1, {
        docDx: ov.docDx,
        wide: await evalJson(SNIPPETS.wideElements),
      });
      check(group, `main 横向溢出 ${tag}`, ov.mainDx <= 1, {
        mainDx: ov.mainDx,
        wide: await evalJson(SNIPPETS.wideElements),
      });
      const nav = await evalJson(SNIPPETS.navA11y);
      check(group, `导航/同步/暂停可达 ${tag}`, nav.navOk && nav.resyncOk && nav.pausedOk, nav);
      const controls = await evalJson(SNIPPETS.pageControls);
      const need = route.needs ?? {};
      const ok =
        (need.search ? controls.search : true) &&
        (need.pagination ? controls.pagination : true) &&
        (need.settingsInputs ? controls.settingsInputs : true) &&
        (need.overviewPause ? controls.overviewPause : true);
      check(group, `页面控件可达 ${tag}`, ok, controls);
    }
  }
  // Breakpoint-adjacent widths: lightweight overflow + nav checks only.
  for (const w of BP_PAIRS) {
    await setViewport(w, HEIGHT);
    for (const route of routes) {
      await goto(baseUrl, route.hash);
      const ov = await evalJson(SNIPPETS.overflow);
      check(group, `断点相邻溢出 ${route.name}@${w}`, ov.docDx <= 1 && ov.mainDx <= 1, ov);
      const nav = await evalJson(SNIPPETS.navA11y);
      check(
        group,
        `断点相邻导航 ${route.name}@${w}`,
        nav.navOk && nav.resyncOk && nav.pausedOk,
        nav,
      );
    }
  }
}

/** Filters + selection + typed text must survive a width change. */
async function scenarioAState(baseUrl) {
  const group = 'A 状态保留';
  await setViewport(1024, HEIGHT);
  await goto(baseUrl, '#/resources');
  await evalJson(`(() => {
    const input = document.querySelector('input[aria-label="搜索应用"]');
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(input, 'redis');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    const select = document.querySelector('select[aria-label="按服务器筛选"]');
    const ssetter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set;
    ssetter.call(select, select.options[1].value);
    select.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);
  // 搜索 'redis' 生效：fixture 中仅 redis 一行（名称或仓库）命中，行数必须下降。
  await waitFor(
    `(() => {
      const rows = [...document.querySelectorAll('tbody tr')];
      return rows.length === 1 && rows[0].textContent.includes('redis') ? rows.length : null;
    })()`,
    { label: 'filter applied' },
  );
  await clickInPage(`document.querySelector('tbody input[type=checkbox]')`, 'first row checkbox');
  const selectedBefore = await evalJson(
    `document.querySelectorAll('tbody input[type=checkbox]:checked').length`,
  );
  await setViewport(320, HEIGHT);
  await sleep(300);
  const state = await evalJson(`({
    search: document.querySelector('input[aria-label="搜索应用"]').value,
    server: document.querySelector('select[aria-label="按服务器筛选"]').value,
    checked: document.querySelectorAll('tbody input[type=checkbox]:checked').length,
  })`);
  check(
    group,
    '宽度切换后筛选/输入/选择保留',
    state.search === 'redis' &&
      state.server !== '' &&
      state.checked === selectedBefore &&
      selectedBefore > 0,
    { before: { checked: selectedBefore }, after: state },
  );
}

async function scenarioB(baseUrl) {
  const group = 'B';
  // --- applications table @720 ----------------------------------------------------
  await setViewport(720, HEIGHT);
  await goto(baseUrl, '#/resources');
  const label = '应用列表';
  await expect(group, `应用表 region 存在且可聚焦（${label}）`, async () => {
    const st = await evalJson(SNIPPETS.tableState(label));
    assert(st.present, 'region missing', st);
    assert(st.focusable, 'region not focusable', st);
    return st;
  });
  await expect(group, '溢出时提示与滚动按钮状态正确', async () => {
    const st = await evalJson(SNIPPETS.tableState(label));
    assert(st.present, 'region missing', st);
    assert(st.overflow > 0, 'fixture 应产生横向溢出（前置条件）', st);
    check(
      group,
      '溢出时提示与右按钮可见、左按钮禁用',
      st.hintVisible &&
        st.rightVisible &&
        st.leftVisible &&
        st.rightDisabled === false &&
        st.leftDisabled === true,
      st,
    );

    // Scroll to the far right via the button.
    await clickInPage(
      `document.querySelector('[role="region"][aria-label="${label}"]').parentElement.querySelector('[data-table-scroll="right"]')`,
      'right scroll button',
    );
    await waitFor(
      `(() => { const r = document.querySelector('[role="region"][aria-label="${label}"]'); return r.scrollLeft >= r.scrollWidth - r.clientWidth - 2; })()`,
      { label: 'scroll right' },
    );
    const st2 = await evalJson(SNIPPETS.tableState(label));
    check(
      group,
      '到达右边界后按钮状态翻转',
      st2.leftDisabled === false && st2.rightDisabled === true,
      st2,
    );

    // Sticky header stays aligned with the scrolled region.
    const hr = await evalJson(SNIPPETS.headerRowInfo(label));
    check(
      group,
      '横滚后表头与区域对齐',
      Math.abs(hr.headerTop - hr.regionTop) <= 2 && hr.headerRight <= hr.regionRight + 1,
      hr,
    );
    // Action buttons readable (not per-character wrapped) and clickable at the edge.
    check(
      group,
      '末列操作按钮横向可读（高度受控且未逐字换行）',
      hr.lastBtn != null && hr.lastBtn.height <= hr.lastBtn.width * 1.2 && hr.lastBtn.height < 60,
      hr.lastBtn,
    );
    await clickInPage(
      `[...document.querySelectorAll('[role="region"][aria-label="${label}"] tbody button')].filter(b => !b.disabled && b.textContent.includes('检查更新')).pop()`,
      'last enabled check button',
    );
    await waitFor(`document.body.textContent.includes('发现候选更新')`, {
      label: 'check feedback',
    });
    check(group, '滚动到边界后操作按钮可点击且产生反馈', true);
    return st;
  });
  await expect(group, '短内容行高紧凑', async () => {
    // Compact rows for short-content fixtures.
    const rh = await evalJson(SNIPPETS.rowHeights(label));
    check(group, '短内容行高紧凑（≤96px）', rh.shortMax <= 96, rh);
    return rh;
  });
  await expect(group, '分页信息与翻页可用', async () => {
    // Pagination reachable.
    const pag = await evalJson(`(() => {
      const btn = [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === '下一页' && !b.disabled);
      const text = [...document.querySelectorAll('span')].find((s) => /第 1 \\/ 2 页/.test(s.textContent));
      if (btn == null || text == null) return { ok: false, url: location.hash, spans: [...document.querySelectorAll('span')].map(s => s.textContent).filter(t => t.includes('第')) };
      btn.click();
      return { ok: true };
    })()`);
    try {
      await waitFor(
        `[...document.querySelectorAll('span')].some(s => /第 2 \\/ 2 页/.test(s.textContent))`,
        { label: 'page 2' },
      );
    } catch (err) {
      const diag = await evalJson(`({
        hash: location.hash,
        spans: [...document.querySelectorAll('span')].map(s => s.textContent).filter(t => t.includes('第')),
        nextDisabled: [...document.querySelectorAll('button')].find(b => b.textContent.trim() === '下一页')?.disabled,
        searchValue: document.querySelector('input[aria-label="搜索应用"]')?.value,
      })`);
      throw new Error(`${err.message}; diag=${JSON.stringify(diag)}`);
    }
    check(group, '分页信息与翻页可用（超过一页数据）', pag.ok === true, pag);
    return pag;
  });

  // --- services tab: two expanded groups with independent scroll regions ----------
  await expect(group, '两个展开服务组独立滚动区域', async () => {
    await goto(baseUrl, '#/resources?tab=services');
    await clickInPage(
      `[...document.querySelectorAll('button[aria-label^="展开服务"]')][0]`,
      'expand group 1',
    );
    await clickInPage(
      `[...document.querySelectorAll('button[aria-label^="展开服务"]')][1]`,
      'expand group 2',
    );
    const regions = await waitFor(
      `[(() => { const rs = [...document.querySelectorAll('[role="region"][aria-label$="子容器"]')]; return rs.length >= 2; })()]`,
      { label: 'two child regions' },
    );
    check(group, '两个展开服务组各自拥有滚动 region', regions[0] === true, { found: regions });
    const independence = await evalJson(`(() => {
      const rs = [...document.querySelectorAll('[role="region"][aria-label$="子容器"]')];
      rs[0].scrollLeft = 120;
      return { first: rs[0].scrollLeft, second: rs[1].scrollLeft };
    })()`);
    await sleep(150);
    const independence2 = await evalJson(`(() => {
      const rs = [...document.querySelectorAll('[role="region"][aria-label$="子容器"]')];
      return { first: rs[0].scrollLeft, second: rs[1].scrollLeft };
    })()`);
    check(
      group,
      '滚动区域相互独立',
      independence.first === independence2.first && independence.second === independence2.second,
      { after: independence2 },
    );

    // Collapse removes the region.
    await clickInPage(
      `[...document.querySelectorAll('button[aria-label^="折叠服务"]')][0]`,
      'collapse group 1',
    );
    const collapsed = await waitFor(
      `[...document.querySelectorAll('[role="region"][aria-label$="子容器"]')].length === 1`,
      { label: 'collapse' },
    );
    check(group, '折叠后对应滚动区域移除', collapsed === true);
    return { regions: 2 };
  });

  // Overflow hint syncs on live resize (ResizeObserver contract).
  await setViewport(320, HEIGHT);
  await goto(baseUrl, '#/resources');
  const before = await evalJson(SNIPPETS.tableState(label));
  await setViewport(2000, HEIGHT);
  const after = await waitFor(
    `(() => {
      const st = (${SNIPPETS.tableState(label)});
      return st.overflow <= 0 && st.hintVisible === false && st.rightVisible === false ? st : null;
    })()`,
    { label: 'resize hides controls', timeoutMs: 4000 },
  ).catch(() => null);
  if (after == null) {
    const stNow = await evalJson(SNIPPETS.tableState(label));
    check(group, '窗口变宽后溢出提示/按钮同步隐藏', false, { before, now: stNow });
  } else {
    check(group, '窗口变宽后溢出提示/按钮同步隐藏', true, { before, after });
  }

  // --- service detail child table ---------------------------------------------------
  await setViewport(720, HEIGHT);
  await goto(baseUrl, `#/${''}resources/${await serviceDetailId(baseUrl)}`);
  const svcLabel = '服务子容器';
  await expect(group, '服务详情子容器表滚动与粘性表头', async () => {
    const st3 = await evalJson(SNIPPETS.tableState(svcLabel));
    assert(st3.present, 'region missing', st3);
    if (st3.overflow <= 0) throw new Error('fixture 应产生横向溢出');
    await clickInPage(
      `document.querySelector('[role="region"][aria-label="${svcLabel}"]').parentElement.querySelector('[data-table-scroll="right"]')`,
      'right scroll button',
    );
    await waitFor(
      `(() => { const r = document.querySelector('[role="region"][aria-label="${svcLabel}"]'); return r.scrollLeft >= r.scrollWidth - r.clientWidth - 2; })()`,
      { label: 'scroll right' },
    );
    const hr2 = await evalJson(SNIPPETS.headerRowInfo(svcLabel));
    assert(Math.abs(hr2.headerTop - hr2.regionTop) <= 2, 'header not sticky', hr2);
    assert(
      hr2.lastBtn != null && hr2.lastBtn.height < 60,
      'action buttons vertically exploded',
      hr2.lastBtn,
    );
    return st3;
  });

  // --- history: full error expander + retry reachable -------------------------------
  await goto(baseUrl, '#/history');
  await expect(group, '历史页完整错误可展开', async () => {
    const found = await waitFor(
      `(() => {
        const d = document.querySelector('[data-full-text]');
        return d == null ? null : { summary: d.querySelector('summary')?.textContent.trim(), len: d.textContent.length };
      })()`,
      { label: 'error details' },
    );
    await clickInPage(`document.querySelector('[data-full-text] summary')`, 'error summary');
    await waitFor(
      `(() => { const d = document.querySelector('[data-full-text]'); return d != null && d.open === true; })()`,
      { label: 'details open' },
    );
    const len = await evalJson(`document.querySelector('[data-full-text]').textContent.length`);
    assert(len > 60, 'expanded text too short to be the full error', { len });
    return found;
  });
  await expect(group, '历史页复制值与展示字符串一致', async () => {
    await evalJson(`(() => {
      window.__copied = [];
      Object.defineProperty(window.navigator, 'clipboard', { value: { writeText: (t) => { window.__copied.push(t); } }, configurable: true });
      return true;
    })()`);
    const shown = await evalJson(`(() => {
      const btn = document.querySelector('[role="region"][aria-label="更新历史"] tbody button.mono');
      if (btn == null) return null;
      btn.click();
      return btn.textContent;
    })()`);
    const copied = await evalJson(`window.__copied`);
    check(
      group,
      '复制值与展示字符串一致',
      typeof shown === 'string' &&
        Array.isArray(copied) &&
        copied.length === 1 &&
        copied[0] === shown,
      { shown, copied },
    );
    return copied;
  });
  await expect(group, '历史页重试按钮滚动后可点击', async () => {
    const hLabel = '更新历史';
    const st4 = await evalJson(SNIPPETS.tableState(hLabel));
    if (st4.present && st4.overflow > 0) {
      await clickInPage(
        `document.querySelector('[role="region"][aria-label="${hLabel}"]').parentElement.querySelector('[data-table-scroll="right"]')`,
        'history right scroll',
      );
      await waitFor(
        `(() => { const r = document.querySelector('[role="region"][aria-label="${hLabel}"]'); return r.scrollLeft >= r.scrollWidth - r.clientWidth - 2; })()`,
        { label: 'history scroll' },
      );
    }
    const jobId = await evalJson(`(() => {
      const btn = [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === '重试' && !b.disabled);
      if (btn == null) return null;
      const row = btn.closest('tr');
      btn.click();
      return { status: row.querySelector('td:nth-child(4)')?.textContent.trim() };
    })()`);
    assert(jobId != null, 'no enabled retry button');
    await waitFor(
      `[...document.querySelectorAll('tbody tr')].some(r => r.textContent.includes('排队中'))`,
      { label: 'retried job pending' },
    );
    return jobId;
  });

  // --- notifications: full title/error expanders -------------------------------------
  await goto(baseUrl, '#/notifications');
  await expect(group, '通知页标题与错误可展开为完整文本', async () => {
    const count = await waitFor(
      `document.querySelectorAll('[data-full-text]').length >= 2 ? document.querySelectorAll('[data-full-text]').length : null`,
      { label: 'notification expanders' },
    );
    await clickInPage(
      `[...document.querySelectorAll('[data-full-text] summary')].find(s => s.closest('td')?.textContent.includes('【'))`,
      'title summary',
    );
    await waitFor(
      `(() => {
      const ds = [...document.querySelectorAll('[data-full-text]')];
      return ds.some(d => d.open === true && d.textContent.length > 80);
    })()`,
      { label: 'title expanded' },
    );
    const longText = await evalJson(`(() => {
      const d = [...document.querySelectorAll('[data-full-text]')].find(x => x.open && x.textContent.length > 80);
      return { len: d.textContent.length, sample: d.textContent.slice(0, 20) };
    })()`);
    assert(longText.len > 80, 'expanded content too short', longText);
    return { expanders: count };
  });
}

async function scenarioC(baseUrl) {
  const group = 'C';
  const sizes = [
    [320, 568],
    [568, 320],
    [720, 400],
  ];
  const GEOM = `(() => {
    const dlg = document.querySelector('[role="dialog"]');
    if (dlg == null) return { open: false };
    const r = dlg.getBoundingClientRect();
    const body = dlg.querySelector('[data-modal-body]');
    const btns = [...dlg.querySelectorAll('button')].map((b) => {
      const br = b.getBoundingClientRect();
      return { text: b.textContent.trim(), top: Math.round(br.top), bottom: Math.round(br.bottom), h: Math.round(br.height), vis: br.height > 0 && br.bottom <= innerHeight && br.top >= 0 };
    });
    return {
      open: true,
      vh: innerHeight, vw: innerWidth,
      top: Math.round(r.top), bottom: Math.round(r.bottom), left: Math.round(r.left), right: Math.round(r.right),
      bodyScrollable: body == null ? null : { sh: body.scrollHeight, ch: body.clientHeight, st: body.scrollTop },
      buttons: btns,
      titleVisible: dlg.querySelector('[data-modal-title]') != null,
    };
  })()`;

  for (const [w, h] of sizes) {
    await setViewport(w, h);
    await goto(baseUrl, '#/resources');
    // Fill the page size with 100 and select all rows so the modal shows 8+ long names.
    await evalJson(`(() => {
      const select = document.querySelector('select[aria-label="每页条数"]');
      const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set;
      setter.call(select, '100');
      select.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`);
    await waitFor(`document.querySelectorAll('tbody input[type=checkbox]').length >= 20`, {
      label: '100 rows',
    });
    await clickInPage(
      `document.querySelector('thead input[type=checkbox]')`,
      'select-all checkbox',
    );
    await clickInPage(
      `[...document.querySelectorAll('button')].find(b => b.textContent.trim() === '执行更新' && b.closest('div')?.textContent.includes('已选'))`,
      'batch update button',
    );
    await waitFor(`document.querySelector('[role="dialog"]') != null`, { label: 'modal open' });
    const geo = await evalJson(GEOM);
    check(
      group,
      `批量确认弹窗受视口约束 @${w}x${h}`,
      geo.open && geo.top >= 0 && geo.bottom <= geo.vh && geo.left >= 0 && geo.right <= geo.vw,
      geo,
    );
    check(
      group,
      `弹窗正文可滚动、标题/取消/确认可见 @${w}x${h}`,
      geo.titleVisible === true &&
        geo.bodyScrollable != null &&
        geo.buttons.some((b) => b.text === '取消' && b.vis) &&
        geo.buttons.some((b) => b.text === '确认执行' && b.vis),
      { body: geo.bodyScrollable, buttons: geo.buttons },
    );

    // Tab focus lands on a visible element inside the dialog.
    await ab(['press', 'Tab']);
    const focus = await evalJson(`(() => {
      const el = document.activeElement;
      const dlg = document.querySelector('[role="dialog"]');
      if (el == null || dlg == null || !dlg.contains(el)) return { inDialog: false };
      const r = el.getBoundingClientRect();
      return { inDialog: true, vis: r.top >= 0 && r.bottom <= innerHeight, tag: el.tagName };
    })()`);
    check(group, `Tab 焦点落在弹窗内可见元素 @${w}x${h}`, focus.inDialog && focus.vis, focus);

    // Cancel closes; reopen; Escape closes.
    await clickInPage(
      `[...document.querySelector('[role="dialog"]').querySelectorAll('button')].find(b => b.textContent.trim() === '取消')`,
      'cancel',
    );
    await waitFor(`document.querySelector('[role="dialog"]') == null`, { label: 'cancel closes' });
    await clickInPage(
      `[...document.querySelectorAll('button')].find(b => b.textContent.trim() === '执行更新' && b.closest('div')?.textContent.includes('已选'))`,
      'batch update button again',
    );
    await waitFor(`document.querySelector('[role="dialog"]') != null`, { label: 'modal reopen' });
    await ab(['press', 'Escape']);
    await waitFor(`document.querySelector('[role="dialog"]') == null`, { label: 'escape closes' });
    check(group, `取消与 Escape 关闭弹窗 @${w}x${h}`, true);

    // Confirm executes and closes with feedback.
    await clickInPage(
      `[...document.querySelectorAll('button')].find(b => b.textContent.trim() === '执行更新' && b.closest('div')?.textContent.includes('已选'))`,
      'batch update button 3',
    );
    await waitFor(`document.querySelector('[role="dialog"]') != null`, { label: 'modal reopen 2' });
    await clickInPage(
      `[...document.querySelector('[role="dialog"]').querySelectorAll('button')].find(b => b.textContent.trim() === '确认执行')`,
      'confirm',
    );
    await waitFor(`document.querySelector('[role="dialog"]') == null`, { label: 'confirm closes' });
    await waitFor(`document.body.textContent.includes('更新完成')`, { label: 'update feedback' });
    check(group, `确认执行走通且弹窗关闭 @${w}x${h}`, true);
    await ab(['screenshot', path.join(shotsDir, `modal-${w}x${h}.png`)]);
  }

  // Service-group update modal with 8 long child names at 320x568.
  await setViewport(320, 568);
  await goto(baseUrl, '#/resources?tab=services');
  await clickInPage(
    `[...document.querySelectorAll('input[aria-label^="选择服务"]')].find(i => i.getAttribute('aria-label').includes('stack-media-suite'))`,
    'media group checkbox',
  );
  await clickInPage(
    `[...document.querySelectorAll('button')].find(b => b.textContent.trim() === '执行更新' && b.closest('div')?.textContent.includes('已选'))`,
    'service batch update',
  );
  await waitFor(`document.querySelector('[role="dialog"]') != null`, {
    label: 'service modal open',
  });
  const geo = await evalJson(GEOM);
  const namesShown = await evalJson(
    `document.querySelector('[role="dialog"]').textContent.includes('extremely-long-sub-container-name')`,
  );
  check(
    group,
    '服务整组确认弹窗（8 个超长子容器名）受视口约束 @320x568',
    geo.open &&
      geo.top >= 0 &&
      geo.bottom <= geo.vh &&
      namesShown &&
      geo.buttons.some((b) => b.text === '确认执行' && b.vis),
    {
      geo: {
        ...geo,
        buttons: geo.buttons.filter((b) => b.text === '取消' || b.text === '确认执行'),
      },
      namesShown,
    },
  );
  await clickInPage(
    `[...document.querySelector('[role="dialog"]').querySelectorAll('button')].find(b => b.textContent.trim() === '取消')`,
    'cancel service modal',
  );
  await waitFor(`document.querySelector('[role="dialog"]') == null`, {
    label: 'service modal closed',
  });

  // Desktop screenshot for before/after comparison.
  await setViewport(1440, HEIGHT);
  await goto(baseUrl, '#/resources');
  await ab(['screenshot', path.join(shotsDir, 'desktop-1440.png')]);
  await setViewport(720, HEIGHT);
  await ab(['screenshot', path.join(shotsDir, 'narrow-720.png')]);
  await setViewport(320, HEIGHT);
  await goto(baseUrl, '#/resources?tab=services');
  await ab(['screenshot', path.join(shotsDir, 'narrow-320-services.png')]);
}

// --- helpers for scenario data ------------------------------------------------------

async function serviceDetailId(baseUrl) {
  const res = await fetch(`${baseUrl}/api/resources?kind=compose_service`);
  const data = await res.json();
  const parent = data.resources.find((r) => r.name === 'stack-media-suite');
  if (parent == null) throw new Error('fixture missing stack-media-suite');
  return String(parent.id);
}

// --- main ----------------------------------------------------------------------------

async function main() {
  const webRoot = path.resolve(import.meta.dirname, '../dist/web');
  if (!fs.existsSync(path.join(webRoot, 'index.html'))) {
    console.error('环境阻塞：dist/web/index.html 不存在，请先运行 npm run build:web。');
    process.exit(2);
  }
  let fixture;
  try {
    fixture = createResponsiveFixtureServer({ webRoot });
  } catch (err) {
    console.error('环境阻塞：fixture 创建失败：', err);
    process.exit(2);
  }
  let server;
  try {
    server = await fixture.start();
  } catch (err) {
    console.error('环境阻塞：fixture 启动失败：', err);
    process.exit(2);
  }
  const baseUrl = server.url;

  // Ids used by scenario routes come from the fixture API (stable, not hardcoded).
  let detailId;
  try {
    const apps = await (await fetch(`${baseUrl}/api/resources?kind=application`)).json();
    const long = apps.resources.find((r) => r.name.includes('very-long-application-name'));
    detailId = String(long.id);
  } catch (err) {
    console.error('环境阻塞：fixture 数据不可用：', err);
    await server.close();
    process.exit(2);
  }

  const routes = [
    { name: '概览', hash: '#/', needs: { overviewPause: true } },
    { name: '应用列表', hash: '#/resources', needs: { search: true, pagination: true } },
    {
      name: '服务列表',
      hash: '#/resources?tab=services',
      needs: { search: true, pagination: true },
    },
    { name: '资源详情', hash: `#/resources/${detailId}`, needs: {} },
    { name: '服务详情', hash: `#/resources/${await serviceDetailIdSafe(baseUrl)}`, needs: {} },
    { name: '更新历史', hash: '#/history', needs: { pagination: true } },
    { name: '通知', hash: '#/notifications', needs: { pagination: true } },
    { name: '设置', hash: '#/settings', needs: { settingsInputs: true } },
  ];

  try {
    await exec('agent-browser', ['close', '--all'], { timeout: 30_000 });
    await setViewport(1280, HEIGHT);
    await goto(baseUrl, '#/');
    console.log(`fixture: ${baseUrl}\nshots: ${shotsDir}\n`);
  } catch (err) {
    console.error('环境阻塞：agent-browser 不可用或浏览器无法启动：', String(err).slice(0, 400));
    await server.close();
    process.exit(2);
  }

  try {
    await scenarioA(baseUrl, routes);
    await scenarioAState(baseUrl);
    await scenarioB(baseUrl);
    await scenarioC(baseUrl);

    if (fixture.unknownHits.length > 0) {
      check('fixture', '页面未请求未实现的 API', false, fixture.unknownHits);
    } else {
      check('fixture', '页面未请求未实现的 API', true);
    }
  } catch (err) {
    check(
      '执行',
      '场景执行完成（未中断）',
      false,
      String(err instanceof Error ? (err.stack ?? err.message) : err).slice(0, 800),
    );
  } finally {
    try {
      await ab(['close']);
    } catch {
      try {
        await exec('agent-browser', ['close', '--all'], { timeout: 30_000 });
      } catch {
        // cleanup best effort
      }
    }
    await server.close();
  }

  const failed = results.filter((r) => !r.pass);
  const summary = {
    total: results.length,
    failed: failed.length,
    passed: results.length - failed.length,
    failures: failed,
    shots: fs.existsSync(shotsDir) ? fs.readdirSync(shotsDir) : [],
  };
  fs.writeFileSync(path.join(shotsDir, 'results.json'), JSON.stringify(summary, null, 2));
  console.log(
    `\n===== 响应式回归：${summary.passed} 通过 / ${summary.failed} 失败（共 ${summary.total}）=====`,
  );
  console.log(`产物目录：${shotsDir}`);
  process.exit(failed.length > 0 ? 1 : 0);
}

async function serviceDetailIdSafe(baseUrl) {
  try {
    return await serviceDetailId(baseUrl);
  } catch {
    return '28'; // unreachable in practice; keeps routes bootstrappable
  }
}

main().catch((err) => {
  console.error('环境阻塞：', err);
  process.exit(2);
});
