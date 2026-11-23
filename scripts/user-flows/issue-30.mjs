#!/usr/bin/env node
/**
 * L4 用户流程（#30）：场景选择与激活。
 *
 * 演示连接 → 控制页 3 个场景卡且场景 1 高亮 → 选场景 2 → 编辑（sceneId=2、名字加载）
 * → 保存场景名「场景二」+ 一步 → 返回激活场景 2（State.activeScene=2、高亮移动）
 * → 重进编辑器读回场景二 → 编辑器顶部切回场景 1 读回其名字/时间轴。
 *
 * 只通过页面事件方法与页面 data 驱动/断言，走真实页面 + session + MockTransport。
 * 开头 off→on 重建演示会话，让脚本连续跑两次结果一致。
 *
 * 用法：
 *   WS=ws://127.0.0.1:9529 node scripts/user-flows/issue-30.mjs
 *
 * 退出码：0 全过或 SKIPPED；1 有失败。
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
const { call, dataGet, switchTab, waitForRoute, curRoute } = driver;

/** 等待页面某个 data 路径满足条件；返回最后一次值。 */
const waitForData = async (path, predicate, timeoutMs = 8000) =>
  driver.waitFor(async () => {
    const value = await dataGet(path);
    return predicate(value) ? value : false;
  }, { timeoutMs });

const goControl = async () => {
  await switchTab("/pages/control/control");
  await sleep(600);
};

async function main() {
  console.log("\n=== §A 重置演示会话并连接 ===");
  await switchTab("/pages/device/device");
  await sleep(800);
  rec("A0 设备页加载", (await curRoute()) === "pages/device/device", `route=${await curRoute()}`);

  // off→on 重建演示会话：新的 MockTransport 与设备运行时，上一轮写入不串。
  await call("onMockModeChange", { detail: { value: false } });
  await sleep(800);
  await call("onMockModeChange", { detail: { value: true } });
  await sleep(1200);
  rec("A1 演示模式开", (await dataGet("mockMode")) === true, `mockMode=${await dataGet("mockMode")}`);

  await call("onScanTap");
  await sleep(1500);
  const deviceCount = await dataGet("devices.length");
  rec("A2 扫描出设备", deviceCount > 0, `devices=${deviceCount}`);

  await call("onDeviceTap", { currentTarget: { dataset: { index: 0 } } });
  const enteredControl = await waitForRoute("pages/control/control", 12000);
  rec("A3 连接后进入控制页", enteredControl, `route=${await curRoute()}`);
  await sleep(1500);

  console.log("\n=== §B 控制页场景卡与高亮 ===");
  const cards = await dataGet("sceneOptions");
  rec(
    "B0 场景卡数量 = maxScenes（3）",
    Array.isArray(cards) && cards.length === 3,
    `期望 3，实际 ${Array.isArray(cards) ? cards.length : cards}`,
  );
  rec(
    "B1 场景卡文案 1/2/3",
    Array.isArray(cards) && cards.map((c) => c.label).join(",") === "场景 1,场景 2,场景 3",
    `实际 ${JSON.stringify((cards ?? []).map((c) => c.label))}`,
  );
  const activeCard = Array.isArray(cards) ? cards.find((c) => c.cls === "active" || c.cls === "selected") : null;
  rec(
    "B2 初始激活场景是 1 且高亮",
    (await dataGet("activeSceneId")) === 0 && activeCard?.id === 0,
    `activeSceneId=${await dataGet("activeSceneId")}，高亮卡片 ${JSON.stringify(activeCard)}`,
  );

  console.log("\n=== §C 选场景 2 → 编辑 → 保存名字与步骤 ===");
  await call("onSceneSelectTap", { currentTarget: { dataset: { scene: 1 } } });
  await sleep(300);
  rec(
    "C0 选中场景 2（不触发激活）",
    (await dataGet("selectedSceneId")) === 1 && (await dataGet("activeSceneId")) === 0,
    `selected=${await dataGet("selectedSceneId")}，active=${await dataGet("activeSceneId")}`,
  );

  await call("onSceneEditorTap");
  await sleep(1500);
  await waitForRoute("pages/scene/scene");
  await sleep(2000);
  await waitForData("loading", (v) => v === false, 12000);

  rec(
    "C1 编辑器打开的是场景 2",
    (await dataGet("sceneId")) === 1,
    `sceneId=${await dataGet("sceneId")}`,
  );
  rec(
    "C2 顶部选择器 3 项且选中下标 = 1",
    Array.isArray(await dataGet("sceneOptions")) &&
      (await dataGet("sceneOptions.length")) === 3 &&
      (await dataGet("selectedSceneIndex")) === 1,
    `sceneOptions=${await dataGet("sceneOptions.length")}，selectedSceneIndex=${await dataGet("selectedSceneIndex")}`,
  );
  rec("C3 场景名加载非报错", typeof (await dataGet("sceneName")) === "string", `sceneName=${await dataGet("sceneName")}`);

  // 保存场景名「场景二」
  await call("onSceneNameInput", { detail: { value: "场景二" } });
  await call("onSaveSceneName");
  await sleep(800);
  rec(
    "C4 场景名保存反馈",
    String(await dataGet("hint") ?? "").includes("已保存"),
    `hint=${await dataGet("hint")}`,
  );

  // 加一步并保存
  await call("onAddStep");
  await sleep(1000);
  rec("C5 添加 1 步", (await dataGet("steps.length")) === 1, `steps=${await dataGet("steps.length")}`);
  await call("onDurationInput", { detail: { value: "3000" } });
  await call("onLayer0HueInput", { detail: { value: "200" } });
  await call("onLayer0LevelInput", { detail: { value: "70" } });
  await call("onSaveStep");
  await sleep(1200);
  rec(
    "C6 步骤时长落库",
    (await dataGet("steps.0.durationMs")) === 3000,
    `steps[0].durationMs=${await dataGet("steps.0.durationMs")}`,
  );

  console.log("\n=== §D 返回控制页激活场景 2 ===");
  await mp.navigateBack().catch(() => {});
  await sleep(1000);
  await goControl();
  await sleep(800);

  await call("onActivateSceneTap");
  const activated = await waitForData("activeSceneId", (v) => v === 1, 6000);
  rec("D0 激活场景 2 后高亮移到场景 2", activated === 1, `activeSceneId=${await dataGet("activeSceneId")}`);
  rec(
    "D1 State.activeScene=2（1 基显示）",
    (await dataGet("state.activeScene")) === 1,
    `state.activeScene=${await dataGet("state.activeScene")}`,
  );

  console.log("\n=== §E 重进编辑器读回场景二 ===");
  await call("onSceneEditorTap");
  await sleep(1500);
  await waitForRoute("pages/scene/scene");
  await sleep(2000);
  await waitForData("loading", (v) => v === false, 12000);

  rec(
    "E0 场景 2 名字读回「场景二」",
    (await dataGet("sceneName")) === "场景二",
    `期望「场景二」，实际「${await dataGet("sceneName")}」`,
  );
  rec(
    "E1 场景 2 步骤读回 [3000]",
    (await dataGet("steps.length")) === 1 && (await dataGet("steps.0.durationMs")) === 3000,
    `steps=${await dataGet("steps.length")}，dur=${await dataGet("steps.0.durationMs")}`,
  );

  console.log("\n=== §F 编辑器顶部切回场景 1 ===");
  await call("onSceneSwitch", { detail: { value: 0 } });
  await sleep(2000);
  await waitForData("loading", (v) => v === false, 12000);

  rec(
    "F0 顶部切回场景 1",
    (await dataGet("sceneId")) === 0 && (await dataGet("selectedSceneIndex")) === 0,
    `sceneId=${await dataGet("sceneId")}，selectedSceneIndex=${await dataGet("selectedSceneIndex")}`,
  );
  rec(
    "F1 场景 1 时间轴未被场景 2 污染",
    (await dataGet("steps.length")) === 0,
    `steps=${await dataGet("steps.length")}`,
  );
  rec(
    "F2 场景 1 名字不是「场景二」",
    (await dataGet("sceneName")) !== "场景二",
    `sceneName=${await dataGet("sceneName")}`,
  );
  const backActive = await dataGet("activeStepIndex");
  rec("F3 切换后 activeStepIndex 归 0", backActive === 0, `activeStepIndex=${backActive}`);
}

try {
  await main();
} catch (error) {
  rec(`EXCEPTION ${String(error?.message ?? error)}`, false);
} finally {
  recorder.printSummary();
  await mp.disconnect().catch(() => {});
  process.exit(recorder.fail === 0 ? 0 : 1);
}