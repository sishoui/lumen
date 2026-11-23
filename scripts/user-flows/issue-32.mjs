#!/usr/bin/env node
/**
 * L4 用户流程（#32）：日志面板可用（演示 + 真机）。
 *
 * 演示模式重置 → 连接 → 控制页连点版本号打开面板 → 触发自检
 *   → 断言 entries 非空、commandName 非空、同 seq TX 在 RX 之前
 *   → 复制内容含命令名与 seq（在页面上下文 mock setClipboardData 捕获）
 *   → onPause 后触发亮度命令，entries 不增长
 *   → onPause 后恢复，刷新看到新条目
 *   → onClear 后 entries=0
 *
 * 开头 off→on 重建演示会话，保证脚本连续跑两次结果一致。
 *
 * 用法：
 *   WS=ws://127.0.0.1:9529 node scripts/user-flows/issue-32.mjs
 *
 * 退出码：0 全过或 SKIPPED；1 有失败。
 * 没有自动化端口 / automator 时打印单行 SKIPPED 并 exit 0。
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
const rec = recorder.rec;
const { call, dataGet, componentCall, componentData } = driver;

async function main() {
  console.log("\n=== §A 重置演示会话并连接 ===");
  await mp.switchTab("/pages/device/device").catch(() => {});
  await sleep(800);
  await driver.waitForRoute("pages/device/device");
  rec("A0 设备页加载", (await driver.curRoute()) === "pages/device/device", `route=${await driver.curRoute()}`);

  // off→on 重建会话：新的 MockTransport 与设备运行时不会带上一次写入的日志。
  await call("onMockModeChange", { detail: { value: false } });
  await sleep(800);
  await call("onMockModeChange", { detail: { value: true } });
  await sleep(1200);

  rec("A1 演示模式开启", (await dataGet("mockMode")) === true, `mockMode=${await dataGet("mockMode")}`);

  await call("onScanTap");
  const scanned = await driver.waitFor(async () => ((await dataGet("devices.length")) ?? 0) > 0, { timeoutMs: 6000 });
  rec("A2 演示模式扫描出设备", Boolean(scanned), `devices=${await dataGet("devices.length")}`);

  await call("onDeviceTap", { currentTarget: { dataset: { index: 0 } } });
  const onControl = await driver.waitForRoute("pages/control/control", 12000);
  rec("A3 连接后进入控制页", onControl, `route=${await driver.curRoute()}`);
  await sleep(1500);

  console.log("\n=== §B 连点版本号唤出日志面板 ===");
  for (let i = 0; i < 6; i += 1) {
    await call("onVersionTap");
    await sleep(120);
  }
  const panelVisible = await driver.waitFor(
    async () => (await dataGet("logVisible")) === true,
    { timeoutMs: 2500 },
  );
  rec("B1 连点版本号唤出日志面板", panelVisible === true, `logVisible=${await dataGet("logVisible")}`);

  // §B/§C 之前复位日志面板：控制页常驻组件，paused 状态可能从上一个脚本残留。
  // 助手确保打开、paused=false、entries=[]，并断言起始 paused===false。
  await resetLogPanel(driver, recorder);
  const startPanel = await componentData("#frame-log");
  rec(
    "B2 起始 paused=false 且 entries=[]",
    startPanel?.paused === false && Array.isArray(startPanel?.entries) && startPanel.entries.length === 0,
    `paused=${startPanel?.paused} entries=${startPanel?.entries?.length}`,
  );

  console.log("\n=== §C 触发自检 → 断言 TX/RX 与命令名 ===");
  await call("onSelfTestTap");
  const entries = await driver.waitFor(
    async () => {
      const data = await componentData("#frame-log");
      return data && Array.isArray(data.entries) && data.entries.length > 0 ? data.entries : null;
    },
    { timeoutMs: 4000 },
  );
  const list = entries ?? [];
  rec("C1 帧日志快照非空", list.length > 0, `entries=${list.length}`);

  const unnamed = list.filter((e) => !e.commandName);
  rec(
    "C2 每条帧都有 commandName",
    list.length > 0 && unnamed.length === 0,
    unnamed.length > 0
      ? `缺名：${unnamed.map((e) => `${e.dir}/${e.seqText}`).join(", ")}`
      : `全部 ${list.length} 条都有命令名`,
  );
  rec(
    "C3 命令名是语义名（含 SelfTest）",
    list.some((e) => entryName(e) === "SelfTest"),
    `names=${list.map(entryName).join(",")}`,
  );

  const seenTx = new Set();
  let orderError = "";
  for (const entry of list) {
    if (entry.dir === "tx") {
      seenTx.add(entry.seqText);
    } else if (entry.dir === "rx" && !seenTx.has(entry.seqText)) {
      orderError = `${entry.seqText} 的 RX 之前没有 TX`;
      break;
    }
  }
  rec(
    "C4 同一 seq 的 TX 出现在 RX 之前",
    list.length > 0 && orderError === "",
    orderError || `检查 ${list.length} 条`,
  );

  console.log("\n=== §D 复制内容 ===");
  // 在页面上下文 mock wx.setClipboardData，捕获 onCopy 实际写入的文本。
  await mp.evaluate(() => {
    if (!globalThis.__issue32Clipboard) {
      globalThis.__issue32Clipboard = { text: "" };
      const original = wx.setClipboardData;
      globalThis.__issue32OrigClipboard = original;
      wx.setClipboardData = (opts) => {
        globalThis.__issue32Clipboard.text = opts?.data ?? "";
        if (typeof original === "function") {
          try { original.call(wx, opts); } catch { /* ignore */ }
        }
      };
    }
  });
  await componentCall("#frame-log", "onCopy");
  const copyText = await mp.evaluate(() => globalThis.__issue32Clipboard?.text ?? "");
  rec("D1 复制内容非空", copyText.length > 0, `len=${copyText.length}`);
  rec(
    "D2 复制内容含命令名",
    copyText.includes("SelfTest"),
    `text=${JSON.stringify(copyText.slice(0, 160))}`,
  );
  rec(
    "D3 复制内容含 seq",
    /seq=\d+/.test(copyText),
    `text=${JSON.stringify(copyText.slice(0, 160))}`,
  );
  rec(
    "D4 复制行格式 DIR seq=<n> <commandName> <hex>",
    list.length === 0 || /^(TX|RX) (seq=\d+ )?\S+ [0-9A-F]/.test(copyText),
    `first=${JSON.stringify(copyText.split("\n")[0] ?? "")}`,
  );

  console.log("\n=== §E 暂停 / 恢复 ===");
  // 进入暂停前确保未暂停（前面 resetLogPanel 已断言，这里再读一次明确起始状态）。
  const prePause = await componentData("#frame-log");
  rec(
    "E0 暂停前 paused=false",
    prePause?.paused === false,
    `paused=${prePause?.paused} entries=${prePause?.entries?.length}`,
  );

  await componentCall("#frame-log", "onPause");
  await sleep(200);
  const paused = await componentData("#frame-log");
  const beforePauseCount = paused?.entries?.length ?? 0;
  rec(
    "E1 onPause 后 paused=true",
    paused?.paused === true,
    `paused=${paused?.paused}`,
  );
  rec(
    "E1b 暂停中面板仍显示当前条目",
    beforePauseCount > 0,
    `entries=${beforePauseCount}`,
  );

  await call("onBrightnessChange", { detail: { value: 100 } });
  await sleep(1200);
  const duringPause = await componentData("#frame-log");
  rec(
    "E2 暂停中触发命令后面板条目冻结",
    duringPause?.paused === true &&
      Array.isArray(duringPause.entries) &&
      duringPause.entries.length === beforePauseCount,
    `paused=${duringPause?.paused} before=${beforePauseCount} during=${duringPause?.entries?.length}`,
  );

  // 恢复后 onAppend 触发 refresh，应该能看到暂停期间的新条目。
  await componentCall("#frame-log", "onPause");
  await sleep(200);
  const resumed = await componentData("#frame-log");
  rec(
    "E3a 再次 onPause 后 paused=false",
    resumed?.paused === false,
    `paused=${resumed?.paused}`,
  );
  const afterResume = await driver.waitFor(
    async () => {
      const data = await componentData("#frame-log");
      return data && Array.isArray(data.entries) && data.entries.length > beforePauseCount ? data.entries : null;
    },
    { timeoutMs: 4000 },
  );
  rec(
    "E3b 恢复后 entries 增加（能看到暂停期间的新条目）",
    Boolean(afterResume),
    `before=${beforePauseCount} after=${afterResume?.length ?? (await componentData("#frame-log"))?.entries?.length}`,
  );

  console.log("\n=== §F 清空 ===");
  await componentCall("#frame-log", "onClear");
  await sleep(300);
  const afterClear = await componentData("#frame-log");
  rec(
    "F1 清空后面板条目为 0",
    afterClear && Array.isArray(afterClear.entries) && afterClear.entries.length === 0,
    `entries=${afterClear?.entries?.length}`,
  );
  rec(
    "F1b 清空后 paused 仍 false",
    afterClear?.paused === false,
    `paused=${afterClear?.paused}`,
  );

  // 清空后新触发的命令应只产生新日志（不依赖旧订阅残留）。
  await call("onSelfTestTap");
  const afterNew = await driver.waitFor(
    async () => {
      const data = await componentData("#frame-log");
      return data && Array.isArray(data.entries) && data.entries.length > 0 ? data.entries : null;
    },
    { timeoutMs: 4000 },
  );
  rec(
    "F2 清空后新命令仍能产生日志",
    Boolean(afterNew),
    `entries=${afterNew?.length ?? (await componentData("#frame-log"))?.entries?.length}`,
  );
}

/** 单行里安全取命令名：组件里可能是 commandName 或 name 字段。 */
function entryName(e) {
  return String(e?.commandName ?? e?.name ?? "").trim();
}

try {
  await main();
} catch (error) {
  rec(`EXCEPTION ${String(error?.message ?? error)}`, false);
} finally {
  // 恢复 wx.setClipboardData 并清理页面全局变量，避免污染后续脚本 / 手动 re-run 跳过 mock 安装。
  await mp.evaluate(() => {
    if (globalThis.__issue32OrigClipboard) {
      wx.setClipboardData = globalThis.__issue32OrigClipboard;
    }
    delete globalThis.__issue32Clipboard;
    delete globalThis.__issue32OrigClipboard;
  }).catch(() => {});
  recorder.printSummary();
  await mp.disconnect().catch(() => {});
  process.exit(recorder.fail === 0 ? 0 : 1);
}