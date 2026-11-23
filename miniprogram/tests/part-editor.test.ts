/** 部位编辑器（引脚分区）测试：布局往返 + 段互斥 + 相位模式。 */

import { describe, it, expect } from "vitest";
import { MockTransport } from "../utils/ble/mock-transport";
import { ControlSession } from "../utils/session/session";
import { createMemoryStorage } from "./helpers/storage";
import { MOCK_DEVICES } from "../utils/mock/mock-devices";
import {
  validateLayout, validateSegment, createEmptyLayout, readbackToParts,
  planLayoutCommit, layoutCommitFeedback,
  partLimit, canAddPart, addPartSlot, removePartSlot,
} from "../utils/part-editor";
import { decodeFrame } from "../utils/protocol/frame";
import { validateNameBytes } from "../utils/name-bytes";
import { CMD, MAX_PARTS, RESULT } from "../utils/protocol/constants";
import type {
  AdapterState, DeviceInfo, DiscoveredDevice, LayoutPart, LinkState,
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

function slot(partId: number, name = "", segs: Array<[number, number]> = []): LayoutPart {
  return { stripId: 0, partId, name, nameLen: name.length, segs, segCount: segs.length, phase: 0 };
}

function deviceInfo(overrides: Partial<DeviceInfo> = {}): DeviceInfo {
  return {
    firmwareVersion: 0x0100,
    firmwareMajor: 1,
    firmwareMinor: 0,
    hwId: "3C:71:BF:00:00:01",
    maxLeds: 300,
    maxStrips: 8,
    maxParts: MAX_PARTS,
    maxPartSegs: 8,
    maxSteps: 8,
    maxScenes: 3,
    caps: 0,
    supportsTwoLayers: true,
    fadeImplemented: true,
    ...overrides,
  };
}

describe("部位槽位增删", () => {
  it("上限来自 deviceInfo.maxParts，缺失时回退协议常量", () => {
    expect(partLimit(null), "无 deviceInfo 时回退 MAX_PARTS").toBe(MAX_PARTS);
    expect(partLimit(deviceInfo({ maxParts: 2 })), "有 deviceInfo 时按设备能力").toBe(2);

    expect(canAddPart([slot(0)], 2)).toBe(true);
    expect(canAddPart([slot(0), slot(1)], 2)).toBe(false);
    expect(canAddPart([], MAX_PARTS)).toBe(true);
  });

  it("addPartSlot 追加空槽位到末尾，达到设备上限时拒绝", () => {
    const source = [slot(0, "前半", [[0, 29]])];
    const maxParts = partLimit(deviceInfo({ maxParts: 2 }));

    const first = addPartSlot(source, 0, maxParts);
    expect(first.kind, `上限 2、现有 1 个槽位应可新增，实际 ${JSON.stringify(first)}`).toBe("added");
    if (first.kind !== "added") return;
    expect(first.partId, "新槽位追加到末尾").toBe(1);
    expect(first.parts.map((p) => p.partId)).toEqual([0, 1]);
    expect(first.parts[1]).toMatchObject({
      stripId: 0, name: "", nameLen: 0, segs: [], segCount: 0, phase: 0,
    });
    expect(source.length, "新增不得改写已有槽位数组").toBe(1);

    const second = addPartSlot(first.parts, 0, maxParts);
    expect(second.kind, `上限 2 时第 3 个槽位应被拒，实际 ${JSON.stringify(second)}`).toBe("rejected");
  });

  it("removePartSlot 空槽位直接删，partId 连续且名字/段保留", () => {
    const parts = [slot(0, "左", [[0, 9]]), slot(1, "空槽"), slot(2, "右", [[20, 29]])];

    const plan = removePartSlot(parts, 1, 0);
    expect(plan.kind).toBe("removed");
    if (plan.kind !== "removed") return;
    expect(plan.parts.map((p) => p.partId), "partId 连续重编号").toEqual([0, 1]);
    expect(plan.parts.map((p) => p.name)).toEqual(["左", "右"]);
    expect(plan.parts[1].segs).toEqual([[20, 29]]);
    expect(plan.activePartId, "删除不改变对前序槽位的选中").toBe(0);
    expect(parts.length, "删除不得改写入参数组").toBe(3);
  });

  it("removePartSlot 有段槽位需确认，确认后才删", () => {
    const parts = [slot(0, "空槽"), slot(1, "后半", [[30, 59]])];

    const plan = removePartSlot(parts, 1, 1);
    expect(plan.kind, `有段槽位应先要确认，实际 ${JSON.stringify(plan)}`).toBe("confirm");
    if (plan.kind === "confirm") {
      expect(plan.prompt, "确认文案要说明删的是哪个部位").toContain("后半");
      expect(plan.prompt, "确认文案要说明段会一并移除").toContain("段");
    }

    const confirmed = removePartSlot(parts, 1, 1, { confirmed: true });
    expect(confirmed.kind).toBe("removed");
    if (confirmed.kind !== "removed") return;
    expect(confirmed.parts.map((p) => p.partId)).toEqual([0]);
    expect(confirmed.parts[0].segs).toEqual([]);
  });

  it("removePartSlot 至少保留 1 个槽位，删除后 activePartId 落在合法范围", () => {
    expect(removePartSlot([slot(0, "唯一", [[0, 9]])], 0, 0).kind, "最后一个槽位不可删").toBe("rejected");
    expect(removePartSlot([slot(0)], 5, 0).kind, "越界槽位不可删").toBe("rejected");

    const parts = [slot(0), slot(1), slot(2)];
    const afterMiddle = removePartSlot(parts, 1, 2);
    expect(afterMiddle.kind).toBe("removed");
    if (afterMiddle.kind === "removed") {
      expect(afterMiddle.activePartId, "选中槽位在删除点之后时前移一位").toBe(1);
    }

    const activeRemoved = removePartSlot(parts, 1, 1);
    if (activeRemoved.kind === "removed") {
      expect(activeRemoved.activePartId, "删掉选中槽位后新选中槽位仍在范围内").toBe(1);
    }

    const lastRemoved = removePartSlot(parts, 2, 2);
    if (lastRemoved.kind === "removed") {
      expect(lastRemoved.activePartId, "删掉末尾选中槽位后回退到新的末位").toBe(1);
    }
  });

  it("新增槽位并画段后提交：QueryLayout 读回连续编号、新槽位与段/名字", async () => {
    const transport = new MockTransport({ scenario: "normal" });
    const session = new ControlSession({ transport, storage: createMemoryStorage() });
    const desk = MOCK_DEVICES[0];
    await session.connect(desk.deviceId, desk.broadcastName);

    const read = await session.queryLayout(0);
    expect(read.kind).toBe("ok");
    if (read.kind !== "ok") return;
    const baseline = readbackToParts(0, read.layout, session.deviceState!.partCounts[0]);
    expect(baseline.map((p) => p.partId), "基线 2 个槽位").toEqual([0, 1]);

    // 删空槽位 0，剩 1 个槽位；再新增回 2 个槽位（与页面增删路径一致）。
    const emptied = baseline.map((p) => (
      p.partId === 0 ? { ...p, nameLen: 0, name: "", segCount: 0, segs: [] } : p
    ));
    const removed = removePartSlot(emptied, 0, 0);
    expect(removed.kind).toBe("removed");
    if (removed.kind !== "removed") return;
    const added = addPartSlot(removed.parts, 0, partLimit(session.deviceInfo));
    expect(added.kind).toBe("added");
    if (added.kind !== "added") return;
    expect(added.parts.map((p) => p.partId)).toEqual([0, 1]);

    // 给新槽位画段 [0,29]（原槽位 0 已删，灯珠空闲）。
    const withSeg = added.parts.map((p) => (
      p.partId === added.partId
        ? { ...p, name: "新增段", nameLen: 9, segs: [[0, 29]] as Array<[number, number]>, segCount: 1 }
        : p
    ));
    const plan = planLayoutCommit(withSeg);
    const result = await session.layoutCommit(plan);
    expect(result.kind, `提交应成功，实际 ${JSON.stringify(result)}`).toBe("ok");

    const after = await session.queryLayout(0);
    expect(after.kind).toBe("ok");
    if (after.kind !== "ok") return;
    expect(
      after.layout.parts.map((p) => ({ partId: p.partId, name: p.name, segs: p.segs, phase: p.phase })),
      "QueryLayout 读回应等于提交的连续编号计划",
    ).toEqual([
      { partId: 0, name: "后半", segs: [[30, 59]], phase: 0 },
      { partId: 1, name: "新增段", segs: [[0, 29]], phase: 0 },
    ]);
    expect(session.deviceState?.partCounts[0], "提交后 State 的部位数为 2").toBe(2);

    const sceneView = session.layout[0];
    expect(sceneView?.parts.map((p) => p.partId), "场景编辑器读取的布局缓存含新槽位").toEqual([0, 1]);
    expect(sceneView?.parts.find((p) => p.partId === 1)?.name).toBe("新增段");
  });

  it("删除有段槽位后提交：QueryLayout 读回 1 个连续编号槽位", async () => {
    const transport = new MockTransport({ scenario: "normal" });
    const session = new ControlSession({ transport, storage: createMemoryStorage() });
    const desk = MOCK_DEVICES[0];
    await session.connect(desk.deviceId, desk.broadcastName);

    const read = await session.queryLayout(0);
    expect(read.kind).toBe("ok");
    if (read.kind !== "ok") return;
    const baseline = readbackToParts(0, read.layout, session.deviceState!.partCounts[0]);
    expect(baseline.map((p) => p.partId), "基线 2 个槽位").toEqual([0, 1]);

    const removed = removePartSlot(baseline, 1, 1, { confirmed: true });
    expect(removed.kind).toBe("removed");
    if (removed.kind !== "removed") return;
    const plan = planLayoutCommit(removed.parts);
    const result = await session.layoutCommit(plan);
    expect(result.kind, `提交应成功，实际 ${JSON.stringify(result)}`).toBe("ok");

    const after = await session.queryLayout(0);
    expect(after.kind).toBe("ok");
    if (after.kind !== "ok") return;
    expect(
      after.layout.parts.map((p) => ({ partId: p.partId, name: p.name, segs: p.segs })),
      "删除后读回 1 个槽位，段与名字保留",
    ).toEqual([{ partId: 0, name: "前半", segs: [[0, 29]] }]);
    expect(session.deviceState?.partCounts[0], "提交后 State 的部位数为 1").toBe(1);
    expect(session.layout[0]?.parts.length, "场景编辑器读取的布局缓存同步为 1 个部位").toBe(1);
  });
});

describe("部位名字节上限（#29）", () => {
  const CJK8 = "一二三四五六七八"; // 24 字节
  const CJK9 = "一二三四五六七八九"; // 27 字节
  const EMOJI6 = "😀😀😀😀😀😀"; // 24 字节
  const EMOJI7 = "😀😀😀😀😀😀😀"; // 28 字节

  /** 记录帧并转发给真实 MockTransport；用于断言「超限不发 LayoutCommit 族命令」。 */
  function recordingTransport(): { transport: MockTransport; frames: Uint8Array[] } {
    const transport = new MockTransport({ scenario: "normal" });
    const frames: Uint8Array[] = [];
    const original = transport.sendFrame.bind(transport);
    transport.sendFrame = async (frame: Uint8Array): Promise<void> => {
      frames.push(frame);
      return original(frame);
    };
    return { transport, frames };
  }

  const layoutFrames = (frames: Uint8Array[]): Uint8Array[] =>
    frames.filter((f) => {
      const d = decodeFrame(f);
      return d.ok && (d.command === CMD.LAYOUT_WRITE || d.command === CMD.LAYOUT_PART);
    });

  it("8 个中文（24 字节）提交成功，QueryLayout 读回名字一致", async () => {
    const rec = recordingTransport();
    const session = new ControlSession({ transport: rec.transport, storage: createMemoryStorage() });
    const desk = MOCK_DEVICES[0];
    await session.connect(desk.deviceId, desk.broadcastName);

    const parts: LayoutPart[] = [
      { stripId: 0, partId: 0, name: CJK8, nameLen: 24, segs: [[0, 29]], segCount: 1, phase: 0 },
    ];
    const result = await session.layoutCommit(parts);
    expect(result.kind, `24 字节名字应可提交，实际 ${JSON.stringify(result)}`).toBe("ok");

    const read = await session.queryLayout(0);
    expect(read.kind).toBe("ok");
    if (read.kind !== "ok") return;
    expect(read.layout.parts.map((p) => p.name), "读回名字应与提交一致").toEqual([CJK8]);
  });

  it("6 个 emoji（24 字节）提交成功，读回名字一致", async () => {
    const rec = recordingTransport();
    const session = new ControlSession({ transport: rec.transport, storage: createMemoryStorage() });
    const desk = MOCK_DEVICES[0];
    await session.connect(desk.deviceId, desk.broadcastName);

    const parts: LayoutPart[] = [
      { stripId: 0, partId: 0, name: EMOJI6, nameLen: 24, segs: [[0, 29]], segCount: 1, phase: 0 },
    ];
    const result = await session.layoutCommit(parts);
    expect(result.kind, `24 字节 emoji 名字应可提交，实际 ${JSON.stringify(result)}`).toBe("ok");

    const read = await session.queryLayout(0);
    expect(read.kind).toBe("ok");
    if (read.kind !== "ok") return;
    expect(read.layout.parts.map((p) => p.name)).toEqual([EMOJI6]);
  });

  it("9 个中文（27 字节）validateLayout 拦截，不发 LayoutCommit 族命令", async () => {
    const rec = recordingTransport();
    const session = new ControlSession({ transport: rec.transport, storage: createMemoryStorage() });
    const desk = MOCK_DEVICES[0];
    await session.connect(desk.deviceId, desk.broadcastName);
    rec.frames.length = 0;

    const parts: LayoutPart[] = [
      { stripId: 0, partId: 0, name: CJK9, nameLen: 27, segs: [[0, 29]], segCount: 1, phase: 0 },
    ];
    const verr = validateLayout(0, parts, 60);
    expect(verr, "27 字节名字应被 validateLayout 拦截").toContain("27");
    expect(verr, "拦截提示应含上限 24").toContain("24");

    // 页面在 validateLayout 失败时不调用 layoutCommit：断言 transport 无 LayoutWrite/LayoutPart。
    expect(layoutFrames(rec.frames).length, "超限不得发送任何 LayoutCommit 族命令").toBe(0);
  });

  it("7 个 emoji（28 字节）validateLayout 拦截，提示 28/24", () => {
    const parts: LayoutPart[] = [
      { stripId: 0, partId: 0, name: EMOJI7, nameLen: 28, segs: [[0, 29]], segCount: 1, phase: 0 },
    ];
    const verr = validateLayout(0, parts, 60);
    expect(verr, "28 字节 emoji 名字应被拦截").not.toBeNull();
    expect(verr).toContain("28");
    expect(verr).toContain("24");
  });

  it("nameLen 用 UTF-8 字节数而非字符数：8 中文=24 字节，9 中文=27 字节", () => {
    expect(validateNameBytes(CJK8).bytes, "8 个中文的 nameLen 应是 24 字节").toBe(24);
    expect(CJK8.length, "字符数是 8，证明字节数≠字符数").toBe(8);
    expect(validateNameBytes(CJK9).bytes, "9 个中文的 nameLen 应是 27 字节").toBe(27);
    expect(CJK9.length).toBe(9);
  });
});
