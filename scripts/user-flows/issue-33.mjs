#!/usr/bin/env node
/**
 * L4 用户流程（#33）：演示模式连接 → 控制页可用 → 切真实模式（不扫真机）
 * → 切回演示模式 → 重新扫描连接 → 控制页仍可用。
 *
 * 只通过页面事件方法与页面 data 驱动/断言，走真实页面 + session + MockTransport。
 * 开头 off→on 重建演示会话，让脚本连续跑两次结果一致（新的 MockTransport 与
 * 设备运行时都不会带上一次写入）。
 *
 * 用法：
 *   WS=ws://127.0.0.1:9529 node scripts/user-flows/issue-33.mjs
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
const rec = createRecorder();
const { call, dataGet, switchTab, waitForRoute, curRoute } = driver;

const waitForPower = async (expected) =>
  Boolean(await driver.waitFor(async () => (await dataGet("state.power")) === expected, { timeoutMs: 5000 }));

async function main() {
  console.log("\n=== §A 重置演示会话并连接 ===");
  await switchTab("/pages/device/device");
  await sleep(800);
  rec("A0 设备页加载", (await curRoute()) === "pages/device/device", `route=${await curRoute()}`);

  // off→on 让页面按新偏好重建会话：MockTransport 与设备运行时都是新实例。
  await call("onMockModeChange", { detail: { value: false } });
  await sleep(800);
  await call("onMockModeChange", { detail: { value: true } });
  await sleep(1200);

  const mockMode = await dataGet("mockMode");
  rec("A1 演示模式开启", mockMode === true, `mockMode=${mockMode}`);
  const devicesAfterReset = await dataGet("devices.length");
  rec("A2 切换后设备列表为空", devicesAfterReset === 0, `devices=${devicesAfterReset}`);

  await call("onScanTap");
  const scanned = await driver.waitFor(async () => (await dataGet("devices.length")) > 0, { timeoutMs: 6000 });
  const deviceCount = await dataGet("devices.length");
  rec("A3 演示模式扫描出设备", Boolean(scanned), `devices=${deviceCount}`);
  const firstDeviceId = await dataGet("devices.0.deviceId");

  await call("onDeviceTap", { currentTarget: { dataset: { index: 0 } } });
  const enteredControl = await waitForRoute("pages/control/control", 12000);
  rec("A4 连接后进入控制页", enteredControl, `route=${await curRoute()}`);
  await sleep(1200);

  console.log("\n=== §B 控制页可用 ===");
  const power = await dataGet("state.power");
  rec("B0 控制页读到设备状态", typeof power === "number", `power=${power}`);
  await call("onPowerChange", { detail: { value: false } });
  const turnedOff = await waitForPower(0);
  rec("B1 开关生效（关）", turnedOff, `power=${await dataGet("state.power")}`);

  console.log("\n=== §C 切换到真实模式（不扫真机） ===");
  await switchTab("/pages/device/device");
  await sleep(600);
  await call("onMockModeChange", { detail: { value: false } });
  await sleep(1000);

  const realMode = await dataGet("mockMode");
  rec("C0 已切到真实模式", realMode === false, `mockMode=${realMode}`);
  const devicesInRealMode = await dataGet("devices.length");
  rec("C1 设备列表被清空", devicesInRealMode === 0, `devices=${devicesInRealMode}`);
  const realLinkState = await dataGet("linkState");
  rec("C2 真实模式未连接（没有自动扫真机）", realLinkState === "idle", `linkState=${realLinkState}`);

  console.log("\n=== §D 切回演示模式并重新扫描连接 ===");
  await call("onMockModeChange", { detail: { value: true } });
  await sleep(1200);
  const backToMock = await dataGet("mockMode");
  rec("D0 切回演示模式", backToMock === true, `mockMode=${backToMock}`);
  const clearedList = await dataGet("devices.length");
  rec("D1 旧设备列表已清空（待重建）", clearedList === 0, `devices=${clearedList}`);

  await call("onScanTap");
  const rescanned = await driver.waitFor(async () => (await dataGet("devices.length")) > 0, { timeoutMs: 6000 });
  const rebuiltCount = await dataGet("devices.length");
  rec("D2 重新扫描成功（列表重建）", Boolean(rescanned), `devices=${rebuiltCount}`);
  const secondDeviceId = await dataGet("devices.0.deviceId");
  rec("D3 扫描到同一台演示设备", secondDeviceId === firstDeviceId, `期望 ${firstDeviceId}，实际 ${secondDeviceId}`);

  await call("onDeviceTap", { currentTarget: { dataset: { index: 0 } } });
  const enteredAgain = await waitForRoute("pages/control/control", 12000);
  rec("D4 重新连接进入控制页", enteredAgain, `route=${await curRoute()}`);
  await sleep(1500);

  const freshPower = await dataGet("state.power");
  rec("D5 新会话是设备默认状态（旧状态没串过来）", freshPower === 1, `期望 1，实际 ${freshPower}`);
  await call("onPowerChange", { detail: { value: false } });
  const stillWorks = await waitForPower(0);
  rec("D6 切换后控制页开关仍生效", stillWorks, `power=${await dataGet("state.power")}`);
}

try {
  await main();
} catch (error) {
  rec(`EXCEPTION ${String(error?.message ?? error)}`, false);
} finally {
  rec.printSummary();
  await mp.disconnect().catch(() => {});
  process.exit(rec.fail === 0 ? 0 : 1);
}
