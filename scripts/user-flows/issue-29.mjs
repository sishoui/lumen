#!/usr/bin/env node
/**
 * L4 用户流程（#29）：部位名 / 场景名 UTF-8 字节上限。
 *
 * 流程：重置演示会话 → 连接 → 部位编辑器输入 8 中文（24 字节）提交成功
 * → 重进读回名字一致 → 输入 9 中文（27 字节）提交被拦、提示含 27/24 且
 * 不发 LayoutCommit → 场景编辑器 8 中文保存重进读回 → 9 中文被拦、提示
 * 含具体字节数。
 *
 * 用法：
 *   WS=ws://127.0.0.1:9529 node scripts/user-flows/issue-29.mjs
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

const CJK8 = "一二三四五六七八"; // 24 字节
const CJK9 = "一二三四五六七八九"; // 27 字节

const waitLoadingDone = () =>
  waitFor(async () => (await driver.dataGet("loading")) === false, 12000);
const waitCommitDone = () =>
  waitFor(async () => String(await driver.dataGet("hint") ?? "").includes("提交"), 20000);

const backToControl = async () => {
  await mp.navigateBack().catch(() => {});
  await driver.waitForRoute("pages/control/control");
};

const enterPart = async () => {
  await driver.call("onPartEditorTap", { currentTarget: { dataset: { strip: 0 } } });
  await driver.waitForRoute("pages/part/part");
  const loaded = await waitLoadingDone();
  await sleep(300);
  return loaded;
};

const enterScene = async () => {
  await driver.call("onSceneEditorTap");
  await driver.waitForRoute("pages/scene/scene");
  const loaded = await waitLoadingDone();
  await sleep(300);
  return loaded;
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

  console.log("\n=== §B 部位名 8 中文提交成功并重进读回 ===");
  const entered = await enterPart();
  rec("B0 进入部位编辑器", entered && (await driver.curRoute()) === "pages/part/part",
    `route=${await driver.curRoute()} loading=${await driver.dataGet("loading")}`);

  // 给部位 0 画段 [0,29]，再输入 8 中文（24 字节）。
  await driver.call("onLedTap", { currentTarget: { dataset: { index: 0 } } });
  await sleep(150);
  await driver.call("onLedTap", { currentTarget: { dataset: { index: 29 } } });
  await sleep(300);
  await driver.call("onNameInput", { detail: { value: CJK8 } });
  await sleep(200);
  const byteLabel = String(await driver.dataGet("nameByteLabel") ?? "");
  rec("B1 输入时显示已用字节数「已用 24 / 24 字节」",
    byteLabel.includes("24") && byteLabel.includes("24"),
    `nameByteLabel=${byteLabel}`);

  await driver.call("onCommitTap");
  await waitCommitDone();
  await sleep(500);
  let data = await driver.pageData();
  rec("B2 8 中文（24 字节）提交成功",
    String(data?.hint ?? "").includes("已提交"),
    `hint=${data?.hint}`);

  // 重进读回。
  await backToControl();
  await sleep(400);
  await enterPart();
  data = await driver.pageData();
  const p0 = (data?.parts ?? []).find((p) => p.partId === 0);
  rec("B3 重进读回部位 0 名字与 8 中文一致",
    p0?.name === CJK8,
    `name=${p0?.name}`);

  console.log("\n=== §C 部位名 9 中文（27 字节）被拦，不发 LayoutCommit ===");
  await driver.call("onNameInput", { detail: { value: CJK9 } });
  await sleep(200);
  const overLabel = String(await driver.dataGet("nameByteLabel") ?? "");
  rec("C1 超限输入显示「已用 27 / 24 字节」",
    overLabel.includes("27") && overLabel.includes("24"),
    `nameByteLabel=${overLabel}`);
  const inputHint = String(await driver.dataGet("hint") ?? "");
  rec("C2 输入时提示具体字节数",
    inputHint.includes("27") && inputHint.includes("24"),
    `hint=${inputHint}`);

  await driver.call("onCommitTap");
  await sleep(800);
  data = await driver.pageData();
  const commitHint = String(data?.hint ?? "");
  rec("C3 提交被拦，提示含 27/24 且未发送",
    commitHint.includes("27") && commitHint.includes("24"),
    `hint=${commitHint}`);

  console.log("\n=== §D 场景名 8 中文保存重进读回 ===");
  await backToControl();
  await sleep(400);
  await enterScene();
  rec("D0 进入场景编辑器", (await driver.curRoute()) === "pages/scene/scene",
    `route=${await driver.curRoute()}`);

  await driver.call("onSceneNameInput", { detail: { value: CJK8 } });
  await sleep(200);
  const sceneLabel = String(await driver.dataGet("nameByteLabel") ?? "");
  rec("D1 场景名输入显示「已用 24 / 24 字节」",
    sceneLabel.includes("24") && sceneLabel.includes("24"),
    `nameByteLabel=${sceneLabel}`);

  await driver.call("onSaveSceneName");
  await sleep(800);
  rec("D2 8 中文场景名保存成功",
    String(await driver.dataGet("hint") ?? "").includes("已保存"),
    `hint=${await driver.dataGet("hint")}`);

  await backToControl();
  await sleep(400);
  await enterScene();
  data = await driver.pageData();
  rec("D3 重进读回场景名与 8 中文一致",
    data?.sceneName === CJK8,
    `sceneName=${data?.sceneName}`);

  console.log("\n=== §E 场景名 9 中文（27 字节）被拦，提示具体字节数 ===");
  await driver.call("onSceneNameInput", { detail: { value: CJK9 } });
  await sleep(200);
  const sceneOverLabel = String(await driver.dataGet("nameByteLabel") ?? "");
  rec("E1 超限输入显示「已用 27 / 24 字节」",
    sceneOverLabel.includes("27") && sceneOverLabel.includes("24"),
    `nameByteLabel=${sceneOverLabel}`);

  await driver.call("onSaveSceneName");
  await sleep(800);
  const sceneSaveHint = String(await driver.dataGet("hint") ?? "");
  rec("E2 保存被拦，提示含 27/24",
    sceneSaveHint.includes("27") && sceneSaveHint.includes("24"),
    `hint=${sceneSaveHint}`);
  rec("E3 提示不是笼统的「保存失败：error」",
    !sceneSaveHint.includes("保存失败：error"),
    `hint=${sceneSaveHint}`);
} catch (err) {
  rec(`EXCEPTION ${String(err?.message ?? err)}`, false);
} finally {
  printSummary();
  await mp.disconnect().catch(() => {});
  process.exit(recorder.fail === 0 ? 0 : 1);
}