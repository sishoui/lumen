/**
 * 协议向量断言（工单 #4 / #6 决策 9）。
 * readFileSync + JSON.parse 同一份 docs/protocol-testvectors.json；
 * 断言对象是产品代码 encodeFrame/decodeFrame 输出 vs frame_hex / payload_hex；
 * PROTOCOL_VERSION 常量 vs JSON protocol_version。不在测试里重写编码实现。
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { encodeFrame, decodeFrame, crc16 } from "../utils/protocol/frame";
import { bytesToCompactHex, hexToBytes } from "../utils/protocol/hex";
import { chunkFrame } from "../utils/protocol/chunk";
import { PROTOCOL_VERSION, MAGIC } from "../utils/protocol/constants";

const vectorsPath = new URL("../../docs/protocol-testvectors.json", import.meta.url);
const vectors = JSON.parse(readFileSync(vectorsPath, "utf8")) as {
  protocol_version: number;
  magic: string;
  cases: Array<{
    name: string;
    direction: string;
    command: number;
    command_name: string;
    seq: number;
    payload_hex: string;
    payload_len: number;
    frame_hex: string;
    frame_len: number;
    chunks_hex: string[];
    frame_valid: boolean;
    result_code: number;
  }>;
};

describe("协议向量", () => {
  it("PROTOCOL_VERSION 与 JSON protocol_version 一致", () => {
    expect(PROTOCOL_VERSION).toBe(vectors.protocol_version);
  });

  it("magic 常量与 JSON 一致", () => {
    expect(MAGIC).toBe(parseInt(vectors.magic, 16));
  });

  it("CRC16 CCITT-FALSE 标准校验值", () => {
    const check = new TextEncoder().encode("123456789");
    expect(crc16(check)).toBe(0x29b1);
  });

  for (const c of vectors.cases) {
    describe(c.name, () => {
      it("encodeFrame 输出 == frame_hex（仅对 frame_valid=true 的帧）", () => {
        if (!c.frame_valid) return; // 坏帧的 frame_hex 是人工构造的，不由 encodeFrame 产生
        const payload = c.payload_hex ? hexToBytes(c.payload_hex)! : new Uint8Array(0);
        const frame = encodeFrame(c.command, c.seq, payload);
        expect(bytesToCompactHex(frame)).toBe(c.frame_hex);
        expect(frame.length).toBe(c.frame_len);
      });

      it("decodeFrame 还原 == payload_hex（信封合法时）", () => {
        const frame = hexToBytes(c.frame_hex)!;
        const result = decodeFrame(frame);
        if (c.frame_valid) {
          expect(result.ok).toBe(true);
          if (result.ok) {
            expect(result.command).toBe(c.command);
            expect(result.seq).toBe(c.seq);
            expect(bytesToCompactHex(result.payload)).toBe(c.payload_hex);
          }
        } else {
          // 坏帧：bad_magic/version/length/checksum 必须被 decodeFrame 拒绝；
          // set_power_bad_value / retired_set_color 是信封合法但语义非法，decodeFrame 通过
          const badEnvelope = ["bad_magic", "bad_version", "bad_length", "bad_checksum"].includes(c.name);
          if (badEnvelope) {
            expect(result.ok).toBe(false);
          } else {
            expect(result.ok).toBe(true);
          }
        }
      });

      it("chunkFrame(单分片) 输出 == chunks_hex[0]", () => {
        const frame = hexToBytes(c.frame_hex)!;
        const chunks = chunkFrame(frame, 20);
        expect(chunks.length).toBe(1);
        expect(bytesToCompactHex(chunks[0])).toBe(c.chunks_hex[0]);
      });
    });
  }

  describe("坏帧拒绝", () => {
    const badCases = vectors.cases.filter((c) =>
      ["bad_magic", "bad_version", "bad_length", "bad_checksum"].includes(c.name)
    );
    it("每个坏信封 decodeFrame 返回非 ok", () => {
      for (const c of badCases) {
        const frame = hexToBytes(c.frame_hex)!;
        const result = decodeFrame(frame);
        expect(result.ok, `${c.name} 应当被拒绝`).toBe(false);
      }
    });
  });

  describe("帧超长拒绝", () => {
    it("payload 超过 232 抛 FrameTooLongError", () => {
      const big = new Uint8Array(233);
      expect(() => encodeFrame(0x01, 1, big)).toThrow();
    });
  });
});