/** 多帧读回：保存后从设备读回的值必须与写入一致（#20）。 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { MockTransport } from "../utils/ble/mock-transport";
import { ControlSession } from "../utils/session/session";
import { rebuildFromDevice } from "../utils/session/rebuild";
import { createMemoryStorage } from "./helpers/storage";
import { MOCK_DEVICES } from "../utils/mock/mock-devices";
import { ScriptedTransport, ackFrame, idleState, makeRebuildResponder } from "./helpers/scripted-transport";
import { encodeFrame } from "../utils/protocol/frame";
import { cmdSceneName, cmdSceneStep, staticLayer } from "../utils/protocol/commands";
import { DEVICE_CMD } from "../utils/protocol/constants";

function sceneStepReport(seq: number, durationMs: number): Uint8Array {
  const payload = cmdSceneStep({
    sceneId: 0,
    stripId: 0,
    partId: 0,
    stepIndex: 0,
    durationMs,
    layer0: staticLayer(0, 255, 100),
    layer1: { type: 0xff, hue: 0, sat: 0, periodMs: 0, p5: 0, flags: 0, level: 0 },
  }).payload;
  return encodeFrame(DEVICE_CMD.SCENE_STEP_REPORT, seq, payload);
}

function sceneTail(seq: number, name: string): Uint8Array {
  return encodeFrame(DEVICE_CMD.SCENE_LIST_END, seq, cmdSceneName(0, name).payload);
}

describe("多帧读回", () => {
  const desk = MOCK_DEVICES[0];

  it("保存场景名后 QueryScene 读回名字", async () => {
    const transport = new MockTransport({ scenario: "normal" });
    const session = new ControlSession({ transport, storage: createMemoryStorage() });
    await session.connect(desk.deviceId, desk.broadcastName);

    const saved = await session.sceneName(0, "客厅模式");
    expect(saved.kind).toBe("ok");

    const read = await session.queryScene(0);
    expect(read.kind, "QueryScene 应该成功").toBe("ok");
    if (read.kind === "ok") {
      expect(read.scene.name, `期望读回「客厅模式」，实际「${read.scene.name}」`).toBe("客厅模式");
    }
  });

  it("QueryLayout 读回 LayoutListEnd 的 partMask 与部位名", async () => {
    const transport = new MockTransport({ scenario: "normal" });
    const session = new ControlSession({ transport, storage: createMemoryStorage() });
    await session.connect(desk.deviceId, desk.broadcastName);

    const read = await session.queryLayout(0);
    expect(read.kind, "QueryLayout 应该成功").toBe("ok");
    if (read.kind === "ok") {
      expect(
        read.layout.partMask,
        `期望 partMask=3（部位 0/1 有段），实际 ${read.layout.partMask}`,
      ).toBe(0b11);
      expect(read.layout.parts.map((p) => p.name)).toEqual(["前半", "后半"]);
    }
  });

  it("权威重建读回场景名与 partMask", async () => {
    const transport = new MockTransport({ scenario: "normal" });
    await transport.connect(desk.deviceId, desk.broadcastName);
    const state = await transport.readState();

    const result = await rebuildFromDevice(transport, state, { reportTimeoutMs: 5000 });

    expect(result.layout[0], "链 0 有部位，读回不应为 null").not.toBeNull();
    expect(
      result.layout[0]!.partMask,
      `期望 partMask=3，实际 ${result.layout[0]!.partMask}`,
    ).toBe(0b11);
    expect(result.scene?.name, `期望读回默认场景名「场景 1」，实际「${result.scene?.name ?? ""}」`).toBe("场景 1");
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("收尾帧缺失：查询在超时后失败且错误可读", async () => {
    vi.useFakeTimers();
    const transport = new ScriptedTransport(
      idleState(),
      makeRebuildResponder((request, emit) => {
        emit(ackFrame(request));
      }),
    );
    const session = new ControlSession({ transport, storage: createMemoryStorage() });
    await session.connect("scripted");

    const pending = session.queryScene(0);
    await vi.advanceTimersByTimeAsync(5000);
    const result = await pending;

    expect(result.kind, "没有 SceneListEnd 时不能返回成功").toBe("error");
    if (result.kind === "error") {
      expect(result.message, `错误信息应说明超时，实际「${result.message}」`).toContain("超时");
      expect(result.message, `错误信息应包含请求名，实际「${result.message}」`).toContain("QueryScene");
    }
  });

  it("收尾帧 seq 不匹配：不能当作本次查询的收尾", async () => {
    vi.useFakeTimers();
    const transport = new ScriptedTransport(
      idleState(),
      makeRebuildResponder((request, emit) => {
        emit(ackFrame(request));
        emit(sceneStepReport(request.seq, 1500));
        emit(sceneTail((request.seq + 1) & 0xff, "别的请求"));
      }),
    );
    const session = new ControlSession({ transport, storage: createMemoryStorage() });
    await session.connect("scripted");

    const pending = session.queryScene(0);
    await vi.advanceTimersByTimeAsync(5000);
    const result = await pending;

    expect(result.kind, "seq 不匹配的收尾帧不能结束查询").toBe("error");
    if (result.kind === "error") {
      expect(result.message, `错误信息应说明超时，实际「${result.message}」`).toContain("超时");
    }
  });

  it("收尾帧长度不足：返回可读的解析错误", async () => {
    const transport = new ScriptedTransport(
      idleState(),
      makeRebuildResponder((request, emit) => {
        emit(ackFrame(request));
        emit(encodeFrame(DEVICE_CMD.SCENE_LIST_END, request.seq, new Uint8Array(25)));
      }),
    );
    const session = new ControlSession({ transport, storage: createMemoryStorage() });
    await session.connect("scripted");

    const result = await session.queryScene(0);

    expect(result.kind, "收尾帧长度不足时不能返回空名字的成功结果").toBe("error");
    if (result.kind === "error") {
      expect(result.message, `错误信息应包含期望长度，实际「${result.message}」`).toContain("26");
      expect(result.message, `错误信息应包含实际长度，实际「${result.message}」`).toContain("25");
    }
  });
});
