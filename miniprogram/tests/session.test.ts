/** 会话全链路（MockTransport）：connect → 重建 → 命令 → disconnect。 */

import { describe, it, expect, beforeEach } from "vitest";
import { ControlSession } from "../utils/session/session";
import { MockTransport } from "../utils/ble/mock-transport";
import { MOCK_DEVICES } from "../utils/mock/mock-devices";
import { createMemoryStorage } from "./helpers/storage";

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

  it("offline 场景 connect 失败", async () => {
    const transport = new MockTransport({ scenario: "offline" });
    const session = new ControlSession({ transport, storage });
    const desk = MOCK_DEVICES[0];
    await expect(session.connect(desk.deviceId, desk.broadcastName)).rejects.toThrow();
  });
});