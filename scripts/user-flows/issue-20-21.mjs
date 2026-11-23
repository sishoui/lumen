#!/usr/bin/env node
/**
 * L4 用户流程（#20/#21）：演示模式连接 → 场景名保存/重进读回 → 两步时长与灯效读回
 * → 多部位布局重进读回。
 *
 * 驱动方式与 scripts/verify-user-flow.mjs 相同：通过 evaluate 调页面事件处理方法，
 * 走真实页面 + session + MockTransport 路径。只断言用户可见的页面数据。
 *
 * 用法：
 *   WS=ws://127.0.0.1:9529 node scripts/user-flows/issue-20-21.mjs
 *
 * 退出码：0 全过或 SKIPPED；1 有失败。
 * 没有自动化端口 / automator 时打印单行 SKIPPED 并 exit 0。
 */

import { createRequire } from "node:module";
import net from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..", "..");

const PORT_CANDIDATES = process.env.WS
  ? [process.env.WS]
  : ["ws://127.0.0.1:9529", "ws://127.0.0.1:9501", "ws://127.0.0.1:9502"];

const skip = (reason) => {
  console.log(`SKIPPED: ${reason}`);
  process.exit(0);
};

function withTimeout(promise, ms, endpoint) {
  return new Promise((resolveP, rejectP) => {
    const timer = setTimeout(() => rejectP(new Error(`${endpoint} ${ms}ms 超时`)), ms);
    promise.then(
      (v) => { clearTimeout(timer); resolveP(v); },
      (e) => { clearTimeout(timer); rejectP(e); },
    );
  });
}

function loadAutomator() {
  try {
    const requireFromMp = createRequire(resolve(REPO, "miniprogram", "package.json"));
    const mod = requireFromMp("miniprogram-automator");
    return mod.default ?? mod;
  } catch {
    return null;
  }
}

function probePort(endpoint, timeoutMs = 3000) {
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
    socket.once("connect", () => { clearTimeout(timer); finish([]); });
    socket.once("error", (e) => { clearTimeout(timer); finish([`${endpoint}: ${e.code ?? e.message}`]); });
  });
}

async function pickEndpoint(automator) {
  const reasons = [];
  for (const ep of PORT_CANDIDATES) {
    const tcp = await probePort(ep);
    if (tcp.length > 0) { reasons.push(...tcp); continue; }
    try {
      const conn = await withTimeout(automator.connect({ wsEndpoint: ep }), 8000, ep);
      await conn.disconnect();
      return { endpoint: ep };
    } catch (e) {
      reasons.push(`${ep}: ${String(e.message ?? e)}`);
    }
  }
  return { reasons };
}

const automator = loadAutomator();
if (!automator) skip("缺 miniprogram-automator");

const chosen = await pickEndpoint(automator);
if (!("endpoint" in chosen)) {
  skip(`无可用自动化端口（${chosen.reasons.join("；")}）`);
}

let mp;
try {
  mp = await automator.connect({ wsEndpoint: chosen.endpoint });
} catch (e) {
  skip(`连接失败：${String(e.message ?? e)}`);
}

let pass = 0;
let fail = 0;
const failures = [];
const rec = (name, ok, detail = "") => {
  if (ok) {
    pass += 1;
    console.log(`PASS  ${name}${detail ? " — " + detail : ""}`);
  } else {
    fail += 1;
    failures.push(name + (detail ? " — " + detail : ""));
    console.log(`FAIL  ${name}${detail ? " — " + detail : ""}`);
  }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const pageData = () => mp.evaluate(() => {
  const p = getCurrentPages().pop();
  return p ? JSON.parse(JSON.stringify(p.data)) : null;
});

const dataGet = async (path) => {
  const d = await pageData();
  if (!d) return undefined;
  return path.split(".").reduce((o, k) => (o == null ? o : o[k]), d);
};

const call = (method, arg) => mp.evaluate(({ m, a }) => {
  const p = getCurrentPages().pop();
  if (!p || typeof p[m] !== "function") return { error: `no method ${m}` };
  try {
    p[m](a);
    return { ok: true };
  } catch (e) {
    return { error: String(e?.message ?? e) };
  }
}, { m: method, a: arg });

const curRoute = () => mp.evaluate(() => {
  const p = getCurrentPages().pop();
  return p ? p.route : null;
});

const waitForRoute = async (route, timeoutMs = 10000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if ((await curRoute()) === route) return true;
    await sleep(150);
  }
  return false;
};

const goControl = async () => {
  await mp.switchTab("/pages/control/control").catch(() => {});
  await sleep(800);
  await waitForRoute("pages/control/control");
};

async function main() {
  console.log("\n=== §A 演示模式连接 ===");
  await mp.switchTab("/pages/device/device").catch(() => {});
  await sleep(1000);
  await waitForRoute("pages/device/device");
  if ((await dataGet("mockMode")) !== true) {
    await call("onMockModeChange", { detail: { value: true } });
    await sleep(1200);
  }
  rec("A1 演示模式开", (await dataGet("mockMode")) === true, `mockMode=${await dataGet("mockMode")}`);

  await call("onScanTap");
  await sleep(1500);
  const deviceCount = await dataGet("devices.length");
  rec("A2 扫描出设备", deviceCount > 0, `devices=${deviceCount}`);

  await call("onDeviceTap", { currentTarget: { dataset: { index: 0 } } });
  await sleep(2500);
  const route = await curRoute();
  rec("A3 连接后进入控制页", route === "pages/control/control", `route=${route}`);

  console.log("\n=== §B 场景名与两步读回 ===");
  await call("onSceneEditorTap");
  await sleep(1500);
  await waitForRoute("pages/scene/scene");
  await sleep(2000);
  rec("B1 场景编辑器加载", (await dataGet("loading")) === false, `loading=${await dataGet("loading")}`);
  const partCount = await dataGet("parts.length");
  rec("B2 部位列表非空", partCount > 0, `parts=${partCount}`);

  await call("onSceneNameInput", { detail: { value: "客厅模式" } });
  await call("onSaveSceneName");
  await sleep(1000);
  rec(
    "B3 保存场景名反馈",
    String(await dataGet("hint") ?? "").includes("已保存"),
    `hint=${await dataGet("hint")}`,
  );

  await call("onAddStep");
  await sleep(1200);
  rec("B4 添加第 1 步", (await dataGet("steps.length")) === 1, `steps=${await dataGet("steps.length")}`);
  await call("onDurationInput", { detail: { value: "1500" } });
  await call("onLayer0HueInput", { detail: { value: "120" } });
  await call("onLayer0LevelInput", { detail: { value: "80" } });
  await call("onSaveStep");
  await sleep(1200);
  rec(
    "B5 第 1 步时长落库",
    (await dataGet("steps.0.durationMs")) === 1500,
    `steps[0].durationMs=${await dataGet("steps.0.durationMs")}`,
  );

  await call("onAddStep");
  await sleep(1200);
  rec("B6 添加第 2 步", (await dataGet("steps.length")) === 2, `steps=${await dataGet("steps.length")}`);
  await call("onStepTap", { currentTarget: { dataset: { index: 1 } } });
  await sleep(300);
  await call("onDurationInput", { detail: { value: "2500" } });
  await call("onLayer0HueInput", { detail: { value: "240" } });
  await call("onLayer0LevelInput", { detail: { value: "60" } });
  await call("onSaveStep");
  await sleep(1200);

  // 加第 2 步时固件语义会清空已有步骤；按时间轴重新写回第 1 步。
  await call("onStepTap", { currentTarget: { dataset: { index: 0 } } });
  await sleep(300);
  await call("onDurationInput", { detail: { value: "1500" } });
  await call("onLayer0HueInput", { detail: { value: "120" } });
  await call("onLayer0LevelInput", { detail: { value: "80" } });
  await call("onSaveStep");
  await sleep(1200);

  const expectedDurations = [1500, 2500];
  const expectedHues = [120, 240];
  const expectedLevels = [80, 60];
  const readDurations = [
    await dataGet("steps.0.durationMs"),
    await dataGet("steps.1.durationMs"),
  ];
  rec(
    "B7 两步时长写入一致",
    JSON.stringify(readDurations) === JSON.stringify(expectedDurations),
    `期望 ${JSON.stringify(expectedDurations)}，实际 ${JSON.stringify(readDurations)}`,
  );

  await mp.navigateBack().catch(() => {});
  await sleep(1000);
  await goControl();
  await call("onSceneEditorTap");
  await sleep(1500);
  await waitForRoute("pages/scene/scene");
  await sleep(2500);

  rec(
    "B8 重新进入后场景名仍在",
    (await dataGet("sceneName")) === "客厅模式",
    `期望「客厅模式」，实际「${await dataGet("sceneName")}」`,
  );
  const reDurations = [
    await dataGet("steps.0.durationMs"),
    await dataGet("steps.1.durationMs"),
  ];
  const reHues = [
    await dataGet("steps.0.layer0.hue"),
    await dataGet("steps.1.layer0.hue"),
  ];
  const reLevels = [
    await dataGet("steps.0.layer0.level"),
    await dataGet("steps.1.layer0.level"),
  ];
  rec(
    "B9 重新进入后两步时长读回一致",
    JSON.stringify(reDurations) === JSON.stringify(expectedDurations),
    `期望 ${JSON.stringify(expectedDurations)}，实际 ${JSON.stringify(reDurations)}`,
  );
  rec(
    "B10 重新进入后两步灯效读回一致",
    JSON.stringify(reHues) === JSON.stringify(expectedHues) &&
      JSON.stringify(reLevels) === JSON.stringify(expectedLevels),
    `期望 hue=${JSON.stringify(expectedHues)} level=${JSON.stringify(expectedLevels)}，实际 hue=${JSON.stringify(reHues)} level=${JSON.stringify(reLevels)}`,
  );

  await mp.navigateBack().catch(() => {});
  await sleep(800);
  await goControl();

  console.log("\n=== §C 多部位布局读回 ===");
  await call("onPartEditorTap");
  await sleep(1500);
  await waitForRoute("pages/part/part");
  await sleep(2000);
  const parts = await dataGet("parts.length");
  rec("C1 重新进入后部位数量一致", parts === 2, `期望 2，实际 ${parts}`);
  const names = await dataGet("parts");
  rec(
    "C2 部位名读回一致",
    Array.isArray(names) && names[0]?.name === "前半" && names[1]?.name === "后半",
    `实际 ${JSON.stringify((names ?? []).map((p) => p.name))}`,
  );
  const segs = await dataGet("parts");
  rec(
    "C3 部位段读回一致",
    Array.isArray(segs) && segs[0]?.segs?.length > 0 && segs[1]?.segs?.length > 0,
    `实际 ${JSON.stringify((segs ?? []).map((p) => p.segs))}`,
  );
}

try {
  await main();
} catch (e) {
  fail += 1;
  failures.push(`EXCEPTION: ${String(e?.message ?? e)}`);
  console.log(`FAIL  EXCEPTION — ${String(e?.message ?? e)}`);
} finally {
  console.log(`\n===== ${pass} passed / ${fail} failed =====`);
  if (failures.length > 0) {
    console.log("\n失败清单：");
    for (const f of failures) console.log(`  - ${f}`);
  }
  await mp.disconnect().catch(() => {});
  process.exit(fail === 0 ? 0 : 1);
}
