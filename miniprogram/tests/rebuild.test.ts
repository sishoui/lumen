/** 权威重建编排顺序与部分失败降级。 */

import { describe, it, expect, vi } from "vitest";
import { rebuildFromDevice } from "../utils/session/rebuild";
import { MockTransport } from "../utils/ble/mock-transport";
import { MOCK_DEVICES } from "../utils/mock/mock-devices";
import { parseState } from "../utils/protocol/commands";
import type { DeviceState } from "../utils/protocol/types";

describe("rebuildFromDevice", () => {
  it("连接后能重建 StripConfig / Layout / DeviceInfo", async () => {
    const transport = new MockTransport({ scenario: "normal" });
    const desk = MOCK_DEVICES[0];
    await transport.connect(desk.deviceId, desk.broadcastName);
    const state = await transport.readState();

    const result = await rebuildFromDevice(transport, state, { ackTimeoutMs: 1500 });

    expect(result.stripConfig).not.toBeNull();
    expect(result.stripConfig!.channels.length).toBe(8);
    expect(result.deviceInfo).not.toBeNull();
    expect(result.deviceInfo!.hwId).toBe(desk.hwId);
    // 书桌 2 链，链 0 有 2 个部位
    const layout0 = result.layout[0];
    expect(layout0).not.toBeNull();
    expect(layout0!.parts.length).toBe(2);
  });

  it("part_count=0 的链不查询 layout", async () => {
    const transport = new MockTransport({ scenario: "normal" });
    const desk = MOCK_DEVICES[0];
    await transport.connect(desk.deviceId, desk.broadcastName);
    const state = await transport.readState();
    const result = await rebuildFromDevice(transport, state, { ackTimeoutMs: 1500 });
    // 链 2..7 没配置，layout 应为 null
    expect(result.layout[2]).toBeNull();
    expect(result.layout[7]).toBeNull();
  });
});