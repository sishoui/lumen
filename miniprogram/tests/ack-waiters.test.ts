/** ACK 等待表：seq 匹配 / 超时 / 断线清空。 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { AckWaiters } from "../utils/ble/ack-waiters";
import type { AckResult } from "../utils/protocol/types";

describe("AckWaiters", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("settle 兑现正确的等待者", async () => {
    const w = new AckWaiters();
    const p = w.register(1, 0x01, 600);
    const ack: AckResult = { seq: 1, command: 0x01, resultCode: 0, ok: true };
    w.settle(1, ack);
    await expect(p).resolves.toEqual(ack);
  });

  it("seq 不匹配不兑现", async () => {
    const w = new AckWaiters();
    const p = w.register(1, 0x01, 600);
    w.settle(2, { seq: 2, command: 0x01, resultCode: 0, ok: true });
    // 让超时触发
    vi.advanceTimersByTime(700);
    await expect(p).rejects.toThrow();
  });

  it("原命令字不匹配不兑现", async () => {
    const w = new AckWaiters();
    const p = w.register(1, 0x01, 600);
    w.settle(1, { seq: 1, command: 0x02, resultCode: 0, ok: true });
    vi.advanceTimersByTime(700);
    await expect(p).rejects.toThrow();
  });

  it("超时 reject", async () => {
    const w = new AckWaiters();
    const p = w.register(1, 0x01, 600);
    vi.advanceTimersByTime(601);
    await expect(p).rejects.toThrow();
  });

  it("reset reject 所有等待者", async () => {
    const w = new AckWaiters();
    const p1 = w.register(1, 0x01, 600);
    const p2 = w.register(2, 0x02, 600);
    w.reset(new Error("断线"));
    await expect(p1).rejects.toThrow("断线");
    await expect(p2).rejects.toThrow("断线");
  });

  it("fail(seq) reject 对应等待者", async () => {
    const w = new AckWaiters();
    const p = w.register(1, 0x01, 600);
    w.fail(1, new Error("写失败"));
    await expect(p).rejects.toThrow("写失败");
  });
});