/** SerialWriter 串行化（假 sendOne）。 */

import { describe, it, expect, vi } from "vitest";
import { SerialWriter } from "../utils/ble/writer";

describe("SerialWriter", () => {
  it("单飞：任意时刻最多一个 sendOne 在飞", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const sendOne = vi.fn((_bytes: Uint8Array) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      return new Promise<void>((resolve) => {
        setTimeout(() => { inFlight -= 1; resolve(); }, 5);
      });
    });
    const w = new SerialWriter(sendOne);
    await Promise.all([
      w.enqueue(new Uint8Array([1])),
      w.enqueue(new Uint8Array([2])),
      w.enqueue(new Uint8Array([3])),
    ]);
    expect(maxInFlight).toBe(1);
    expect(sendOne).toHaveBeenCalledTimes(3);
  });

  it("FIFO 顺序", async () => {
    const order: number[] = [];
    const sendOne = vi.fn((bytes: Uint8Array) => {
      order.push(bytes[0]);
      return Promise.resolve();
    });
    const w = new SerialWriter(sendOne);
    await Promise.all([
      w.enqueue(new Uint8Array([1])),
      w.enqueue(new Uint8Array([2])),
      w.enqueue(new Uint8Array([3])),
    ]);
    expect(order).toEqual([1, 2, 3]);
  });

  it("reset reject 队列与在飞帧", async () => {
    let rejectInFlight: ((e: Error) => void) | null = null;
    const sendOne = vi.fn(() => new Promise<void>((_resolve, reject) => { rejectInFlight = reject; }));
    const w = new SerialWriter(sendOne);
    const p1 = w.enqueue(new Uint8Array([1]));
    await Promise.resolve();
    const p2 = w.enqueue(new Uint8Array([2]));
    w.reset(new Error("断线"));
    await expect(p1).rejects.toThrow("断线");
    await expect(p2).rejects.toThrow("断线");
    rejectInFlight?.(new Error("断线"));
  });

  it("reset 后入队立即失败", async () => {
    const w = new SerialWriter(() => Promise.resolve());
    w.reset(new Error("断线"));
    await expect(w.enqueue(new Uint8Array([1]))).rejects.toThrow("断线");
  });

  it("revive 后恢复", async () => {
    const w = new SerialWriter(() => Promise.resolve());
    w.reset(new Error("断线"));
    w.revive();
    await expect(w.enqueue(new Uint8Array([1]))).resolves.toBeUndefined();
  });

  it("busy 标志", async () => {
    const sendOne = vi.fn(() => new Promise<void>((resolve) => setTimeout(resolve, 10)));
    const w = new SerialWriter(sendOne);
    expect(w.busy).toBe(false);
    void w.enqueue(new Uint8Array([1]));
    expect(w.busy).toBe(true);
  });
});