#!/usr/bin/env node
/**
 * L4 用户流程（#28）：灯效参数发送前校验 + 类型切换归一化。
 *
 * 流程：重置演示会话 → 连接 → 场景编辑器造一步 → layer0 level 101 保存
 * → 提示含亮度/100 且步骤未被改写 → 心跳周期 200 保存 → 提示含 500–1500
 * → 呼吸→静态保存读回 period=0 → 熄灭保存读回 hue/sat/period 全 0
 * → 叠加层空层保存读回 0xFF 全 0。
 *
 * 用法：
 *   WS=ws://127.0.0.1:9529 node scripts/user-flows/issue-28.mjs
 *
 * 退出码：0 全过或 SKIPPED；1 有失败。缺端口/automator 打印 SKIPPED exit 0。
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
const rec = recorder.rec;
const { printSummary } = recorder;

const waitFor = (check, timeoutMs = 8000) =>
  driver.waitFor(check, { timeoutMs, intervalMs: 150 });

const stepsCount = () => driver.dataGet("steps.length");

/** 当前步骤列表快照：时长 + 两层 type + 关键字段。 */
const timeline = async () => {
  const raw = await driver.dataGet("steps");
  if (!Array.isArray(raw)) return [];
  return raw.map((s) => ({
    durationMs: s.durationMs,
    l0Type: s.layer0?.type,
    l0Hue: s.layer0?.hue,
    l0Sat: s.layer0?.sat,
    l0Period: s.layer0?.periodMs,
    l0Level: s.layer0?.level,
    l1Type: s.layer1?.type,
    l1Hue: s.layer1?.hue,
    l1Period: s.layer1?.periodMs,
    l1Level: s.layer1?.level,
  }));
};

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

/** 保存后等待 hint 出现任意文本变化；返回最终 hint。 */
const saveAndReadHint = async () => {
  await driver.call("onSaveStep");
  await sleep(500);
  return String(await driver.dataGet("hint") ?? "");
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

  console.log("\n=== §B 造一步干净基线 ===");
  const loaded = await enterScene();
  rec("B0 场景编辑器加载", loaded, `loading=${await driver.dataGet("loading")}`);
  const cleared = await deleteAllSteps();
  rec("B1 时间轴已清零", cleared && (await stepsCount()) === 0, `steps=${await stepsCount()}`);

  await driver.call("onAddStep");
  const added = await waitFor(async () => (await stepsCount()) === 1);
  rec("B2 添加第 1 步", added, `steps=${await stepsCount()}`);
  // 先存一个合法基线（静态 1000ms），后续非法保存不得改写它。
  await driver.call("onLayer0TypeChange", { detail: { value: 0 } });
  await driver.call("onLayer0HueInput", { detail: { value: "500" } });
  await driver.call("onLayer0SatInput", { detail: { value: "255" } });
  await driver.call("onLayer0LevelInput", { detail: { value: "80" } });
  await saveAndReadHint();
  await waitFor(async () => String(await driver.dataGet("hint") ?? "").includes("已保存"));
  const baseline = await timeline();
  rec("B3 基线步骤静态 80 亮度保存成功",
    baseline[0]?.l0Type === 0x00 && baseline[0]?.l0Level === 80,
    `实际 ${JSON.stringify(baseline[0])}`);

  console.log("\n=== §C level 101 被拦截，步骤不被改写 ===");
  await driver.call("onLayer0TypeChange", { detail: { value: 0 } });
  await driver.call("onLayer0LevelInput", { detail: { value: "101" } });
  const hintLevel = await saveAndReadHint();
  const afterLevel = await timeline();
  rec("C1 level 101 提示含亮度/100",
    hintLevel.includes("亮度") && hintLevel.includes("100"),
    `hint=${hintLevel}`);
  rec("C2 level 101 未发送：步骤读回仍是 80 亮度",
    afterLevel[0]?.l0Level === 80 && afterLevel[0]?.l0Hue === 500,
    `实际 ${JSON.stringify(afterLevel[0])}`);
  // 字段错误内联展示非空
  const fieldErrors = await driver.dataGet("layerErrors");
  rec("C3 字段级错误内联展示非空",
    Array.isArray(fieldErrors) && fieldErrors.length > 0,
    `layerErrors=${JSON.stringify(fieldErrors)}`);

  console.log("\n=== §D 心跳周期 200 被拦截，提示 500–1500 ===");
  await driver.call("onLayer0LevelInput", { detail: { value: "80" } });
  await driver.call("onLayer0TypeChange", { detail: { value: 5 } }); // 心跳
  await driver.call("onLayer0PeriodInput", { detail: { value: "200" } });
  const hintPeriod = await saveAndReadHint();
  rec("D1 心跳周期 200 提示含 500–1500",
    hintPeriod.includes("500–1500") || (hintPeriod.includes("500") && hintPeriod.includes("1500")),
    `hint=${hintPeriod}`);

  console.log("\n=== §E 呼吸→静态保存，读回 period=0 ===");
  // 先切呼吸并给合法周期，再切静态：静态应把 period 清 0。
  await driver.call("onLayer0TypeChange", { detail: { value: 1 } }); // 呼吸
  await driver.call("onLayer0PeriodInput", { detail: { value: "1000" } });
  await driver.call("onLayer0TypeChange", { detail: { value: 0 } }); // 静态
  const hintStatic = await saveAndReadHint();
  await waitFor(async () => String(await driver.dataGet("hint") ?? "").includes("已保存"), 6000);
  const afterStatic = await timeline();
  rec("E1 呼吸→静态保存成功",
    hintStatic.includes("已保存") || (await driver.dataGet("hint"))?.includes("已保存"),
    `hint=${await driver.dataGet("hint")}`);
  rec("E2 读回静态 period=0",
    afterStatic[0]?.l0Type === 0x00 && afterStatic[0]?.l0Period === 0,
    `实际 ${JSON.stringify(afterStatic[0])}`);

  console.log("\n=== §F 熄灭保存，读回 hue/sat/period 全 0 ===");
  // 熄灭的 hue/sat 输入是隐藏的，真实用户碰不到；先填入颜色再切熄灭，
  // 验证类型切换会把不适用参数清零，保存后读回全 0。
  await driver.call("onLayer0HueInput", { detail: { value: "300" } });
  await driver.call("onLayer0SatInput", { detail: { value: "200" } });
  await driver.call("onLayer0TypeChange", { detail: { value: 6 } }); // 熄灭
  const hintOff = await saveAndReadHint();
  await waitFor(async () => String(await driver.dataGet("hint") ?? "").includes("已保存"), 6000);
  const afterOff = await timeline();
  rec("F1 熄灭保存成功",
    hintOff.includes("已保存") || (await driver.dataGet("hint"))?.includes("已保存"),
    `hint=${await driver.dataGet("hint")}`);
  rec("F2 读回熄灭 hue/sat/period 全 0",
    afterOff[0]?.l0Type === 0x06 && afterOff[0]?.l0Hue === 0 && afterOff[0]?.l0Sat === 0 && afterOff[0]?.l0Period === 0,
    `实际 ${JSON.stringify(afterOff[0])}`);

  console.log("\n=== §G 叠加层空层保存，读回 0xFF 全 0 ===");
  // 底层先回到静态，再叠加层切到空层。
  await driver.call("onLayer0TypeChange", { detail: { value: 0 } }); // 静态
  await driver.call("onLayer0HueInput", { detail: { value: "500" } });
  await driver.call("onLayer0LevelInput", { detail: { value: "100" } });
  await driver.call("onLayer1TypeChange", { detail: { value: 8 } }); // 叠加层空层（选项最后一项）
  const hintEmpty = await saveAndReadHint();
  await waitFor(async () => String(await driver.dataGet("hint") ?? "").includes("已保存"), 6000);
  const afterEmpty = await timeline();
  rec("G1 叠加层空层保存成功",
    hintEmpty.includes("已保存") || (await driver.dataGet("hint"))?.includes("已保存"),
    `hint=${await driver.dataGet("hint")}`);
  rec("G2 读回叠加层 0xFF 且 hue/period/level 全 0",
    afterEmpty[0]?.l1Type === 0xff && afterEmpty[0]?.l1Hue === 0 &&
      afterEmpty[0]?.l1Period === 0 && afterEmpty[0]?.l1Level === 0,
    `实际 ${JSON.stringify(afterEmpty[0])}`);
} catch (err) {
  rec(`EXCEPTION ${String(err?.message ?? err)}`, false);
} finally {
  printSummary();
  await mp.disconnect().catch(() => {});
  process.exit(recorder.fail === 0 ? 0 : 1);
}