#!/usr/bin/env node
/**
 * 编排器自身 node:test 自测（工单 #16）。
 *
 * 钉住：CLI 参数 / 退出码翻译 / 报告结构 / SKIP 路径 / 清单查漏负向 / 双池归档。
 * 零依赖，只跑 node:test + node:assert。
 *
 * 用法：node --test scripts/tests/test-run.test.mjs
 *   或：npm run test:runner
 */
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import {
  parseArgs,
  parseFirmwareOutput,
  parseTestCounts,
  parseSkippedTags,
  parseUiOutput,
  parseVitestJson,
  parseTscOutput,
  combineNodeLayerResults,
  manifestIssues,
  reportRoots,
  uniqueRunId,
  pickRunId,
  executeLayers,
  describeFiles,
  diffRuns,
  findPreviousReportDir,
  readPreviousReport,
  renderReport,
  writeReport,
  buildLayerSpecs,
  notWiredYet,
  REPO,
} from "../test-run.mjs";

import { checkManifest, loadManifest, discoverTests } from "../check-test-manifest.mjs";

/* ------------------------------------------------------------------ */
/* parseArgs：CLI 参数                                                */
/* ------------------------------------------------------------------ */

describe("parseArgs", () => {
  test("默认无参 → 三层便宜", () => {
    const r = parseArgs([]);
    assert.deepEqual(r.layers, []);
    assert.equal(r.release, false);
    assert.equal(r.list, false);
  });

  test("--release 全五层", () => {
    assert.equal(parseArgs(["--release"]).release, true);
  });

  test("--list 列层", () => {
    assert.equal(parseArgs(["--list"]).list, true);
  });

  test("指定层名", () => {
    const r = parseArgs(["firmware", "mp"]);
    assert.deepEqual(r.layers, ["firmware", "mp"]);
  });

  test("未知参数 → unknownFlag", () => {
    const r = parseArgs(["--bogus"]);
    assert.equal(r.unknownFlag, "--bogus");
  });
});

/* ------------------------------------------------------------------ */
/* parseFirmwareOutput：固件输出解析                                  */
/* ------------------------------------------------------------------ */

describe("parseFirmwareOutput", () => {
  test("全过", () => {
    const r = parseFirmwareOutput("TESTCOUNT test_a 5\nTESTCOUNT test_b 7\nall 12 checks passed\nvectors: 3 cases");
    assert.equal(r.status, "PASS");
    assert.equal(r.checks, 12);
    assert.equal(r.unit, "断言");
    assert.match(r.detail, /12 条断言通过/);
    assert.equal(r.extra.vectors, 3);
    assert.equal(r.extra.byTest.test_a, 5);
    assert.equal(r.extra.byTest.test_b, 7);
  });

  test("有失败", () => {
    const r = parseFirmwareOutput("[FAIL] test_a — expect 0x01 got 0x02\n2/9 checks failed\n");
    assert.equal(r.status, "FAIL");
    assert.equal(r.checks, 9);
    assert.equal(r.failures.length, 1);
  });

  test("找不到统计 → FAIL", () => {
    const r = parseFirmwareOutput("garbage output");
    assert.equal(r.status, "FAIL");
    assert.match(r.detail, /找不到断言统计/);
  });
});

describe("parseTestCounts", () => {
  test("聚合 TESTCOUNT 行", () => {
    const r = parseTestCounts("TESTCOUNT test_a 3\nTESTCOUNT test_a 4\nTESTCOUNT test_b 5");
    assert.equal(r.byTest.test_a, 7);
    assert.equal(r.byTest.test_b, 5);
    assert.equal(r.total, 12);
    assert.equal(r.count, 2);
  });

  test("只认行首前缀", () => {
    const r = parseTestCounts("gcc error TESTCOUNT not_a_test 99");
    assert.equal(r.count, 0);
  });
});

describe("parseSkippedTags", () => {
  test("提取 SKIPPED: 行", () => {
    const r = parseSkippedTags("SKIPPED: node not found\nsome other line\nSKIPPED: gcc missing");
    assert.deepEqual(r, ["node not found", "gcc missing"]);
  });
});

/* ------------------------------------------------------------------ */
/* parseUiOutput：渲染回归输出解析                                    */
/* ------------------------------------------------------------------ */

describe("parseUiOutput", () => {
  test("SKIPPED 行 → SKIP", () => {
    const r = parseUiOutput("SKIPPED: 缺微信开发者工具自动化端口", 0);
    assert.equal(r.status, "SKIP");
    assert.match(r.skipReason, /微信开发者工具/);
  });

  test("全过", () => {
    const r = parseUiOutput("PASS  §0 启动\nPASS  §1 演示\n===== 2 passed / 0 failed =====", 0);
    assert.equal(r.status, "PASS");
    assert.equal(r.checks, 2);
  });

  test("有失败", () => {
    const r = parseUiOutput("PASS  §0\nFAIL  §1  — 差异\n===== 1 passed / 1 failed =====", 1);
    assert.equal(r.status, "FAIL");
    assert.equal(r.checks, 2);
    assert.equal(r.failures.length, 1);
  });

  test("断言全过但退出码非零 → FAIL", () => {
    const r = parseUiOutput("PASS  §0\n===== 1 passed / 0 failed =====", 1);
    assert.equal(r.status, "FAIL");
    assert.match(r.detail, /退出码 1/);
  });

  test("找不到断言行 → FAIL", () => {
    const r = parseUiOutput("random output", 0);
    assert.equal(r.status, "FAIL");
    assert.match(r.detail, /找不到断言行/);
  });
});

/* ------------------------------------------------------------------ */
/* parseVitestJson：vitest JSON 解析                                  */
/* ------------------------------------------------------------------ */

describe("parseVitestJson", () => {
  const sample = JSON.stringify({
    numTotalTests: 2,
    numFailedTests: 0,
    success: true,
    testResults: [
      {
        name: "C:/repo/miniprogram/tests/a.test.ts",
        status: "passed",
        assertionResults: [
          { status: "passed", fullName: "A works", title: "works", failureMessages: [] },
          { status: "passed", fullName: "A also works", title: "also works", failureMessages: [] },
        ],
      },
    ],
  });

  test("全过", () => {
    const r = parseVitestJson(sample, { root: "C:/repo", dir: "" });
    assert.equal(r.status, "PASS");
    assert.equal(r.checks, 2);
    assert.equal(r.files.length, 1);
    assert.match(r.files[0].file, /miniprogram\/tests\/a\.test\.ts/);
  });

  test("失败用例", () => {
    const failed = JSON.stringify({
      numTotalTests: 1,
      numFailedTests: 1,
      success: false,
      testResults: [
        {
          name: "C:/repo/miniprogram/tests/b.test.ts",
          status: "failed",
          assertionResults: [
            {
              status: "failed",
              fullName: "B breaks",
              title: "breaks",
              failureMessages: ["Error: expected 1 got 2\n    at C:/repo/miniprogram/tests/b.test.ts:12:5"],
            },
          ],
        },
      ],
    });
    const r = parseVitestJson(failed, { root: "C:/repo", dir: "" });
    assert.equal(r.status, "FAIL");
    assert.equal(r.failures.length, 1);
    assert.match(r.failures[0].location, /b\.test\.ts:12/);
  });

  test("文件加载失败单列", () => {
    const broken = JSON.stringify({
      numTotalTests: 0,
      numFailedTests: 1,
      success: false,
      testResults: [
        {
          name: "C:/repo/miniprogram/tests/c.test.ts",
          status: "failed",
          assertionResults: [],
          message: "SyntaxError: unexpected token",
        },
      ],
    });
    const r = parseVitestJson(broken, { root: "C:/repo", dir: "" });
    assert.equal(r.status, "FAIL");
    assert.ok(r.failures.some((f) => /文件加载失败/.test(f.name)));
  });

  test("零用例 → FAIL", () => {
    const empty = JSON.stringify({ numTotalTests: 0, numFailedTests: 0, success: true, testResults: [] });
    const r = parseVitestJson(empty, { root: "C:/repo", dir: "" });
    assert.equal(r.status, "FAIL");
    assert.match(r.detail, /一个用例都没收集到/);
  });

  test("JSON 解析失败 → FAIL", () => {
    const r = parseVitestJson("not json", { root: "C:/repo", dir: "" });
    assert.equal(r.status, "FAIL");
  });
});

/* ------------------------------------------------------------------ */
/* parseTscOutput：tsc 输出解析                                       */
/* ------------------------------------------------------------------ */

describe("parseTscOutput", () => {
  test("空输出 → PASS", () => {
    const r = parseTscOutput("");
    assert.equal(r.status, "PASS");
  });

  test("有错误", () => {
    const r = parseTscOutput("src/a.ts(12,5): error TS2322: Type 'number' is not assignable.");
    assert.equal(r.status, "FAIL");
    assert.equal(r.failures.length, 1);
    assert.match(r.failures[0].location, /a\.ts:12/);
    assert.equal(r.failures[0].kind, "typecheck");
  });

  test("无法定位的输出 → FAIL", () => {
    const r = parseTscOutput("some garbage tsc output");
    assert.equal(r.status, "FAIL");
    assert.match(r.detail, /无法定位/);
  });
});

describe("combineNodeLayerResults", () => {
  test("vitest PASS + tsc PASS → PASS", () => {
    const v = { status: "PASS", checks: 10, failures: [], files: [] };
    const t = { status: "PASS", failures: [] };
    const r = combineNodeLayerResults(v, t);
    assert.equal(r.status, "PASS");
    assert.equal(r.checks, 10);
  });

  test("vitest PASS + tsc FAIL → FAIL", () => {
    const v = { status: "PASS", checks: 10, failures: [], files: [] };
    const t = { status: "FAIL", failures: [{ name: "err", kind: "typecheck" }], detail: "1 处类型错误" };
    const r = combineNodeLayerResults(v, t);
    assert.equal(r.status, "FAIL");
    assert.equal(r.failures.length, 1);
  });
});

/* ------------------------------------------------------------------ */
/* manifestIssues：清单查漏五类问题摊平                               */
/* ------------------------------------------------------------------ */

describe("manifestIssues", () => {
  test("五类问题全部摊平", () => {
    const check = {
      unregistered: [{ file: "a.ts", layer: "mp" }],
      missing: [{ file: "b.ts", layer: "mp" }],
      misplaced: [{ file: "c.ts", declared: "mp", actual: "server" }],
      unknownLayer: [{ file: "d.ts", layer: "ghost" }],
      emptyCovers: [{ file: "e.ts" }],
    };
    const issues = manifestIssues(check);
    assert.equal(issues.length, 5);
    assert.ok(issues.some((i) => /未登记/.test(i.name)));
    assert.ok(issues.some((i) => /文件不存在/.test(i.name)));
    assert.ok(issues.some((i) => /层不一致/.test(i.name)));
    assert.ok(issues.some((i) => /未知层/.test(i.name)));
    assert.ok(issues.some((i) => /缺少覆盖说明/.test(i.name)));
  });
});

/* ------------------------------------------------------------------ */
/* reportRoots / uniqueRunId / pickRunId：双池归档                    */
/* ------------------------------------------------------------------ */

describe("reportRoots", () => {
  test("日常池 = reports/", () => {
    const { runRoot } = reportRoots(false, "C:/repo");
    assert.equal(runRoot, resolve("C:/repo/reports"));
  });

  test("发布池 = docs/evidence/test-runs/", () => {
    const { runRoot } = reportRoots(true, "C:/repo");
    assert.equal(runRoot, resolve("C:/repo/docs/evidence/test-runs"));
  });
});

describe("uniqueRunId", () => {
  test("不撞名 → 原样返回", () => {
    assert.equal(uniqueRunId("2026-11-22T10-00-00-000", []), "2026-11-22T10-00-00-000");
  });

  test("撞名 → 追加 -02", () => {
    assert.equal(uniqueRunId("2026-11-22T10-00-00-000", ["2026-11-22T10-00-00-000"]), "2026-11-22T10-00-00-000-02");
  });

  test("连续撞名 → -03", () => {
    assert.equal(
      uniqueRunId("base", ["base", "base-02"]),
      "base-03",
    );
  });
});

describe("pickRunId", () => {
  let dir;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "bt-light-pickrun-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("空目录 → 原样", () => {
    const id = pickRunId(dir, new Date("2026-11-22T10:00:00.000Z"));
    assert.equal(id, "2026-11-22T10-00-00-000");
  });

  test("目录已存在 → 追加 -02", () => {
    mkdirSync(join(dir, "2026-11-22T10-00-00-000"));
    const id = pickRunId(dir, new Date("2026-11-22T10:00:00.000Z"));
    assert.equal(id, "2026-11-22T10-00-00-000-02");
  });
});

/* ------------------------------------------------------------------ */
/* executeLayers：三态语义 + 非法状态降级                             */
/* ------------------------------------------------------------------ */

describe("executeLayers", () => {
  test("全 PASS → conclusion PASS", () => {
    const specs = [
      { name: "a", label: "A", cheap: true, probe: () => [], run: () => ({ status: "PASS", checks: 1, detail: "1 用例通过", failures: [] }) },
      { name: "b", label: "B", cheap: true, probe: () => [], run: () => ({ status: "PASS", checks: 2, detail: "2 用例通过", failures: [] }) },
    ];
    const r = executeLayers(specs, { repoRoot: REPO });
    assert.equal(r.conclusion, "PASS");
    assert.equal(r.layers.length, 2);
  });

  test("有 FAIL → conclusion FAIL", () => {
    const specs = [
      { name: "a", label: "A", cheap: true, probe: () => [], run: () => ({ status: "FAIL", checks: null, detail: "坏了", failures: [{ name: "x" }] }) },
    ];
    const r = executeLayers(specs, { repoRoot: REPO });
    assert.equal(r.conclusion, "FAIL");
  });

  test("probe 返回缺失 → SKIP", () => {
    const specs = [
      { name: "a", label: "A", cheap: false, probe: () => ["缺 gcc"], run: () => ({ status: "PASS" }) },
    ];
    const r = executeLayers(specs, { repoRoot: REPO });
    assert.equal(r.layers[0].status, "SKIP");
    assert.equal(r.layers[0].skipReason, "缺 gcc");
    assert.equal(r.conclusion, "PASS");
  });

  test("非法状态 → FAIL", () => {
    const specs = [
      { name: "a", label: "A", cheap: true, probe: () => [], run: () => ({ status: "BOGUS" }) },
    ];
    const r = executeLayers(specs, { repoRoot: REPO });
    assert.equal(r.layers[0].status, "FAIL");
    assert.match(r.layers[0].detail, /非法状态/);
  });

  test("run 抛异常 → FAIL", () => {
    const specs = [
      {
        name: "a", label: "A", cheap: true, probe: () => [],
        run: () => { throw new Error("boom"); },
      },
    ];
    const r = executeLayers(specs, { repoRoot: REPO });
    assert.equal(r.layers[0].status, "FAIL");
    assert.match(r.layers[0].detail, /boom/);
  });

  test("SKIP 不改退出码（conclusion 仍 PASS）", () => {
    const specs = [
      { name: "a", label: "A", cheap: true, probe: () => [], run: () => ({ status: "PASS", checks: 1, detail: "ok", failures: [] }) },
      { name: "b", label: "B", cheap: false, probe: () => ["缺环境"], run: () => ({ status: "PASS" }) },
    ];
    const r = executeLayers(specs, { repoRoot: REPO });
    assert.equal(r.conclusion, "PASS");
    assert.equal(r.layers[1].status, "SKIP");
  });
});

/* ------------------------------------------------------------------ */
/* notWiredYet：未接入层占位                                          */
/* ------------------------------------------------------------------ */

describe("notWiredYet", () => {
  test("probe 返回尚未接入", () => {
    const spec = notWiredYet("ghost", "幽灵层");
    assert.deepEqual(spec.probe(), ["ghost 层尚未接入编排器"]);
  });

  test("run 返回 SKIP", () => {
    const spec = notWiredYet("ghost", "幽灵层");
    const r = spec.run();
    assert.equal(r.status, "SKIP");
    assert.match(r.skipReason, /尚未接入/);
  });
});

/* ------------------------------------------------------------------ */
/* diffRuns：只比用例数                                               */
/* ------------------------------------------------------------------ */

describe("diffRuns", () => {
  const makeLayer = (name, status, checks) => ({ name, label: name, status, checks, failures: [], skipped: [] });
  const makeFile = (path, layer, checks) => ({ path, layer, checks });

  test("首次运行（无 previous）→ 无法比对", () => {
    const current = {
      layers: [makeLayer("mp", "PASS", 10)],
      files: [makeFile("a.ts", "mp", 10)],
    };
    const r = diffRuns(current, null);
    /* previous=null 时 diffRuns 不应抛，但也不该假装有基线 */
    assert.equal(r.comparable, 0);
  });

  test("用例数变化 → changed", () => {
    const current = {
      layers: [makeLayer("mp", "PASS", 12)],
      files: [makeFile("a.ts", "mp", 12)],
    };
    const previous = {
      layers: [makeLayer("mp", "PASS", 10)],
      files: [makeFile("a.ts", "mp", 10)],
    };
    const r = diffRuns(current, previous);
    assert.equal(r.files.changed.length, 1);
    assert.equal(r.files.changed[0].delta, 2);
  });

  test("新失败 → newFailures", () => {
    const current = {
      layers: [{ ...makeLayer("mp", "FAIL", 10), failures: [{ name: "new fail", location: "a.ts:1" }] }],
      files: [makeFile("a.ts", "mp", 10)],
    };
    const previous = {
      layers: [makeLayer("mp", "PASS", 10)],
      files: [makeFile("a.ts", "mp", 10)],
    };
    const r = diffRuns(current, previous);
    assert.equal(r.newFailures.length, 1);
  });
});

/* ------------------------------------------------------------------ */
/* findPreviousReportDir / readPreviousReport：基线选择              */
/* ------------------------------------------------------------------ */

describe("findPreviousReportDir", () => {
  let dir;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "bt-light-prev-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("无目录 → null", () => {
    assert.equal(findPreviousReportDir(dir, "2026-11-22T10-00-00-000"), null);
  });

  test("有更早的带 report.json 的目录 → 返回它", () => {
    const older = join(dir, "2026-11-22T09-00-00-000");
    mkdirSync(older);
    writeFileSync(join(older, "report.json"), "{}");
    assert.equal(findPreviousReportDir(dir, "2026-11-22T10-00-00-000"), "2026-11-22T09-00-00-000");
  });

  test("跳过没有 report.json 的目录", () => {
    const noJson = join(dir, "2026-11-22T09-00-00-000");
    mkdirSync(noJson);
    const withJson = join(dir, "2026-11-22T08-00-00-000");
    mkdirSync(withJson);
    writeFileSync(join(withJson, "report.json"), "{}");
    assert.equal(findPreviousReportDir(dir, "2026-11-22T10-00-00-000"), "2026-11-22T08-00-00-000");
  });

  test("不拿自己当基线", () => {
    const self = join(dir, "2026-11-22T10-00-00-000");
    mkdirSync(self);
    writeFileSync(join(self, "report.json"), "{}");
    assert.equal(findPreviousReportDir(dir, "2026-11-22T10-00-00-000"), null);
  });
});

describe("readPreviousReport", () => {
  let dir;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "bt-light-readprev-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("合法 JSON → report", () => {
    writeFileSync(join(dir, "report.json"), JSON.stringify({ layers: [], files: [] }));
    const r = readPreviousReport(dir);
    assert.ok(r.report);
    assert.deepEqual(r.report.layers, []);
  });

  test("坏 JSON → error", () => {
    writeFileSync(join(dir, "report.json"), "not json");
    const r = readPreviousReport(dir);
    assert.ok(r.error);
  });

  test("缺文件 → error", () => {
    const r = readPreviousReport(dir);
    assert.ok(r.error);
  });
});

/* ------------------------------------------------------------------ */
/* renderReport：六段固定顺序 + 未验证清单                            */
/* ------------------------------------------------------------------ */

describe("renderReport", () => {
  const baseReport = {
    startedAt: "2026-11-22T10:00:00.000Z",
    finishedAt: "2026-11-22T10:00:05.000Z",
    runId: "2026-11-22T10-00-00-000",
    head: {
      commit: "43ff2c4",
      branch: "skeleton/orch",
      dirty: false,
      host: "test-host",
      platform: "win32 10.0",
      cpus: 8,
      layers: ["firmware", "mp"],
    },
    conclusion: "PASS",
    layers: [
      { name: "firmware", label: "固件", status: "PASS", checks: 10, unit: "断言", detail: "10 条断言通过", failures: [], skipped: [], extra: null, durationMs: 1000 },
      { name: "mp", label: "小程序", status: "PASS", checks: 5, unit: "用例", detail: "5 用例通过", failures: [], skipped: [], extra: { files: [{ file: "a.test.ts", checks: 5 }] }, durationMs: 2000 },
    ],
    files: [
      { path: "a.test.ts", layer: "mp", covers: "测试 A", checks: 5 },
    ],
  };

  test("六段标题顺序正确", () => {
    const md = renderReport(baseReport);
    const sections = ["## 分层结果", "## 未验证清单", "## 明细", "## 失败详情", "## 与上次运行"];
    let lastIdx = -1;
    for (const s of sections) {
      const idx = md.indexOf(s);
      assert.ok(idx > lastIdx, `段落顺序错：${s} 应在前一段之后`);
      lastIdx = idx;
    }
  });

  test("无 SKIP → 未验证清单写「本轮没有未验证的层。」", () => {
    const md = renderReport(baseReport);
    assert.match(md, /本轮没有未验证的层。/);
  });

  test("有 SKIP → 未验证清单列出原因", () => {
    const r = { ...baseReport, conclusion: "PASS", layers: [
      ...baseReport.layers,
      { name: "ui", label: "渲染回归", status: "SKIP", checks: null, unit: "断言", detail: "", failures: [], skipped: [], skipReason: "缺微信开发者工具", extra: null, durationMs: 0 },
    ] };
    const md = renderReport(r);
    assert.match(md, /未验证清单/);
    assert.match(md, /渲染回归.*缺微信开发者工具/);
  });

  test("有 FAIL → 结论 ❌ 有失败", () => {
    const r = { ...baseReport, conclusion: "FAIL" };
    const md = renderReport(r);
    assert.match(md, /❌ 有失败/);
  });

  test("全 SKIP 但有层内跳过 → ✅ 通过（N 项层内跳过）", () => {
    const r = { ...baseReport, conclusion: "PASS", layers: [
      { name: "firmware", label: "固件", status: "PASS", checks: 10, unit: "断言", detail: "ok", failures: [], skipped: ["node not found"], extra: null, durationMs: 100 },
    ] };
    const md = renderReport(r);
    assert.match(md, /✅ 通过（1 项层内跳过）/);
  });

  test("release + SKIP → 横幅出现", () => {
    const r = { ...baseReport, conclusion: "PASS", layers: [
      ...baseReport.layers,
      { name: "ble", label: "真机 e2e", status: "SKIP", checks: null, unit: "断言", detail: "", failures: [], skipped: [], skipReason: "缺真机", extra: null, durationMs: 0 },
    ] };
    const md = renderReport(r, { release: true });
    assert.match(md, /发布级证据，但本轮发布未覆盖/);
    assert.match(md, /真机 e2e/);
  });

  test("release 无 SKIP → 无横幅", () => {
    const md = renderReport(baseReport, { release: true });
    assert.ok(!md.includes("发布级证据，但本轮发布未覆盖"));
  });

  test("失败详情段有内容时列出", () => {
    const r = { ...baseReport, conclusion: "FAIL", layers: [
      { name: "mp", label: "小程序", status: "FAIL", checks: 5, unit: "用例", detail: "1/5 失败", failures: [{ name: "用例 X", detail: "expected 1 got 2", location: "a.test.ts:12", kind: "test" }], skipped: [], extra: null, durationMs: 100 },
    ] };
    const md = renderReport(r);
    assert.match(md, /失败详情/);
    assert.match(md, /用例 X/);
    assert.match(md, /a\.test\.ts:12/);
  });
});

/* ------------------------------------------------------------------ */
/* writeReport：写 md + json                                          */
/* ------------------------------------------------------------------ */

describe("writeReport", () => {
  test("写出 report.md 与 report.json", () => {
    const dir = mkdtempSync(join(tmpdir(), "bt-light-write-"));
    try {
      const report = {
        startedAt: "2026-11-22T10:00:00.000Z",
        finishedAt: "2026-11-22T10:00:01.000Z",
        runId: "test",
        head: { commit: "x", branch: "y", dirty: false, host: "h", platform: "p", cpus: 1, layers: [] },
        conclusion: "PASS",
        layers: [],
        files: [],
      };
      const written = writeReport(report, dir, {});
      assert.ok(existsSync(written.mdPath));
      assert.ok(existsSync(written.jsonPath));
      const json = JSON.parse(readFileSync(written.jsonPath, "utf8"));
      assert.equal(json.conclusion, "PASS");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/* ------------------------------------------------------------------ */
/* buildLayerSpecs：五层规格                                          */
/* ------------------------------------------------------------------ */

describe("buildLayerSpecs", () => {
  test("五层全部构造", () => {
    const manifest = loadManifest(REPO);
    const specs = buildLayerSpecs(manifest, { repoRoot: REPO });
    assert.ok(specs.firmware);
    assert.ok(specs.mp);
    assert.ok(specs.server);
    assert.ok(specs.ui);
    assert.ok(specs.ble);
    assert.equal(specs.firmware.cheap, true);
    assert.equal(specs.mp.cheap, true);
    assert.equal(specs.server.cheap, true);
    assert.equal(specs.ui.cheap, false);
    assert.equal(specs.ble.cheap, false);
  });
});

/* ------------------------------------------------------------------ */
/* checkManifest：清单查漏（真实仓库）                                */
/* ------------------------------------------------------------------ */

describe("checkManifest", () => {
  test("真实仓库 → ok", () => {
    const manifest = loadManifest(REPO);
    const result = checkManifest(manifest, REPO);
    assert.equal(result.ok, true, `清单查漏失败：${JSON.stringify(result)}`);
    assert.ok(result.total > 0);
  });
});

/* ------------------------------------------------------------------ */
/* checkManifest 负向：临时改 manifest → 必须 FAIL                    */
/* ------------------------------------------------------------------ */

describe("checkManifest 负向（临时改 manifest 验证会 FAIL）", () => {
  let tmpRepo;
  beforeEach(() => {
    tmpRepo = mkdtempSync(join(tmpdir(), "bt-light-neg-"));
    /* 造一个最小仓库结构 */
    mkdirSync(join(tmpRepo, "docs"), { recursive: true });
    mkdirSync(join(tmpRepo, "miniprogram", "tests"), { recursive: true });
    writeFileSync(join(tmpRepo, "miniprogram", "tests", "a.test.ts"), "");
    /* 故意不登记 a.test.ts 的 manifest */
    writeFileSync(
      join(tmpRepo, "docs", "test-manifest.json"),
      JSON.stringify({
        version: 1,
        layers: { mp: { label: "MP", cheap: true, requires: [], missingHint: "", scan: ["miniprogram/tests/*.test.ts"] } },
        files: {},
      }),
    );
  });
  afterEach(() => {
    rmSync(tmpRepo, { recursive: true, force: true });
  });

  test("未登记文件 → ok=false", () => {
    const manifest = loadManifest(tmpRepo);
    const result = checkManifest(manifest, tmpRepo);
    assert.equal(result.ok, false);
    assert.equal(result.unregistered.length, 1);
    assert.equal(result.unregistered[0].file, "miniprogram/tests/a.test.ts");
  });

  test("登记了不存在的文件 → missing", () => {
    writeFileSync(
      join(tmpRepo, "docs", "test-manifest.json"),
      JSON.stringify({
        version: 1,
        layers: { mp: { label: "MP", cheap: true, requires: [], missingHint: "", scan: ["miniprogram/tests/*.test.ts"] } },
        files: { "miniprogram/tests/ghost.test.ts": { layer: "mp", covers: "幽灵" } },
      }),
    );
    const manifest = loadManifest(tmpRepo);
    const result = checkManifest(manifest, tmpRepo);
    assert.equal(result.ok, false);
    assert.equal(result.missing.length, 1);
  });

  test("层不一致 → misplaced", () => {
    writeFileSync(
      join(tmpRepo, "docs", "test-manifest.json"),
      JSON.stringify({
        version: 1,
        layers: {
          mp: { label: "MP", cheap: true, requires: [], missingHint: "", scan: ["miniprogram/tests/*.test.ts"] },
          server: { label: "Server", cheap: true, requires: [], missingHint: "", scan: [] },
        },
        files: { "miniprogram/tests/a.test.ts": { layer: "server", covers: "错层" } },
      }),
    );
    const manifest = loadManifest(tmpRepo);
    const result = checkManifest(manifest, tmpRepo);
    assert.equal(result.ok, false);
    assert.equal(result.misplaced.length, 1);
  });

  test("covers 为空 → emptyCovers", () => {
    writeFileSync(
      join(tmpRepo, "docs", "test-manifest.json"),
      JSON.stringify({
        version: 1,
        layers: { mp: { label: "MP", cheap: true, requires: [], missingHint: "", scan: ["miniprogram/tests/*.test.ts"] } },
        files: { "miniprogram/tests/a.test.ts": { layer: "mp", covers: "" } },
      }),
    );
    const manifest = loadManifest(tmpRepo);
    const result = checkManifest(manifest, tmpRepo);
    assert.equal(result.ok, false);
    assert.equal(result.emptyCovers.length, 1);
  });
});