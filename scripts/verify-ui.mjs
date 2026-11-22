#!/usr/bin/env node
/**
 * L4 UI 渲染回归骨架（工单 #17）。
 *
 * 用 miniprogram-automator 驱动微信开发者工具里的真实小程序，按 §0–§7 八节组织
 * 断言。骨架期每节只挂 describe 壳 + 1 条「壳就位」占位断言，完整 48 条断言随
 * 页面实现逐个加。完整实现的判定口径与分节见 docs/spec.md §3.5 与工单 #8 决策 4。
 *
 * 为什么住在 scripts/ 而不是 miniprogram/.auto/：`.auto/` 整个在 .gitignore 里，
 * 换台机器 clone 下来这一层就凭空消失了——而它是唯一能发现白屏与 bindtap 全失效的
 * 一层。这里与真机探针、串口工具同类：都是「需要外部环境」的脚本。
 *
 * 用法：
 *   node scripts/verify-ui.mjs                  # 跑全部 8 节
 *   node scripts/verify-ui.mjs --probe          # 只探端口，不跑断言
 *   WS=ws://127.0.0.1:9502 node scripts/verify-ui.mjs
 *
 * 9501 是 IDE 的 HTTP 端口，不是自动化 ws。必须 --auto-port：
 *   "C:\Program Files (x86)\Tencent\微信web开发者工具\cli.bat" auto ^
 *     --project "<repo>\miniprogram" --auto-port 9502 --trust-project
 * 判据是 `netstat -ano | findstr :9502` 有 LISTENING（不带 --auto-port 时 CLI
 * 照样打印 `✔ auto` 但 ws 端口根本不监听）。
 *
 * 退出码（供编排器 scripts/test-run.mjs 的 ui 层解析）：
 *   0 全部断言通过，或环境缺失（缺 automator / 缺自动化端口）
 *   1 有断言失败
 * 环境缺失不是失败：开发工具没开是常态，编排器要把它记成 SKIP 并写明原因。
 * 缺环境时 stdout 唯一一行 `SKIPPED: <原因>`。
 */
import { createRequire } from "node:module";
import net from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
/* 仓库根：scripts -> 仓库根。所有路径都从这里推，不依赖 cwd。 */
const REPO = resolve(HERE, "..");

/* 候选自动化端口。微信开发者工具「设置 → 安全设置 → 服务端口」是个区间：
   开着自动化后第一项占 9501，再开一个窗口顺延到 9502。`WS` 可强制指定，
   指了就只试它（CI 与手工排查要靠这个确定性）。 */
const PORT_CANDIDATES = process.env.WS
  ? [process.env.WS]
  : ["ws://127.0.0.1:9501", "ws://127.0.0.1:9502"];

/* 探测超时：3 秒。开发者工具的 ws 端口要么立刻接受连接，要么本机直接
   ECONNREFUSED。 */
const PROBE_TIMEOUT_MS = 3000;

/* 握手另给 8 秒：TCP 通之后真实 WebSocket 握手要来回几帧，3 秒偏紧；
   但也不能无限等——半开端口会一直不应答。 */
const HANDSHAKE_TIMEOUT_MS = 8000;

/* 缺环境时的固定前缀：编排器只认这一行，不看别的。 */
const skipLine = (reason) => `SKIPPED: ${reason}`;

/** 给不带宽限的 promise 加超时。 */
function withTimeout(promise, ms, endpoint) {
  return new Promise((resolvePromise, rejectPromise) => {
    const timer = setTimeout(
      () => rejectPromise(new Error(`${endpoint} ${ms}ms 内没完成握手`)),
      ms,
    );
    promise.then(
      (value) => { clearTimeout(timer); resolvePromise(value); },
      (error) => { clearTimeout(timer); rejectPromise(error); },
    );
  });
}

/** 加载 automator；缺失时返回 null（调用方据此报「缺环境」而不是硬失败）。 */
function loadAutomator() {
  try {
    const requireFromMp = createRequire(resolve(REPO, "miniprogram", "package.json"));
    const mod = requireFromMp("miniprogram-automator");
    return mod.default ?? mod;
  } catch {
    return null;
  }
}

/** 探测自动化端口是否可连（仅 TCP，不握手、不跑断言）。 */
function probeAutomationPort(endpoint, timeoutMs = PROBE_TIMEOUT_MS) {
  return new Promise((resolvePromise) => {
    let host = "127.0.0.1";
    let port = 9501;
    try {
      const url = new URL(endpoint);
      host = url.hostname || host;
      port = Number(url.port) || port;
    } catch {
      resolvePromise([`自动化端口地址无法解析：${endpoint}`]);
      return;
    }

    const socket = net.connect({ host, port });
    let settled = false;
    const finish = (reasons) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolvePromise(reasons);
    };

    const timer = setTimeout(
      () => finish([`缺微信开发者工具自动化端口（${endpoint} ${timeoutMs}ms 内没连上）`]),
      timeoutMs,
    );
    socket.once("connect", () => { clearTimeout(timer); finish([]); });
    socket.once("error", (error) => {
      clearTimeout(timer);
      finish([`缺微信开发者工具自动化端口（${endpoint}：${error.code ?? error.message}）`]);
    });
  });
}

/**
 * 依次试候选端口，返回第一个真正握手成功的地址。
 *
 * TCP 通不算数：端口开着但窗口没开「自动化」时 TCP 连得上、WebSocket 握手
 * 却失败。只测 TCP 会让探测说「可连」、正式跑立刻 SKIP，同一份环境两个结论。
 *
 * @returns {{ endpoint: string } | { reasons: string[] }}
 */
async function pickEndpoint(automator) {
  const reasons = [];
  for (const endpoint of PORT_CANDIDATES) {
    const tcp = await probeAutomationPort(endpoint);
    if (tcp.length > 0) {
      reasons.push(...tcp);
      continue;
    }
    try {
      const connection = await withTimeout(
        automator.connect({ wsEndpoint: endpoint }),
        HANDSHAKE_TIMEOUT_MS,
        endpoint,
      );
      await connection.disconnect();
      return { endpoint };
    } catch (error) {
      reasons.push(`${endpoint}：${String(error.message ?? error)}`);
    }
  }
  return { reasons };
}

/** 探测失败时指向可操作项。 */
const PORT_HINT =
  "在微信开发者工具里打开 设置 → 安全设置 → 服务端口（开启「自动化」），" +
  `或按需设置 WS=<ws 地址>；已试 ${PORT_CANDIDATES.join(" / ")}`;

/* ---------------- 只探测，不跑断言 ---------------- */

if (process.argv.includes("--probe")) {
  const probeAutomator = loadAutomator();
  if (probeAutomator === null) {
    console.log(skipLine("缺 miniprogram-automator（在 miniprogram/ 下跑 npm install）"));
    process.exit(0);
  }
  const chosen = await pickEndpoint(probeAutomator);
  if ("endpoint" in chosen) {
    console.log(`PORT: ${chosen.endpoint} 可连`);
  } else {
    console.log(skipLine(`缺微信开发者工具自动化端口（${chosen.reasons.join("；")}）。${PORT_HINT}`));
  }
  process.exit(0);
}

/* ---------------- 正常验收 ---------------- */

const automator = loadAutomator();
if (automator === null) {
  console.log(skipLine("缺 miniprogram-automator（在 miniprogram/ 下跑 npm install）：ui 层未验证"));
  process.exit(0);
}

/* 先试端口再跑断言：连不上时报「缺环境」而不是抛栈，编排器才不会把常态当失败。 */
const chosen = await pickEndpoint(automator);
if (!("endpoint" in chosen)) {
  console.log(skipLine(`缺微信开发者工具自动化端口（${chosen.reasons.join("；")}）。${PORT_HINT}`));
  process.exit(0);
}

let mp;
try {
  mp = await automator.connect({ wsEndpoint: chosen.endpoint });
} catch (error) {
  console.log(skipLine(`缺微信开发者工具自动化端口（${chosen.endpoint}：${String(error.message ?? error)}）。${PORT_HINT}`));
  process.exit(0);
}

let pass = 0;
let fail = 0;
const rec = (name, ok, detail = "") => {
  ok ? pass++ : fail++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const pageState = () =>
  mp.evaluate(() => {
    const p = getCurrentPages().pop();
    return p ? { route: p.route, data: p.data } : null;
  });

const textOf = async () => {
  const pages = await mp.currentPage().then((p) => p.$$(".page"));
  if (pages.length === 0) return "";
  return pages[0].outerWxml();
};

/** 等页面栈顶变成指定路由。switchTab / navigateTo 都是异步的，
    抢在它前面 pop() 会拿到错的页面。 */
const waitForRoute = async (route, timeoutMs = 8000) => {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const state = await pageState();
    if (state !== null && state.route === route) return true;
    await sleep(120);
  }
  return false;
};

/* ---------------- 8 节 describe 壳 ----------------
 * 骨架期每节只挂壳 + 1 条占位断言，完整 48 条断言随页面实现逐个加。
 * 分节与覆盖范围按 docs/spec.md §3.5 与工单 #8 决策 4。
 */

console.log("\n--- §0 启动 ---");
try {
  const boot = await pageState();
  rec("小程序启动、页面已注册", boot !== null && boot.route !== undefined, boot?.route ?? "");
} catch (err) {
  rec("小程序启动、页面已注册", false, String(err));
}

console.log("\n--- §1 演示模式 ---");
{
  /* TODO: 无真机记录自动开演示；3 台设备 spec 形状差异可见。完整实现：5 条。 */
  rec("演示模式壳就位", true, "骨架占位");
}

console.log("\n--- §2 设备 tab ---");
{
  await mp.switchTab("/pages/device/device").catch(() => {});
  await sleep(800);
  await waitForRoute("pages/device/device");
  /* TODO: 扫描列表、点卡连接、连接状态条、演示开关。完整实现：6 条。 */
  rec("设备 tab 壳就位", true, "骨架占位");
}

console.log("\n--- §3 控制 tab ---");
{
  await mp.switchTab("/pages/control/control").catch(() => {});
  await sleep(800);
  await waitForRoute("pages/control/control");
  /* TODO: 整机开关 / 亮度滑块 / 每链开关与灯珠数 / 场景切换 / 自检入口。完整实现：8 条。 */
  rec("控制 tab 壳就位", true, "骨架占位");
}

console.log("\n--- §4 部位编辑器（壳）---");
{
  /* TODO: navigateTo 带参 stripId、占位渲染、返回后控制页镜像不丢。完整实现：4 条。 */
  rec("部位编辑器壳就位", true, "骨架占位");
}

console.log("\n--- §5 场景编辑器（壳）---");
{
  /* TODO: navigateTo 带参 sceneId、占位渲染、返回后控制页镜像不丢。完整实现：4 条。 */
  rec("场景编辑器壳就位", true, "骨架占位");
}

console.log("\n--- §6 开关层级与镜像读回 ---");
{
  /* TODO: 切开关 → ACK → 镜像更新；亮度拖动跟手（latest-wins）。完整实现：4 条。 */
  rec("开关层级与镜像读回壳就位", true, "骨架占位");
}

console.log("\n--- §7 日志面板 ---");
{
  /* TODO: 版本号×5 唤出、环形 200 帧、暂停 / 清空 / 复制。完整实现：6 条。 */
  rec("日志面板壳就位", true, "骨架占位");
}

console.log(`\n===== ${pass} passed / ${fail} failed =====`);
await mp.disconnect();
process.exit(fail === 0 ? 0 : 1);