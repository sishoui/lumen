#!/usr/bin/env node
/**
 * 工单 #25 用户流程：每链灯珠数 + 链选择。
 *
 * 演示模式连接 → 控制页把链 0 灯珠数改为 50（失焦提交）→ State 读回 50
 * → 点链 1 行进入部位编辑器 → 显示链 1、灯珠数 30、方格 30 颗
 * → 返回 → 越界输入（101）被拦截，提示含上限 100，灯珠数不变。
 *
 * 断言对象是页面从设备读回的数据（State 镜像 / 部位编辑器数据），不是 hint 文案本身。
 * 开头的 off→on 重建演示会话（新的 MockTransport + 设备运行时），
 * 让脚本连续跑两次都从 60 颗的默认值开始。
 *
 * 用法：WS=ws://127.0.0.1:9529 node scripts/user-flows/issue-25.mjs
 * 缺自动化端口或 automator → 打印 SKIPPED 并 exit 0；断言失败 exit 1。
 */

import { connect, createDriver, createRecorder, sleep } from "./harness.mjs";

const recorder = createRecorder();
const rec = recorder.rec;

const conn = await connect();
if (conn.skipped) {
  console.log(`SKIPPED: ${conn.skipped}`);
  process.exit(0);
}
const { mp } = conn;
const d = createDriver(mp);

const waitLedHint = (fragment) =>
  d.waitFor(async () => String((await d.dataGet("hint")) ?? "").includes(fragment), { timeoutMs: 10000 });
const waitLoadingDone = () =>
  d.waitFor(async () => (await d.dataGet("loading")) === false, { timeoutMs: 12000 });

/** 在控制页编辑某条链的灯珠数：先写输入框，再触发失焦提交（与用户操作同路径）。 */
const editLedCount = async (stripId, text) => {
  await d.call("onLedCountInput", { currentTarget: { dataset: { strip: stripId } }, detail: { value: text } });
  await d.call("onLedCountBlur", { currentTarget: { dataset: { strip: stripId } } });
};

const backToControl = async () => {
  await mp.navigateBack().catch(() => {});
  await d.waitForRoute("pages/control/control");
};

console.log("\n=== 工单 #25：每链灯珠数与链选择 ===");

/* §A 重置演示会话并连接（书桌：链 0 = 60 颗、链 1 = 30 颗）。 */
await mp.switchTab("/pages/device/device").catch(() => {});
await d.waitForRoute("pages/device/device");
await sleep(800);
rec("A0 设备页加载", (await d.curRoute()) === "pages/device/device", await d.curRoute());

if ((await d.dataGet("mockMode")) !== true) {
  await d.call("onMockModeChange", { detail: { value: true } });
  await sleep(1000);
}
await d.call("onMockModeChange", { detail: { value: false } });
await sleep(800);
await d.call("onMockModeChange", { detail: { value: true } });
await sleep(1200);
rec("A1 演示模式重置会话", (await d.dataGet("mockMode")) === true, `mockMode=${await d.dataGet("mockMode")}`);

await d.call("onScanTap");
const scanned = await d.waitFor(async () => ((await d.dataGet("devices.length")) ?? 0) > 0, { timeoutMs: 8000 });
rec("A2 扫描出演示设备", !!scanned, `devices=${await d.dataGet("devices.length")}`);

await d.call("onDeviceTap", { currentTarget: { dataset: { index: 0 } } });
const reachedControl = await d.waitForRoute("pages/control/control");
rec("A3 连接后进入控制页", reachedControl, await d.curRoute());
await sleep(2000); // 等权威重建（含 DeviceInfoReport）完成

/* §B 控制页基线：两条链、上限来自设备能力。 */
let data = await d.pageData();
rec(
  "B1 两条链各自显示灯珠数",
  data?.stripRows?.length === 2 &&
    data?.stripRows?.[0]?.ledCount === 60 &&
    data?.stripRows?.[1]?.ledCount === 30,
  `stripRows=${JSON.stringify((data?.stripRows ?? []).map((r) => [r.stripId, r.ledCount]))}`,
);
rec(
  "B2 上限来自 DeviceInfoReport 而非硬编码页面文案",
  data?.maxLeds === 100,
  `maxLeds=${data?.maxLeds}`,
);

/* §C 链 0 灯珠数改为 50：失焦提交 → State 读回 50。 */
await editLedCount(0, "50");
const ledOk = await waitLedHint("已设为 50");
data = await d.pageData();
rec("C1 设置成功反馈（读回值）", !!ledOk, `hint=${data?.hint}`);
rec(
  "C2 State 读回链 0 = 50",
  data?.stripRows?.[0]?.ledCount === 50 && data?.stripRows?.[0]?.ledDraft === "50",
  `stripRows[0]=${JSON.stringify(data?.stripRows?.[0])}`,
);
rec(
  "C3 链 1 不受影响仍为 30",
  data?.stripRows?.[1]?.ledCount === 30,
  `stripRows[1]=${JSON.stringify(data?.stripRows?.[1])}`,
);

/* §D 点链 1 行进部位编辑器：当前链 1、灯珠数 30、方格 30 颗。 */
await d.call("onPartEditorTap", { currentTarget: { dataset: { strip: 1 } } });
const reachedPart = await d.waitForRoute("pages/part/part");
rec("D1 点链 1 行进入部位编辑器", reachedPart, await d.curRoute());
await waitLoadingDone();
data = await d.pageData();
rec("D2 部位编辑器显示当前链 1", data?.stripId === 1, `stripId=${data?.stripId}`);
rec(
  "D3 部位编辑器灯珠数为 30",
  data?.ledCount === 30,
  `ledCount=${data?.ledCount}`,
);
rec(
  "D4 灯珠方格渲染 30 颗",
  Array.isArray(data?.ledCells) && data.ledCells.length === 30,
  `ledCells=${data?.ledCells?.length ?? "非数组"}`,
);

/* §E 返回控制页，越界输入在发送前被拦截。 */
await backToControl();
await sleep(800);
await editLedCount(0, "101");
const blocked = await waitLedHint("100");
data = await d.pageData();
rec("E1 越界输入被拦截且提示含上限", !!blocked, `hint=${data?.hint}`);
rec(
  "E2 拦截后灯珠数保持 50 不变",
  data?.stripRows?.[0]?.ledCount === 50,
  `stripRows[0].ledCount=${data?.stripRows?.[0]?.ledCount}`,
);

recorder.printSummary();
await mp.disconnect().catch(() => {});
process.exit(recorder.fail === 0 ? 0 : 1);