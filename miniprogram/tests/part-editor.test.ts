/** 部位编辑器（引脚分区）测试：布局往返 + 段互斥 + 相位模式。 */

import { describe, it, expect } from "vitest";
import { MockTransport } from "../utils/ble/mock-transport";
import { ControlSession } from "../utils/session/session";
import { createMemoryStorage } from "./helpers/storage";
import { MOCK_DEVICES } from "../utils/mock/mock-devices";
import {
  validateLayout, validateSegment, createEmptyLayout, readbackToParts,
  planLayoutCommit, layoutCommitFeedback,
} from "../utils/part-editor";
import { decodeFrame } from "../utils/protocol/frame";
import { CMD, RESULT } from "../utils/protocol/constants";
import type {
  AdapterState, DiscoveredDevice, LayoutPart, LinkState,
} from "../utils/protocol/types";
import type { Transport } from "../utils/ble/transport";

/** QueryLayout 黑洞：命令照发但把帧吞掉，模拟读回超时（提交本身仍成功）。 */
class QueryLayoutTimeoutTransport implements Transport {
  constructor(private readonly inner: MockTransport) {}

  connect(deviceId: string, broadcastName?: string) { return this.inner.connect(deviceId, broadcastName); }
  disconnect() { return this.inner.disconnect(); }
  sendFrame(frame: Uint8Array) {
    const decoded = decodeFrame(frame);
    if (decoded.ok && decoded.command === CMD.QUERY_LAYOUT) return Promise.resolve();
    return this.inner.sendFrame(frame);
  }
  readState() { return this.inner.readState(); }
  startScan(onDevice: (device: DiscoveredDevice) => void) { return this.inner.startScan(onDevice); }
  stopScan() { this.inner.stopScan(); }
  onFrame(listener: (frame: Uint8Array) => void) { return this.inner.onFrame(listener); }
  onLinkChange(listener: (state: LinkState) => void) { return this.inner.onLinkChange(listener); }
  onAdapterState(listener: (state: AdapterState) => void) { return this.inner.onAdapterState(listener); }
  get linkState() { return this.inner.linkState; }
  get currentDeviceId() { return this.inner.currentDeviceId; }
  get chunkCapacity() { return this.inner.chunkCapacity; }
  get persistsDeviceIdentity() { return this.inner.persistsDeviceIdentity; }
  destroy() { this.inner.destroy(); }
}

describe("部位编辑器", () => {
  it("createEmptyLayout 生成空槽位", () => {
    const parts = createEmptyLayout(0, 3);
    expect(parts.length).toBe(3);
    expect(parts[0].segs.length).toBe(0);
    expect(parts[0].name).toBe("");
  });

  it("readbackToParts 从缓存还原", () => {
    const readback = {
      stripId: 0,
      parts: [
        { stripId: 0, partId: 0, name: "前半", nameLen: 6, segs: [[0, 29]] as Array<[number, number]>, segCount: 1, phase: 0 },
      ],
      partMask: 1,
    };
    const parts = readbackToParts(0, readback, 2);
    expect(parts[0].name).toBe("前半");
    expect(parts[0].segs[0]).toEqual([0, 29]);
    expect(parts[1].segs.length).toBe(0);
  });

  it("validateSegment 段互斥", () => {
    const parts: LayoutPart[] = [
      { stripId: 0, partId: 0, name: "A", nameLen: 1, segs: [[0, 29]], segCount: 1, phase: 0 },
    ];
    // 无冲突
    expect(validateSegment(30, 59, 60, parts)).toBeNull();
    // 与已有段重叠
    expect(validateSegment(10, 20, 60, parts)).toContain("重叠");
    // 超出灯珠数
    expect(validateSegment(0, 60, 60, parts)).toContain("超出");
  });

  it("validateLayout 整份校验", () => {
    const parts: LayoutPart[] = [
      { stripId: 0, partId: 0, name: "A", nameLen: 1, segs: [[0, 29]], segCount: 1, phase: 0 },
      { stripId: 0, partId: 1, name: "B", nameLen: 1, segs: [[30, 59]], segCount: 1, phase: 0 },
    ];
    expect(validateLayout(0, parts, 60)).toBeNull();
    // 段重叠
    parts[1].segs = [[10, 40]];
    expect(validateLayout(0, parts, 60)).toContain("重叠");
  });

  it("layoutCommit 往返（MockTransport）", async () => {
    const transport = new MockTransport({ scenario: "normal" });
    const storage = createMemoryStorage();
    const session = new ControlSession({ transport, storage });
    const desk = MOCK_DEVICES[0];
    await session.connect(desk.deviceId, desk.broadcastName);

    const parts: LayoutPart[] = [
      { stripId: 0, partId: 0, name: "左半", nameLen: 6, segs: [[0, 29]], segCount: 1, phase: 0 },
      { stripId: 0, partId: 1, name: "右半", nameLen: 6, segs: [[30, 59]], segCount: 1, phase: 1 },
    ];
    const result = await session.layoutCommit(parts);
    expect(result.kind).toBe("ok");
  });

  it("planLayoutCommit 过滤空槽位并连续重编号", () => {
    const source: LayoutPart[] = [
      { stripId: 0, partId: 0, name: "前半", nameLen: 6, segs: [], segCount: 0, phase: 0 },
      { stripId: 0, partId: 1, name: "后半", nameLen: 6, segs: [[30, 59]], segCount: 0, phase: 1 },
      { stripId: 0, partId: 2, name: "空槽", nameLen: 6, segs: [], segCount: 0, phase: 0 },
      { stripId: 0, partId: 3, name: "中段", nameLen: 6, segs: [[0, 9], [20, 29]], segCount: 2, phase: 0 },
    ];

    const plan = planLayoutCommit(source);

    expect(plan.map((p) => ({ partId: p.partId, name: p.name, segs: p.segs, phase: p.phase, segCount: p.segCount }))).toEqual([
      { partId: 0, name: "后半", segs: [[30, 59]], phase: 1, segCount: 1 },
      { partId: 1, name: "中段", segs: [[0, 9], [20, 29]], phase: 0, segCount: 2 },
    ]);
    expect(source.map((p) => p.partId), "计划不得改写入参").toEqual([0, 1, 2, 3]);
  });

  it("断层提交：部位 0 空、部位 1 有段 → QueryLayout 读回 1 个连续编号部位", async () => {
    const transport = new MockTransport({ scenario: "normal" });
    const session = new ControlSession({ transport, storage: createMemoryStorage() });
    const desk = MOCK_DEVICES[0];
    await session.connect(desk.deviceId, desk.broadcastName);

    const source: LayoutPart[] = [
      { stripId: 0, partId: 0, name: "前半", nameLen: 6, segs: [], segCount: 0, phase: 0 },
      { stripId: 0, partId: 1, name: "后半", nameLen: 6, segs: [[30, 59]], segCount: 1, phase: 0 },
    ];
    const result = await session.layoutCommit(planLayoutCommit(source));
    expect(result.kind, `提交应成功，实际 ${JSON.stringify(result)}`).toBe("ok");

    const read = await session.queryLayout(0);
    expect(read.kind).toBe("ok");
    if (read.kind !== "ok") return;
    expect(
      read.layout.parts.map((p) => ({ partId: p.partId, name: p.name, segs: p.segs })),
      "QueryLayout 读回应等于提交计划：空槽位被过滤、partId 重编号为 0",
    ).toEqual([{ partId: 0, name: "后半", segs: [[30, 59]] }]);

    expect(session.deviceState?.partCounts[0], "提交后会话 partCounts 应更新为 1").toBe(1);
    expect(session.deviceState?.stripLedCounts[0], "提交后会话灯珠数不变").toBe(60);

    const pageSlots = readbackToParts(0, read.layout, session.deviceState!.partCounts[0]);
    expect(pageSlots.length, "页面槽位数应等于读回部位数").toBe(1);
    expect(pageSlots[0].segs, "页面显示的段应是读回的段").toEqual([[30, 59]]);
    expect(pageSlots[0].name).toBe("后半");

    await session.disconnect();
    await session.connect(desk.deviceId, desk.broadcastName);
    expect(session.deviceState?.partCounts[0], "重连 State 的 partCounts 仍为 1").toBe(1);
    const afterReconnect = await session.queryLayout(0);
    expect(afterReconnect.kind).toBe("ok");
    if (afterReconnect.kind !== "ok") return;
    expect(
      afterReconnect.layout.parts.map((p) => ({ partId: p.partId, name: p.name, segs: p.segs })),
      "重连后读回应与提交内容一致",
    ).toEqual([{ partId: 0, name: "后半", segs: [[30, 59]] }]);
  });

  it("提交成功但读回失败：提示「已提交但读回失败」", async () => {
    const inner = new MockTransport({ scenario: "normal" });
    const transport = new QueryLayoutTimeoutTransport(inner);
    const session = new ControlSession({ transport, storage: createMemoryStorage(), ackTimeoutMs: 30 });
    const desk = MOCK_DEVICES[0];
    await session.connect(desk.deviceId, desk.broadcastName);

    const source: LayoutPart[] = [
      { stripId: 0, partId: 0, name: "前半", nameLen: 6, segs: [], segCount: 0, phase: 0 },
      { stripId: 0, partId: 1, name: "后半", nameLen: 6, segs: [[30, 59]], segCount: 1, phase: 0 },
    ];
    const result = await session.layoutCommit(planLayoutCommit(source));
    expect(result.kind, `提交应成功（只有读回被吞），实际 ${JSON.stringify(result)}`).toBe("ok");

    const read = await session.queryLayout(0);
    expect(read.kind, "QueryLayout 被吞帧后应超时失败").toBe("error");

    const hint = layoutCommitFeedback(result, read.kind === "ok");
    expect(hint).toContain("已提交但读回失败");
    expect(hint).not.toContain("布局已提交");
    session.destroy();
  });

  it("提交失败的结果码显示中文原因", () => {
    const hint = layoutCommitFeedback(
      { kind: "ack-error", ack: { seq: 1, command: CMD.LAYOUT_COMMIT, resultCode: RESULT.INVALID_PARAM, ok: false } },
      false,
    );
    expect(hint).toContain("参数无效");
  });
});
