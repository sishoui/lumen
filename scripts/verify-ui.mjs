#!/usr/bin/env node
/**
 * L4 UI 渲染回归 runner（#17 骨架，#34 改为用户流程 runner）。
 *
 * 顺序执行 scripts/verify-user-flow.mjs 与 scripts/user-flows/issue-*.mjs，
 * 逐个用 spawnSync 调起。每个子脚本自己负责 automator 连接、断言与汇总输出。
 * 本 runner 只负责：
 *  - 先探测端口，无端口时单行 `SKIPPED: <原因>` exit 0（不染绿）。
 *  - 按编号排序发现子脚本，spawnSync 执行，逐个打印 header 与 stdout/stderr。
 *  - 统计每个子脚本的 PASS/FAIL 行；SKIPPED 记为 skipped，不算失败。
 *  - 任一子脚本非零退出或有 FAIL → 整体失败。
 *  - 末尾输出 `===== N passed / M failed =====` 与失败清单；有失败 exit 1。
 *  - 保持 PASS/FAIL 行 + 汇总行的格式，让 scripts/test-run.mjs 的 ui 层
 *    parseUiOutput 能解析（PASS/FAIL 行优先；缺环境时只有 SKIPPED 行）。
 *
 * 用法：
 *   node scripts/verify-ui.mjs                  # 跑所有用户流程
 *   node scripts/verify-ui.mjs --probe          # 只探端口
 *   WS=ws://127.0.0.1:9502 node scripts/verify-ui.mjs
 *
 * 缺环境时 stdout 唯一一行 `SKIPPED: <原因>`，退出码 0。
 */

import { createRequire } from "node:module";
import net from "node:net";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, readdirSync } from "node:fs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..");

const PORT_CANDIDATES = process.env.WS
  ? [process.env.WS]
  : ["ws://127.0.0.1:9529", "ws://127.0.0.1:9501", "ws://127.0.0.1:9502"];

const PROBE_TIMEOUT_MS = 3000;
const HANDSHAKE_TIMEOUT_MS = 8000;
const CHILD_TIMEOUT_MS = 240000;

const skipLine = (reason) => `SKIPPED: ${reason}`;

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

function loadAutomator() {
  try {
    const requireFromMp = createRequire(resolve(REPO, "miniprogram", "package.json"));
    const mod = requireFromMp("miniprogram-automator");
    return mod.default ?? mod;
  } catch {
    return null;
  }
}

function probeAutomationPort(endpoint, timeoutMs = PROBE_TIMEOUT_MS) {
  return new Promise((resolvePromise) => {
    let host = "127.0.0.1";
    let port = 9529;
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

const PORT_HINT =
  "在微信开发者工具里打开 设置 → 安全设置 → 服务端口（开启「自动化」），" +
  `或按需设置 WS=<ws 地址>；已试 ${PORT_CANDIDATES.join(" / ")}`;

/* ---------------- --probe 分支 ---------------- */

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

/* ---------------- 正常模式 ---------------- */

const automator = loadAutomator();
if (automator === null) {
  console.log(skipLine("缺 miniprogram-automator（在 miniprogram/ 下跑 npm install）：ui 层未验证"));
  process.exit(0);
}

const chosen = await pickEndpoint(automator);
if (!("endpoint" in chosen)) {
  console.log(skipLine(`缺微信开发者工具自动化端口（${chosen.reasons.join("；")}）。${PORT_HINT}`));
  process.exit(0);
}

/** 发现子脚本：verify-user-flow.mjs + user-flows/issue-*.mjs，按编号排序。 */
function discoverScripts() {
  const scripts = [resolve(HERE, "verify-user-flow.mjs")];
  const flowsDir = resolve(HERE, "user-flows");
  if (!existsSync(flowsDir)) return scripts;
  const issueFiles = readdirSync(flowsDir)
    .filter((name) => /^issue-[\d-]+\.mjs$/.test(name))
    .sort((a, b) => {
      const na = Number(a.match(/issue-([\d]+)/)[1]);
      const nb = Number(b.match(/issue-([\d]+)/)[1]);
      return na - nb || a.localeCompare(b);
    });
  for (const name of issueFiles) {
    scripts.push(resolve(flowsDir, name));
  }
  return scripts;
}

function parseChildOutput(stdout) {
  let pass = 0;
  let fail = 0;
  const failures = [];
  for (const raw of String(stdout ?? "").split(/\r?\n/)) {
    const line = raw.trim();
    const match = /^(PASS|FAIL)\s{2,}(.+)$/.exec(line);
    if (match === null) continue;
    const rest = match[2];
    const splitAt = rest.indexOf("  — ");
    const name = splitAt < 0 ? rest : rest.slice(0, splitAt);
    const detail = splitAt < 0 ? "" : rest.slice(splitAt + "  — ".length);
    if (match[1] === "PASS") pass += 1;
    else {
      fail += 1;
      failures.push(name + (detail ? ` — ${detail}` : ""));
    }
  }
  return { pass, fail, failures };
}

function relativeToRepo(absPath) {
  return absPath.replace(REPO + "\\", "").replace(REPO + "/", "").replace(/\\/g, "/");
}

const scripts = discoverScripts();
let totalPass = 0;
let totalFail = 0;
let totalSkipped = 0;
const failedScripts = [];

for (const script of scripts) {
  const rel = relativeToRepo(script);
  console.log(`\n--- ${rel} ---`);
  const res = spawnSync(process.execPath, [script], {
    cwd: REPO,
    env: { ...process.env, WS: chosen.endpoint },
    encoding: "utf8",
    timeout: CHILD_TIMEOUT_MS,
    maxBuffer: 32 * 1024 * 1024,
  });

  const stdout = String(res.stdout ?? "");
  const stderr = String(res.stderr ?? "");
  if (stdout.trim()) process.stdout.write(stdout.endsWith("\n") ? stdout : stdout + "\n");
  if (stderr.trim()) process.stderr.write(stderr.endsWith("\n") ? stderr : stderr + "\n");

  if (res.error) {
    const timedOut = res.error.code === "ETIMEDOUT";
    const reason = timedOut ? `子脚本超时（${CHILD_TIMEOUT_MS / 1000}s）` : String(res.error.message ?? res.error);
    totalFail += 1;
    failedScripts.push({ script: rel, reason, detail: "" });
    console.log(`FAIL  ${rel} — ${reason}`);
    continue;
  }

  const skippedLine = stdout.split(/\r?\n/).find((line) => line.trim().startsWith("SKIPPED:"));
  if (skippedLine !== undefined) {
    totalSkipped += 1;
    console.log(`SKIPPED: ${skippedLine.trim().slice("SKIPPED:".length).trim()}（${rel}）`);
    continue;
  }

  const parsed = parseChildOutput(stdout);
  totalPass += parsed.pass;
  if (parsed.fail > 0 || res.status !== 0) {
    totalFail += parsed.fail > 0 ? parsed.fail : 1;
    failedScripts.push({
      script: rel,
      reason: parsed.fail > 0 ? `${parsed.fail} 条断言失败` : `非零退出码 ${res.status}`,
      detail: parsed.failures.join("；"),
    });
  }
}

console.log(`\n===== ${totalPass} passed / ${totalFail} failed =====`);
if (totalSkipped > 0) {
  console.log(`（${totalSkipped} 个脚本 SKIPPED，不计入失败）`);
}
if (failedScripts.length > 0) {
  console.log("\n失败清单：");
  for (const item of failedScripts) {
    console.log(`  - ${item.script}：${item.reason}${item.detail ? `（${item.detail}）` : ""}`);
  }
}

process.exit(totalFail > 0 ? 1 : 0);