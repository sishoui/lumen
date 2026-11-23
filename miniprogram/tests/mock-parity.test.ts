/**
 * Mock 与固件同形（#19）：拒绝真机会拒绝的 part_id / 层参数，
 * QueryScene 报完整时间轴，DeviceInfo 报 v1.0，帧日志 TX→RX 且带命令名。
 *
 * 断言对象是设备读回值（QueryLayout / QueryScene / State / DeviceInfoReport）
 * 或 ACK 结果码，不是 Mock 内部数组。
 */

import { describe, it, expect } from "vitest";
import { MockTransport } from "../utils/ble/mock-transport";
import type { Transport } from "../utils/ble/transport";
import { MOCK_DEVICES } from "../utils/mock/mock-devices";
import { encodeFrame, decodeFrame } from "../utils/protocol/frame";
import {
  parseLayoutReport,
  parseScenePartReport,
  parseSceneStepReport,
} from "../utils/protocol/commands";
import { rebuildFromDevice } from "../utils/session/rebuild";
import { isValidSceneStepLayers } from "../utils/protocol/layer-rules";
import {
  CMD,
  DEVICE_CMD,
  EFFECT_TYPE,
  MAX_PARTS,
  NO_EFFECT,
  RESULT,
} from "../utils/protocol/constants";
import type { LayoutPart, ScenePartReport, SceneStepReport } from "../utils/protocol/types";

const desk = MOCK_DEVICES[0];

function layer(bytes: number[]): Uint8Array {
  if (bytes.length !== 9) throw new Error(`测试层必须是 9 字节，收到 ${bytes.length}`);
  return Uint8Array.from(bytes);
}

function staticLayer(hue = 1000, sat = 255, level = 80): Uint8Array {
  return layer([EFFECT_TYPE.STATIC, hue & 0xff, (hue >> 8) & 0xff, sat, 0, 0, 0, 0, level]);
}

function emptyLayer(): Uint8Array {
  return layer([NO_EFFECT, 0, 0, 0, 0, 0, 0, 0, 0]);
}

function sceneStepPayload(
  sceneId: number,
  stripId: number,
  partId: number,
  stepIndex: number,
  durationMs: number,
  layer0: Uint8Array,
  layer1: Uint8Array,
): Uint8Array {
  const payload = new Uint8Array(24);
  payload[0] = sceneId;
  payload[1] = stripId;
  payload[2] = partId;
  payload[3] = stepIndex;
  payload[4] = durationMs & 0xff;
  payload[5] = (durationMs >> 8) & 0xff;
  payload.set(layer0, 6);
  payload.set(layer1, 15);
  return payload;
}

async function connectMock(): Promise<Transport> {
  const transport = new MockTransport({ scenario: "normal" });
  await transport.connect(desk.deviceId, desk.broadcastName);
  return transport;
}

/** 发一条命令并等同一 seq 的 ACK；超时直接失败，不让测试静默通过。 */
function sendRaw(
  transport: Transport,
  command: number,
  seq: number,
  payload: Uint8Array,
): Promise<{ resultCode: number }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      off();
      reject(new Error(`seq=${seq} 600ms 内没有 ACK`));
    }, 600);
    const off = transport.onFrame((frame) => {
      const decoded = decodeFrame(frame);
      if (!decoded.ok || decoded.command !== DEVICE_CMD.ACK || decoded.seq !== seq) return;
      if (decoded.payload.length !== 2) return;
      clearTimeout(timer);
      off();
      resolve({ resultCode: decoded.payload[1] });
    });
    void transport.sendFrame(encodeFrame(command, seq, payload)).catch((err) => {
      clearTimeout(timer);
      off();
      reject(err);
    });
  });
}

/** 收多帧报告直到收尾帧。 */
function collectReports(
  transport: Transport,
  seq: number,
  endCommand: number,
): Promise<Uint8Array[]> {
  return new Promise((resolve, reject) => {
    const frames: Uint8Array[] = [];
    const timer = setTimeout(() => {
      off();
      reject(new Error(`seq=${seq} 800ms 内没有收尾帧 0x${endCommand.toString(16)}`));
    }, 800);
    const off = transport.onFrame((frame) => {
      const decoded = decodeFrame(frame);
      if (!decoded.ok || decoded.seq !== seq) return;
      frames.push(decoded.payload);
      if (decoded.command === endCommand) {
        clearTimeout(timer);
        off();
        resolve(frames);
      }
    });
  });
}

async function queryLayout(transport: Transport, stripId: number, seq: number): Promise<LayoutPart[]> {
  const reports = collectReports(transport, seq, DEVICE_CMD.LAYOUT_LIST_END);
  await transport.sendFrame(encodeFrame(CMD.QUERY_LAYOUT, seq, Uint8Array.from([stripId])));
  const payloads = await reports;
  return payloads
    .filter((payload) => payload.length === 45)
    .map((payload) => parseLayoutReport(payload));
}

interface SceneReadback {
  parts: ScenePartReport[];
  steps: SceneStepReport[];
}

async function queryScene(transport: Transport, sceneId: number, seq: number): Promise<SceneReadback> {
  const reports = collectReports(transport, seq, DEVICE_CMD.SCENE_LIST_END);
  await transport.sendFrame(encodeFrame(CMD.QUERY_SCENE, seq, Uint8Array.from([sceneId])));
  const payloads = await reports;
  const parts: ScenePartReport[] = [];
  const steps: SceneStepReport[] = [];
  for (const payload of payloads) {
    if (payload.length === 6) parts.push(parseScenePartReport(payload));
    else if (payload.length === 24) steps.push(parseSceneStepReport(payload));
  }
  return { parts, steps };
}

describe("Mock 布局族与固件同形", () => {
  it("LayoutPart / LayoutSeg 拒绝 part_id >= 已声明 part_count，读回不出现被拒部位", async () => {
    const transport = await connectMock();

    const write = await sendRaw(transport, CMD.LAYOUT_WRITE, 10, Uint8Array.from([0, 1]));
    expect(write.resultCode, `LayoutWrite(0,1) 期望 OK(0)，实际 ${write.resultCode}`).toBe(RESULT.OK);

    // 只声明了 1 个部位（0），part_id=1 必须被拒。
    const part = await sendRaw(
      transport,
      CMD.LAYOUT_PART,
      11,
      Uint8Array.from([0, 1, 0, ...new Uint8Array(24), 1, 0]),
    );
    expect(part.resultCode, `LayoutPart(part_id=1) 期望 InvalidParam(1)，实际 ${part.resultCode}`).toBe(
      RESULT.INVALID_PARAM,
    );

    const seg = await sendRaw(transport, CMD.LAYOUT_SEG, 12, Uint8Array.from([0, 1, 0, 0, 29]));
    expect(seg.resultCode, `LayoutSeg(part_id=1) 期望 InvalidParam(1)，实际 ${seg.resultCode}`).toBe(
      RESULT.INVALID_PARAM,
    );

    // 声明内的 part 0 仍可写并落盘。
    const part0 = await sendRaw(
      transport,
      CMD.LAYOUT_PART,
      13,
      Uint8Array.from([0, 0, 0, ...new Uint8Array(24), 1, 0]),
    );
    expect(part0.resultCode, `LayoutPart(part_id=0) 期望 OK(0)，实际 ${part0.resultCode}`).toBe(RESULT.OK);
    const seg0 = await sendRaw(transport, CMD.LAYOUT_SEG, 14, Uint8Array.from([0, 0, 0, 0, 29]));
    expect(seg0.resultCode, `LayoutSeg(part_id=0) 期望 OK(0)，实际 ${seg0.resultCode}`).toBe(RESULT.OK);
    await sendRaw(transport, CMD.LAYOUT_COMMIT, 15, new Uint8Array([]));

    const parts = await queryLayout(transport, 0, 16);
    expect(
      parts.map((p) => p.partId),
      `QueryLayout 期望只有 part 0，实际 [${parts.map((p) => p.partId).join(", ")}]`,
    ).toEqual([0]);
  });

  it("part_count 维持 LayoutWrite 的声明值（State 读回），不因空部位缩水", async () => {
    const transport = await connectMock();

    await sendRaw(transport, CMD.LAYOUT_WRITE, 20, Uint8Array.from([0, 2]));
    // 只写 part 1；part 0 留空。part_id=1 < 声明的 2，应接受。
    const part1 = await sendRaw(
      transport,
      CMD.LAYOUT_PART,
      21,
      Uint8Array.from([0, 1, 0, ...new Uint8Array(24), 1, 0]),
    );
    expect(part1.resultCode, `LayoutPart(part_id=1, part_count=2) 期望 OK(0)，实际 ${part1.resultCode}`).toBe(
      RESULT.OK,
    );
    await sendRaw(transport, CMD.LAYOUT_SEG, 22, Uint8Array.from([0, 1, 0, 30, 59]));
    await sendRaw(transport, CMD.LAYOUT_COMMIT, 23, new Uint8Array([]));

    const state = await transport.readState();
    expect(
      state.partCounts[0],
      `State.part_count[0] 期望声明值 2，实际 ${state.partCounts[0]}`,
    ).toBe(2);

    const parts = await queryLayout(transport, 0, 24);
    expect(
      parts.map((p) => p.partId),
      `QueryLayout 期望只报有段的 part 1，实际 [${parts.map((p) => p.partId).join(", ")}]`,
    ).toEqual([1]);
  });
});

describe("Mock 场景族与固件同形", () => {
  it("QueryScene 报告 step_count 内的每一步，未写入的步骤按时长 0、两层全 0 读回", async () => {
    const transport = await connectMock();

    const head = await sendRaw(transport, CMD.SCENE_PART, 30, Uint8Array.from([0, 0, 0, 3, 1, 1]));
    expect(head.resultCode, `ScenePart(step_count=3) 期望 OK(0)，实际 ${head.resultCode}`).toBe(RESULT.OK);
    const step0 = await sendRaw(
      transport,
      CMD.SCENE_STEP,
      31,
      sceneStepPayload(0, 0, 0, 0, 1500, staticLayer(), emptyLayer()),
    );
    expect(step0.resultCode, `写 step 0 期望 OK(0)，实际 ${step0.resultCode}`).toBe(RESULT.OK);

    // 0 步部位不演，不应被 QueryScene 报出来（固件 S10）。
    await sendRaw(transport, CMD.SCENE_PART, 32, Uint8Array.from([0, 0, 1, 0, 0, 0]));

    const scene = await queryScene(transport, 0, 33);
    expect(
      scene.parts.map((p) => p.partId),
      `ScenePartReport 期望只有 part 0，实际 [${scene.parts.map((p) => p.partId).join(", ")}]`,
    ).toEqual([0]);

    const steps = scene.steps
      .filter((s) => s.partId === 0)
      .sort((a, b) => a.stepIndex - b.stepIndex);
    expect(
      steps.map((s) => s.stepIndex),
      `step 索引期望 [0, 1, 2]，实际 [${steps.map((s) => s.stepIndex).join(", ")}]`,
    ).toEqual([0, 1, 2]);
    expect(
      steps.map((s) => s.durationMs),
      `时长期望 [1500, 0, 0]，实际 [${steps.map((s) => s.durationMs).join(", ")}]`,
    ).toEqual([1500, 0, 0]);
    expect(
      steps.slice(1).every((s) => s.layer0.type === 0 && s.layer0.level === 0 && s.layer1.type === 0),
      `未写入步骤的层期望全 0，实际 ${JSON.stringify(steps.slice(1).map((s) => [s.layer0, s.layer1]))}`,
    ).toBe(true);
  });

  it("ScenePart / SceneStep 按固件只拒绝 part_id >= MAX_PARTS，不绑定布局 part_count", async () => {
    const transport = await connectMock();

    const outOfRange = await sendRaw(transport, CMD.SCENE_PART, 40, Uint8Array.from([0, 0, MAX_PARTS, 1, 0, 1]));
    expect(
      outOfRange.resultCode,
      `ScenePart(part_id=${MAX_PARTS}) 期望 InvalidParam(1)，实际 ${outOfRange.resultCode}`,
    ).toBe(RESULT.INVALID_PARAM);

    // 固件 main/command.c 明确：场景与布局是两张表，不校验布局 part_count。
    // 书桌的链 0 只划分了 part 0/1；part 5 仍应被接受。
    const separateTable = await sendRaw(transport, CMD.SCENE_PART, 41, Uint8Array.from([0, 0, 5, 1, 0, 1]));
    expect(
      separateTable.resultCode,
      `ScenePart(part_id=5 < MAX_PARTS) 期望 OK(0)，实际 ${separateTable.resultCode}`,
    ).toBe(RESULT.OK);
    const step = await sendRaw(
      transport,
      CMD.SCENE_STEP,
      42,
      sceneStepPayload(0, 0, 5, 0, 1000, staticLayer(), emptyLayer()),
    );
    expect(step.resultCode, `SceneStep(part_id=5) 期望 OK(0)，实际 ${step.resultCode}`).toBe(RESULT.OK);

    const stepOutOfRange = await sendRaw(
      transport,
      CMD.SCENE_STEP,
      43,
      sceneStepPayload(0, 0, MAX_PARTS, 0, 1000, staticLayer(), emptyLayer()),
    );
    expect(
      stepOutOfRange.resultCode,
      `SceneStep(part_id=${MAX_PARTS}) 期望 InvalidParam(1)，实际 ${stepOutOfRange.resultCode}`,
    ).toBe(RESULT.INVALID_PARAM);

    const scene = await queryScene(transport, 0, 44);
    expect(
      scene.parts.some((p) => p.partId === 5),
      `QueryScene 期望读回 part 5，实际 [${scene.parts.map((p) => p.partId).join(", ")}]`,
    ).toBe(true);
  });

  it("非法层参数返回 InvalidParam，且不写入时间轴", async () => {
    const transport = await connectMock();
    await sendRaw(transport, CMD.SCENE_PART, 50, Uint8Array.from([0, 0, 0, 1, 0, 1]));

    const cases: Array<{ name: string; layer0: Uint8Array; layer1: Uint8Array }> = [
      { name: "layer0 为空层", layer0: emptyLayer(), layer1: emptyLayer() },
      {
        name: "layer1 空层带 level",
        layer0: staticLayer(),
        layer1: layer([NO_EFFECT, 0, 0, 0, 0, 0, 0, 0, 5]),
      },
      {
        name: "静态层带保留字节 period=2000",
        layer0: layer([EFFECT_TYPE.STATIC, 0, 0, 0, 0xd0, 0x07, 0, 0, 50]),
        layer1: emptyLayer(),
      },
      {
        name: "静态层带 flags=1",
        layer0: layer([EFFECT_TYPE.STATIC, 0, 0, 0, 0, 0, 0, 1, 50]),
        layer1: emptyLayer(),
      },
      {
        name: "熄灭层带 hue",
        layer0: layer([EFFECT_TYPE.OFF, 1, 0, 0, 0, 0, 0, 0, 0]),
        layer1: emptyLayer(),
      },
      { name: "level=101", layer0: staticLayer(1000, 255, 101), layer1: emptyLayer() },
      {
        name: "呼吸 period=200",
        layer0: layer([EFFECT_TYPE.BREATHING, 0, 0, 0, 200, 0, 0, 0, 50]),
        layer1: emptyLayer(),
      },
      {
        name: "呼吸 flags bit3",
        layer0: layer([EFFECT_TYPE.BREATHING, 0, 0, 0, 0, 0, 0, 8, 50]),
        layer1: emptyLayer(),
      },
      {
        name: "呼吸 p5=101",
        layer0: layer([EFFECT_TYPE.BREATHING, 0, 0, 0, 0, 0, 101, 0, 50]),
        layer1: emptyLayer(),
      },
      {
        name: "彩虹 flags bit1",
        layer0: layer([EFFECT_TYPE.RAINBOW, 0, 0, 0, 0, 0, 0, 2, 50]),
        layer1: emptyLayer(),
      },
      {
        name: "流光 flags bit4",
        layer0: layer([EFFECT_TYPE.COMET, 0, 0, 0, 0, 0, 0, 0x10, 50]),
        layer1: emptyLayer(),
      },
      {
        name: "爆闪 period=50",
        layer0: layer([EFFECT_TYPE.STROBE, 0, 0, 0, 50, 0, 0, 0, 50]),
        layer1: emptyLayer(),
      },
      {
        name: "爆闪 flags=1",
        layer0: layer([EFFECT_TYPE.STROBE, 0, 0, 0, 0, 0, 0, 1, 50]),
        layer1: emptyLayer(),
      },
      {
        name: "心跳 period=200",
        layer0: layer([EFFECT_TYPE.HEARTBEAT, 0, 0, 0, 200, 0, 0, 0, 50]),
        layer1: emptyLayer(),
      },
      {
        name: "心跳 period=1600",
        layer0: layer([EFFECT_TYPE.HEARTBEAT, 0, 0, 0, 0x40, 0x06, 0, 0, 50]),
        layer1: emptyLayer(),
      },
      {
        name: "心跳 flags bit1",
        layer0: layer([EFFECT_TYPE.HEARTBEAT, 0, 0, 0, 0, 0, 0, 2, 50]),
        layer1: emptyLayer(),
      },
      {
        name: "随机闪烁 period=200",
        layer0: layer([EFFECT_TYPE.FLICKER, 0, 0, 0, 200, 0, 0, 0, 50]),
        layer1: emptyLayer(),
      },
      {
        name: "layer0 未知类型 0x08",
        layer0: layer([0x08, 0, 0, 0, 0, 0, 0, 0, 50]),
        layer1: emptyLayer(),
      },
      {
        name: "layer1 未知类型 0x08",
        layer0: staticLayer(),
        layer1: layer([0x08, 0, 0, 0, 0, 0, 0, 0, 0]),
      },
    ];

    let seq = 51;
    for (const testCase of cases) {
      const ack = await sendRaw(
        transport,
        CMD.SCENE_STEP,
        seq,
        sceneStepPayload(0, 0, 0, 0, 1000, testCase.layer0, testCase.layer1),
      );
      expect(ack.resultCode, `${testCase.name} 期望 InvalidParam(1)，实际 ${ack.resultCode}`).toBe(
        RESULT.INVALID_PARAM,
      );
      seq += 1;
    }

    const afterRejects = await queryScene(transport, 0, seq);
    const step0 = afterRejects.steps.find((s) => s.partId === 0 && s.stepIndex === 0);
    expect(step0, "被拒的写入不应产生 step 0").toBeDefined();
    expect(
      step0?.durationMs,
      `被拒的写入不应改时间轴，期望 step 0 时长 0，实际 ${step0?.durationMs}`,
    ).toBe(0);
    expect(
      step0?.layer0.level,
      `被拒的写入不应改层，期望 layer0.level 0，实际 ${step0?.layer0.level}`,
    ).toBe(0);

    // 合法层仍能写入并读回，证明拒绝不是「什么都拒绝」。
    const ok = await sendRaw(
      transport,
      CMD.SCENE_STEP,
      seq + 1,
      sceneStepPayload(0, 0, 0, 0, 1000, staticLayer(5000, 128, 60), emptyLayer()),
    );
    expect(ok.resultCode, `合法静态层期望 OK(0)，实际 ${ok.resultCode}`).toBe(RESULT.OK);
    const afterWrite = await queryScene(transport, 0, seq + 2);
    const written = afterWrite.steps.find((s) => s.partId === 0 && s.stepIndex === 0);
    expect(written?.durationMs, `读回时长期望 1000，实际 ${written?.durationMs}`).toBe(1000);
    expect(
      [written?.layer0.type, written?.layer0.hue, written?.layer0.sat, written?.layer0.level],
      `读回层期望 [0, 5000, 128, 60]，实际 ${JSON.stringify(written?.layer0)}`,
    ).toEqual([EFFECT_TYPE.STATIC, 5000, 128, 60]);
  });

  it("层校验器接受固件允许的边界值", () => {
    const valid: Array<{ name: string; layer0: Uint8Array }> = [
      { name: "静态", layer0: staticLayer() },
      { name: "呼吸 period=0", layer0: layer([EFFECT_TYPE.BREATHING, 0, 0, 0, 0, 0, 0, 0, 50]) },
      { name: "呼吸 period=334", layer0: layer([EFFECT_TYPE.BREATHING, 0, 0, 0, 334 & 0xff, 334 >> 8, 0, 0, 50]) },
      { name: "彩虹 period=200", layer0: layer([EFFECT_TYPE.RAINBOW, 0, 0, 0, 200, 0, 0, 0, 50]) },
      { name: "流光 flags=0x0F", layer0: layer([EFFECT_TYPE.COMET, 0, 0, 0, 0, 0, 0, 0x0f, 50]) },
      { name: "爆闪 period=100", layer0: layer([EFFECT_TYPE.STROBE, 0, 0, 0, 100, 0, 0, 0, 50]) },
      { name: "心跳 period=500", layer0: layer([EFFECT_TYPE.HEARTBEAT, 0, 0, 0, 500 & 0xff, 500 >> 8, 0, 0, 50]) },
      { name: "心跳 period=1500", layer0: layer([EFFECT_TYPE.HEARTBEAT, 0, 0, 0, 1500 & 0xff, 1500 >> 8, 0, 0, 50]) },
      { name: "熄灭全 0", layer0: layer([EFFECT_TYPE.OFF, 0, 0, 0, 0, 0, 0, 0, 0]) },
      { name: "随机闪烁 period=334", layer0: layer([EFFECT_TYPE.FLICKER, 0, 0, 0, 334 & 0xff, 334 >> 8, 0, 0, 50]) },
    ];
    for (const testCase of valid) {
      expect(
        isValidSceneStepLayers(testCase.layer0, emptyLayer()),
        `${testCase.name} 应被接受，实际被拒`,
      ).toBe(true);
    }
  });
});

describe("Mock DeviceInfo 与固件同形", () => {
  it("DeviceInfoReport 的 firmware_version 是 0x0100（v1.0）", async () => {
    const transport = await connectMock();
    const state = await transport.readState();
    const rebuilt = await rebuildFromDevice(transport, state, { ackTimeoutMs: 1500 });
    expect(rebuilt.deviceInfo, "rebuild 未拿到 DeviceInfoReport").not.toBeNull();
    expect(
      rebuilt.deviceInfo?.firmwareVersion,
      `firmwareVersion 期望 0x0100，实际 0x${(rebuilt.deviceInfo?.firmwareVersion ?? 0).toString(16)}`,
    ).toBe(0x0100);
    expect(
      [rebuilt.deviceInfo?.firmwareMajor, rebuilt.deviceInfo?.firmwareMinor],
      `页面展示用主/次版本期望 [1, 0]，实际 ${JSON.stringify([rebuilt.deviceInfo?.firmwareMajor, rebuilt.deviceInfo?.firmwareMinor])}`,
    ).toEqual([1, 0]);
  });
});

describe("Mock 帧日志", () => {
  it("TX 先于 RX，每条都有 commandName", async () => {
    const transport = await connectMock();

    await sendRaw(transport, CMD.SET_POWER, 77, Uint8Array.from([1]));
    await sendRaw(transport, CMD.QUERY_STATE, 78, new Uint8Array([]));

    const entries = transport instanceof MockTransport ? transport.logSource.snapshot() : [];
    expect(entries.length, `帧日志期望非空，实际 ${entries.length} 条`).toBeGreaterThan(0);
    for (const entry of entries) {
      expect(
        entry.commandName,
        `${entry.dir.toUpperCase()} seq=${entry.seq} 期望有 commandName，实际为空`,
      ).toBeTruthy();
    }

    const powerFrames = entries.filter((e) => e.seq === 77);
    expect(
      powerFrames[0]?.dir,
      `seq=77 的第一条期望 TX，实际 ${powerFrames[0]?.dir}`,
    ).toBe("tx");
    expect(
      powerFrames[0]?.commandName,
      `SetPower 的 TX 命令名期望 SetPower，实际 ${powerFrames[0]?.commandName}`,
    ).toBe("SetPower");
    expect(
      powerFrames.slice(1).every((e) => e.dir === "rx"),
      `seq=77 的 TX 之后期望全是 RX，实际 ${JSON.stringify(powerFrames.map((e) => e.dir))}`,
    ).toBe(true);
    expect(
      powerFrames.some((e) => e.dir === "rx" && e.commandName === "ACK"),
      `seq=77 期望有名为 ACK 的 RX，实际 ${JSON.stringify(powerFrames.map((e) => e.commandName))}`,
    ).toBe(true);

    const stateFrames = entries.filter((e) => e.seq === 78);
    expect(stateFrames[0]?.dir, `seq=78 的第一条期望 TX，实际 ${stateFrames[0]?.dir}`).toBe("tx");
    expect(
      stateFrames.some((e) => e.commandName === "StateReport"),
      `seq=78 期望有 StateReport，实际 ${JSON.stringify(stateFrames.map((e) => e.commandName))}`,
    ).toBe(true);
  });
});
