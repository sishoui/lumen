/**
 * 时间轴（Timeline）领域工具。
 * 供场景编辑器、测试共同使用，避免业务逻辑散落页面。
 */

import type { EffectLayer, SceneStep, SceneStepReport, SceneReport, ScenePartReport } from "../protocol/types";
import { EMPTY_LAYER } from "./protocol/commands";
import {
  EFFECT_TYPE, NO_EFFECT, LAYER_LEVEL_MAX,
  STEP_MIN_MS, STEP_MAX_MS, MAX_STEPS, MAX_SCENES,
  LOOP, LOOP_MAX,
} from "./protocol/constants";

/** 灯效类型中文名。 */
export const EFFECT_NAMES: Record<number, string> = {
  [EFFECT_TYPE.STATIC]: "静态",
  [EFFECT_TYPE.BREATHING]: "呼吸",
  [EFFECT_TYPE.RAINBOW]: "彩虹",
  [EFFECT_TYPE.COMET]: "流光",
  [EFFECT_TYPE.STROBE]: "爆闪",
  [EFFECT_TYPE.HEARTBEAT]: "心跳",
  [EFFECT_TYPE.OFF]: "熄灭",
  [EFFECT_TYPE.FLICKER]: "随机",
  [NO_EFFECT]: "空",
};

/** 循环模式中文名。 */
export const LOOP_NAMES: Record<number, string> = {
  [LOOP.NONE]: "不循环",
  [LOOP.ALL]: "全部循环",
  [LOOP.LAST]: "末步循环",
};

/** 相位模式中文名。 */
export const PHASE_NAMES: Record<number, string> = {
  0: "连续",
  1: "各自起点",
};

/**
 * 创建一个空步骤。
 */
export function createEmptyStep(
  sceneId: number, stripId: number, partId: number, stepIndex: number,
): SceneStep {
  return {
    sceneId, stripId, partId, stepIndex,
    durationMs: 1000,
    layer0: EMPTY_LAYER,
    layer1: EMPTY_LAYER,
  };
}

/**
 * 创建一个静态灯效层。
 */
export function createStaticLayer(hue: number, sat: number, level: number = LAYER_LEVEL_MAX): EffectLayer {
  return {
    type: EFFECT_TYPE.STATIC,
    hue,
    sat,
    periodMs: 0,
    p5: 0,
    flags: 0,
    level,
  };
}

/**
 * 判断层是否为空。
 */
export function isLayerEmpty(layer: EffectLayer): boolean {
  return layer.type === NO_EFFECT;
}

/**
 * 格式化步骤时长。
 */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

/**
 * 格式化层的简要描述。
 */
export function formatLayer(layer: EffectLayer): string {
  if (isLayerEmpty(layer)) return "空";
  const name = EFFECT_NAMES[layer.type] ?? `未知(${layer.type})`;
  if (layer.type === EFFECT_TYPE.STATIC || layer.type === EFFECT_TYPE.OFF) {
    return `${name} 亮度${layer.level}%`;
  }
  const period = layer.periodMs > 0 ? ` ${formatDuration(layer.periodMs)}` : "";
  return `${name}${period} 亮度${layer.level}%`;
}

/**
 * 校验步骤时长。
 */
export function validateDuration(ms: number): string | null {
  if (!Number.isInteger(ms)) return `时长必须是整数`;
  if (ms < STEP_MIN_MS) return `时长 ${ms}ms < 下限 ${STEP_MIN_MS}ms`;
  if (ms > STEP_MAX_MS) return `时长 ${ms}ms > 上限 ${STEP_MAX_MS}ms`;
  return null;
}

/**
 * 校验循环模式。
 */
export function validateLoop(loop: number): string | null {
  if (!Number.isInteger(loop) || loop < 0 || loop > LOOP_MAX) {
    return `循环模式 ${loop} 超出 0..${LOOP_MAX}`;
  }
  return null;
}

/**
 * 从场景读回中取某部位的时间轴步骤。
 */
export function getStepsForPart(
  scene: SceneReport | null,
  stripId: number,
  partId: number,
): SceneStepReport[] {
  if (!scene) return [];
  return scene.steps.filter(
    (s) => s.stripId === stripId && s.partId === partId,
  ).sort((a, b) => a.stepIndex - b.stepIndex);
}

/**
 * 从场景读回中取某部位的 ScenePartReport 头。
 */
export function getPartHead(
  scene: SceneReport | null,
  stripId: number,
  partId: number,
): ScenePartReport | null {
  if (!scene) return null;
  return (
    scene.parts.find(
      (p) => p.stripId === stripId && p.partId === partId,
    ) ?? null
  );
}

/**
 * 场景读回中某部位的最大步数。
 */
export function maxStepCount(scene: SceneReport | null): number {
  if (!scene) return 0;
  let max = 0;
  for (const p of scene.parts) {
    if (p.stepCount > max) max = p.stepCount;
  }
  return max;
}

/**
 * 校验场景 ID。
 */
export function validateSceneId(sceneId: number): string | null {
  if (!Number.isInteger(sceneId) || sceneId < 0 || sceneId >= MAX_SCENES) {
    return `场景 ID ${sceneId} 超出 0..${MAX_SCENES - 1}`;
  }
  return null;
}

/**
 * 校验步数。
 */
export function validateStepCount(count: number): string | null {
  if (!Number.isInteger(count) || count < 0 || count > MAX_STEPS) {
    return `步数 ${count} 超出 0..${MAX_STEPS}`;
  }
  return null;
}

/**
 * 计算时间轴总时长（某部位）。
 */
export function totalDuration(steps: SceneStepReport[]): number {
  return steps.reduce((sum, s) => sum + s.durationMs, 0);
}