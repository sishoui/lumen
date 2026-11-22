/** ReconnectSupervisor：1s/2s/4s 退避 + 耗尽。 */

import { describe, it, expect, vi } from "vitest";
import { ReconnectSupervisor, type ReconnectHost } from "../utils/session/reconnect";
import { createFakeTimer } from "./helpers/fake-timer";
import type { LinkState } from "../utils/protocol/types";

function makeHost(overrides: Partial<ReconnectHost> = {}): ReconnectHost & { connectCalls: number } {
  let state: LinkState = "ready";
  const host = {
    connectCalls: 0,
    linkState: () => state,
    cached: () => ({ deviceId: "D1" }),
    connect: (_id: string, _name?: string) => {
      host.connectCalls += 1;
      return Promise.resolve({ power: 1 });
    },
    disconnect: () => Promise.resolve(),
    refresh: () => Promise.resolve({}),
    clearDeviceState: () => undefined,
    onConnected: () => undefined,
    ...overrides,
  };
  return host;
}

describe("ReconnectSupervisor", () => {
  it("退避序列 1s/2s/4s", async () => {
    const timer = createFakeTimer();
    const host = makeHost();
    const sup = new ReconnectSupervisor(host, { timer, delaysMs: [1000, 2000, 4000], initialLink: "ready" });

    // ready → reconnecting（非主动断线）
    sup.onLinkChange("reconnecting");
    expect(sup.pending).toBe(true);

    timer.advance(1000);
    await Promise.resolve();
    expect(host.connectCalls).toBe(1);

    // 模拟失败：重新进入 reconnecting
    sup.onLinkChange("reconnecting");
    timer.advance(2000);
    await Promise.resolve();
    expect(host.connectCalls).toBe(2);

    sup.onLinkChange("reconnecting");
    timer.advance(4000);
    await Promise.resolve();
    expect(host.connectCalls).toBe(3);

    // 耗尽
    sup.onLinkChange("reconnecting");
    timer.advance(10000);
    await Promise.resolve();
    expect(host.connectCalls).toBe(3); // 不再重试
  });

  it("主动断开后 onShow 不擅自回连", () => {
    const timer = createFakeTimer();
    const host = makeHost();
    const sup = new ReconnectSupervisor(host, { timer, delaysMs: [1000], initialLink: "ready" });
    sup.onManualDisconnect();
    sup.onShow();
    timer.advance(2000);
    expect(host.connectCalls).toBe(0);
  });

  it("ready 后重置退避计数", async () => {
    const timer = createFakeTimer();
    const host = makeHost();
    const sup = new ReconnectSupervisor(host, { timer, delaysMs: [1000, 2000], initialLink: "ready" });
    sup.onLinkChange("reconnecting");
    timer.advance(1000);
    await Promise.resolve();
    expect(host.connectCalls).toBe(1);
    sup.onLinkChange("ready");
    // 再次断线，应该从 1s 重新开始
    sup.onLinkChange("reconnecting");
    timer.advance(1000);
    await Promise.resolve();
    expect(host.connectCalls).toBe(2);
  });
});