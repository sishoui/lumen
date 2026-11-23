/**
 * L4 用户流程共用助手：端口探测 / automator 连接 / 页面 data 读取 / 页面方法调用 /
 * 路由等待 / PASS-FAIL 计数。
 *
 * 约定与 scripts/verify-user-flow.mjs 一致：缺 automator 或端口时调用方打印
 * 单行 `SKIPPED: <原因>` 并 exit 0；断言失败 exit 1。
 */

import { createRequire } from "node:module";
import net from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..", "..");

export const DEFAULT_ENDPOINTS = [
  "ws://127.0.0.1:9529",
  "ws://127.0.0.1:9501",
  "ws://127.0.0.1:9502",
];

export const sleep = (ms) => new Promise((resolveP) => setTimeout(resolveP, ms));

export function loadAutomator() {
  try {
    const requireFromMp = createRequire(resolve(REPO, "miniprogram", "package.json"));
    const mod = requireFromMp("miniprogram-automator");
    return mod.default ?? mod;
  } catch {
    return null;
  }
}

function withTimeout(promise, ms, endpoint) {
  return new Promise((resolveP, rejectP) => {
    const timer = setTimeout(() => rejectP(new Error(`${endpoint} ${ms}ms 超时`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolveP(value);
      },
      (err) => {
        clearTimeout(timer);
        rejectP(err);
      },
    );
  });
}

export function probePort(endpoint, timeoutMs = 3000) {
  return new Promise((resolveP) => {
    let host = "127.0.0.1";
    let port = 9529;
    try {
      const url = new URL(endpoint);
      host = url.hostname || host;
      port = Number(url.port) || port;
    } catch {
      resolveP([`无法解析 ${endpoint}`]);
      return;
    }
    const socket = net.connect({ host, port });
    let settled = false;
    const finish = (reasons) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolveP(reasons);
    };
    const timer = setTimeout(() => finish([`${endpoint} ${timeoutMs}ms 无响应`]), timeoutMs);
    socket.once("connect", () => {
      clearTimeout(timer);
      finish([]);
    });
    socket.once("error", (err) => {
      clearTimeout(timer);
      finish([`${endpoint}: ${err.code ?? err.message}`]);
    });
  });
}

export async function pickEndpoint(automator, endpoints = DEFAULT_ENDPOINTS) {
  const reasons = [];
  for (const endpoint of endpoints) {
    const tcp = await probePort(endpoint);
    if (tcp.length > 0) {
      reasons.push(...tcp);
      continue;
    }
    try {
      const conn = await withTimeout(automator.connect({ wsEndpoint: endpoint }), 8000, endpoint);
      await conn.disconnect();
      return { endpoint };
    } catch (err) {
      reasons.push(`${endpoint}: ${String(err.message ?? err)}`);
    }
  }
  return { reasons };
}

/**
 * 连接开发者工具。成功返回 { mp, endpoint }；缺环境时返回 { skipped }。
 */
export async function connect(options = {}) {
  const automator = loadAutomator();
  if (!automator) return { skipped: "缺 miniprogram-automator" };

  const endpoints = options.endpoints ?? (process.env.WS ? [process.env.WS] : DEFAULT_ENDPOINTS);
  const chosen = await pickEndpoint(automator, endpoints);
  if (!("endpoint" in chosen)) {
    return { skipped: `无可用自动化端口（${chosen.reasons.join("；")}）` };
  }
  try {
    const mp = await automator.connect({ wsEndpoint: chosen.endpoint });
    return { mp, endpoint: chosen.endpoint };
  } catch (err) {
    return { skipped: `连接失败：${String(err.message ?? err)}` };
  }
}

/** 页面读取与操作。所有方法都走真实页面对象，不碰内部模块。 */
export function createDriver(mp) {
  const pageData = () =>
    mp.evaluate(() => {
      const page = getCurrentPages().pop();
      return page ? JSON.parse(JSON.stringify(page.data)) : null;
    });

  const dataGet = async (path) => {
    const data = await pageData();
    if (!data) return undefined;
    return path.split(".").reduce((value, key) => (value == null ? value : value[key]), data);
  };

  const call = (method, arg) =>
    mp.evaluate(
      ({ m, a }) => {
        const page = getCurrentPages().pop();
        if (!page || typeof page[m] !== "function") return { error: `no method ${m}` };
        try {
          page[m](a);
          return { ok: true };
        } catch (err) {
          return { error: String(err?.message ?? err) };
        }
      },
      { m: method, a: arg },
    );

  const componentData = (selector) =>
    mp.evaluate(
      ({ sel }) => {
        const page = getCurrentPages().pop();
        if (!page || typeof page.selectComponent !== "function") return null;
        const component = page.selectComponent(sel);
        return component ? JSON.parse(JSON.stringify(component.data)) : null;
      },
      { sel: selector },
    );

  const componentCall = (selector, method, arg) =>
    mp.evaluate(
      ({ sel, m, a }) => {
        const page = getCurrentPages().pop();
        const component = page && typeof page.selectComponent === "function"
          ? page.selectComponent(sel)
          : null;
        if (!component || typeof component[m] !== "function") {
          return { error: `no component method ${m}` };
        }
        try {
          component[m](a);
          return { ok: true };
        } catch (err) {
          return { error: String(err?.message ?? err) };
        }
      },
      { sel: selector, m: method, a: arg },
    );

  const curRoute = () =>
    mp.evaluate(() => {
      const page = getCurrentPages().pop();
      return page ? page.route : null;
    });

  const waitForRoute = async (route, timeoutMs = 10000) => {
    const expected = route.replace(/^\//, "");
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      if ((await curRoute()) === expected) return true;
      await sleep(150);
    }
    return false;
  };

  const switchTab = async (route) => {
    await mp.switchTab(route).catch(() => {});
    await sleep(600);
    return waitForRoute(route);
  };

  /** 轮询检查；返回最后一次的值（布尔检查会返回 false 而不是 null）。 */
  const waitFor = async (check, { timeoutMs = 5000, intervalMs = 150 } = {}) => {
    const startedAt = Date.now();
    let last = null;
    while (Date.now() - startedAt < timeoutMs) {
      last = await check();
      if (last) return last;
      await sleep(intervalMs);
    }
    return last;
  };

  return { pageData, dataGet, call, componentData, componentCall, curRoute, waitForRoute, switchTab, waitFor };
}

/**
 * 日志面板重置：控制页的 #frame-log 是常驻组件，paused 状态跨脚本残留。
 * 打开面板（必要时连点版本号）→ 必要时 onPause 复位 → onClear 清空 → 断言 paused=false 且 entries=[]。
 *
 * 失败时抛 Error（由调用方 try/catch 记为 FAIL），不静默吞掉。
 * 选项：
 *   { verifyEmpty: true }    断言 entries.length===0（默认）
 *   { verifyEmpty: false }   只复位 paused，不要求清空（默认不传时等价于 true）
 */
export async function resetLogPanel(
  driver,
  recorder,
  { verifyEmpty = true, versionTaps = 6, panelSelector = "#frame-log" } = {},
) {
  const rec = recorder.rec;

  // 1. 确保面板打开：连点版本号触发页面的 onVersionTap
  if ((await driver.dataGet("logVisible")) !== true) {
    for (let i = 0; i < versionTaps; i += 1) {
      await driver.call("onVersionTap");
      await sleep(120);
    }
    await driver.waitFor(async () => (await driver.dataGet("logVisible")) === true, { timeoutMs: 2500 });
  }
  const visible = await driver.dataGet("logVisible");
  if (visible !== true) {
    const msg = `resetLogPanel: 连点版本号后面板仍未打开（logVisible=${visible}）`;
    rec("resetLogPanel 打开面板", false, msg);
    throw new Error(msg);
  }

  // 2. 必要时 onPause 复位：读取组件 paused，为 true 时切回 false
  let panel = await driver.componentData(panelSelector);
  if (panel && panel.paused === true) {
    await driver.componentCall(panelSelector, "onPause");
    const resumed = await driver.waitFor(
      async () => {
        const d = await driver.componentData(panelSelector);
        return d && d.paused === false ? d : null;
      },
      { timeoutMs: 3000 },
    );
    if (!resumed) {
      const d = await driver.componentData(panelSelector);
      const msg = `resetLogPanel: onPause 复位后 paused 仍为 ${d?.paused}`;
      rec("resetLogPanel 复位 paused", false, msg);
      throw new Error(msg);
    }
  }

  // 3. 清空日志
  await driver.componentCall(panelSelector, "onClear");
  await sleep(300);
  await driver.waitFor(
    async () => {
      const d = await driver.componentData(panelSelector);
      return d && Array.isArray(d.entries) && d.entries.length === 0 ? d : null;
    },
    { timeoutMs: 3000 },
  );

  // 4. 断言
  const final = await driver.componentData(panelSelector);
  const paused = final?.paused;
  const entriesLen = final && Array.isArray(final.entries) ? final.entries.length : -1;
  if (paused !== false) {
    const msg = `resetLogPanel: 期望 paused=false，实际 paused=${paused}`;
    rec("resetLogPanel paused=false", false, msg);
    throw new Error(msg);
  }
  if (verifyEmpty && entriesLen !== 0) {
    const msg = `resetLogPanel: 期望 entries=[]，实际 entries.length=${entriesLen}`;
    rec("resetLogPanel entries 为空", false, msg);
    throw new Error(msg);
  }
  return final;
}

export function createRecorder({ log = console.log } = {}) {
  let pass = 0;
  const failures = [];

  const rec = (name, ok, detail = "") => {
    if (ok) {
      pass += 1;
      log(`PASS  ${name}${detail ? " — " + detail : ""}`);
    } else {
      failures.push(name + (detail ? " — " + detail : ""));
      log(`FAIL  ${name}${detail ? " — " + detail : ""}`);
    }
  };

  const printSummary = () => {
    log(`\n===== ${pass} passed / ${failures.length} failed =====`);
    if (failures.length > 0) {
      log("\n失败清单：");
      for (const failure of failures) log(`  - ${failure}`);
    }
  };

  return {
    rec,
    printSummary,
    get pass() {
      return pass;
    },
    get fail() {
      return failures.length;
    },
  };
}
