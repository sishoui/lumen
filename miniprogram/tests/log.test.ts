/** 帧日志（FrameLog / Formatter）：TX/RX、commandName、hex、seq、复制文本格式。 */

import { describe, it, expect, beforeEach } from "vitest";
import { FrameLog } from "../utils/ble/log";
import { commandName } from "../utils/protocol/constants";
import { CMD } from "../utils/protocol/constants";

describe("FrameLog", () => {
  let log: FrameLog;

  beforeEach(() => {
    log = new FrameLog({ capacity: 10 });
  });

  it("push 返回带 id 的完整条目，snapshot 反映已写入", () => {
    const entry = log.push({
      ts: 1000, dir: "tx", command: CMD.SET_POWER, seq: 1,
      hex: "AABB", parsed: "cmd=0x1", ok: true,
    });
    expect(entry.id).toBe(1);
    expect(log.snapshot()).toHaveLength(1);
    expect(log.snapshot()[0]).toBe(entry);
  });

  it("push 时补全 commandName（入口不靠展示层回填）", () => {
    const entry = log.push({
      ts: 1000, dir: "rx", command: CMD.SELF_TEST, seq: 2,
      hex: "AABB", parsed: "cmd=0x7", ok: true,
    });
    expect(entry.commandName).toBe("SelfTest");
  });

  it("未知命令的 commandName 走回退（0xXX 形式）", () => {
    const entry = log.push({
      ts: 1000, dir: "rx", command: 0x77, seq: 3,
      hex: "AABB", parsed: "cmd=0x77", ok: true,
    });
    expect(entry.commandName).toBe("0x77");
  });

  it("无 command 的条目不补全 commandName（事件行）", () => {
    const entry = log.push({
      ts: 1000, dir: "rx", hex: "AABB", parsed: "event", ok: true,
    });
    expect(entry.commandName).toBeUndefined();
    expect(entry.seq).toBeUndefined();
  });

  it("容量超出时环形裁剪（保留最新）", () => {
    for (let i = 0; i < 15; i += 1) {
      log.push({ ts: i, dir: "tx", command: CMD.SET_POWER, seq: i, hex: "AA", parsed: "p", ok: true });
    }
    const snapshot = log.snapshot();
    expect(snapshot).toHaveLength(10);
    expect(snapshot[0].seq).toBe(5);
    expect(snapshot[9].seq).toBe(14);
  });

  it("clear 后 snapshot 为空", () => {
    log.push({ ts: 1000, dir: "tx", command: CMD.SET_POWER, seq: 1, hex: "AA", parsed: "p", ok: true });
    log.clear();
    expect(log.snapshot()).toEqual([]);
  });

  it("onAppend 订阅回调；退订后不再触发", () => {
    let count = 0;
    const off = log.onAppend(() => { count += 1; });
    log.push({ ts: 1000, dir: "tx", command: CMD.SET_POWER, seq: 1, hex: "AA", parsed: "p", ok: true });
    expect(count).toBe(1);
    off();
    log.push({ ts: 1000, dir: "tx", command: CMD.SET_POWER, seq: 2, hex: "AA", parsed: "p", ok: true });
    expect(count).toBe(1);
  });
});

describe("Formatter：复制文本格式", () => {
  it("复制行格式 DIR seq=<n> <commandName> <hex>", () => {
    // 与 log-panel.ts onCopy 保持一致的格式契约
    const entries = [
      { dir: "tx", seqText: "seq=1", commandName: "SelfTest", hex: "AABB" },
      { dir: "rx", seqText: "seq=1", commandName: "ACK", hex: "CCDD" },
      { dir: "rx", seqText: "", commandName: "Event", hex: "EEFF" },
    ];
    const text = entries
      .map((e) => `${e.dir.toUpperCase()}${e.seqText ? ` ${e.seqText}` : ""} ${e.commandName} ${e.hex}`)
      .join("\n");
    const lines = text.split("\n");
    expect(lines[0]).toBe("TX seq=1 SelfTest AABB");
    expect(lines[1]).toBe("RX seq=1 ACK CCDD");
    // 无 seq 的事件行不输出空 seq 段
    expect(lines[2]).toBe("RX Event EEFF");
  });

  it("命令名表对未知命令回退到 0xXX", () => {
    expect(commandName(0x77)).toBe("0x77");
    expect(commandName(CMD.SELF_TEST)).toBe("SelfTest");
  });
});