/** Mock 场景：normal / slow / flaky / offline 四场景行为。 */

import { describe, it, expect } from "vitest";
import { MockTransport } from "../utils/ble/mock-transport";
import { MOCK_DEVICES } from "../utils/mock/mock-devices";
import { encodeFrame } from "../utils/protocol/frame";

describe("Mock 场景", () => {
  const desk = MOCK_DEVICES[0];

  it("normal：即时 ACK", async () => {
    const t = new MockTransport({ scenario: "normal" });
    await t.connect(desk.deviceId, desk.broadcastName);
    const acks: any[] = [];
    t.onFrame((f) => { if (f.length >= 3 && f[2] === 0x80) acks.push(f); });
    await t.sendFrame(encodeFrame(0x01, 1, [1]));
    await new Promise((r) => setTimeout(r, 10));
    expect(acks.length).toBe(1);
  });

  it("slow：ACK 延迟约 40ms", async () => {
    const t = new MockTransport({ scenario: "slow" });
    await t.connect(desk.deviceId, desk.broadcastName);
    const acks: any[] = [];
    t.onFrame((f) => { if (f.length >= 3 && f[2] === 0x80) acks.push(f); });
    const start = Date.now();
    await t.sendFrame(encodeFrame(0x01, 1, [1]));
    await new Promise((r) => setTimeout(r, 60));
    expect(acks.length).toBe(1);
    expect(Date.now() - start).toBeGreaterThanOrEqual(30);
  });

  it("offline：connect 直接失败", async () => {
    const t = new MockTransport({ scenario: "offline" });
    await expect(t.connect(desk.deviceId, desk.broadcastName)).rejects.toThrow();
  });

  it("flaky：seq % 3 === 0 的帧 ACK 丢弃", async () => {
    const t = new MockTransport({ scenario: "flaky" });
    await t.connect(desk.deviceId, desk.broadcastName);
    const acks: any[] = [];
    t.onFrame((f) => { if (f.length >= 3 && f[2] === 0x80) acks.push(f); });
    // 发 3 帧，seq 分别为 1,2,3（runtime 内部 seq）
    // MockTransport 用 decoded.seq 传给 handleCommand，flaky 检查 seq % 3 === 0
    await t.sendFrame(encodeFrame(0x01, 1, [1])); // seq=1, ACK 发
    await t.sendFrame(encodeFrame(0x01, 2, [1])); // seq=2, ACK 发
    await t.sendFrame(encodeFrame(0x01, 3, [1])); // seq=3, ACK 丢
    await new Promise((r) => setTimeout(r, 20));
    // 只收到 2 个 ACK（seq 1,2）
    expect(acks.length).toBe(2);
  });
});