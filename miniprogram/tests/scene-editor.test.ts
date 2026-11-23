/** 场景编辑器（时间轴）测试：步骤往返 + 两层灯效 + 循环模式。 */

import { describe, it, expect } from "vitest";
import { MockTransport } from "../utils/ble/mock-transport";
import { ControlSession } from "../utils/session/session";
import { createMemoryStorage } from "./helpers/storage";
import { MOCK_DEVICES } from "../utils/mock/mock-devices";
import { LOOP, EFFECT_TYPE } from "../utils/protocol/constants";
import { validateDuration, validateLoop, createEmptyStep, createStaticLayer, isLayerEmpty } from "../utils/scene-editor";
import type { SceneStep } from "../utils/protocol/types";

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