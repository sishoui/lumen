#!/usr/bin/env node
/**
 * 工单 #27 用户流程（L4）：灯效类型映射、空层、字段显隐。
 *
 * 用法：
 *   WS=ws://127.0.0.1:9529 node scripts/user-flows/issue-27.mjs
 *
 * 退出码：0 全过或 SKIP；1 有失败。缺自动化端口/依赖时打印 SKIPPED 并 exit 0。
 */

import { createRequire } from "node:module";
import net from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..", "..");

const ENDPOINT = process.env.WS || "ws://127.0.0.1:9529";
const SKIP = (reason) => `SKIPPED: ${reason}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
      resolveP(`无法解析 ${endpoint}`);
      return;
    }
    const socket = net.connect({ host, port });
    let settled = false;
    const finish = (reason) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolveP(reason);
    };
    const timer = setTimeout(() => finish(`${endpoint} ${timeoutMs}ms 无响应`), timeoutMs);
    socket.once("connect", () => {
      clearTimeout(timer);
      finish(null);
    });
    socket.once("error", (e) => {
      clearTimeout(timer);
      finish(`${endpoint}: ${e.code ?? e.message}`);
    });
  });
}

const automator = loadAutomator();
if (!automator) {
  console.log(SKIP("缺 miniprogram-automator"));
  process.exit(0);
}

const portProblem = await probePort(ENDPOINT);
if (portProblem) {
  console.log(SKIP(`无可用自动化端口（${portProblem}）`));
  process.exit(0);
}

let mp;
try {
  mp = await automator.connect({ wsEndpoint: ENDPOINT });
} catch (e) {
  console.log(SKIP(`连接失败：${String(e.message ?? e)}`));
  process.exit(0);
}

let pass = 0;
let fail = 0;
const failures = [];
const rec = (name, ok, detail = "") => {
  if (ok) {
    pass++;
    console.log(`PASS  ${name}${detail ? " — " + detail : ""}`);
  } else {
    fail++;
    failures.push(name + (detail ? " — " + detail : ""));
    console.log(`FAIL  ${name}${detail ? " — " + detail : ""}`);
  }
};

const pageData = () => mp.evaluate(() => {
  const p = getCurrentPages().pop();
  return p ? JSON.parse(JSON.stringify(p.data)) : null;
});

const dataGet = async (path) => {
  const data = await pageData();
  if (!data) return undefined;
  return path.split(".").reduce((o, k) => (o == null ? o : o[k]), data);
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

const waitUntil = async (predicate, timeoutMs = 6000, intervalMs = 200) => {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (await predicate()) return true;
    await sleep(intervalMs);
  }
  return false;
};

/** DOM 级：元素是否存在（真实 WXML 渲染）。 */
const domExists = async (selector) => {
  try {
    const page = await mp.currentPage();
    const node = await page.$(selector);
    return node !== null && node !== undefined;
  } catch {
    return false;
  }
};

const optionIndex = async (dataKey, label) => {
  const options = await dataGet(dataKey);
  if (!Array.isArray(options)) return -1;
  return options.findIndex((o) => o.label === label);
};

const fieldsAllFalse = (fields) => fields
  && fields.hue === false && fields.sat === false
  && fields.period === false && fields.level === false;

/* ===================================================================
 * §A 演示模式连接 → 场景编辑器
 * =================================================================== */
console.log("\n=== §A 进入场景编辑器 ===");
{
  await mp.switchTab("/pages/device/device").catch(() => {});
  await sleep(1000);
  await waitForRoute("pages/device/device");

  if ((await dataGet("mockMode")) !== true) {
    await call("onMockModeChange", { detail: { value: true } });
    await sleep(1200);
  }
  rec("A1 演示模式已开", (await dataGet("mockMode")) === true);

  await call("onScanTap");
  await sleep(1500);
  const deviceCount = await dataGet("devices.length");
  rec("A2 扫描出演示设备", deviceCount > 0, `devices=${deviceCount}`);

  await call("onDeviceTap", { currentTarget: { dataset: { index: 0 } } });
  await sleep(3000);
  rec("A3 连接后到控制页", (await curRoute()) === "pages/control/control", await curRoute());

  await call("onSceneEditorTap");
  const reached = await waitForRoute("pages/scene/scene");
  rec("A4 进入场景编辑器", reached, await curRoute());
}

/* ===================================================================
 * §B 选项：底层不含空层，叠加层含空层
 * =================================================================== */
console.log("\n=== §B 灯效选项 ===");
{
  const layer0Options = await dataGet("layer0Options");
  const layer1Options = await dataGet("layer1Options");
  rec("B1 底层选项不出现空层",
    Array.isArray(layer0Options)
      && !layer0Options.some((o) => o.label === "空层" || o.value === 255),
    JSON.stringify(layer0Options?.map((o) => o.label)));
  const emptyOption = Array.isArray(layer1Options)
    ? layer1Options.find((o) => o.label === "空层")
    : undefined;
  rec("B2 叠加层选项含空层且 value=255",
    emptyOption?.value === 255,
    JSON.stringify(emptyOption));
}

/* ===================================================================
 * §C 字段显隐：心跳有周期、静态无周期、熄灭只有类型
 * =================================================================== */
console.log("\n=== §C 字段显隐 ===");
{
  if ((await dataGet("steps.length")) === 0) {
    await call("onAddStep");
    await waitUntil(async () => (await dataGet("steps.length")) > 0, 8000);
  }
  rec("C1 已有可编辑步骤", (await dataGet("steps.length")) > 0, `steps=${await dataGet("steps.length")}`);

  const heartbeatIndex = await optionIndex("layer0Options", "心跳");
  await call("onLayer0TypeChange", { detail: { value: heartbeatIndex } });
  await sleep(300);
  const heartbeatFields = await dataGet("layer0Fields");
  const domPeriodHeartbeat = await domExists(".field-layer0-period");
  const domHueHeartbeat = await domExists(".field-layer0-hue");
  rec("C2 心跳显示周期",
    heartbeatFields?.period === true && (await dataGet("layer0Type")) === 5 &&
      domPeriodHeartbeat === true && domHueHeartbeat === true,
    `type=${await dataGet("layer0Type")} period=${heartbeatFields?.period} dom.period=${domPeriodHeartbeat} dom.hue=${domHueHeartbeat}`);

  const staticIndex = await optionIndex("layer0Options", "静态");
  await call("onLayer0TypeChange", { detail: { value: staticIndex } });
  await sleep(300);
  const staticFields = await dataGet("layer0Fields");
  const domPeriodStatic = await domExists(".field-layer0-period");
  const domHueStatic = await domExists(".field-layer0-hue");
  rec("C3 静态隐藏周期",
    staticFields?.period === false && staticFields?.hue === true &&
      domPeriodStatic === false && domHueStatic === true,
    `period=${staticFields?.period} hue=${staticFields?.hue} dom.period=${domPeriodStatic} dom.hue=${domHueStatic}`);

  const offIndex = await optionIndex("layer0Options", "熄灭");
  await call("onLayer0TypeChange", { detail: { value: offIndex } });
  await sleep(300);
  const domHueOff = await domExists(".field-layer0-hue");
  const domSatOff = await domExists(".field-layer0-sat");
  const domPeriodOff = await domExists(".field-layer0-period");
  const domLevelOff = await domExists(".field-layer0-level");
  rec("C4 熄灭只显示类型",
    fieldsAllFalse(await dataGet("layer0Fields")) && (await dataGet("layer0Label")) === "熄灭" &&
      domHueOff === false && domSatOff === false && domPeriodOff === false && domLevelOff === false,
    `label=${await dataGet("layer0Label")} fields=${JSON.stringify(await dataGet("layer0Fields"))} dom(hue=${domHueOff} sat=${domSatOff} period=${domPeriodOff} level=${domLevelOff})`);

  // 回到静态，后面的保存用合法底层
  await call("onLayer0TypeChange", { detail: { value: staticIndex } });
  await sleep(300);
}

/* ===================================================================
 * §D 叠加层：空层 → 呼吸（默认亮度 50）→ 保存 → 空层 → 保存 → 重进读回
 * =================================================================== */
console.log("\n=== §D 叠加层空层往返 ===");
{
  const emptyIndex = await optionIndex("layer1Options", "空层");
  await call("onLayer1TypeChange", { detail: { value: emptyIndex } });
  await sleep(300);
  const domL1HueEmpty = await domExists(".field-layer1-hue");
  const domL1SatEmpty = await domExists(".field-layer1-sat");
  const domL1PeriodEmpty = await domExists(".field-layer1-period");
  const domL1LevelEmpty = await domExists(".field-layer1-level");
  rec("D1 叠加层空层隐藏全部字段",
    fieldsAllFalse(await dataGet("layer1Fields")) && (await dataGet("layer1Type")) === 255 &&
      domL1HueEmpty === false && domL1SatEmpty === false && domL1PeriodEmpty === false && domL1LevelEmpty === false,
    `type=${await dataGet("layer1Type")} fields=${JSON.stringify(await dataGet("layer1Fields"))} dom(hue=${domL1HueEmpty} sat=${domL1SatEmpty} period=${domL1PeriodEmpty} level=${domL1LevelEmpty})`);

  const breathingIndex = await optionIndex("layer1Options", "呼吸");
  await call("onLayer1TypeChange", { detail: { value: breathingIndex } });
  await sleep(300);
  rec("D2 空层切呼吸默认亮度 50",
    (await dataGet("layer1Type")) === 1 && (await dataGet("layer1Level")) === 50,
    `type=${await dataGet("layer1Type")} level=${await dataGet("layer1Level")}`);
  const domL1PeriodBreath = await domExists(".field-layer1-period");
  const domL1HueBreath = await domExists(".field-layer1-hue");
  rec("D3 呼吸显示 hue/sat/period/level",
    (await dataGet("layer1Fields"))?.period === true && domL1PeriodBreath === true && domL1HueBreath === true,
    `fields=${JSON.stringify(await dataGet("layer1Fields"))} dom.period=${domL1PeriodBreath} dom.hue=${domL1HueBreath}`);

  await call("onSaveStep");
  const savedReal = await waitUntil(async () => (await dataGet("steps.0.layer1.type")) === 1, 8000);
  rec("D4 呼吸叠加层保存并读回 type=1", savedReal,
    `readback=${await dataGet("steps.0.layer1.type")} hint=${await dataGet("hint")}`);

  await call("onLayer1TypeChange", { detail: { value: emptyIndex } });
  await sleep(300);
  rec("D5 呼吸后能切回空层且字段隐藏",
    fieldsAllFalse(await dataGet("layer1Fields")) && (await dataGet("layer1Type")) === 255,
    `type=${await dataGet("layer1Type")}`);

  await call("onSaveStep");
  const savedEmpty = await waitUntil(async () => (await dataGet("steps.0.layer1.type")) === 255, 8000);
  const layer1 = await dataGet("steps.0.layer1");
  rec("D6 空层保存成功且读回全 0", savedEmpty
    && layer1?.hue === 0 && layer1?.sat === 0 && layer1?.periodMs === 0 && layer1?.level === 0,
    `readback=${JSON.stringify(layer1)} hint=${await dataGet("hint")}`);

  // 重新进入页面，确认读回仍是空层
  await mp.navigateBack().catch(() => {});
  await waitForRoute("pages/control/control");
  await sleep(500);
  await call("onSceneEditorTap");
  const reentered = await waitForRoute("pages/scene/scene");
  const readback = await waitUntil(async () => (await dataGet("steps.length")) > 0, 8000)
    ? await dataGet("steps.0.layer1.type")
    : undefined;
  rec("D7 重新进入仍读回空层", reentered && readback === 255, `readback=${readback}`);
}

console.log(`\n===== ${pass} passed / ${fail} failed =====`);
if (failures.length > 0) {
  console.log("\n失败清单：");
  for (const failure of failures) console.log(`  - ${failure}`);
}
await mp.disconnect().catch(() => {});
process.exit(fail === 0 ? 0 : 1);
