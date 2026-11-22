/**
 * 边界测试（源码扫描）：
 *  - session/ 下不出现 mock 分支（无 `if (mock)` / `import.*mock`）；
 *  - 全仓 wx. 只出现在 utils/ble/ 下。
 */

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MP_ROOT = join(__dirname, "..");

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      out.push(...walk(full));
    } else if (entry.endsWith(".ts")) {
      out.push(full);
    }
  }
  return out;
}

describe("boundary：session 零 mock 分支", () => {
  const sessionFiles = walk(join(MP_ROOT, "utils/session")).filter(
    (f) => !f.endsWith("singleton.ts"), // singleton 是注入点，允许 import mock
  );

  it("session/ 下无 import.*mock（singleton.ts 除外）", () => {
    for (const f of sessionFiles) {
      const src = readFileSync(f, "utf8");
      expect(src, `${f} 不应 import mock`).not.toMatch(/import\s+.*from\s+["'][^"']*mock/i);
    }
  });

  it("session/ 下无 `if (mock` / `if (isMock`（singleton.ts 除外）", () => {
    for (const f of sessionFiles) {
      const src = readFileSync(f, "utf8");
      expect(src, `${f} 不应有 mock 分支`).not.toMatch(/if\s*\(\s*(is)?[Mm]ock/i);
    }
  });
});

describe("boundary：wx. 只在 utils/ble/ 下", () => {
  const allFiles = walk(join(MP_ROOT, "utils"));

  it("utils/ 下非 ble/ 文件不直触 wx.", () => {
    for (const f of allFiles) {
      if (f.includes("/utils/ble/")) continue;
      const src = readFileSync(f, "utf8");
      // 跳过注释里的 wx.
      const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
      expect(code, `${f} 不应直触 wx.`).not.toMatch(/\bwx\./);
    }
  });
});