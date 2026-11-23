#!/usr/bin/env node
/**
 * 工单 #24 用户流程：部位槽位增删。
 *
 * 演示模式连接 → 部位编辑器 → 删空槽位缩到 1 → 新增回 2 → 给新槽位画段 → 提交
 * → 读回 2 个连续编号槽位 → 场景编辑器看到新槽位 → 重进编辑器 → 新增空槽位并直接删
 * → 有段槽位先取消确认（不删）再确认删除 → 提交 → 读回 1 个槽位且段/名字正确。
 *
 * 断言对象是页面从设备读回的数据（QueryLayout 结果），不是页面内部数组。
 * 开头的 off→on 重建演示会话（新的 MockTransport + 设备运行时），保证脚本可连续跑两次。
 *
 * 用法：WS=ws://127.0.0.1:9529 node scripts/user-flows/issue-24.mjs
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

const partIds = (data) => (data?.parts ?? []).map((p) => p.partId);
const segsOf = (data, partId) => JSON.stringify(data?.parts?.[partId]?.segs);
const waitLoadingDone = () =>
  d.waitFor(async () => (await d.dataGet("loading")) === false, { timeoutMs: 12000 });
const waitCommitDone = () =>
  d.waitFor(async () => (await d.dataGet("hint")) === "布局已提交", { timeoutMs: 20000 });

/**
 * 在页面上下文替换 wx.showModal。
 * automator 的 mockWxMethod 函数形式只接收 mock 时传入的 args，看不到调用方
 * 传的 options，success 回调永远不会触发；这里直接换掉 wx.showModal 才能拿到
 * 真实调用参数，模拟用户点「取消/确定」。
 */
const setModalAnswer = (confirm) =>
  mp.evaluate(
    (answer) => {
      wx.__origShowModal = wx.__origShowModal || wx.showModal;
      wx.showModal = (options) => {
        if (options && typeof options.success === "function") {
          options.success({ confirm: answer, cancel: !answer });
        }
      };
    },
    confirm,
  );

const mockModalCancel = () => setModalAnswer(false);
const mockModalConfirm = () => setModalAnswer(true);
const restoreModal = () =>
  mp.evaluate(() => {
    if (wx.__origShowModal) wx.showModal = wx.__origShowModal;
  });

const backToControl = async () => {
  await mp.navigateBack().catch(() => {});
  await d.waitForRoute("pages/control/control");
};

console.log("\n=== 工单 #24：部位槽位增删 ===");

/* §A 重置演示会话并连接。 */
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

/* §B 部位编辑器基线：2 个槽位，清空并删掉槽位 0。 */
await d.call("onPartEditorTap");
await d.waitForRoute("pages/part/part");
await waitLoadingDone();
let data = await d.pageData();
rec("B1 进入部位编辑器", (await d.curRoute()) === "pages/part/part", await d.curRoute());
rec(
  "B2 基线 2 个槽位",
  data?.partCount === 2 && data?.parts?.length === 2,
  `partCount=${data?.partCount} parts=${data?.parts?.length}`,
);
rec(
  "B3 上限来自设备能力且当前可新增",
  typeof data?.maxParts === "number" && data.maxParts >= 2 && data?.canAdd === true,
  `maxParts=${data?.maxParts} canAdd=${data?.canAdd}`,
);

await d.call("onClearSegs");
await sleep(300);
await d.call("onDeletePartTap");
await sleep(400);
data = await d.pageData();
rec(
  "B4 空槽位直接删，剩 1 个槽位",
  data?.partCount === 1 && data?.parts?.length === 1,
  `partCount=${data?.partCount} parts=${data?.parts?.length} hint=${data?.hint}`,
);
rec(
  "B5 剩余槽位重编号为 0，名字与段保留",
  data?.parts?.[0]?.partId === 0 && data?.parts?.[0]?.name === "后半" && segsOf(data, 0) === "[[30,59]]",
  `partId=${data?.parts?.[0]?.partId} name=${data?.parts?.[0]?.name} segs=${segsOf(data, 0)}`,
);

/* §C 新增槽位到 2，给新槽位画段，提交并读回。 */
await d.call("onAddPartTap");
await sleep(400);
data = await d.pageData();
rec(
  "C1 新增槽位到 2（连续编号 0,1）",
  data?.partCount === 2 && data?.parts?.length === 2 && JSON.stringify(partIds(data)) === "[0,1]",
  `partCount=${data?.partCount} partIds=${JSON.stringify(partIds(data))}`,
);
rec(
  "C2 新槽位为末尾空槽并被选中",
  data?.activePartId === 1 && data?.parts?.[1]?.partId === 1 && segsOf(data, 1) === "[]",
  `activePartId=${data?.activePartId} segs=${segsOf(data, 1)}`,
);

await d.call("onLedTap", { currentTarget: { dataset: { index: 0 } } });
await sleep(150);
await d.call("onLedTap", { currentTarget: { dataset: { index: 29 } } });
await sleep(400);
data = await d.pageData();
rec("C3 给新槽位画段 [0,29]", segsOf(data, 1) === "[[0,29]]", `segs=${segsOf(data, 1)}`);

await d.call("onCommitTap");
const committed = await waitCommitDone();
data = await d.pageData();
rec("C4 提交并读回完成", !!committed, `hint=${data?.hint}`);
rec(
  "C5 读回 2 个连续编号槽位",
  data?.partCount === 2 && JSON.stringify(partIds(data)) === "[0,1]",
  `partCount=${data?.partCount} partIds=${JSON.stringify(partIds(data))}`,
);
rec(
  "C6 读回名字与段正确",
  data?.parts?.[0]?.name === "后半" && segsOf(data, 0) === "[[30,59]]" && segsOf(data, 1) === "[[0,29]]",
  `p0.name=${data?.parts?.[0]?.name} p0.segs=${segsOf(data, 0)} p1.segs=${segsOf(data, 1)}`,
);

/* §C2 场景编辑器从布局读回新槽位对应的部位。 */
await backToControl();
await d.call("onSceneEditorTap");
await d.waitForRoute("pages/scene/scene");
await waitLoadingDone();
const sceneData = await d.pageData();
const sceneParts = (sceneData?.parts ?? []).filter((p) => p.stripId === 0);
rec(
  "C7 场景编辑器读回 2 个槽位对应的部位",
  JSON.stringify(sceneParts.map((p) => p.partId)) === "[0,1]",
  `sceneParts=${JSON.stringify(sceneParts.map((p) => ({ partId: p.partId, name: p.name })))}`,
);

/* §D 重进编辑器：空槽位直接删；有段槽位取消不删、确认才删。 */
await backToControl();
await d.call("onPartEditorTap");
await d.waitForRoute("pages/part/part");
await waitLoadingDone();
data = await d.pageData();
rec(
  "D1 重进仍读回 2 个槽位",
  data?.partCount === 2 && JSON.stringify(partIds(data)) === "[0,1]",
  `partCount=${data?.partCount} partIds=${JSON.stringify(partIds(data))}`,
);

await d.call("onAddPartTap");
await sleep(400);
data = await d.pageData();
rec(
  "D2 新增第 3 个空槽位并选中",
  data?.partCount === 3 && data?.activePartId === 2,
  `partCount=${data?.partCount} activePartId=${data?.activePartId}`,
);

await mockModalCancel();
await d.call("onDeletePartTap");
await sleep(400);
data = await d.pageData();
rec(
  "D3 空槽位直接删（取消语义的弹窗不会挡住删除）",
  data?.partCount === 2 && JSON.stringify(partIds(data)) === "[0,1]",
  `partCount=${data?.partCount} partIds=${JSON.stringify(partIds(data))}`,
);
rec(
  "D4 删除空槽位后选中仍在合法范围",
  data?.activePartId === 1 && data?.parts?.[1]?.segs?.length === 1,
  `activePartId=${data?.activePartId}`,
);

await d.call("onDeletePartTap");
await sleep(400);
data = await d.pageData();
rec(
  "D5 有段槽位取消确认后不删",
  data?.partCount === 2 && segsOf(data, 1) === "[[0,29]]",
  `partCount=${data?.partCount} segs=${segsOf(data, 1)}`,
);

await mockModalConfirm();
await d.call("onDeletePartTap");
await sleep(400);
data = await d.pageData();
rec(
  "D6 确认后删除有段槽位，剩 1 个槽位",
  data?.partCount === 1 && JSON.stringify(partIds(data)) === "[0]",
  `partCount=${data?.partCount} partIds=${JSON.stringify(partIds(data))}`,
);
rec("D7 删除后选中槽位 0", data?.activePartId === 0, `activePartId=${data?.activePartId}`);

await d.call("onCommitTap");
const committedAgain = await waitCommitDone();
data = await d.pageData();
rec("D8 再次提交并读回完成", !!committedAgain, `hint=${data?.hint}`);
rec(
  "D9 读回 1 个槽位且名字/段正确",
  data?.partCount === 1 &&
    JSON.stringify(partIds(data)) === "[0]" &&
    data?.parts?.[0]?.name === "后半" &&
    segsOf(data, 0) === "[[30,59]]",
  `partCount=${data?.partCount} name=${data?.parts?.[0]?.name} segs=${segsOf(data, 0)}`,
);

await restoreModal().catch(() => {});

recorder.printSummary();
await mp.disconnect().catch(() => {});
process.exit(recorder.fail === 0 ? 0 : 1);
