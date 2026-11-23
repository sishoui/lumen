/** 部位编辑器（引脚分区）测试：布局往返 + 段互斥 + 相位模式。 */

import { describe, it, expect } from "vitest";
import { MockTransport } from "../utils/ble/mock-transport";
import { ControlSession } from "../utils/session/session";
import { createMemoryStorage } from "./helpers/storage";
import { MOCK_DEVICES } from "../utils/mock/mock-devices";
import { validateLayout, validateSegment, createEmptyLayout, readbackToParts } from "../utils/part-editor";
import type { LayoutPart } from "../utils/protocol/types";

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
});