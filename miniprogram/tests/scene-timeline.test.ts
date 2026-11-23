/** 时间轴写计划（#22）：加/删步重写 0..N−1、循环不动步骤、失败后重读。 */

import { describe, it, expect } from "vitest";
import { MockTransport } from "../utils/ble/mock-transport";
import { ControlSession } from "../utils/session/session";
import { createMemoryStorage } from "./helpers/storage";
import { MOCK_DEVICES } from "../utils/mock/mock-devices";
import { LOOP, NO_EFFECT, MAX_STEPS } from "../utils/protocol/constants";
import type { EffectLayer, SceneStep } from "../utils/protocol/types";
import {
  planAddStep, planDeleteLastStep, planLoopChange,
  createStaticLayer, formatDuration,
} from "../utils/scene-editor";
import { runTimelineWrite } from "../utils/scene-writer";
import type { SceneTimelinePort } from "../utils/scene-writer";

const EMPTY_LAYER: EffectLayer = {
  type: NO_EFFECT, hue: 0, sat: 0, periodMs: 0, p5: 0, flags: 0, level: 0,
};

function step(index: number, durationMs: number, hue = 0, level = 100): SceneStep {
  return {
    sceneId: 0,
    stripId: 0,
    partId: 0,
    stepIndex: index,
    durationMs,
    layer0: createStaticLayer(hue, 255, level),
    layer1: { ...EMPTY_LAYER },
  };
}

async function connectSession(): Promise<ControlSession> {
  const transport = new MockTransport({ scenario: "normal" });
  const session = new ControlSession({ transport, storage: createMemoryStorage() });
  const desk = MOCK_DEVICES[0];
  await session.connect(desk.deviceId, desk.broadcastName);
  return session;
}

async function readSteps(session: ControlSession): Promise<SceneStep[]> {
  const result = await session.queryScene(0);
  expect(result.kind, "QueryScene 应该成功").toBe("ok");
  if (result.kind !== "ok") throw new Error("QueryScene 失败");
  return result.scene.steps
    .filter((s) => s.stripId === 0 && s.partId === 0)
    .sort((a, b) => a.stepIndex - b.stepIndex);
}

async function readLoop(session: ControlSession): Promise<number | undefined> {
  const result = await session.queryScene(0);
  if (result.kind !== "ok") throw new Error("QueryScene 失败");
  return result.scene.parts.find((p) => p.stripId === 0 && p.partId === 0)?.loop;
}

describe("时间轴写计划", () => {
  it("加步计划保留已有步骤的时长与两层灯效", () => {
    const first = step(0, 3000, 120, 80);
    const plan = planAddStep([first], step(0, 1000));

    expect(plan.kind).toBe("steps");
    expect(plan.stepCount).toBe(2);
    expect(plan.steps.map((s) => s.stepIndex)).toEqual([0, 1]);
    expect(plan.steps[0].durationMs, `第 1 步时长应保持 3000，实际 ${plan.steps[0].durationMs}`).toBe(3000);
    expect(plan.steps[0].layer0, "第 1 步底层应原样保留").toEqual(first.layer0);
    expect(plan.steps[0].layer1, "第 1 步叠加层应原样保留").toEqual(first.layer1);
    expect(plan.steps[1].durationMs).toBe(1000);
    expect(plan.steps[1].stepIndex).toBe(1);
  });

  it("删末步计划保留剩余步骤内容", () => {
    const first = step(0, 3000, 120, 80);
    const second = step(1, 1000, 240, 60);
    const plan = planDeleteLastStep([first, second]);

    expect(plan.stepCount).toBe(1);
    expect(plan.steps).toHaveLength(1);
    expect(plan.steps[0]).toEqual(first);
  });

  it("循环切换计划只改 loop，不产生步骤重写", () => {
    const plan = planLoopChange([step(0, 3000, 120, 80)], LOOP.LAST);

    expect(plan.kind).toBe("loop");
    expect(plan.stepCount).toBe(1);
    expect(plan.loop).toBe(LOOP.LAST);
    expect("steps" in plan, "循环计划不应携带步骤列表").toBe(false);
  });

  it("步数上限、空时间轴与非法循环明确报错", () => {
    const full = Array.from({ length: MAX_STEPS }, (_, i) => step(i, 1000));
    expect(() => planAddStep(full, step(MAX_STEPS, 1000))).toThrow(/上限/);
    expect(() => planDeleteLastStep([])).toThrow(/没有可删除/);
    expect(() => planLoopChange([], 9)).toThrow(/超出/);
  });
});

describe("时间轴写计划往返（MockTransport + ControlSession）", () => {
  it("加第 2 步读回 [3000,1000]，第 1 步灯效不变；删末步读回 [3000]；切循环步骤不变", async () => {
    const session = await connectSession();

    const first = await runTimelineWrite(session, 0, 0, 0, {
      kind: "add",
      newStep: step(0, 3000, 120, 80),
    });
    expect(first.ok, `第 1 步写入应成功，实际「${first.message}」`).toBe(true);
    expect(first.steps.map((s) => s.durationMs)).toEqual([3000]);

    const second = await runTimelineWrite(session, 0, 0, 0, {
      kind: "add",
      newStep: step(0, 1000),
    });
    expect(second.ok, `加第 2 步应成功，实际「${second.message}」`).toBe(true);

    const afterAdd = await readSteps(session);
    expect(
      afterAdd.map((s) => s.durationMs),
      `两步时长期望 [3000,1000]，实际 [${afterAdd.map((s) => s.durationMs).join(", ")}]`,
    ).toEqual([3000, 1000]);
    expect(afterAdd[0].layer0.hue, `第 1 步 hue 期望 120，实际 ${afterAdd[0].layer0.hue}`).toBe(120);
    expect(afterAdd[0].layer0.level, `第 1 步亮度期望 80，实际 ${afterAdd[0].layer0.level}`).toBe(80);
    expect(afterAdd[0].layer1.type, "第 1 步叠加层应保持空层").toBe(NO_EFFECT);
    expect(afterAdd[1].layer0.hue, "新步应使用默认灯效 hue=0").toBe(0);
    expect(afterAdd[1].layer0.level, "新步应使用默认亮度 100").toBe(100);

    const loopChange = await runTimelineWrite(session, 0, 0, 0, { kind: "loop", loop: LOOP.LAST });
    expect(loopChange.ok, `切换循环应成功，实际「${loopChange.message}」`).toBe(true);
    expect(await readLoop(session), "循环模式读回应为末步循环").toBe(LOOP.LAST);
    const afterLoop = await readSteps(session);
    expect(
      afterLoop.map((s) => [s.durationMs, s.layer0.hue, s.layer0.level]),
      "切换循环不应改变任何步骤",
    ).toEqual(afterAdd.map((s) => [s.durationMs, s.layer0.hue, s.layer0.level]));

    const deleted = await runTimelineWrite(session, 0, 0, 0, { kind: "deleteLast" });
    expect(deleted.ok, `删除末步应成功，实际「${deleted.message}」`).toBe(true);
    const afterDelete = await readSteps(session);
    expect(
      afterDelete.map((s) => s.durationMs),
      `删除后时长期望 [3000]，实际 [${afterDelete.map((s) => s.durationMs).join(", ")}]`,
    ).toEqual([3000]);
    expect(afterDelete[0].layer0.hue).toBe(120);
    expect(afterDelete[0].layer0.level).toBe(80);
    expect(await readLoop(session), "删除末步不应重置循环模式").toBe(LOOP.LAST);
  });

  it("第 2 步写入失败：停止后续写入，重读设备并给出失败原因", async () => {
    const session = await connectSession();
    await runTimelineWrite(session, 0, 0, 0, { kind: "add", newStep: step(0, 3000, 120, 80) });
    await runTimelineWrite(session, 0, 0, 0, { kind: "add", newStep: step(1, 1000) });

    let writes = 0;
    const failing: SceneTimelinePort = {
      scenePart: (...args) => session.scenePart(...args),
      sceneStep: (...args) => {
        writes += 1;
        if (args[3] === 1) {
          return Promise.resolve({
            kind: "ack-error" as const,
            ack: { seq: 0, command: 0x26, resultCode: 1, ok: false },
          });
        }
        return session.sceneStep(...args);
      },
      queryScene: (sceneId) => session.queryScene(sceneId),
    };

    const outcome = await runTimelineWrite(failing, 0, 0, 0, {
      kind: "add",
      newStep: step(2, 1000),
    });

    expect(outcome.ok, "写入失败不能返回成功").toBe(false);
    expect(outcome.failedStepIndex, "失败步骤应为第 2 步（索引 1）").toBe(1);
    expect(outcome.reRead, "失败后必须从设备重读").toBe(true);
    expect(outcome.message, `提示应指名失败步骤，实际「${outcome.message}」`).toContain("写入步骤 2 失败");
    expect(outcome.message, `提示应带结果码原因，实际「${outcome.message}」`).toContain("参数无效");
    expect(outcome.message, `提示应说明已重读，实际「${outcome.message}」`).toContain("已从设备重读");
    expect(writes, "第 2 步失败后不能再写第 3 步").toBe(2);

    const deviceSteps = await readSteps(session);
    expect(
      deviceSteps.map((s) => s.durationMs),
      `设备读回时长期望 [3000,0,0]，实际 [${deviceSteps.map((s) => s.durationMs).join(", ")}]`,
    ).toEqual([3000, 0, 0]);
    expect(deviceSteps[0].layer0.hue, "第 1 步灯效应保持").toBe(120);
    expect(
      outcome.steps.map((s) => s.durationMs),
      "页面拿到的步骤应与设备读回一致",
    ).toEqual(deviceSteps.map((s) => s.durationMs));
    expect(
      outcome.steps.map((s) => formatDuration(s.durationMs)),
      "0ms 步骤必须照常显示（可据此修正）",
    ).toEqual(["3.0s", "0ms", "0ms"]);
  });

  it("达到 MAX_STEPS 时提示上限，不发送任何写命令", async () => {
    const full = Array.from({ length: MAX_STEPS }, (_, i) => step(i, 1000));
    let partCalls = 0;
    let stepCalls = 0;
    const port: SceneTimelinePort = {
      scenePart: async () => { partCalls += 1; return { kind: "ok" }; },
      sceneStep: async () => { stepCalls += 1; return { kind: "ok" }; },
      queryScene: async () => ({
        kind: "ok",
        scene: {
          sceneId: 0,
          name: "满步场景",
          parts: [{
            sceneId: 0, stripId: 0, partId: 0,
            stepCount: MAX_STEPS, loop: LOOP.ALL, on: true,
          }],
          steps: full,
        },
      }),
    };

    const outcome = await runTimelineWrite(port, 0, 0, 0, {
      kind: "add",
      newStep: step(MAX_STEPS, 1000),
    });

    expect(outcome.ok).toBe(false);
    expect(outcome.message, `提示应包含上限 ${MAX_STEPS}，实际「${outcome.message}」`).toContain(`上限 ${MAX_STEPS}`);
    expect(partCalls, "达到上限时不能改 step_count").toBe(0);
    expect(stepCalls, "达到上限时不能写步骤").toBe(0);
  });

  it("开始前读回失败：中止操作并说明原因", async () => {
    let writes = 0;
    const port: SceneTimelinePort = {
      scenePart: async () => { writes += 1; return { kind: "ok" }; },
      sceneStep: async () => { writes += 1; return { kind: "ok" }; },
      queryScene: async () => ({ kind: "error", message: "报告超时" }),
    };

    const outcome = await runTimelineWrite(port, 0, 0, 0, { kind: "deleteLast" });

    expect(outcome.ok).toBe(false);
    expect(outcome.message, `提示应说明读回失败，实际「${outcome.message}」`).toContain("读取场景失败");
    expect(outcome.message).toContain("操作已取消");
    expect(writes, "读回失败时不能继续发送写命令").toBe(0);
  });
});
