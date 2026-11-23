/** 场景编辑器（时间轴）测试：步骤往返 + 两层灯效 + 循环模式 + 类型映射与字段显隐。 */

import { describe, it, expect } from "vitest";
import { MockTransport } from "../utils/ble/mock-transport";
import { ControlSession } from "../utils/session/session";
import { createMemoryStorage } from "./helpers/storage";
import { MOCK_DEVICES } from "../utils/mock/mock-devices";
import {
  LOOP, EFFECT_TYPE, NO_EFFECT, LAYER_LEVEL_MAX, CMD, DEVICE_CMD,
  isValidEffectPeriod,
} from "../utils/protocol/constants";
import { decodeFrame, encodeFrame } from "../utils/protocol/frame";
import { validateNameBytes } from "../utils/name-bytes";
import type { EffectLayer } from "../utils/protocol/types";
import {
  validateDuration, validateLoop, createEmptyStep, createStaticLayer, isLayerEmpty,
  effectLabel, layerPickerOptions, pickerIndexToType, pickerIndexForType,
  layerFieldVisibility, normalizeLayer, switchEffectType, OVERLAY_DEFAULT_LEVEL,
} from "../utils/scene-editor";
import type { SceneStep } from "../utils/protocol/types";
import {
  ScriptedTransport, ackFrame, idleState, makeRebuildResponder,
} from "./helpers/scripted-transport";

describe("场景编辑器", () => {
  it("validateDuration", () => {
    expect(validateDuration(1000)).toBeNull();
    expect(validateDuration(50)).toContain("下限");
    expect(validateDuration(70000)).toContain("上限");
    expect(validateDuration(-100)).toContain("下限");
  });

  it("validateLoop", () => {
    expect(validateLoop(LOOP.NONE)).toBeNull();
    expect(validateLoop(LOOP.LAST)).toBeNull();
    expect(validateLoop(3)).toContain("超出");
    expect(validateLoop(-1)).toContain("超出");
  });

  it("createEmptyStep + createStaticLayer", () => {
    const step = createEmptyStep(0, 0, 0, 0);
    expect(step.durationMs).toBe(1000);
    const layer = createStaticLayer(12345, 200, 50);
    expect(layer.type).toBe(EFFECT_TYPE.STATIC);
    expect(layer.hue).toBe(12345);
    expect(layer.sat).toBe(200);
    expect(layer.level).toBe(50);
    expect(isLayerEmpty(layer)).toBe(false);
  });

  it("scenePart + sceneStep 往返（MockTransport）", async () => {
    const transport = new MockTransport({ scenario: "normal" });
    const storage = createMemoryStorage();
    const session = new ControlSession({ transport, storage });
    const desk = MOCK_DEVICES[0];
    await session.connect(desk.deviceId, desk.broadcastName);
    // 等待 rebuild 完成
    await new Promise((r) => setTimeout(r, 50));

    // 设置场景 0 的部位 0（stripId=0, partId=0）头
    const r1 = await session.scenePart(0, 0, 0, { stepCount: 2, loop: LOOP.ALL, on: true });
    expect(r1.kind).toBe("ok");

    // 写步骤 0
    const step0: SceneStep = {
      sceneId: 0, stripId: 0, partId: 0, stepIndex: 0,
      durationMs: 1500,
      layer0: createStaticLayer(1000, 255, 80),
      layer1: { type: 0xff, hue: 0, sat: 0, periodMs: 0, p5: 0, flags: 0, level: 0 },
    };
    const r2 = await session.sceneStep(0, 0, 0, 0, step0);
    expect(r2.kind).toBe("ok");

    // 写步骤 1
    const step1: SceneStep = {
      sceneId: 0, stripId: 0, partId: 0, stepIndex: 1,
      durationMs: 2000,
      layer0: createStaticLayer(5000, 128, 60),
      layer1: { type: 0xff, hue: 0, sat: 0, periodMs: 0, p5: 0, flags: 0, level: 0 },
    };
    const r3 = await session.sceneStep(0, 0, 0, 1, step1);
    expect(r3.kind).toBe("ok");

    // 重新查询场景验证读回
    const result = await session.queryScene(0);
    expect(result.kind).toBe("ok");
    if (result.kind === "ok") {
      expect(result.scene.parts.length).toBeGreaterThan(0);
      const part = result.scene.parts.find((p) => p.stripId === 0 && p.partId === 0);
      expect(part?.stepCount).toBe(2);
      const steps = result.scene.steps.filter((s) => s.stripId === 0 && s.partId === 0);
      expect(steps.length).toBe(2);
      expect(steps[0].durationMs).toBe(1500);
      expect(steps[1].durationMs).toBe(2000);
    }
  });

  it("sceneName 往返", async () => {
    const transport = new MockTransport({ scenario: "normal" });
    const storage = createMemoryStorage();
    const session = new ControlSession({ transport, storage });
    const desk = MOCK_DEVICES[0];
    await session.connect(desk.deviceId, desk.broadcastName);

    const r = await session.sceneName(0, "测试场景");
    expect(r.kind).toBe("ok");
  });

  it("activateScene", async () => {
    const transport = new MockTransport({ scenario: "normal" });
    const storage = createMemoryStorage();
    const session = new ControlSession({ transport, storage });
    const desk = MOCK_DEVICES[0];
    await session.connect(desk.deviceId, desk.broadcastName);

    const r = await session.activateScene(1);
    expect(r.kind).toBe("ok");
    if (r.kind === "ok") {
      expect(r.state?.activeScene).toBe(1);
    }
  });

  it("场景步骤校验：stepIndex >= stepCount 返回 InvalidParam", async () => {
    const transport = new MockTransport({ scenario: "normal" });
    const storage = createMemoryStorage();
    const session = new ControlSession({ transport, storage });
    const desk = MOCK_DEVICES[0];
    await session.connect(desk.deviceId, desk.broadcastName);

    // 先设 stepCount=1
    await session.scenePart(0, 0, 0, { stepCount: 1, loop: 0, on: true });

    // 试图写 stepIndex=2（超出）
    const step: SceneStep = {
      sceneId: 0, stripId: 0, partId: 0, stepIndex: 2,
      durationMs: 1000,
      layer0: createStaticLayer(0, 255, 100),
      layer1: { type: 0xff, hue: 0, sat: 0, periodMs: 0, p5: 0, flags: 0, level: 0 },
    };
    const r = await session.sceneStep(0, 0, 0, 2, step);
    expect(r.kind).toBe("ack-error");
    if (r.kind === "ack-error") {
      expect(r.ack.resultCode).toBe(1); // INVALID_PARAM
    }
  });
});

describe("灯效类型映射与字段显隐（#27）", () => {
  const breathing = (overrides: Partial<EffectLayer> = {}): EffectLayer => ({
    type: EFFECT_TYPE.BREATHING,
    hue: 1200,
    sat: 200,
    periodMs: 2000,
    p5: 0,
    flags: 0,
    level: 70,
    ...overrides,
  });

  async function connectDesk(): Promise<ControlSession> {
    const transport = new MockTransport({ scenario: "normal" });
    const session = new ControlSession({ transport, storage: createMemoryStorage() });
    const desk = MOCK_DEVICES[0];
    await session.connect(desk.deviceId, desk.broadcastName);
    await new Promise((r) => setTimeout(r, 50));
    return session;
  }

  async function readStep(
    session: ControlSession, stepIndex: number,
  ): Promise<SceneStep> {
    const res = await session.queryScene(0);
    expect(res.kind).toBe("ok");
    if (res.kind !== "ok") throw new Error("QueryScene 失败");
    const step = res.scene.steps.find(
      (s) => s.stripId === 0 && s.partId === 0 && s.stepIndex === stepIndex,
    );
    expect(step, `读回缺少步骤 ${stepIndex}`).toBeTruthy();
    return step!;
  }

  it("picker 选项的 value 是协议 type：底层不含空层，叠加层含空层", () => {
    const base = layerPickerOptions(false);
    const overlay = layerPickerOptions(true);

    expect(base.map((o) => o.value)).toEqual([
      EFFECT_TYPE.STATIC, EFFECT_TYPE.BREATHING, EFFECT_TYPE.RAINBOW, EFFECT_TYPE.COMET,
      EFFECT_TYPE.STROBE, EFFECT_TYPE.HEARTBEAT, EFFECT_TYPE.OFF, EFFECT_TYPE.FLICKER,
    ]);
    expect(base.some((o) => o.value === NO_EFFECT)).toBe(false);
    expect(base.some((o) => o.label === "空层")).toBe(false);
    expect(overlay[overlay.length - 1]).toEqual({ value: NO_EFFECT, label: "空层" });
    expect(overlay.map((o) => o.label)).toEqual([
      "静态", "呼吸", "彩虹", "流光", "爆闪", "心跳", "熄灭", "随机", "空层",
    ]);
  });

  it("index → 协议 type 换算，type → 索引可逆", () => {
    const base = layerPickerOptions(false);
    const overlay = layerPickerOptions(true);

    overlay.forEach((option, index) => {
      expect(pickerIndexToType(overlay, index)).toBe(option.value);
    });
    // 叠加层最后一个下标对应 0xFF，而不是下标本身
    expect(pickerIndexToType(overlay, 8)).toBe(NO_EFFECT);
    expect(pickerIndexForType(overlay, NO_EFFECT)).toBe(8);
    expect(pickerIndexForType(overlay, EFFECT_TYPE.HEARTBEAT)).toBe(5);
    // 底层没有空层：读回空层时回退到第一项
    expect(pickerIndexForType(base, NO_EFFECT)).toBe(0);
    expect(() => pickerIndexToType(base, 8)).toThrow(RangeError);
  });

  it("字段可见性由协议类型决定", () => {
    expect(layerFieldVisibility(EFFECT_TYPE.STATIC)).toEqual({
      hue: true, sat: true, period: false, level: true,
    });
    expect(layerFieldVisibility(EFFECT_TYPE.HEARTBEAT)).toEqual({
      hue: true, sat: true, period: true, level: true,
    });
    for (const type of [
      EFFECT_TYPE.BREATHING, EFFECT_TYPE.RAINBOW, EFFECT_TYPE.COMET,
      EFFECT_TYPE.STROBE, EFFECT_TYPE.FLICKER,
    ]) {
      expect(layerFieldVisibility(type).period, `type=${type} 应显示周期`).toBe(true);
    }
    expect(layerFieldVisibility(EFFECT_TYPE.OFF)).toEqual({
      hue: false, sat: false, period: false, level: false,
    });
    expect(layerFieldVisibility(NO_EFFECT)).toEqual({
      hue: false, sat: false, period: false, level: false,
    });
  });

  it("类型切换归一化：静态清周期，熄灭只留亮度，空层全 0", () => {
    const staticLayer = switchEffectType(breathing(), EFFECT_TYPE.STATIC, false);
    expect(staticLayer).toEqual({
      type: EFFECT_TYPE.STATIC, hue: 1200, sat: 200, periodMs: 0, p5: 0, flags: 0, level: 70,
    });

    const off = switchEffectType(breathing(), EFFECT_TYPE.OFF, false);
    expect(off).toEqual({
      type: EFFECT_TYPE.OFF, hue: 0, sat: 0, periodMs: 0, p5: 0, flags: 0, level: 70,
    });

    const empty = switchEffectType(breathing(), NO_EFFECT, true);
    expect(empty).toEqual({
      type: NO_EFFECT, hue: 0, sat: 0, periodMs: 0, p5: 0, flags: 0, level: 0,
    });
  });

  it("从空层切到真实效果补默认亮度：叠加层 50，底层 100", () => {
    const empty: EffectLayer = {
      type: NO_EFFECT, hue: 0, sat: 0, periodMs: 0, p5: 0, flags: 0, level: 0,
    };
    const overlay = switchEffectType(empty, EFFECT_TYPE.BREATHING, true);
    expect(overlay.type).toBe(EFFECT_TYPE.BREATHING);
    expect(overlay.level).toBe(OVERLAY_DEFAULT_LEVEL);
    expect(overlay.level).toBe(50);
    // 周期沿用 0 = 设备默认
    expect(overlay.periodMs).toBe(0);

    const base = switchEffectType(empty, EFFECT_TYPE.BREATHING, false);
    expect(base.level).toBe(LAYER_LEVEL_MAX);
    expect(base.level).toBe(100);
  });

  it("周期边界按固件规则（0 表示设备默认）", () => {
    expect(isValidEffectPeriod(EFFECT_TYPE.BREATHING, 333)).toBe(false);
    expect(isValidEffectPeriod(EFFECT_TYPE.BREATHING, 334)).toBe(true);
    expect(isValidEffectPeriod(EFFECT_TYPE.RAINBOW, 199)).toBe(false);
    expect(isValidEffectPeriod(EFFECT_TYPE.RAINBOW, 200)).toBe(true);
    // 固件 effects.c 的 COMET 分支用 LUMEN_RAINBOW_MIN_PERIOD_MS
    expect(isValidEffectPeriod(EFFECT_TYPE.COMET, 199)).toBe(false);
    expect(isValidEffectPeriod(EFFECT_TYPE.COMET, 200)).toBe(true);
    expect(isValidEffectPeriod(EFFECT_TYPE.STROBE, 99)).toBe(false);
    expect(isValidEffectPeriod(EFFECT_TYPE.STROBE, 100)).toBe(true);
    expect(isValidEffectPeriod(EFFECT_TYPE.HEARTBEAT, 499)).toBe(false);
    expect(isValidEffectPeriod(EFFECT_TYPE.HEARTBEAT, 500)).toBe(true);
    expect(isValidEffectPeriod(EFFECT_TYPE.HEARTBEAT, 1500)).toBe(true);
    expect(isValidEffectPeriod(EFFECT_TYPE.HEARTBEAT, 1501)).toBe(false);
    expect(isValidEffectPeriod(EFFECT_TYPE.FLICKER, 333)).toBe(false);
    expect(isValidEffectPeriod(EFFECT_TYPE.FLICKER, 334)).toBe(true);
    expect(isValidEffectPeriod(EFFECT_TYPE.STATIC, 1000)).toBe(false);
    expect(isValidEffectPeriod(EFFECT_TYPE.HEARTBEAT, 0)).toBe(true);
  });

  it("normalizeLayer 清掉与类型无关的残留值", () => {
    expect(normalizeLayer(breathing({ periodMs: 200 })).periodMs).toBe(0);
    expect(normalizeLayer(breathing({ periodMs: 800 })).periodMs).toBe(800);
    expect(normalizeLayer(breathing({ type: EFFECT_TYPE.STATIC, periodMs: 2000 }))).toEqual({
      type: EFFECT_TYPE.STATIC, hue: 1200, sat: 200, periodMs: 0, p5: 0, flags: 0, level: 70,
    });
    expect(normalizeLayer(breathing({ type: EFFECT_TYPE.OFF }))).toEqual({
      type: EFFECT_TYPE.OFF, hue: 0, sat: 0, periodMs: 0, p5: 0, flags: 0, level: 70,
    });
    expect(normalizeLayer(breathing({ type: NO_EFFECT, level: 70 }))).toEqual({
      type: NO_EFFECT, hue: 0, sat: 0, periodMs: 0, p5: 0, flags: 0, level: 0,
    });
  });

  it("叠加层空层保存后读回 0xFF 且其余全 0", async () => {
    const session = await connectDesk();
    await session.scenePart(0, 0, 0, { stepCount: 1, loop: LOOP.ALL, on: true });

    const empty = switchEffectType(breathing(), NO_EFFECT, true);
    const step: SceneStep = {
      sceneId: 0, stripId: 0, partId: 0, stepIndex: 0,
      durationMs: 1500,
      layer0: createStaticLayer(500, 255, 100),
      layer1: empty,
    };
    const write = await session.sceneStep(0, 0, 0, 0, step);
    expect(write.kind).toBe("ok");

    const read = await readStep(session, 0);
    expect(read.layer1).toEqual({
      type: NO_EFFECT, hue: 0, sat: 0, periodMs: 0, p5: 0, flags: 0, level: 0,
    });
  });

  it("先选呼吸保存、再选空层保存：两次都成功且读回空层", async () => {
    const session = await connectDesk();
    await session.scenePart(0, 0, 0, { stepCount: 1, loop: LOOP.ALL, on: true });
    const base = createStaticLayer(500, 255, 100);

    const real = switchEffectType(
      { type: NO_EFFECT, hue: 0, sat: 0, periodMs: 0, p5: 0, flags: 0, level: 0 },
      EFFECT_TYPE.BREATHING,
      true,
    );
    const saveReal = await session.sceneStep(0, 0, 0, 0, {
      sceneId: 0, stripId: 0, partId: 0, stepIndex: 0, durationMs: 1000,
      layer0: base, layer1: real,
    });
    expect(saveReal.kind).toBe("ok");
    const afterReal = await readStep(session, 0);
    expect(afterReal.layer1.type).toBe(EFFECT_TYPE.BREATHING);
    expect(afterReal.layer1.level).toBe(50);

    const cleared = switchEffectType(real, NO_EFFECT, true);
    const saveEmpty = await session.sceneStep(0, 0, 0, 0, {
      sceneId: 0, stripId: 0, partId: 0, stepIndex: 0, durationMs: 1000,
      layer0: base, layer1: cleared,
    });
    expect(saveEmpty.kind).toBe("ok");
    const afterEmpty = await readStep(session, 0);
    expect(afterEmpty.layer1).toEqual({
      type: NO_EFFECT, hue: 0, sat: 0, periodMs: 0, p5: 0, flags: 0, level: 0,
    });
  });

  it("保存前归一化：呼吸→静态周期读回 0；呼吸→熄灭参数全 0", async () => {
    const session = await connectDesk();
    await session.scenePart(0, 0, 0, { stepCount: 2, loop: LOOP.ALL, on: true });
    const base = createStaticLayer(500, 255, 100);

    const staticLayer = switchEffectType(breathing(), EFFECT_TYPE.STATIC, false);
    const saveStatic = await session.sceneStep(0, 0, 0, 0, {
      sceneId: 0, stripId: 0, partId: 0, stepIndex: 0, durationMs: 1000,
      layer0: staticLayer, layer1: base,
    });
    expect(saveStatic.kind).toBe("ok");
    const readStatic = await readStep(session, 0);
    expect(readStatic.layer0.type).toBe(EFFECT_TYPE.STATIC);
    expect(readStatic.layer0.hue).toBe(1200);
    expect(readStatic.layer0.sat).toBe(200);
    expect(readStatic.layer0.periodMs).toBe(0);

    const off = switchEffectType(breathing(), EFFECT_TYPE.OFF, false);
    const saveOff = await session.sceneStep(0, 0, 0, 1, {
      sceneId: 0, stripId: 0, partId: 0, stepIndex: 1, durationMs: 1000,
      layer0: off, layer1: base,
    });
    expect(saveOff.kind).toBe("ok");
    const readOff = await readStep(session, 1);
    expect(readOff.layer0).toEqual({
      type: EFFECT_TYPE.OFF, hue: 0, sat: 0, periodMs: 0, p5: 0, flags: 0, level: 70,
    });
  });

  it("类型标签按 value 查找，空层显示「空层」", () => {
    expect(effectLabel(EFFECT_TYPE.HEARTBEAT)).toBe("心跳");
    expect(effectLabel(NO_EFFECT)).toBe("空层");
    expect(effectLabel(0x42)).toContain("未知");
  });
});
describe("场景名字节上限（#29）", () => {
  const CJK8 = "一二三四五六七八"; // 24 字节
  const CJK9 = "一二三四五六七八九"; // 27 字节

  /** 记录帧并转发给真实 MockTransport。 */
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

  const sceneNameFrames = (frames: Uint8Array[]): Uint8Array[] =>
    frames.filter((f) => {
      const d = decodeFrame(f);
      return d.ok && d.command === CMD.SCENE_NAME;
    });

  it("8 个中文（24 字节）保存成功，QueryScene 读回一致", async () => {
    const rec = recordingTransport();
    const session = new ControlSession({ transport: rec.transport, storage: createMemoryStorage() });
    const desk = MOCK_DEVICES[0];
    await session.connect(desk.deviceId, desk.broadcastName);

    const r = await session.sceneName(0, CJK8);
    expect(r.kind, `24 字节场景名应可保存，实际 ${JSON.stringify(r)}`).toBe("ok");

    const read = await session.queryScene(0);
    expect(read.kind).toBe("ok");
    if (read.kind !== "ok") return;
    expect(read.scene.name, "读回场景名应与保存一致").toBe(CJK8);
  });

  it("9 个中文（27 字节）sceneName 编码器抛 RangeError，message 含 27/24 透传", async () => {
    const rec = recordingTransport();
    const session = new ControlSession({ transport: rec.transport, storage: createMemoryStorage() });
    const desk = MOCK_DEVICES[0];
    await session.connect(desk.deviceId, desk.broadcastName);
    rec.frames.length = 0;

    // 直接调 session.sceneName：编码器 RangeError 被 enqueue 捕获为 error 结果，
    // message 必须透传（不再显示「保存失败：error」）。
    const r = await session.sceneName(0, CJK9);
    expect(r.kind, "27 字节场景名应被编码器拒绝").toBe("error");
    if (r.kind !== "error") return;
    expect(r.message, "error message 应透传具体字节数").toContain("27");
    expect(r.message, "error message 应含上限 24").toContain("24");
    expect(r.message, "不得是笼统的 error 字样").not.toBe("error");
    // 超限未发送 SceneName 命令。
    expect(sceneNameFrames(rec.frames).length, "超限不得发送 SceneName").toBe(0);
  });

  it("超限走页面 onSaveSceneName：validateNameBytes 先拦，提示具体字节数，不发命令", () => {
    const check = validateNameBytes(CJK9);
    expect(check.ok).toBe(false);
    expect(check.bytes).toBe(27);
    expect(check.message).toContain("27");
    expect(check.message).toContain("24");
  });
});

describe("场景选择与激活（#30）", () => {
  it("场景 2 保存名字/步骤后 QueryScene(2) 读回一致，场景 1 不受影响", async () => {
    const transport = new MockTransport({ scenario: "normal" });
    const session = new ControlSession({ transport, storage: createMemoryStorage() });
    const desk = MOCK_DEVICES[0];
    await session.connect(desk.deviceId, desk.broadcastName);
    await new Promise((r) => setTimeout(r, 50));

    // 场景 2（id=1）设部位头 + 两步
    const head = await session.scenePart(1, 0, 0, { stepCount: 2, loop: LOOP.ALL, on: true });
    expect(head.kind, "场景 2 ScenePart 应成功").toBe("ok");
    const stepA: SceneStep = {
      sceneId: 1, stripId: 0, partId: 0, stepIndex: 0,
      durationMs: 3000,
      layer0: createStaticLayer(1000, 255, 80),
      layer1: { type: NO_EFFECT, hue: 0, sat: 0, periodMs: 0, p5: 0, flags: 0, level: 0 },
    };
    const stepB: SceneStep = { ...stepA, stepIndex: 1, durationMs: 1000 };
    expect((await session.sceneStep(1, 0, 0, 0, stepA)).kind).toBe("ok");
    expect((await session.sceneStep(1, 0, 0, 1, stepB)).kind).toBe("ok");
    expect((await session.sceneName(1, "场景二")).kind).toBe("ok");

    // 场景 2 读回一致
    const read2 = await session.queryScene(1);
    expect(read2.kind, "场景 2 查询应成功").toBe("ok");
    if (read2.kind === "ok") {
      expect(read2.scene.name, "场景 2 名字读回一致").toBe("场景二");
      const steps = read2.scene.steps.filter((s) => s.stripId === 0 && s.partId === 0);
      expect(steps.map((s) => s.stepIndex), "场景 2 步骤索引 [0,1]").toEqual([0, 1]);
      expect(steps.map((s) => s.durationMs), "场景 2 时长 [3000,1000]").toEqual([3000, 1000]);
    }

    // 场景 1（id=0）不受影响：名字仍为空（Mock 初始场景名）
    const read1 = await session.queryScene(0);
    expect(read1.kind).toBe("ok");
    if (read1.kind === "ok") {
      expect(read1.scene.name, "场景 1 名字未被场景 2 的保存污染").not.toBe("场景二");
      const steps1 = read1.scene.steps.filter((s) => s.stripId === 0 && s.partId === 0);
      expect(steps1.length, "场景 1 没有场景 2 的步骤").toBe(0);
    }
  });

  it("激活场景 2 后 State.activeScene=2（1 基显示），再激活场景 1 读回 0", async () => {
    const transport = new MockTransport({ scenario: "normal" });
    const session = new ControlSession({ transport, storage: createMemoryStorage() });
    const desk = MOCK_DEVICES[0];
    await session.connect(desk.deviceId, desk.broadcastName);
    await new Promise((r) => setTimeout(r, 50));

    const r = await session.activateScene(1);
    expect(r.kind).toBe("ok");
    expect(session.deviceState?.activeScene, "激活场景 2 后 State.activeScene=1（0 基）").toBe(1);

    const back = await session.activateScene(0);
    expect(back.kind).toBe("ok");
    expect(session.deviceState?.activeScene, "切回场景 1 读回 0").toBe(0);
  });

  it("maxScenes 来自注入的 deviceInfo（=2）：场景 3 被拦截且不发帧，能力内仍可激活", async () => {
    // ScriptedTransport + 注入 DeviceInfoReport.maxScenes=2 的设备：
    // 能力来自读回，不是协议常量（同 led-count 的注入模式）。
    const state = idleState();
    const base = makeRebuildResponder(() => undefined);
    const transport = new ScriptedTransport(state, (request, emit) => {
      if (request.command === CMD.ACTIVATE_SCENE) {
        const sceneId = request.payload[0];
        if (sceneId < 2) state.activeScene = sceneId as 0 | 1 | 2;
        emit(ackFrame(request, sceneId < 2 ? 0 : 1));
        return;
      }
      if (request.command === CMD.QUERY_DEVICE_INFO) {
        emit(ackFrame(request));
        const payload = new Uint8Array(15);
        payload[8] = 100; // maxLeds
        payload[9] = 8;   // maxStrips
        payload[10] = 8;  // maxParts
        payload[11] = 8;  // maxPartSegs
        payload[12] = 8;  // maxSteps
        payload[13] = 2;  // maxScenes = 2
        emit(encodeFrame(DEVICE_CMD.DEVICE_INFO_REPORT, request.seq, payload));
        return;
      }
      base(request, emit);
    });
    const session = new ControlSession({ transport, storage: createMemoryStorage() });
    await session.connect("scripted");
    await session.queryDeviceInfo(); // 排在重建之后，返回即重建完成

    expect(session.deviceInfo?.maxScenes, "上限应来自注入的 DeviceInfoReport").toBe(2);

    const bad = await session.activateScene(2);
    expect(bad.kind, "maxScenes=2 时场景 3（id=2）应被拦截").toBe("error");
    if (bad.kind === "error") {
      expect(bad.message, "拦截原因含 0..1").toContain("0..1");
    }
    const actuateFrames = transport.sent.filter((r) => r.command === CMD.ACTIVATE_SCENE);
    expect(actuateFrames.length, "越界不得发帧").toBe(0);

    // 能力内仍可用：场景 2（id=1）激活成功且 State 读回
    const ok = await session.activateScene(1);
    expect(ok.kind, "能力内场景 2 应可激活").toBe("ok");
    expect(session.deviceState?.activeScene, "激活场景 2 后读回 1").toBe(1);
  });
});
