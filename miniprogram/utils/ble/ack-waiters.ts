/**
 * ACK 等待表：seq → 一个等待中的离散命令。
 * 只有传输层使用。register 时挂超时，收到 ACK 时按 seq + 原命令字匹配兑现，
 * 写失败或断线时统一 reject。
 */

import type { AckResult } from "../protocol/types";
import { WxCallTimeoutError } from "./errors";

interface AckWaiter {
  command: number;
  resolve: (ack: AckResult) => void;
  reject: (err: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class AckWaiters {
  private readonly waiters = new Map<number, AckWaiter>();

  register(seq: number, command: number, timeoutMs: number): Promise<AckResult> {
    const promise = new Promise<AckResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters.delete(seq);
        reject(new WxCallTimeoutError("ACK", timeoutMs));
      }, timeoutMs);
      this.waiters.set(seq, { command, resolve, reject: (err) => reject(err), timer });
    });
    promise.catch(() => undefined);
    return promise;
  }

  /** 收到 ACK：seq 与原命令字都对上才兑现，否则只记录。 */
  settle(seq: number, ack: AckResult): void {
    const waiter = this.waiters.get(seq);
    if (waiter === undefined) return;
    if (waiter.command !== ack.command) {
      console.warn(`[bt-light] ACK 原命令字不匹配 seq=${seq}`);
      return;
    }
    clearTimeout(waiter.timer);
    this.waiters.delete(seq);
    waiter.resolve(ack);
  }

  /** 这一帧没发出去：同 seq 的等待者立即失败。 */
  fail(seq: number, err: unknown): void {
    const waiter = this.waiters.get(seq);
    if (waiter === undefined) return;
    clearTimeout(waiter.timer);
    this.waiters.delete(seq);
    waiter.reject(err);
  }

  /** 断线 / 销毁：所有等待者一起 reject。 */
  reset(reason: Error): void {
    for (const waiter of this.waiters.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(reason);
    }
    this.waiters.clear();
  }
}