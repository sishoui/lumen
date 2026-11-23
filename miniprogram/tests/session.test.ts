/** 会话全链路（MockTransport）：connect → 重建 → 命令 → disconnect。 */

import { describe, it, expect, beforeEach } from "vitest";
import { ControlSession } from "../utils/session/session";
import { MockTransport } from "../utils/ble/mock-transport";
import { MOCK_DEVICES } from "../utils/mock/mock-devices";
import { createMemoryStorage } from "./helpers/storage";

/** 轮询到条件成立，最多 timeoutMs；避免固定 sleep 拖慢测试。 */
async function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return predicate();
}

describe("ControlSession", () => {
  let storage: ReturnType<typeof createMemoryStorage>;

  beforeEach(() => {
    storage = createMemoryStorage();
  });

  it("connect 返回 State 且与 spec 一致", async () => {
    const transport = new MockTransport({ scenario: "normal" });
    const session = new ControlSession({ transport, storage });
    const desk = MOCK_DEVICES[0];
    const state = await session.connect(desk.deviceId, desk.broadcastName);
    expect(state.power).toBe(desk.power);
    expect(state.brightness).toBe(desk.brightness);
    expect(session.linkState).toBe("ready");
  });

  it("setPower 往返", async () => {
    const transport = new MockTransport({ scenario: "normal" });
    const session = new ControlSession({ transport, storage });
    const desk = MOCK_DEVICES[0];
    await session.connect(desk.deviceId, desk.broadcastName);
    const r = await session.setPower(false);
    expect(r.kind).toBe("ok");
    if (r.kind === "ok") {
      expect(r.state?.power).toBe(0);
    }
  });

  it("setBrightness 走 latest-wins（不阻塞）", async () => {
    const transport = new MockTransport({ scenario: "normal" });
    const session = new ControlSession({ transport, storage });
    const desk = MOCK_DEVICES[0];
    await session.connect(desk.deviceId, desk.broadcastName);
    session.setBrightness(100);
    expect(session.deviceState?.brightness).toBe(100);
  });

  it("disconnect 后 linkState = idle", async () => {
    const transport = new MockTransport({ scenario: "normal" });
    const session = new ControlSession({ transport, storage });
    const desk = MOCK_DEVICES[0];
    await session.connect(desk.deviceId, desk.broadcastName);
    await session.disconnect();
    expect(session.linkState).toBe("idle");
    expect(session.deviceState).toBeNull();
  });

  it("setStripPower 往返", async () => {
    const transport = new MockTransport({ scenario: "normal" });
    const session = new ControlSession({ transport, storage });
    const desk = MOCK_DEVICES[0];
    await session.connect(desk.deviceId, desk.broadcastName);
    const r = await session.setStripPower(1, false);
    expect(r.kind).toBe("ok");
  });

  it("断开重连后重建结果仍然生效（#19 回归）", async () => {
    const transport = new MockTransport({ scenario: "normal" });
    const session = new ControlSession({ transport, storage });
    const desk = MOCK_DEVICES[0];

    await session.connect(desk.deviceId, desk.broadcastName);
    expect(await waitFor(() => session.deviceInfo !== null)).toBe(true);
    expect(session.deviceInfo?.firmwareVersion).toBe(0x0100);

    await session.disconnect();
    await session.connect(desk.deviceId, desk.broadcastName);

    expect(await waitFor(() => session.deviceInfo !== null)).toBe(true);
    expect(session.deviceInfo?.firmwareVersion).toBe(0x0100);
    expect(session.deviceInfo?.firmwareMajor).toBe(1);
    expect(session.deviceInfo?.firmwareMinor).toBe(0);
    // 重建不止 deviceInfo：布局也要从设备读回（书桌 0 号带声明了部位）
    expect(session.layout[0]?.parts.length).toBeGreaterThan(0);
    expect(session.stripConfig?.channels.length).toBe(8);
  });

  it("onShow 静默回连后重建结果仍然生效（#19 回归）", async () => {
    const storage2 = createMemoryStorage({
      "lumen.device.v1": JSON.stringify({
        deviceId: MOCK_DEVICES[0].deviceId,
        broadcastName: MOCK_DEVICES[0].broadcastName,
      }),
    });
    const transport = new MockTransport({ scenario: "normal" });
    const session = new ControlSession({ transport, storage: storage2, reconnectDelaysMs: [0] });

    session.onShow();

    expect(await waitFor(() => session.deviceInfo !== null)).toBe(true);
    expect(session.linkState).toBe("ready");
    expect(session.deviceInfo?.firmwareVersion).toBe(0x0100);
    expect(session.layout[0]?.parts.length).toBeGreaterThan(0);
  });

  it("offline 场景 connect 失败", async () => {
    const transport = new MockTransport({ scenario: "offline" });
    const session = new ControlSession({ transport, storage });
    const desk = MOCK_DEVICES[0];
    await expect(session.connect(desk.deviceId, desk.broadcastName)).rejects.toThrow();
  });
});