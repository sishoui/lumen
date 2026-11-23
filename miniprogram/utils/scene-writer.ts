/**
 * 时间轴写计划执行器：加/删步先改 ScenePart 的 step_count，再按计划把
 * 0..N−1 步全部写回。
 *
 * 固件语义（docs/protocol.md §7.4）：step_count 一旦变化就清空该部位全部
 * 步骤，只补写新增/剩余步骤会让旧步骤归零。计划源因此总是设备刚读回的
 * 时间轴；任何一步失败都停止后续写入，并重新 QueryScene 取回真实状态。
 */

import type { EditResult, SceneResult } from "./session/session";
import type { SceneReport, SceneStep } from "./protocol/types";
import {
  getPartHead, getStepsForPart,
  planAddStep, planDeleteLastStep, planLoopChange, validateLoop,
} from "./scene-editor";
import type { TimelinePlan } from "./scene-editor";
import { LOOP, MAX_STEPS, resultName } from "./protocol/constants";

/** 执行写计划所需的最小会话接口；ControlSession 结构上直接满足。 */
export interface SceneTimelinePort {
  scenePart(
    sceneId: number, stripId: number, partId: number,
    head: { stepCount: number; loop: number; on: boolean },
  ): Promise<EditResult>;
  sceneStep(
    sceneId: number, stripId: number, partId: number,
    stepIndex: number, step: SceneStep,
  ): Promise<EditResult>;
  queryScene(sceneId: number): Promise<SceneResult>;
}

export type TimelineOperation =
  | { kind: "add"; newStep: SceneStep }
  | { kind: "deleteLast" }
  | { kind: "loop"; loop: number };

export interface TimelineWriteOutcome {
  ok: boolean;
  /** 给页面直接显示的结果说明，含失败原因与是否已重读。 */
  message: string;
  /** 写入后（或失败后重读）的场景；读回失败时为 null。 */
  scene: SceneReport | null;
  /** 该部位的最新步骤（读回失败时退回计划/开始时的步骤）。 */
  steps: SceneStep[];
  failedStepIndex: number | null;
  /** 是否在失败后成功从设备重读了当前状态。 */
  reRead: boolean;
}

/** 设备/编码失败 → 用户能判断「改参数还是重试」的文案。 */
export function editFailureText(result: EditResult): string {
  if (result.kind === "ack-error") {
    return `结果码 ${result.ack.resultCode}（${resultName(result.ack.resultCode)}）`;
  }
  if (result.kind === "error") return result.message;
  if (result.kind === "storage") return `本地存储失败：${result.message}`;
  if (result.kind === "stale") return "连接已切换，请重试";
  return "未知原因";
}

function sceneFailureText(result: SceneResult): string {
  return result.kind === "error" ? result.message : "连接已切换，请重试";
}

/**
 * 执行一次时间轴写计划。返回的 steps 是该部位的最新值，页面据此刷新列表
 * 与编辑区。步数上限与空时间轴在这里拦截，页面只负责显示 message。
 */
export async function runTimelineWrite(
  port: SceneTimelinePort,
  sceneId: number,
  stripId: number,
  partId: number,
  op: TimelineOperation,
): Promise<TimelineWriteOutcome> {
  const read = await port.queryScene(sceneId);
  if (read.kind !== "ok") {
    return {
      ok: false,
      message: `读取场景失败：${sceneFailureText(read)}；操作已取消`,
      scene: null,
      steps: [],
      failedStepIndex: null,
      reRead: false,
    };
  }

  const scene = read.scene;
  const head = getPartHead(scene, stripId, partId);
  const loop = head?.loop ?? LOOP.ALL;
  const on = head?.on ?? true;
  const currentSteps = getStepsForPart(scene, stripId, partId);

  let plan: TimelinePlan;
  let successMessage: string;
  switch (op.kind) {
    case "add":
      if (currentSteps.length >= MAX_STEPS) {
        return {
          ok: false,
          message: `步数已达上限 ${MAX_STEPS}，未添加步骤`,
          scene,
          steps: currentSteps,
          failedStepIndex: null,
          reRead: false,
        };
      }
      plan = planAddStep(currentSteps, op.newStep);
      successMessage = `已添加步骤 ${plan.stepCount}`;
      break;
    case "deleteLast":
      if (currentSteps.length === 0) {
        return {
          ok: false,
          message: "没有可删除的步骤",
          scene,
          steps: [],
          failedStepIndex: null,
          reRead: false,
        };
      }
      plan = planDeleteLastStep(currentSteps);
      successMessage = `已删除步骤 ${currentSteps.length}`;
      break;
    case "loop": {
      const err = validateLoop(op.loop);
      if (err) {
        return {
          ok: false,
          message: err,
          scene,
          steps: currentSteps,
          failedStepIndex: null,
          reRead: false,
        };
      }
      plan = planLoopChange(currentSteps, op.loop);
      successMessage = "循环模式已更新";
      break;
    }
  }

  const failWithReread = async (
    reason: string,
    failedStepIndex: number | null,
  ): Promise<TimelineWriteOutcome> => {
    const reread = await port.queryScene(sceneId);
    if (reread.kind === "ok") {
      return {
        ok: false,
        message: `${reason}；已从设备重读当前状态`,
        scene: reread.scene,
        steps: getStepsForPart(reread.scene, stripId, partId),
        failedStepIndex,
        reRead: true,
      };
    }
    return {
      ok: false,
      message: `${reason}；重新读取设备状态失败：${sceneFailureText(reread)}`,
      scene: null,
      steps: currentSteps,
      failedStepIndex,
      reRead: false,
    };
  };

  const nextLoop = plan.kind === "loop" ? plan.loop : loop;
  const partResult = await port.scenePart(sceneId, stripId, partId, {
    stepCount: plan.stepCount,
    loop: nextLoop,
    on,
  });
  if (partResult.kind !== "ok") {
    return failWithReread(`更新场景头失败：${editFailureText(partResult)}`, null);
  }

  if (plan.kind === "steps") {
    for (const step of plan.steps) {
      const result = await port.sceneStep(sceneId, stripId, partId, step.stepIndex, step);
      if (result.kind !== "ok") {
        return failWithReread(
          `写入步骤 ${step.stepIndex + 1} 失败：${editFailureText(result)}`,
          step.stepIndex,
        );
      }
    }
  }

  const after = await port.queryScene(sceneId);
  if (after.kind !== "ok") {
    return {
      ok: false,
      message: `${successMessage}，但读回失败：${sceneFailureText(after)}`,
      scene: null,
      steps: plan.kind === "steps" ? plan.steps : currentSteps,
      failedStepIndex: null,
      reRead: false,
    };
  }

  return {
    ok: true,
    message: successMessage,
    scene: after.scene,
    steps: getStepsForPart(after.scene, stripId, partId),
    failedStepIndex: null,
    reRead: true,
  };
}
