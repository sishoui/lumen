#!/usr/bin/env node
/**
 * 模拟用户测试（L4+）：用 miniprogram-automator 驱动真实小程序，按用户操作流程
 * 逐项断言。覆盖：设备扫描连接 → 控制页 → 部位编辑器（引脚分区）→ 场景编辑器（时间轴）。
 *
 * 驱动方式：通过 evaluate 在页面上下文调用页面事件处理方法（onScanTap / onLedTap …），
 * 这比 element.tap() 在复杂 WXML 上更稳定，且仍走真实业务代码路径（session/transport）。
 *
 * 用法：
 *   WS=ws://127.0.0.1:9529 node scripts/verify-user-flow.mjs
 *   node scripts/verify-user-flow.mjs --probe
 *
 * 退出码：0 全过；1 有失败；缺环境报 SKIPPED: <原因> 且 exit 0（编排器记 SKIP）。
 */

import { createRequire } from "node:module";
import net from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..");

const PORT_CANDIDATES = process.env.WS
  ? [process.env.WS]
  : ["ws://127.0.0.1:9529", "ws://127.0.0.1:9501", "ws://127.0.0.1:9502"];

const skipLine = (reason) => `SKIPPED: ${reason}`;

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
    let host = "127.0.0.1", port = 9529;
    try {
      const url = new URL(endpoint);
      host = url.hostname || host;
      port = Number(url.port) || port;
    } catch { resolveP([`无法解析 ${endpoint}`]); return; }
    const socket = net.connect({ host, port });
    let settled = false;
    const finish = (reasons) => { if (settled) return; settled = true; socket.destroy(); resolveP(reasons); };
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

if (process.argv.includes("--probe")) {
  const automator = loadAutomator();
  if (!automator) { console.log(skipLine("缺 miniprogram-automator")); process.exit(0); }
  const chosen = await pickEndpoint(automator);
  if ("endpoint" in chosen) console.log(`PORT: ${chosen.endpoint} 可连`);
  else console.log(skipLine(`无可用自动化端口：${chosen.reasons.join("；")}`));
  process.exit(0);
}

const automator = loadAutomator();
if (!automator) { console.log(skipLine("缺 miniprogram-automator")); process.exit(0); }

const chosen = await pickEndpoint(automator);
if (!("endpoint" in chosen)) {
  console.log(skipLine(`无可用自动化端口（${chosen.reasons.join("；")}）`));
  process.exit(0);
}

let mp;
try {
  mp = await automator.connect({ wsEndpoint: chosen.endpoint });
} catch (e) {
  console.log(skipLine(`连接失败：${String(e.message ?? e)}`));
  process.exit(0);
}

let pass = 0, fail = 0;
const failures = [];
const rec = (name, ok, detail = "") => {
  if (ok) { pass++; console.log(`PASS  ${name}${detail ? " — " + detail : ""}`); }
  else { fail++; failures.push(name + (detail ? " — " + detail : "")); console.log(`FAIL  ${name}${detail ? " — " + detail : ""}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 取当前页面 data 的快照。 */
const pageData = () => mp.evaluate(() => {
  const p = getCurrentPages().pop();
  return p ? JSON.parse(JSON.stringify(p.data)) : null;
});

/** 取 data 里某路径的值。 */
const dataGet = async (path) => {
  const d = await pageData();
  if (!d) return undefined;
  return path.split(".").reduce((o, k) => (o == null ? o : o[k]), d);
};

/** 在当前页调用页面方法（模拟用户操作）。 */
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

/** 等页面栈顶变成指定路由。 */
const waitForRoute = async (route, timeoutMs = 10000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const s = await mp.evaluate(() => {
      const p = getCurrentPages().pop();
      return p ? p.route : null;
    });
    if (s === route) return true;
    await sleep(150);
  }
  return false;
};

const curRoute = () => mp.evaluate(() => {
  const p = getCurrentPages().pop();
  return p ? p.route : null;
});

/* ===================================================================
 * §A 设备页：扫描 + 连接
 * =================================================================== */
console.log("\n=== §A 设备页：扫描 + 连接 ===");
{
  await mp.switchTab("/pages/device/device").catch(() => {});
  await sleep(1000);
  await waitForRoute("pages/device/device");
  rec("A1 设备页加载", (await curRoute()) === "pages/device/device", await curRoute());

  // 演示会话重置（off→on）：重建 MockTransport 与设备运行时，确保脚本可重复执行。
  await call("onMockModeChange", { detail: { value: false } });
  await sleep(800);
  await call("onMockModeChange", { detail: { value: true } });
  await sleep(1200);

  // 确保演示模式开（storage 可能残留 false，导致扫不到设备）
  if ((await dataGet("mockMode")) !== true) {
    await call("onMockModeChange", { detail: { value: true } });
    await sleep(1200);
  }
  const mockMode = await dataGet("mockMode");
  rec("A2 演示模式默认开", mockMode === true, `mockMode=${mockMode}`);
  const devicesAfterReset = await dataGet("devices.length");
  rec("A2b 重置后设备列表清空", (devicesAfterReset ?? 0) === 0, `devices=${devicesAfterReset}`);

  // 扫描
  const r = await call("onScanTap");
  rec("A3a onScanTap 调用成功", r.ok === true, r.error ?? "");
  await sleep(1500);
  const devCount = await dataGet("devices.length");
  rec("A3 扫描出设备", devCount > 0, `devices=${devCount}`);

  // 连接第一台
  await call("onDeviceTap", { currentTarget: { dataset: { index: 0 } } });
  await sleep(3000);
  // 连接成功后 onDeviceTap 会 wx.switchTab 跳到控制页
  const route = await curRoute();
  const ctrlState = route === "pages/control/control" ? await dataGet("state") : null;
  rec("A4 点设备卡连接成功（跳控制页）", route === "pages/control/control" && ctrlState?.power !== undefined,
    `route=${route} power=${ctrlState?.power}`);
}

/* ===================================================================
 * §B 控制页：整机开关 / 亮度 / 链开关
 * =================================================================== */
console.log("\n=== §B 控制页 ===");
{
  await mp.switchTab("/pages/control/control").catch(() => {});
  await sleep(1200);
  await waitForRoute("pages/control/control");
  const state = await dataGet("state");
  rec("B1 控制页加载有 state", state !== null && state !== undefined, `power=${state?.power}`);
  const stripRows = await dataGet("stripRows.length");
  rec("B2 链列表非空", stripRows > 0, `rows=${stripRows}`);

  // 整机开关
  const swBefore = state?.power;
  await call("onPowerChange", { detail: { value: !swBefore } });
  await sleep(1200);
  const swAfter = (await dataGet("state"))?.power;
  rec("B3 整机开关切换", swAfter !== swBefore, `${swBefore}→${swAfter}`);

  // 亮度
  await call("onBrightnessChanging", { detail: { value: 100 } });
  await call("onBrightnessChange", { detail: { value: 100 } });
  await sleep(800);
  const brightness = (await dataGet("state"))?.brightness;
  rec("B4 亮度设置生效", brightness === 100, `brightness=${brightness}`);
}

/* ===================================================================
 * §C 部位编辑器（引脚分区）
 * =================================================================== */
console.log("\n=== §C 部位编辑器（引脚分区）===");
{
  await call("onPartEditorTap");
  await sleep(1500);
  const onPart = (await curRoute()) === "pages/part/part";
  rec("C1 导航到部位编辑器", onPart, await curRoute());

  if (onPart) {
    const ledCount = await dataGet("ledCount");
    rec("C2 灯珠数加载", typeof ledCount === "number" && ledCount > 0, `ledCount=${ledCount}`);

    const ledCells = await dataGet("ledCells.length");
    rec("C3 灯珠方格渲染", ledCells === ledCount, `cells=${ledCells}/${ledCount}`);

    const parts = await dataGet("parts.length");
    rec("C4 部位槽位加载", parts > 0, `parts=${parts}`);

    // 选段：点灯珠 0，再点灯珠 4
    await call("onLedTap", { currentTarget: { dataset: { index: 0 } } });
    await sleep(300);
    const selecting = await dataGet("selecting");
    rec("C5 点击灯珠开始选段", selecting !== null && selecting !== undefined, `selecting=${JSON.stringify(selecting)}`);

    await call("onLedTap", { currentTarget: { dataset: { index: 4 } } });
    await sleep(300);
    const segs = await dataGet("segs");
    rec("C6 拖选生成段", Array.isArray(segs) && segs.length > 0, `segs=${JSON.stringify(segs)}`);

    // 填名字
    await call("onNameInput", { detail: { value: "测试部位" } });
    await sleep(300);
    rec("C7 部位名输入", (await dataGet("partName")) === "测试部位", `partName=${await dataGet("partName")}`);

    // 相位模式
    await call("onPhaseChange", { detail: { value: 1 } });
    await sleep(200);
    rec("C8 相位模式切换", (await dataGet("phase")) === 1, `phase=${await dataGet("phase")}`);

    // 提交布局
    await call("onCommitTap");
    await sleep(2000);
    const hint = await dataGet("hint");
    rec("C9 提交布局有反馈", hint !== "" && hint !== undefined, `hint=${hint}`);
    const segsAfter = await dataGet("segs");
    rec("C10 提交后段不丢失", Array.isArray(segsAfter) && segsAfter.length > 0, `segs=${JSON.stringify(segsAfter)}`);
    // 最终值断言：提交后页面立即刷新，parts/segs 反映设备读回值。
    const partsAfter = await dataGet("parts");
    const partCountAfter = await dataGet("partCount");
    const activePartId = await dataGet("activePartId");
    const activeSegs = Array.isArray(partsAfter) && partsAfter[activePartId]?.segs
      ? JSON.stringify(partsAfter[activePartId].segs)
      : "undefined";
    const expectedSegs = JSON.stringify(segsAfter ?? []);
    rec("C11 提交后 parts 槽位数与 segs 读回一致",
      Array.isArray(partsAfter) && partsAfter.length > 0 &&
        partCountAfter === partsAfter.length &&
        activeSegs === expectedSegs,
      `期望槽位数≥1 且 activePartId=${activePartId} segs=${expectedSegs}，实际 partCount=${partCountAfter} parts=${partsAfter?.length} activeSegs=${activeSegs}`);

    await mp.navigateBack().catch(() => {});
    await sleep(1000);
  }
}

/* ===================================================================
 * §D 场景编辑器（时间轴）
 * =================================================================== */
console.log("\n=== §D 场景编辑器（时间轴）===");
{
  await mp.switchTab("/pages/control/control").catch(() => {});
  await sleep(800);
  await call("onSceneEditorTap");
  await sleep(1500);
  const onScene = (await curRoute()) === "pages/scene/scene";
  rec("D1 导航到场景编辑器", onScene, await curRoute());

  if (onScene) {
    await sleep(1500);
    rec("D2 场景加载完成", (await dataGet("loading")) === false, `loading=${await dataGet("loading")}`);

    const parts = await dataGet("parts.length");
    rec("D3 部位列表加载", parts > 0, `parts=${parts}`);

    // 添加步骤
    await call("onAddStep");
    await sleep(1500);
    const steps = await dataGet("steps.length");
    rec("D4 添加步骤", steps > 0, `steps=${steps}`);

    // 设置时长
    await call("onDurationInput", { detail: { value: "2000" } });
    await sleep(300);
    rec("D5 时长输入", (await dataGet("durationMs")) === 2000, `durationMs=${await dataGet("durationMs")}`);

    // 保存步骤
    await call("onSaveStep");
    await sleep(1500);
    const hint = await dataGet("hint");
    rec("D6 保存步骤有反馈", hint !== "" && hint !== undefined, `hint=${hint}`);
    // 验证步骤时长真的写进去了（#22 起新增步会保留旧步，读当前选中步而不是固定 0）
    const activeStep = await dataGet("activeStepIndex");
    const savedDur = await dataGet(`steps.${activeStep}.durationMs`);
    rec("D6b 步骤时长落库", savedDur === 2000, `期望 2000，实际 steps[${activeStep}].durationMs=${savedDur}`);

    // 保存场景名
    await call("onSceneNameInput", { detail: { value: "我的场景" } });
    await sleep(200);
    await call("onSaveSceneName");
    await sleep(1000);
    const nameHint = await dataGet("hint");
    rec("D7 保存场景名", nameHint !== "" && nameHint !== undefined, `hint=${nameHint}`);

    // 最终值断言：返回控制页再进编辑器，断言场景名从设备读回。
    await mp.navigateBack().catch(() => {});
    await sleep(1000);
    await mp.switchTab("/pages/control/control").catch(() => {});
    await sleep(800);
    await waitForRoute("pages/control/control");
    await call("onSceneEditorTap");
    await sleep(1500);
    await waitForRoute("pages/scene/scene");
    await sleep(2000);
    const sceneNameAfter = await dataGet("sceneName");
    rec("D7b 场景名重进后读回「我的场景」",
      sceneNameAfter === "我的场景",
      `期望「我的场景」，实际「${sceneNameAfter}」`);

    // 激活场景
    await call("onActivateTap");
    await sleep(1000);
    const actHint = await dataGet("hint");
    rec("D8 激活场景", actHint !== "" && actHint !== undefined, `hint=${actHint}`);
    // 最终值断言：返回控制页，断言 State.activeScene 等于当前 sceneId。
    await mp.navigateBack().catch(() => {});
    await sleep(1000);
    await mp.switchTab("/pages/control/control").catch(() => {});
    await sleep(800);
    await waitForRoute("pages/control/control");
    const expectedSceneId = await dataGet("state.activeScene");
    const actualActive = await dataGet("activeSceneId");
    rec("D8b 控制页 activeSceneId 与 State.activeScene 一致",
      actualActive !== undefined && expectedSceneId !== undefined &&
        actualActive === expectedSceneId,
      `activeSceneId=${actualActive} state.activeScene=${expectedSceneId}`);
    await mp.navigateBack().catch(() => {});
    await sleep(800);
  }
}

/* ===================================================================
 * §E 日志面板
 * =================================================================== */
console.log("\n=== §E 日志面板 ===");
{
  await mp.switchTab("/pages/control/control").catch(() => {});
  await sleep(800);
  for (let i = 0; i < 6; i++) {
    await call("onVersionTap");
    await sleep(150);
  }
  await sleep(500);
  rec("E1 连点版本号唤出日志", (await dataGet("logVisible")) === true, `logVisible=${await dataGet("logVisible")}`);
}

/* ===================================================================
 * 汇总
 * =================================================================== */
console.log(`\n===== ${pass} passed / ${fail} failed =====`);
if (failures.length > 0) {
  console.log("\n失败清单：");
  for (const f of failures) console.log(`  - ${f}`);
}
await mp.disconnect().catch(() => {});
process.exit(fail === 0 ? 0 : 1);