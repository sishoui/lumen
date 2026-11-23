#!/usr/bin/env node
/**
 * 工单 #23 用户流程：清空部位 0、保留部位 1 的段后提交。
 *
 * 断言：提交前断层不发给设备；提交后页面立即显示重编号后的 1 个部位；
 * 返回再进入（同一连接，不重连）读回仍是连续编号且名字/段保留。
 *
 * 用法：WS=ws://127.0.0.1:9529 node scripts/user-flows/issue-23.mjs
 * 缺自动化端口或 automator → 打印 SKIPPED 并 exit 0；断言失败 exit 1。
 */

import { createRequire } from "node:module";
import net from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..", "..");
const ENDPOINT = process.env.WS ?? "ws://127.0.0.1:9529";

const skip = (reason) => {
  console.log(`SKIPPED: ${reason}`);
  process.exit(0);
};

function loadAutomator() {
  try {
    const requireFromMp = createRequire(resolve(REPO, "miniprogram", "package.json"));
    const mod = requireFromMp("miniprogram-automator");
    return mod.default ?? mod;
  } catch {
    return null;
  }
}

function probePort(endpoint, timeoutMs = 3000) {
  return new Promise((resolveP) => {
    let host = "127.0.0.1";
    let port = 9529;
    try {
      const url = new URL(endpoint);
      host = url.hostname || host;
      port = Number(url.port) || port;
    } catch {
      resolveP(`无法解析 ${endpoint}`);
      return;
    }
    const socket = net.connect({ host, port });
    let settled = false;
    const finish = (reason) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolveP(reason);
    };
    const timer = setTimeout(() => finish(`${endpoint} ${timeoutMs}ms 无响应`), timeoutMs);
    socket.once("connect", () => {
      clearTimeout(timer);
      finish("");
    });
    socket.once("error", (e) => {
      clearTimeout(timer);
      finish(`${endpoint}: ${e.code ?? e.message}`);
    });
  });
}

const automator = loadAutomator();
if (!automator) skip("缺 miniprogram-automator");
const probeError = await probePort(ENDPOINT);
if (probeError) skip(`无可用自动化端口（${probeError}）`);

let mp;
try {
  mp = await automator.connect({ wsEndpoint: ENDPOINT });
} catch (e) {
  skip(`连接失败：${String(e.message ?? e)}`);
}

let pass = 0;
let fail = 0;
const failures = [];
const rec = (name, ok, detail = "") => {
  if (ok) {
    pass += 1;
    console.log(`PASS  ${name}${detail ? " — " + detail : ""}`);
  } else {
    fail += 1;
    failures.push(name + (detail ? " — " + detail : ""));
    console.log(`FAIL  ${name}${detail ? " — " + detail : ""}`);
  }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const pageData = () => mp.evaluate(() => {
  const p = getCurrentPages().pop();
  return p ? JSON.parse(JSON.stringify(p.data)) : null;
});

const call = (method, arg) => mp.evaluate(({ m, a }) => {
  const p = getCurrentPages().pop();
  if (!p || typeof p[m] !== "function") return { error: `no method ${m}` };
  try {
    p[m](a);
    return { ok: true };
  } catch (e) {
    return { error: String(e?.message ?? e) };
  }
}, { m: method, a: arg });

const curRoute = () => mp.evaluate(() => {
  const p = getCurrentPages().pop();
  return p ? p.route : null;
});

async function waitUntil(predicate, timeoutMs = 15000, intervalMs = 150) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (await predicate()) return true;
    await sleep(intervalMs);
  }
  return false;
}

async function waitForRoute(route, timeoutMs = 12000) {
  return waitUntil(async () => (await curRoute()) === route, timeoutMs);
}

const segsOf = (data, partId) => {
  const part = data?.parts?.[partId];
  return part ? JSON.stringify(part.segs) : "undefined";
};

console.log("\n=== 工单 #23：断层部位提交 → 读回一致 ===");

/* 设备页：重置演示设备（重建会话 → 新的 Mock 运行时），扫描并连接。 */
await mp.switchTab("/pages/device/device").catch(() => {});
await waitForRoute("pages/device/device");
await sleep(800);
rec("R1 设备页加载", (await curRoute()) === "pages/device/device", await curRoute());

if ((await pageData())?.mockMode !== true) {
  await call("onMockModeChange", { detail: { value: true } });
  await sleep(1000);
}
await call("onMockModeChange", { detail: { value: false } });
await sleep(800);
await call("onMockModeChange", { detail: { value: true } });
await sleep(1000);
rec("R2 演示模式重置会话", (await pageData())?.mockMode === true, `mockMode=${(await pageData())?.mockMode}`);

await call("onScanTap");
const scanned = await waitUntil(async () => ((await pageData())?.devices?.length ?? 0) > 0, 8000);
rec("R3 扫描出演示设备", scanned, `devices=${(await pageData())?.devices?.length ?? 0}`);

await call("onDeviceTap", { currentTarget: { dataset: { index: 0 } } });
const reachedControl = await waitForRoute("pages/control/control");
rec("R4 连接后进入控制页", reachedControl, await curRoute());

/* 部位编辑器：建立断层，提交，断言立即刷新。 */
await call("onPartEditorTap");
await waitForRoute("pages/part/part");
await waitUntil(async () => (await pageData())?.loading === false, 12000);
let data = await pageData();
rec("R5 进入部位编辑器", (await curRoute()) === "pages/part/part", await curRoute());
rec("R6 基线 2 个槽位", data?.partCount === 2 && data?.parts?.length === 2,
  `partCount=${data?.partCount} parts=${data?.parts?.length}`);
rec("R7 基线部位 1 名为「后半」且有段",
  data?.parts?.[1]?.name === "后半" && segsOf(data, 1) === "[[30,59]]",
  `name=${data?.parts?.[1]?.name} segs=${segsOf(data, 1)}`);

await call("onClearSegs");
await sleep(300);
data = await pageData();
rec("R8 清空部位 0 的段", Array.isArray(data?.parts?.[0]?.segs) && data.parts[0].segs.length === 0,
  `parts[0].segs=${segsOf(data, 0)}`);

await call("onPartTap", { currentTarget: { dataset: { part: 1 } } });
await sleep(300);
data = await pageData();
rec("R9 切到部位 1：名字与段仍在",
  data?.partName === "后半" && JSON.stringify(data?.segs) === "[[30,59]]",
  `partName=${data?.partName} segs=${JSON.stringify(data?.segs)}`);

await call("onCommitTap");
const committed = await waitUntil(async () => {
  const d = await pageData();
  return d?.canCommit === true && d?.hint !== "" && d?.hint !== "提交中…";
}, 15000);
data = await pageData();
rec("R10 提交并读回完成", committed, `hint=${data?.hint}`);
rec("R11 提交提示为「布局已提交」", data?.hint === "布局已提交", `hint=${data?.hint}`);
rec("R12 提交后页面立即 1 个槽位（不重连）",
  data?.partCount === 1 && data?.parts?.length === 1,
  `partCount=${data?.partCount} parts=${data?.parts?.length}`);
rec("R13 槽位重编号为 0，名字「后半」、段保留",
  data?.parts?.[0]?.partId === 0 && data?.parts?.[0]?.name === "后半" && segsOf(data, 0) === "[[30,59]]",
  `partId=${data?.parts?.[0]?.partId} name=${data?.parts?.[0]?.name} segs=${segsOf(data, 0)}`);
rec("R14 灯珠方格按读回渲染",
  data?.ledCells?.[0]?.occupied === false && data?.ledCells?.[30]?.partId === 0 && data?.ledCells?.[59]?.partId === 0,
  `cell0.occupied=${data?.ledCells?.[0]?.occupied} cell30.partId=${data?.ledCells?.[30]?.partId}`);

/* 返回再进入：同一连接，读回仍一致。 */
await mp.navigateBack().catch(() => {});
await waitForRoute("pages/control/control");
rec("R15 返回控制页", (await curRoute()) === "pages/control/control", await curRoute());

await call("onPartEditorTap");
await waitForRoute("pages/part/part");
await waitUntil(async () => (await pageData())?.loading === false, 12000);
data = await pageData();
rec("R16 重新进入后读回 1 个槽位", data?.partCount === 1 && data?.parts?.length === 1,
  `partCount=${data?.partCount} parts=${data?.parts?.length}`);
rec("R17 读回 partId=0，名字与段仍在",
  data?.parts?.[0]?.partId === 0 && data?.parts?.[0]?.name === "后半" && segsOf(data, 0) === "[[30,59]]",
  `partId=${data?.parts?.[0]?.partId} name=${data?.parts?.[0]?.name} segs=${segsOf(data, 0)}`);

console.log(`\n===== ${pass} passed / ${fail} failed =====`);
if (failures.length > 0) {
  console.log("\n失败清单：");
  for (const f of failures) console.log(`  - ${f}`);
}
await mp.disconnect().catch(() => {});
process.exit(fail === 0 ? 0 : 1);
