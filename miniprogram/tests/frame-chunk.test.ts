/** 帧边界 / 分片重组边界。 */

import { describe, it, expect } from "vitest";
import { encodeFrame, decodeFrame } from "../utils/protocol/frame";
import { chunkFrame, ChunkAssembler } from "../utils/protocol/chunk";
import { bytesToCompactHex } from "../utils/protocol/hex";

describe("帧边界", () => {
  it("8 字节 header + 0 payload = 8 字节帧", () => {
    const f = encodeFrame(0x05, 1);
    expect(f.length).toBe(8);
  });

  it("短帧（<8）decode 返回 short", () => {
    const r = decodeFrame(new Uint8Array(4));
    expect(r.ok).toBe(false);
  });

  it("magic 错返回 magic", () => {
    const f = encodeFrame(0x01, 1, [1]);
    f[0] = 0x00;
    const r = decodeFrame(f);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("magic");
  });

  it("version 错返回 version", () => {
    const f = encodeFrame(0x01, 1, [1]);
    f[1] = 0x04;
    const r = decodeFrame(f);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("version");
  });

  it("CRC 错返回 crc", () => {
    const f = encodeFrame(0x01, 1, [1]);
    f[f.length - 1] ^= 0xff;
    const r = decodeFrame(f);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("crc");
  });

  it("length 声明 > 实际返回 length", () => {
    const f = encodeFrame(0x01, 1, [1]);
    f[4] = 200;
    const r = decodeFrame(f);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("length");
  });
});

describe("分片", () => {
  it("单分片 ctrl = 0xC0", () => {
    const frame = encodeFrame(0x01, 1, [1]);
    const chunks = chunkFrame(frame, 20);
    expect(chunks.length).toBe(1);
    expect(chunks[0][0]).toBe(0xc0);
  });

  it("多分片 FIRST/LAST/序号正确", () => {
    const big = new Uint8Array(100);
    for (let i = 0; i < 100; i += 1) big[i] = i & 0xff;
    const frame = encodeFrame(0x01, 1, big);
    const chunks = chunkFrame(frame, 20);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[0][0] & 0x80).toBe(0x80); // FIRST
    expect(chunks[chunks.length - 1][0] & 0x40).toBe(0x40); // LAST
  });

  it("重组后 == 原帧", () => {
    const big = new Uint8Array(80);
    for (let i = 0; i < 80; i += 1) big[i] = (i * 7) & 0xff;
    const frame = encodeFrame(0x05, 42, big);
    const chunks = chunkFrame(frame, 20);
    const asm = new ChunkAssembler({ now: () => Date.now() });
    let out: Uint8Array | null = null;
    for (const c of chunks) {
      const r = asm.push(c);
      if (r.kind === "frame") out = r.frame;
    }
    expect(out).not.toBeNull();
    expect(bytesToCompactHex(out!)).toBe(bytesToCompactHex(frame));
  });

  it("孤立续片（无 FIRST）返回 orphan", () => {
    const asm = new ChunkAssembler();
    const r = asm.push(new Uint8Array([0x01, 0xaa])); // 无 FIRST
    expect(r.kind).toBe("error");
    if (r.kind === "error") expect(r.reason).toBe("orphan");
  });

  it("FIRST 重入丢弃旧缓冲", () => {
    const asm = new ChunkAssembler({ now: () => Date.now() });
    asm.push(new Uint8Array([0x80, 0x01])); // FIRST，未完成
    expect(asm.pending).toBe(true);
    asm.push(new Uint8Array([0xc0, 0x02, 0x03])); // 新 FIRST|LAST
    expect(asm.pending).toBe(false);
  });
});