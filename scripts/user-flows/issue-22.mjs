#!/usr/bin/env node
/**
 * 工单 #22 用户流程（L4）：场景时间轴加/删步重写、选中保持、循环不动步骤。
 *
 * 流程：重置演示会话 → 连接 → 场景编辑器 → 1 步 3000ms 保存 → 加第 2 步
 * → 读回 [3000,1000] 且新步自动选中 → 保存后仍停在第 2 步 → 删除末步读回
 * [3000] → 切换循环步骤不变 → 返回再进读回一致。
 *
 * 用法：
 *   WS=ws://127.0.0.1:9529 node scripts/user-flows/issue-22.mjs
 *
 * 退出码：0 全过或 SKIPPED；1 有失败。缺自动化端口/automator 时打印
 * 单行 `SKIPPED: <原因>` 并 exit 0。
 */

import { connect, createDriver, createRecorder, sleep } from "./harness.mjs";

const conn = await connect();
if (conn.skipped) {
  console.log(`SKIPPED: ${conn.skipped}`);
  process.exit(0);
}

const { mp } = conn;
const driver = createDriver(mp);
const recorder = createRecorder();
const { rec, printSummary } = recorder;

const waitFor = (check, timeoutMs = 8000) =>
  driver.waitFor(check, { timeoutMs, intervalMs: 150 });

const stepsCount = () => driver.dataGet("steps.length");

/** 时间轴快照：只取用户可见的时长与底层灯效。 */
const timeline = async () => {
  const raw = await driver.dataGet("steps");
  if (!Array.isArray(raw)) return [];
  return raw.map((s) => ({
    durationMs: s.durationMs,
    hue: s.layer0?.hue,
    level: s.layer0?.level,
    layer1Type: s.layer1?.type,
  }));
};

const durations = async () => (await timeline()).map((s) => s.durationMs);

/** 场景头可能是上一个脚本留下的；逐步删空，保证可连续跑两次。 */
const deleteAllSteps = async () => {
  for (let guard = 0; guard < 20; guard += 1) {
    const before = await stepsCount();
    if (before === 0) return true;
    await driver.call("onDeleteLastStep");
    const shrank = await waitFor(async () => (await stepsCount()) === before - 1, 6000);
    if (!shrank) return false;
  }
  return (await stepsCount()) === 0;
};

const goControl = async () => {
  await driver.switchTab("/pages/control/control");
  await driver.waitForRoute("pages/control/control");
};

const enterScene = async () => {
  await sleep(400);
  await driver.call("onSceneEditorTap");
  await driver.waitForRoute("pages/scene/scene");
  const loaded = await waitFor(async () => (await driver.dataGet("loading")) === false, 12000);
  await sleep(400);
  return loaded;
};

const saveStep = async ({ durationMs, hue, level }) => {
  if (durationMs !== undefined) {
    await driver.call("onDurationInput", { detail: { value: String(durationMs) } });
  }
  if (hue !== undefined) {
    await driver.call("onLayer0HueInput", { detail: { value: String(hue) } });
  }
  if (level !== undefined) {
    await driver.call("onLayer0LevelInput", { detail: { value: String(level) } });
  }
  await driver.call("onSaveStep");
  return waitFor(async () => String(await driver.dataGet("hint") ?? "").includes("已保存"));
};

try {
  console.log("\n=== §A 重置演示会话并连接 ===");
  await driver.switchTab("/pages/device/device");
  await driver.waitForRoute("pages/device/device");

  // off→on 重建会话：MockTransport 与设备运行时都是新实例，上一轮写入清空。
  await driver.call("onMockModeChange", { detail: { value: false } });
  await sleep(800);
  await driver.call("onMockModeChange", { detail: { value: true } });
  await sleep(1200);
  rec("A1 演示模式开", (await driver.dataGet("mockMode")) === true,
    `mockMode=${await driver.dataGet("mockMode")}`);

  await driver.call("onScanTap");
  await sleep(1500);
  const deviceCount = await driver.dataGet("devices.length");
  rec("A2 扫描出设备", deviceCount > 0, `devices=${deviceCount}`);

  await driver.call("onDeviceTap", { currentTarget: { dataset: { index: 0 } } });
  await sleep(2500);
  rec("A3 连接后进入控制页", (await driver.curRoute()) === "pages/control/control",
    `route=${await driver.curRoute()}`);

  console.log("\n=== §B 造 1 步 3000ms ===");
  const loaded = await enterScene();
  rec("B0 场景编辑器加载", loaded, `loading=${await driver.dataGet("loading")}`);
  const cleared = await deleteAllSteps();
  rec("B1 时间轴已清零", cleared && (await stepsCount()) === 0, `steps=${await stepsCount()}`);
  const partCount = await driver.dataGet("parts.length");
  rec("B2 部位列表非空", partCount > 0, `parts=${partCount}`);

  await driver.call("onAddStep");
  const added1 = await waitFor(async () => (await stepsCount()) === 1);
  rec("B3 添加第 1 步", added1, `steps=${await stepsCount()}`);
  const saved1 = await saveStep({ durationMs: 3000, hue: 120, level: 80 });
  const afterFirst = await timeline();
  rec("B4 第 1 步 3000ms 保存并读回",
    saved1 && afterFirst[0]?.durationMs === 3000 && afterFirst[0]?.hue === 120 && afterFirst[0]?.level === 80,
    `期望 3000/hue120/level80，实际 ${JSON.stringify(afterFirst[0])} hint=${await driver.dataGet("hint")}`);

  console.log("\n=== §C 添加第 2 步：重写 0..1 并自动选中 ===");
  await driver.call("onAddStep");
  const added2 = await waitFor(async () => (await stepsCount()) === 2);
  rec("C1 添加第 2 步", added2, `steps=${await stepsCount()}`);
  const afterAdd = await timeline();
  rec("C2 读回时长为 [3000,1000]",
    JSON.stringify(afterAdd.map((s) => s.durationMs)) === JSON.stringify([3000, 1000]),
    `期望 [3000,1000]，实际 ${JSON.stringify(afterAdd.map((s) => s.durationMs))}`);
  rec("C3 第 1 步灯效未被清零",
    afterAdd[0]?.hue === 120 && afterAdd[0]?.level === 80 && afterAdd[0]?.layer1Type === 0xff,
    `实际 ${JSON.stringify(afterAdd[0])}`);
  rec("C4 新步自动选中",
    (await driver.dataGet("activeStepIndex")) === 1 && (await driver.dataGet("durationMs")) === 1000,
    `activeStepIndex=${await driver.dataGet("activeStepIndex")} editor.durationMs=${await driver.dataGet("durationMs")}`);

  const saved2 = await saveStep({});
  rec("C5 保存第 2 步后仍停在第 2 步",
    saved2 && (await driver.dataGet("activeStepIndex")) === 1,
    `activeStepIndex=${await driver.dataGet("activeStepIndex")} hint=${await driver.dataGet("hint")}`);
  rec("C6 保存后时长仍为 [3000,1000]",
    JSON.stringify(await durations()) === JSON.stringify([3000, 1000]),
    `实际 ${JSON.stringify(await durations())}`);

  console.log("\n=== §D 删除末步：剩余步骤保留 ===");
  await driver.call("onDeleteLastStep");
  const deleted = await waitFor(async () => (await stepsCount()) === 1);
  const afterDelete = await timeline();
  rec("D1 删除末步后读回 [3000]",
    deleted && JSON.stringify(afterDelete.map((s) => s.durationMs)) === JSON.stringify([3000]),
    `期望 [3000]，实际 ${JSON.stringify(afterDelete.map((s) => s.durationMs))}`);
  rec("D2 剩余步骤灯效不变",
    afterDelete[0]?.hue === 120 && afterDelete[0]?.level === 80,
    `实际 ${JSON.stringify(afterDelete[0])}`);
  rec("D3 选中下标夹到剩余范围",
    (await driver.dataGet("activeStepIndex")) === 0,
    `activeStepIndex=${await driver.dataGet("activeStepIndex")}`);

  console.log("\n=== §E 切换循环：不动任何步骤 ===");
  await driver.call("onLoopChange", { detail: { value: 0 } });
  const loopChanged = await waitFor(async () => (await driver.dataGet("loop")) === 0);
  const afterLoop = await timeline();
  rec("E1 循环模式更新为不循环", loopChanged, `loop=${await driver.dataGet("loop")} hint=${await driver.dataGet("hint")}`);
  rec("E2 切换循环后步骤时长与灯效不变",
    JSON.stringify(afterLoop) === JSON.stringify(afterDelete),
    `切换前 ${JSON.stringify(afterDelete)}，切换后 ${JSON.stringify(afterLoop)}`);

  console.log("\n=== §F 返回再进入：读回一致 ===");
  await mp.navigateBack().catch(() => {});
  await sleep(1000);
  await goControl();
  const reloaded = await enterScene();
  const afterReenter = await timeline();
  rec("F0 重新进入场景编辑器", reloaded, `loading=${await driver.dataGet("loading")}`);
  rec("F1 重新进入后读回 [3000]",
    JSON.stringify(afterReenter.map((s) => s.durationMs)) === JSON.stringify([3000]),
    `期望 [3000]，实际 ${JSON.stringify(afterReenter.map((s) => s.durationMs))}`);
  rec("F2 重新进入后灯效一致",
    afterReenter[0]?.hue === 120 && afterReenter[0]?.level === 80,
    `实际 ${JSON.stringify(afterReenter[0])}`);
  rec("F3 重新进入后循环模式一致",
    (await driver.dataGet("loop")) === 0,
    `loop=${await driver.dataGet("loop")}`);
} catch (err) {
  rec(`EXCEPTION ${String(err?.message ?? err)}`, false);
} finally {
  printSummary();
  await mp.disconnect().catch(() => {});
  process.exit(recorder.fail === 0 ? 0 : 1);
}
