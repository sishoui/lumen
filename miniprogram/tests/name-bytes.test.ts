/** 名字 UTF-8 字节数校验边界（#29）：ASCII / 中文 8/9 / emoji 6/7 / 24-25 字节。 */

import { describe, it, expect } from "vitest";
import { utf8ByteLength, validateNameBytes, nameByteLabel } from "../utils/name-bytes";
import { NAME_BYTES } from "../utils/protocol/constants";

const CJK8 = "一二三四五六七八"; // 8 个中文 = 24 字节
const CJK9 = "一二三四五六七八九"; // 9 个中文 = 27 字节
const EMOJI6 = "😀😀😀😀😀😀"; // 6 个代理对 = 24 字节
const EMOJI7 = "😀😀😀😀😀😀😀"; // 7 个 = 28 字节

describe("utf8ByteLength", () => {
  it("ASCII 每字符 1 字节", () => {
    expect(utf8ByteLength("")).toBe(0);
    expect(utf8ByteLength("abc")).toBe(3);
    expect(utf8ByteLength("a".repeat(24))).toBe(24);
    expect(utf8ByteLength("a".repeat(25))).toBe(25);
  });

  it("中文每字符 3 字节", () => {
    expect(utf8ByteLength("中")).toBe(3);
    expect(utf8ByteLength(CJK8)).toBe(24);
    expect(utf8ByteLength(CJK9)).toBe(27);
  });

  it("emoji（代理对）每字符 4 字节", () => {
    expect(utf8ByteLength(EMOJI6)).toBe(24);
    expect(utf8ByteLength(EMOJI7)).toBe(28);
  });

  it("混合：ASCII + 中文 + emoji 累加正确", () => {
    // "ab" (2) + "中" (3) + emoji (4) = 9
    expect(utf8ByteLength("ab中😀")).toBe(9);
  });
});

describe("validateNameBytes", () => {
  it("24 字节边界：恰好 24 通过", () => {
    const ok24 = validateNameBytes(CJK8);
    expect(ok24.ok).toBe(true);
    expect(ok24.bytes).toBe(24);
    expect(ok24.limit).toBe(NAME_BYTES);
    expect(ok24.message).toBe("");

    expect(validateNameBytes("a".repeat(24)).ok).toBe(true);
    expect(validateNameBytes(EMOJI6).ok).toBe(true);
  });

  it("25 字节边界：25 字节被拦，message 含具体字节数与上限", () => {
    const over25 = validateNameBytes("a".repeat(25));
    expect(over25.ok).toBe(false);
    expect(over25.bytes).toBe(25);
    expect(over25.message).toBe("名字是 25 字节，上限 24");
  });

  it("9 个中文（27 字节）被拦，message 含 27/24", () => {
    const over = validateNameBytes(CJK9);
    expect(over.ok).toBe(false);
    expect(over.bytes).toBe(27);
    expect(over.message).toContain("27");
    expect(over.message).toContain("24");
  });

  it("7 个 emoji（28 字节）被拦，message 含 28/24", () => {
    const over = validateNameBytes(EMOJI7);
    expect(over.ok).toBe(false);
    expect(over.bytes).toBe(28);
    expect(over.message).toContain("28");
    expect(over.message).toContain("24");
  });

  it("自定义 limit 生效", () => {
    const r = validateNameBytes("abcd", 3);
    expect(r.ok).toBe(false);
    expect(r.limit).toBe(3);
    expect(r.message).toBe("名字是 4 字节，上限 3");
  });
});

describe("nameByteLabel", () => {
  it("文案形如「已用 X / 24 字节」", () => {
    expect(nameByteLabel("")).toBe("已用 0 / 24 字节");
    expect(nameByteLabel(CJK8)).toBe("已用 24 / 24 字节");
    expect(nameByteLabel(CJK9)).toBe("已用 27 / 24 字节");
  });
});