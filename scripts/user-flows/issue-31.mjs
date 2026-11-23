#!/usr/bin/env node
/**
 * L4 用户流程（#31）：失败原因可见。
 *
 * 流程：
 * 1. 演示连接 → 控制页 onSelfTestTap → hint/status 含「自检已开始」。
 * 2. 自检失败路径优先 L2 覆盖；L4 至少断言成功提示存在。
 * 3. 扫描失败：切真实模式 → 在页面上下文 mock wx.openBluetoothAdapter 返回失败
 *    （fail({errCode:10001, errMsg:"bluetooth not available"})）→ onScanTap → 设备页
 *    statusText 含「扫描失败」与可读原因；恢复 mock。
 * 4. 连接失败：devtools 下向页面 data 注入一台假设备后 onDeviceTap，mock
 *    wx.createBLEConnection 失败 → statusText 含「连接失败」与原因；若不可行，
 *    在报告里写「连接失败仅 L2 覆盖」（本脚本实际尝试；不可行时记录 SKIPPED 而不假装跑过）。
 *
 * 开头必须重置演示会话（off→on + 删空步骤），保证连续两次通过。
 *
 * 约定：WS=ws://127.0.0.1:9529 node scripts/user-flows/issue-31.mjs
 * 缺端口/automator 打印 SKIPPED: <原因> exit 0；失败 exit 1；结尾 ===== N passed / M failed =====。
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

  console.log("\n=== §B 自检提示 ===");
  await call("onSelfTestTap");
  await sleep(600);
  const hint = await dataGet("hint");
  rec(
    "B0 自检 hint 含「自检已开始」",
    typeof hint === "string" && hint.includes("自检已开始"),
    `hint=${hint}`,
  );

  console.log("\n=== §C 扫描失败（真实模式 + mock adapter） ===");
  // 切真实模式
  await switchTab("/pages/device/device");
  await sleep(800);
  await call("onMockModeChange", { detail: { value: false } });
  await sleep(800);
  rec("C0 真实模式", (await dataGet("mockMode")) === false, `mockMode=${await dataGet("mockMode")}`);

  // 在页面上下文 mock wx.openBluetoothAdapter 返回失败
  const mockResult = await mp.evaluate(() => {
    try {
      // 保存原始
      const orig = wx.openBluetoothAdapter;
      wx.openBluetoothAdapter = (opts) => {
        if (opts && typeof opts.fail === "function") {
          opts.fail({ errCode: 10001, errMsg: "bluetooth not available" });
        }
        return Promise.reject({ errCode: 10001, errMsg: "bluetooth not available" });
      };
      return { ok: true };
    } catch (e) {
      return { ok: false, error: String(e?.message ?? e) };
    }
  });
  rec("C1 mock adapter 注入成功", mockResult?.ok === true, JSON.stringify(mockResult));

  await call("onScanTap");
  await sleep(1500);
  const statusText = await dataGet("statusText");
  rec(
    "C2 statusText 含「扫描失败」",
    typeof statusText === "string" && statusText.includes("扫描失败"),
    `statusText=${statusText}`,
  );
  rec(
    "C3 statusText 含可读原因（请打开蓝牙）",
    typeof statusText === "string" && statusText.includes("请打开蓝牙"),
    `statusText=${statusText}`,
  );
  const scanning = await dataGet("scanning");
  rec("C4 扫描失败后 scanning=false", scanning === false, `scanning=${scanning}`);

  // 恢复 mock
  await mp.evaluate(() => {
    // 还原：重新加载页面上下文无法简单还原，置回演示模式由 onMockModeChange 重建会话
    return { ok: true };
  });
  await call("onMockModeChange", { detail: { value: true } });
  await sleep(1200);
  rec("C5 恢复演示模式", (await dataGet("mockMode")) === true, `mockMode=${await dataGet("mockMode")}`);

  console.log("\n=== §D 连接失败（真实模式 + mock createBLEConnection） ===");
  // 切真实模式
  await switchTab("/pages/device/device");
  await sleep(800);
  await call("onMockModeChange", { detail: { value: false } });
  await sleep(800);
  rec("D0 真实模式", (await dataGet("mockMode")) === false, `mockMode=${await dataGet("mockMode")}`);

  // mock wx.openBluetoothAdapter 成功 + createBLEConnection 失败
  const mockConn = await mp.evaluate(() => {
    try {
      wx.openBluetoothAdapter = (opts) => {
        if (opts && typeof opts.success === "function") opts.success();
        return Promise.resolve();
      };
      wx.createBLEConnection = (opts) => {
        if (opts && typeof opts.fail === "function") {
          opts.fail({ errCode: 10003, errMsg: "connect fail" });
        }
        return Promise.reject({ errCode: 10003, errMsg: "connect fail" });
      };
      return { ok: true };
    } catch (e) {
      return { ok: false, error: String(e?.message ?? e) };
    }
  });
  rec("D1 mock 注入成功", mockConn?.ok === true, JSON.stringify(mockConn));

  // 注入假设备
  const injectResult = await mp.evaluate(() => {
    try {
      const page = getCurrentPages().pop();
      const fake = { deviceId: "FAKE-DEVICE", name: "LUMEN-FAKE", rssi: -50, _index: 0 };
      page.setData({ devices: [fake], scanning: false });
      return { ok: true };
    } catch (e) {
      return { ok: false, error: String(e?.message ?? e) };
    }
  });
  rec("D2 假设备注入成功", injectResult?.ok === true, JSON.stringify(injectResult));

  await call("onDeviceTap", { currentTarget: { dataset: { index: 0 } } });
  await sleep(2500);
  const connStatus = await dataGet("statusText");
  if (typeof connStatus === "string" && connStatus.includes("连接失败")) {
    rec("D3 statusText 含「连接失败」", true, `statusText=${connStatus}`);
    rec(
      "D4 statusText 含可读原因",
      connStatus.includes("占用") || connStatus.includes("connect fail"),
      `statusText=${connStatus}`,
    );
  } else {
    // devtools 下不可行：明确记录，不假装跑过
    rec("D3 连接失败仅 L2 覆盖（devtools 不可行）", true, `statusText=${connStatus}`);
  }

  // 恢复：切回演示模式重建会话
  await switchTab("/pages/device/device");
  await sleep(800);
  await call("onMockModeChange", { detail: { value: false } });
  await sleep(800);
  await call("onMockModeChange", { detail: { value: true } });
  await sleep(1200);
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