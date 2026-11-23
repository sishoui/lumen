/**
 * #28 灯效参数发送前校验：字段级错误 + 发送拦截 + 类型切换归一化读回。
 *
 * 行为断言：给定一个会记录 sendFrame 的 transport，非法层不得产生 SceneStep；
 * 合法层发出的载荷字段与读回值符合固件规则（docs/protocol.md §9）。
 */

import { describe, it, expect } from "vitest";
import { MockTransport } from "../utils/ble/mock-transport";
import { ControlSession } from "../utils/session/session";
import { createMemoryStorage } from "./helpers/storage";
import { MOCK_DEVICES } from "../utils/mock/mock-devices";
import { LOOP, EFFECT_TYPE, NO_EFFECT, CMD, DEVICE_CMD } from "../utils/protocol/constants";
import type { EffectLayer, SceneStep } from "../utils/protocol/types";
import {
  validateLayerForSend, normalizeLayer, switchEffectType, createStaticLayer,
} from "../utils/scene-editor";
import { decodeFrame } from "../utils/protocol/frame";

const EMPTY: EffectLayer = { type: NO_EFFECT, hue: 0, sat: 0, periodMs: 0, p5: 0, flags: 0, level: 0 };

function base(overrides: Partial<EffectLayer> = {}): EffectLayer {
  return {
    type: EFFECT_TYPE.BREATHING, hue: 1200, sat: 200,
    periodMs: 1000, p5: 0, flags: 0, level: 70,
    ...overrides,
  };
}

describe("#28 validateLayerForSend 字段级校验", () => {
  const overlay = { isOverlay: true };
  const under = { isOverlay: false };

  it("level 101 非法、level 0 合法", () => {
    const bad = validateLayerForSend(base({ level: 101 }), under);
    expect(bad.ok).toBe(false);
    expect(bad.errors.some((e) => e.field === "level")).toBe(true);
    expect(bad.firstError).toContain("亮度");
    expect(bad.firstError).toContain("100");

    const good = validateLayerForSend(base({ level: 0 }), under);
    expect(good.ok).toBe(true);
    expect(good.errors).toEqual([]);
    expect(good.firstError).toBe("");
  });

  it("静态 period 2000 非法、period 0 合法", () => {
    const bad = validateLayerForSend(base({ type: EFFECT_TYPE.STATIC, periodMs: 2000 }), under);
    expect(bad.ok).toBe(false);
    expect(bad.errors.some((e) => e.field === "period")).toBe(true);
    expect(bad.firstError).toContain("周期");

    const good = validateLayerForSend(base({ type: EFFECT_TYPE.STATIC, periodMs: 0 }), under);
    expect(good.ok).toBe(true);
  });

  it("心跳 period 边界 499/500/1500/1501", () => {
    const at = (periodMs: number) => validateLayerForSend(
      base({ type: EFFECT_TYPE.HEARTBEAT, periodMs }), under,
    );
    expect(at(499).ok).toBe(false);
    expect(at(500).ok).toBe(true);
    expect(at(1500).ok).toBe(true);
    expect(at(1501).ok).toBe(false);
    expect(at(200).firstError).toContain("500–1500");
  });

  it("呼吸 period 333 非法 / 334 合法；p5 101 非法", () => {
    expect(validateLayerForSend(base({ type: EFFECT_TYPE.BREATHING, periodMs: 333 }), under).ok).toBe(false);
    expect(validateLayerForSend(base({ type: EFFECT_TYPE.BREATHING, periodMs: 334 }), under).ok).toBe(true);
    const p5bad = validateLayerForSend(base({ type: EFFECT_TYPE.BREATHING, p5: 101 }), under);
    expect(p5bad.ok).toBe(false);
    expect(p5bad.errors.some((e) => e.field === "p5")).toBe(true);
  });

  it("叠加层空层带 hue/level 非法", () => {
    const bad = validateLayerForSend({ ...EMPTY, hue: 100, level: 50 }, overlay);
    expect(bad.ok).toBe(false);
    expect(bad.errors.some((e) => e.field === "type")).toBe(true);
    expect(validateLayerForSend({ ...EMPTY }, overlay).ok).toBe(true);
  });

  it("底层空层非法", () => {
    const bad = validateLayerForSend({ ...EMPTY }, under);
    expect(bad.ok).toBe(false);
    expect(bad.firstError).toContain("底层");
  });

  it("未知 type 非法", () => {
    const bad = validateLayerForSend(base({ type: 0x42 }), under);
    expect(bad.ok).toBe(false);
    expect(bad.errors.some((e) => e.field === "type")).toBe(true);
    expect(bad.firstError).toContain("未知");
  });

  it("熄灭带 hue 非法", () => {
    const bad = validateLayerForSend(base({ type: EFFECT_TYPE.OFF, hue: 300 }), under);
    expect(bad.ok).toBe(false);
    expect(bad.firstError).toContain("熄灭");
  });

  it("静态 flags 非 0 非法", () => {
    const bad = validateLayerForSend(base({ type: EFFECT_TYPE.STATIC, flags: 0x01 }), under);
    expect(bad.ok).toBe(false);
    expect(bad.errors.some((e) => e.field === "flags")).toBe(true);
  });

  it("心跳 flags 保留位非法（bit1 起）", () => {
    expect(validateLayerForSend(base({ type: EFFECT_TYPE.HEARTBEAT, flags: 0x01 }), under).ok).toBe(true);
    expect(validateLayerForSend(base({ type: EFFECT_TYPE.HEARTBEAT, flags: 0x02 }), under).ok).toBe(false);
  });
});

/** 记录所有发出的帧；转发给真实 MockTransport 以保持设备可读写。 */
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

function sceneStepFrames(frames: Uint8Array[]): Uint8Array[] {
  return frames.filter((f) => {
    const decoded = decodeFrame(f);
    return decoded.ok && decoded.command === CMD.SCENE_STEP;
  });
}

async function connect(rec: { transport: MockTransport }): Promise<ControlSession> {
  const session = new ControlSession({ transport: rec.transport, storage: createMemoryStorage() });
  const desk = MOCK_DEVICES[0];
  await session.connect(desk.deviceId, desk.broadcastName);
  await new Promise((r) => setTimeout(r, 50));
  return session;
}

async function readStep(session: ControlSession, stepIndex: number): Promise<SceneStep> {
  const res = await session.queryScene(0);
  expect(res.kind).toBe("ok");
  if (res.kind !== "ok") throw new Error("QueryScene 失败");
  const step = res.scene.steps.find(
    (s) => s.stripId === 0 && s.partId === 0 && s.stepIndex === stepIndex,
  );
  expect(step, `读回缺少步骤 ${stepIndex}`).toBeTruthy();
  return step!;
}

describe("#28 发送前拦截与载荷", () => {
  it("非法层不发送 SceneStep；合法层发送且载荷字段正确", async () => {
    const rec = recordingTransport();
    const session = await connect(rec);
    await session.scenePart(0, 0, 0, { stepCount: 1, loop: LOOP.ALL, on: true });
    rec.frames.length = 0;

    const bad0 = normalizeLayer(base({ level: 101 }));
    const bad1 = normalizeLayer(EMPTY);
    const badStep: SceneStep = {
      sceneId: 0, stripId: 0, partId: 0, stepIndex: 0, durationMs: 1000,
      layer0: bad0, layer1: bad1,
    };
    const v0 = validateLayerForSend(badStep.layer0, { isOverlay: false });
    const v1 = validateLayerForSend(badStep.layer1, { isOverlay: true });
    expect(v0.ok).toBe(false);
    expect(v1.ok).toBe(true);
    expect(sceneStepFrames(rec.frames).length).toBe(0);

    const good0 = normalizeLayer(base({ level: 80, type: EFFECT_TYPE.STATIC, hue: 500, sat: 255 }));
    const goodStep: SceneStep = {
      sceneId: 0, stripId: 0, partId: 0, stepIndex: 0, durationMs: 1200,
      layer0: good0, layer1: { ...EMPTY },
    };
    const write = await session.sceneStep(0, 0, 0, 0, goodStep);
    expect(write.kind).toBe("ok");
    const sent = sceneStepFrames(rec.frames);
    expect(sent.length).toBe(1);
    const decoded = decodeFrame(sent[0]);
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) throw new Error("帧解码失败");
    expect(decoded.command).toBe(CMD.SCENE_STEP);
    // 载荷偏移：payload[6..14] 是 layer0 的 9 字节。
    const p = decoded.payload;
    expect(p[6]).toBe(EFFECT_TYPE.STATIC);
    expect(p[7] | (p[8] << 8)).toBe(500);
    expect(p[9]).toBe(255);
    expect(p[14]).toBe(80);

    const read = await readStep(session, 0);
    expect(read.layer0.type).toBe(EFFECT_TYPE.STATIC);
    expect(read.layer0.hue).toBe(500);
    expect(read.layer0.sat).toBe(255);
    expect(read.layer0.level).toBe(80);
    expect(read.layer0.periodMs).toBe(0);
  });

  it("呼吸→静态保存读回 period=0", async () => {
    const rec = recordingTransport();
    const session = await connect(rec);
    await session.scenePart(0, 0, 0, { stepCount: 1, loop: LOOP.ALL, on: true });
    const l0 = switchEffectType(base({ periodMs: 1000 }), EFFECT_TYPE.STATIC, false);
    expect(l0.periodMs).toBe(0);
    const v = validateLayerForSend(l0, { isOverlay: false });
    expect(v.ok).toBe(true);
    const w = await session.sceneStep(0, 0, 0, 0, {
      sceneId: 0, stripId: 0, partId: 0, stepIndex: 0, durationMs: 1000,
      layer0: l0, layer1: { ...EMPTY },
    });
    expect(w.kind).toBe("ok");
    const read = await readStep(session, 0);
    expect(read.layer0.periodMs).toBe(0);
    expect(read.layer0.type).toBe(EFFECT_TYPE.STATIC);
  });

  it("呼吸→熄灭保存读回参数全 0（除 level）", async () => {
    const rec = recordingTransport();
    const session = await connect(rec);
    await session.scenePart(0, 0, 0, { stepCount: 1, loop: LOOP.ALL, on: true });
    const l0 = switchEffectType(base({ hue: 1200, sat: 200, periodMs: 1000 }), EFFECT_TYPE.OFF, false);
    expect(l0).toMatchObject({ type: EFFECT_TYPE.OFF, hue: 0, sat: 0, periodMs: 0, p5: 0, flags: 0, level: 70 });
    expect(validateLayerForSend(l0, { isOverlay: false }).ok).toBe(true);
    await session.sceneStep(0, 0, 0, 0, {
      sceneId: 0, stripId: 0, partId: 0, stepIndex: 0, durationMs: 1000,
      layer0: l0, layer1: { ...EMPTY },
    });
    const read = await readStep(session, 0);
    expect(read.layer0).toEqual({ type: EFFECT_TYPE.OFF, hue: 0, sat: 0, periodMs: 0, p5: 0, flags: 0, level: 70 });
  });

  it("叠加层空层保存读回 0xFF 且全 0", async () => {
    const rec = recordingTransport();
    const session = await connect(rec);
    await session.scenePart(0, 0, 0, { stepCount: 1, loop: LOOP.ALL, on: true });
    const empty = switchEffectType(base(), NO_EFFECT, true);
    expect(empty).toEqual({ ...EMPTY });
    expect(validateLayerForSend(empty, { isOverlay: true }).ok).toBe(true);
    await session.sceneStep(0, 0, 0, 0, {
      sceneId: 0, stripId: 0, partId: 0, stepIndex: 0, durationMs: 1000,
      layer0: createStaticLayer(500, 255, 100), layer1: empty,
    });
    const read = await readStep(session, 0);
    expect(read.layer1).toEqual({ ...EMPTY });
  });

  it("静态层保留字节为 0：读回 p5/flags/period 均为 0", async () => {
    const rec = recordingTransport();
    const session = await connect(rec);
    await session.scenePart(0, 0, 0, { stepCount: 1, loop: LOOP.ALL, on: true });
    await session.sceneStep(0, 0, 0, 0, {
      sceneId: 0, stripId: 0, partId: 0, stepIndex: 0, durationMs: 1000,
      layer0: createStaticLayer(1000, 200, 60), layer1: { ...EMPTY },
    });
    const read = await readStep(session, 0);
    expect(read.layer0.periodMs).toBe(0);
    expect(read.layer0.p5).toBe(0);
    expect(read.layer0.flags).toBe(0);
  });
});