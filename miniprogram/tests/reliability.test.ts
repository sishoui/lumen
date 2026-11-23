/** 多帧读回可靠性（#21）：报告超时、seq/CRC 过滤、重建串行、Busy 重试。 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { ControlSession } from "../utils/session/session";
import { queryMultiFrame } from "../utils/session/query";
import { createMemoryStorage } from "./helpers/storage";
import {
  ScriptedTransport, ackFrame, idleState, makeRebuildResponder, type RequestResponder,
} from "./helpers/scripted-transport";
import { encodeFrame } from "../utils/protocol/frame";
import {
  cmdSceneName, cmdScenePart, cmdSceneStep, parseSceneListEnd, staticLayer,
} from "../utils/protocol/commands";
import { CMD, DEVICE_CMD, RESULT } from "../utils/protocol/constants";

function sceneStepReport(
  seq: number,
  stripId: number,
  partId: number,
  stepIndex: number,
  durationMs: number,
): Uint8Array {
  const payload = cmdSceneStep({
    sceneId: 0,
    stripId,
    partId,
    stepIndex,
    durationMs,
    layer0: staticLayer(0, 255, 100),
    layer1: { type: 0xff, hue: 0, sat: 0, periodMs: 0, p5: 0, flags: 0, level: 0 },
  }).payload;
  return encodeFrame(DEVICE_CMD.SCENE_STEP_REPORT, seq, payload);
}

function scenePartReport(seq: number, stripId: number, partId: number): Uint8Array {
  const payload = cmdScenePart(0, stripId, partId, 8, 1, true).payload;
  return encodeFrame(DEVICE_CMD.SCENE_PART_REPORT, seq, payload);
}

function sceneTail(seq: number, name: string): Uint8Array {
  return encodeFrame(DEVICE_CMD.SCENE_LIST_END, seq, cmdSceneName(0, name).payload);
}

function stripConfigReport(seq: number): Uint8Array {
  return encodeFrame(DEVICE_CMD.STRIP_CONFIG_REPORT, seq, new Uint8Array(24));
}

function deviceInfoReport(seq: number): Uint8Array {
  return encodeFrame(DEVICE_CMD.DEVICE_INFO_REPORT, seq, new Uint8Array(15));
}

function makeSession(respond: RequestResponder, reportTimeoutMs?: number) {
  const transport = new ScriptedTransport(idleState(), respond);
  const session = new ControlSession({
    transport,
    storage: createMemoryStorage(),
    ...(reportTimeoutMs === undefined ? {} : { reportTimeoutMs }),
  });
  return { transport, session };
}

describe("多帧读回可靠性", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("72 帧延迟报告（8 部位 × 8 步）完整读回", async () => {
    vi.useFakeTimers();
    const { session } = makeSession((request, emit) => {
      if (request.command === CMD.QUERY_STRIP_CONFIG) {
        emit(ackFrame(request));
        emit(stripConfigReport(request.seq));
        return;
      }
      if (request.command === CMD.QUERY_DEVICE_INFO) {
        emit(ackFrame(request));
        emit(deviceInfoReport(request.seq));
        return;
      }
      if (request.command !== CMD.QUERY_SCENE) return;
      emit(ackFrame(request));
      for (let partId = 0; partId < 8; partId += 1) {
        emit(scenePartReport(request.seq, 0, partId));
      }
      for (let i = 0; i < 64; i += 1) {
        const partId = Math.floor(i / 8);
        const stepIndex = i % 8;
        setTimeout(() => emit(sceneStepReport(request.seq, 0, partId, stepIndex, 100 + i)), 20 * (i + 1));
      }
      setTimeout(() => emit(sceneTail(request.seq, "复杂场景")), 20 * 65);
    });
    await session.connect("scripted");

    const pending = session.queryScene(0);
    await vi.advanceTimersByTimeAsync(4000);
    const result = await pending;

    expect(result.kind, "72 帧报告应在报告超时内完整到达").toBe("ok");
    if (result.kind === "ok") {
      expect(result.scene.parts.length, `部位数应为 8，实际 ${result.scene.parts.length}`).toBe(8);
      expect(result.scene.steps.length, `步骤数应为 64，实际 ${result.scene.steps.length}`).toBe(64);
      expect(result.scene.name).toBe("复杂场景");
      const last = result.scene.steps.find((s) => s.partId === 7 && s.stepIndex === 7);
      expect(last?.durationMs, `最后一步时长应为 163，实际 ${last?.durationMs}`).toBe(163);
    }
  });

  it("跨 seq 与坏 CRC 的帧被忽略，收尾帧必须 seq 匹配", async () => {
    const transport = new ScriptedTransport(idleState());
    await transport.connect("scripted");
    const seq = 7;
    const pending = queryMultiFrame(
      transport,
      CMD.QUERY_SCENE,
      new Uint8Array([0]),
      seq,
      DEVICE_CMD.SCENE_LIST_END,
      { ackTimeoutMs: 600, reportTimeoutMs: 5000 },
    );

    transport.emit(ackFrame({ command: CMD.QUERY_SCENE, seq, payload: new Uint8Array([0]) }));
    transport.emit(sceneStepReport((seq + 1) & 0xff, 0, 0, 0, 999));
    transport.emit(sceneStepReport(seq, 0, 0, 0, 111));
    const corrupt = sceneStepReport(seq, 0, 0, 1, 999);
    corrupt[corrupt.length - 1] ^= 0xff;
    transport.emit(corrupt);
    transport.emit(sceneStepReport(seq, 0, 0, 2, 222));
    transport.emit(sceneTail((seq + 1) & 0xff, "别的请求"));
    transport.emit(sceneTail(seq, "正确收尾"));

    const result = await pending;
    expect(result.ok, "收尾帧到达后应成功").toBe(true);
    if (result.ok) {
      const durations = result.body.map((f) => f.payload[4] | (f.payload[5] << 8));
      expect(durations, `只应收到 seq=7 的两条合法帧，实际 ${JSON.stringify(durations)}`).toEqual([111, 222]);
      expect(parseSceneListEnd(result.tail.payload).name).toBe("正确收尾");
    }
  });

  it("ACK 600ms 超时，错误可读", async () => {
    vi.useFakeTimers();
    const { session } = makeSession(makeRebuildResponder(() => undefined));
    await session.connect("scripted");

    const pending = session.queryScene(0);
    await vi.advanceTimersByTimeAsync(600);
    const result = await pending;

    expect(result.kind).toBe("error");
    if (result.kind === "error") {
      expect(result.message, `应说明 ACK 超时，实际「${result.message}」`).toContain("ACK 超时");
      expect(result.message, `应带 600ms，实际「${result.message}」`).toContain("600");
      expect(result.message, `应带请求名，实际「${result.message}」`).toContain("QueryScene");
    }
  });

  it("ACK 之后报告可超过 600ms，默认 5000ms 内成功", async () => {
    vi.useFakeTimers();
    const { session } = makeSession(makeRebuildResponder((request, emit) => {
      emit(ackFrame(request));
      setTimeout(() => {
        emit(sceneStepReport(request.seq, 0, 0, 0, 1500));
        emit(sceneTail(request.seq, "慢报告"));
      }, 1000);
    }));
    await session.connect("scripted");

    const pending = session.queryScene(0);
    await vi.advanceTimersByTimeAsync(1000);
    const result = await pending;

    expect(result.kind, "报告在 1000ms 到达时不应被 600ms ACK 超时打断").toBe("ok");
    if (result.kind === "ok") {
      expect(result.scene.name).toBe("慢报告");
      expect(result.scene.steps.length).toBe(1);
    }
  });

  it("报告在默认 5000ms 后超时，错误可读", async () => {
    vi.useFakeTimers();
    const { session } = makeSession(makeRebuildResponder((request, emit) => {
      emit(ackFrame(request));
    }));
    await session.connect("scripted");

    let settled = false;
    const pending = session.queryScene(0).then((result) => {
      settled = true;
      return result;
    });
    await vi.advanceTimersByTimeAsync(4999);
    expect(settled, "4999ms 时报告超时不应提前触发").toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const result = await pending;

    expect(result.kind).toBe("error");
    if (result.kind === "error") {
      expect(result.message, `应说明报告超时，实际「${result.message}」`).toContain("报告超时");
      expect(result.message, `应带 5000ms，实际「${result.message}」`).toContain("5000");
      expect(result.message, `应带收尾帧名，实际「${result.message}」`).toContain("SceneListEnd");
    }
  });

  it("报告超时可注入", async () => {
    vi.useFakeTimers();
    const { session } = makeSession(makeRebuildResponder((request, emit) => {
      emit(ackFrame(request));
    }), 25);
    await session.connect("scripted");

    const pending = session.queryScene(0);
    await vi.advanceTimersByTimeAsync(25);
    const result = await pending;

    expect(result.kind).toBe("error");
    if (result.kind === "error") {
      expect(result.message, `应带注入的 25ms，实际「${result.message}」`).toContain("25");
    }
  });

  it("重建先进命令泵：页面查询排在重建之后，迟到的重建帧不影响页面结果", async () => {
    vi.useFakeTimers();
    let sceneQueries = 0;
    let lateRebuildFrame = false;
    const transport = new ScriptedTransport(idleState(), (request, emit) => {
      if (request.command === CMD.QUERY_STRIP_CONFIG) {
        setTimeout(() => {
          emit(ackFrame(request));
          emit(stripConfigReport(request.seq));
        }, 100);
        return;
      }
      if (request.command === CMD.QUERY_DEVICE_INFO) {
        emit(ackFrame(request));
        emit(deviceInfoReport(request.seq));
        return;
      }
      if (request.command !== CMD.QUERY_SCENE) return;
      sceneQueries += 1;
      if (sceneQueries === 1) {
        emit(ackFrame(request));
        emit(sceneStepReport(request.seq, 0, 0, 0, 500));
        emit(sceneTail(request.seq, "重建场景"));
        setTimeout(() => {
          lateRebuildFrame = true;
          emit(sceneStepReport(request.seq, 0, 0, 1, 500));
        }, 50);
        return;
      }
      setTimeout(() => {
        emit(ackFrame(request));
        emit(sceneStepReport(request.seq, 0, 0, 0, 1234));
        emit(sceneTail(request.seq, "页面场景"));
      }, 200);
    });
    const session = new ControlSession({ transport, storage: createMemoryStorage() });
    await session.connect("scripted");

    expect(
      transport.sent.some((r) => r.command === CMD.QUERY_DEVICE_INFO),
      "connect 应在重建完成前返回",
    ).toBe(false);

    const pending = session.queryScene(0);
    await vi.advanceTimersByTimeAsync(500);
    const result = await pending;

    expect(result.kind).toBe("ok");
    if (result.kind === "ok") {
      expect(result.scene.name).toBe("页面场景");
      expect(
        result.scene.steps.length,
        `页面查询只应看到自己的 1 步，实际 ${result.scene.steps.length} 步`,
      ).toBe(1);
      expect(result.scene.steps[0].durationMs).toBe(1234);
    }
    expect(lateRebuildFrame, "迟到的重建帧应已发出（用于证明它被忽略）").toBe(true);

    const sceneRequests = transport.sent.filter((r) => r.command === CMD.QUERY_SCENE);
    expect(sceneRequests.length, "重建 1 次 + 页面 1 次").toBe(2);
    const infoIndex = transport.sent.findIndex((r) => r.command === CMD.QUERY_DEVICE_INFO);
    const pageSceneIndex = transport.sent.indexOf(sceneRequests[1]);
    expect(infoIndex, "设备信息查询属于重建").toBeGreaterThan(-1);
    expect(pageSceneIndex, "页面查询应排在设备信息（重建最后一步）之后").toBeGreaterThan(infoIndex);
  });

  it("自动重连后的重建结果不被误判为 stale", async () => {
    vi.useFakeTimers();
    let deviceInfoReplies = 0;
    const transport = new ScriptedTransport(idleState(), (request, emit) => {
      if (request.command === CMD.QUERY_STRIP_CONFIG) {
        emit(ackFrame(request));
        emit(stripConfigReport(request.seq));
        return;
      }
      if (request.command === CMD.QUERY_SCENE) {
        emit(ackFrame(request));
        emit(sceneTail(request.seq, "重建场景"));
        return;
      }
      if (request.command === CMD.QUERY_DEVICE_INFO) {
        deviceInfoReplies += 1;
        const payload = new Uint8Array(15);
        payload[2] = deviceInfoReplies === 1 ? 0xaa : 0xbb;
        emit(ackFrame(request));
        emit(encodeFrame(DEVICE_CMD.DEVICE_INFO_REPORT, request.seq, payload));
      }
    });
    const session = new ControlSession({
      transport,
      storage: createMemoryStorage(),
      reconnectDelaysMs: [1000],
    });
    const flush = async (): Promise<void> => {
      for (let i = 0; i < 100; i += 1) await Promise.resolve();
    };

    await session.connect("scripted");
    await flush();
    expect(
      session.deviceInfo?.hwId.startsWith("AA"),
      `首次重建应写入 AA…，实际 ${session.deviceInfo?.hwId}`,
    ).toBe(true);

    transport.emitLink("reconnecting");
    await vi.advanceTimersByTimeAsync(1000);
    await flush();

    expect(
      session.deviceInfo?.hwId.startsWith("BB"),
      `重连后的重建结果应保留，实际 ${session.deviceInfo?.hwId}`,
    ).toBe(true);
  });

  it("QueryStripConfig 只发 0x1C 单条查询", async () => {
    const { transport, session } = makeSession(makeRebuildResponder(() => undefined));
    await session.connect("scripted");
    await session.queryStripConfig();

    const before = transport.sent.length;
    const result = await session.queryStripConfig();

    expect(result.kind, `QueryStripConfig 应成功，实际 ${result.kind}`).toBe("ok");
    expect(
      transport.sent.slice(before).map((r) => r.command),
      "只应重新发送 0x1C，不应重跑 8 条链 + 场景 + DeviceInfo",
    ).toEqual([CMD.QUERY_STRIP_CONFIG]);
  });

  it("离散命令 Busy 重试一次，仍 Busy 时不再重试", async () => {
    const base = makeRebuildResponder(() => undefined);
    const transport = new ScriptedTransport(idleState(), (request, emit) => {
      if (request.command === CMD.SET_POWER) {
        emit(ackFrame(request, RESULT.BUSY));
        return;
      }
      base(request, emit);
    });
    const session = new ControlSession({ transport, storage: createMemoryStorage() });
    await session.connect("scripted");

    const result = await session.setPower(true);
    const powerRequests = transport.sent.filter((r) => r.command === CMD.SET_POWER);

    expect(result.kind, "两次 Busy 后应返回 ack-error").toBe("ack-error");
    if (result.kind === "ack-error") {
      expect(result.ack.resultCode).toBe(RESULT.BUSY);
    }
    expect(powerRequests.length, `应发送 2 次（原发 + 1 次重试），实际 ${powerRequests.length}`).toBe(2);
    expect(
      powerRequests[1].seq,
      `重试应复用同一 seq，实际 ${powerRequests[0].seq} → ${powerRequests[1].seq}`,
    ).toBe(powerRequests[0].seq);
  });

  it("离散命令 Busy 后重试成功", async () => {
    const base = makeRebuildResponder(() => undefined);
    let powerAttempts = 0;
    const transport = new ScriptedTransport(idleState(), (request, emit) => {
      if (request.command === CMD.SET_POWER) {
        powerAttempts += 1;
        emit(ackFrame(request, powerAttempts === 1 ? RESULT.BUSY : RESULT.OK));
        return;
      }
      base(request, emit);
    });
    const session = new ControlSession({ transport, storage: createMemoryStorage() });
    await session.connect("scripted");

    const result = await session.setPower(true);

    expect(result.kind).toBe("ok");
    expect(transport.sent.filter((r) => r.command === CMD.SET_POWER).length).toBe(2);
  });

  it("连续量（亮度）遇到 Busy 不重试", async () => {
    vi.useFakeTimers();
    const base = makeRebuildResponder(() => undefined);
    const transport = new ScriptedTransport(idleState(), (request, emit) => {
      if (request.command === CMD.SET_BRIGHTNESS) {
        emit(ackFrame(request, RESULT.BUSY));
        return;
      }
      base(request, emit);
    });
    const session = new ControlSession({ transport, storage: createMemoryStorage() });
    await session.connect("scripted");

    session.setBrightness(100);
    session.flushBrightness();
    await vi.advanceTimersByTimeAsync(100);

    expect(
      transport.sent.filter((r) => r.command === CMD.SET_BRIGHTNESS).length,
      "亮度是连续量，Busy 也不重发",
    ).toBe(1);
  });
});
