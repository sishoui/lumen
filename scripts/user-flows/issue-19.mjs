#!/usr/bin/env node
/**
 * L4：演示模式与固件同形（#19）。
 *
 * 断言真实渲染层：演示模式连接后控制页版本为 1.0；帧日志快照非空、每条有
 * commandName、同一 seq 的 TX 出现在 RX 之前。
 *
 * 用法：WS=ws://127.0.0.1:9529 node scripts/user-flows/issue-19.mjs
 * 缺端口 / 缺 automator → 单行 SKIPPED 并 exit 0；断言失败 exit 1。
 */

import { connect, createDriver, createRecorder, resetLogPanel, sleep } from "./harness.mjs";

const conn = await connect();
if (conn.skipped) {
  console.log(`SKIPPED: ${conn.skipped}`);
  process.exit(0);
}

const { mp } = conn;
const driver = createDriver(mp);
const recorder = createRecorder();

try {
  await mp.switchTab("/pages/device/device").catch(() => {});
  await sleep(800);
  await driver.waitForRoute("pages/device/device");

  if ((await driver.dataGet("mockMode")) !== true) {
    await driver.call("onMockModeChange", { detail: { value: true } });
    await sleep(1000);
  }
  const mockMode = await driver.dataGet("mockMode");
  recorder.rec("A1 演示模式已开启", mockMode === true, `mockMode=${mockMode}`);

  const scan = await driver.call("onScanTap");
  const found = await driver.waitFor(
    async () => ((await driver.dataGet("devices.length")) ?? 0) > 0,
    { timeoutMs: 4000 },
  );
  recorder.rec(
    "A2 扫描到虚拟设备",
    found && scan.ok === true,
    scan.error ?? `devices=${await driver.dataGet("devices.length")}`,
  );
  if (!found) throw new Error("扫描不到演示设备，后续步骤无法执行");

  await driver.call("onDeviceTap", { currentTarget: { dataset: { index: 0 } } });
  const onControl = await driver.waitForRoute("pages/control/control", 12000);
  recorder.rec("A3 连接虚拟设备并进入控制页", onControl, `route=${await driver.curRoute()}`);
  if (!onControl) throw new Error("连接后没有进入控制页");

  await driver.waitFor(
    async () => {
      await driver.call("refresh");
      return (await driver.dataGet("firmwareVersion")) === "1.0";
    },
    { timeoutMs: 6000 },
  );
  const version = await driver.dataGet("firmwareVersion");
  recorder.rec("B1 控制页版本显示 v1.0", version === "1.0", `firmwareVersion=${JSON.stringify(version)}`);

  for (let i = 0; i < 6; i += 1) {
    await driver.call("onVersionTap");
    await sleep(120);
  }
  const panelVisible = await driver.waitFor(
    async () => (await driver.dataGet("logVisible")) === true,
    { timeoutMs: 2500 },
  );
  recorder.rec("C1 连点版本号唤出日志面板", panelVisible === true, `logVisible=${await driver.dataGet("logVisible")}`);

  // 复位日志面板：控制页常驻组件，paused 状态可能从上一个脚本残留。
  // 助手确保面板打开、paused=false、entries=[]，并断言起始 paused===false。
  await resetLogPanel(driver, recorder);

  // 触发一条已知命令，避免连接重建的日志被环形缓冲裁掉后
  // 出现「RX 没有对应 TX」的假失败。
  await driver.call("onSelfTestTap");
  await sleep(800);
  recorder.rec("C1b 清空后触发一条自检命令", true, "SelfTest");

  const entries =
    (await driver.waitFor(
      async () => {
        const data = await driver.componentData("#frame-log");
        return data && Array.isArray(data.entries) && data.entries.length > 0 ? data.entries : null;
      },
      { timeoutMs: 4000 },
    )) ?? [];
  recorder.rec("C2 帧日志快照非空", entries.length > 0, `entries=${entries.length}`);

  const unnamed = entries.filter((entry) => !entry.commandName);
  recorder.rec(
    "C3 每条帧都有 commandName",
    entries.length > 0 && unnamed.length === 0,
    unnamed.length > 0
      ? `缺名：${unnamed.map((entry) => `${entry.dir}/${entry.seqText}`).join(", ")}`
      : `全部 ${entries.length} 条都有命令名`,
  );
  recorder.rec(
    "C3b 命令名是语义名（含 SelfTest）",
    entries.some((entry) => entry.commandName === "SelfTest"),
    `names=${entries.map((entry) => entry.commandName).join(",")}`,
  );

  const seenTx = new Set();
  let orderError = "";
  for (const entry of entries) {
    if (entry.dir === "tx") {
      seenTx.add(entry.seqText);
    } else if (entry.dir === "rx" && !seenTx.has(entry.seqText)) {
      orderError = `${entry.seqText} 的 RX 之前没有 TX`;
      break;
    }
  }
  recorder.rec(
    "C4 同一 seq 的 TX 出现在 RX 之前",
    entries.length > 0 && orderError === "",
    orderError || `检查 ${entries.length} 条`,
  );
} catch (err) {
  recorder.rec("执行中断", false, String(err?.message ?? err));
} finally {
  recorder.printSummary();
  await mp.disconnect().catch(() => {});
}

process.exit(recorder.fail === 0 ? 0 : 1);
