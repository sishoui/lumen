/**
 * 时间轴（Timeline）领域工具。
 * 供场景编辑器、测试共同使用，避免业务逻辑散落页面。
 */

import { isValidLayer } from "./protocol/layer-rules";

import type { EffectLayer, SceneStep, SceneStepReport, SceneReport, ScenePartReport } from "./protocol/types";
import { EMPTY_EFFECT } from "./protocol/types";
import { EMPTY_LAYER } from "./protocol/commands";
import { EFFECT_TYPE, NO_EFFECT, KNOWN_EFFECT_TYPES, LAYER_LEVEL_MAX, EFFECT_PERIOD_BOUNDS,
  STEP_MIN_MS, STEP_MAX_MS, MAX_STEPS, MAX_SCENES,
  LOOP, LOOP_MAX, isValidEffectPeriod, isKnownEffectType,
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
  [NO_EFFECT]: "空层",
};

/** picker 选项：value 是协议 type，label 只用于显示。 */
export interface LayerPickerOption {
  value: number;
  label: string;
}

/** 一层编辑器里哪些字段可见。 */
export interface LayerFieldVisibility {
  hue: boolean;
  sat: boolean;
  period: boolean;
  level: boolean;
}

/** 叠加层从空层切到真实效果时的默认亮度（0 会让叠加层看不见）。 */
export const OVERLAY_DEFAULT_LEVEL = 50;

const PERIOD_FIELD_TYPES = new Set<number>([
  EFFECT_TYPE.BREATHING,
  EFFECT_TYPE.RAINBOW,
  EFFECT_TYPE.COMET,
  EFFECT_TYPE.STROBE,
  EFFECT_TYPE.HEARTBEAT,
  EFFECT_TYPE.FLICKER,
]);

/** 类型对应的中文名；未知类型如实显示数值。 */
export function effectLabel(type: number): string {
  return EFFECT_NAMES[type] ?? `未知(${type})`;
}

/**
 * 某层的 picker 选项。底层必须非空，因此不含空层；叠加层可以清回空层。
 * 选项的 value 是协议 type，不是数组下标。
 */
export function layerPickerOptions(isOverlay: boolean): LayerPickerOption[] {
  const types = isOverlay ? [...KNOWN_EFFECT_TYPES, NO_EFFECT] : [...KNOWN_EFFECT_TYPES];
  return types.map((value) => ({ value, label: effectLabel(value) }));
}

/** picker 的 change 事件只做这一步：下标 → 协议 type。 */
export function pickerIndexToType(options: LayerPickerOption[], index: number): number {
  const option = options[index];
  if (!option) {
    throw new RangeError(`灯效选项索引 ${index} 越界（0..${options.length - 1}）`);
  }
  return option.value;
}

/** 把读回的协议 type 换算成 picker 需要的下标；未知类型回退到第一项。 */
export function pickerIndexForType(options: LayerPickerOption[], type: number): number {
  const index = options.findIndex((option) => option.value === type);
  return index >= 0 ? index : 0;
}

/** 字段可见性完全由协议类型决定，不看数组下标。 */
export function layerFieldVisibility(type: number): LayerFieldVisibility {
  if (type === NO_EFFECT || type === EFFECT_TYPE.OFF) {
    return { hue: false, sat: false, period: false, level: false };
  }
  return {
    hue: true,
    sat: true,
    period: PERIOD_FIELD_TYPES.has(type),
    level: true,
  };
}

/**
 * 按类型清掉不适用的参数，保证编码前不残留上一个类型的值。
 * 空层全 0（含 level）；熄灭除 level 外全 0；静态清 period/p5/flags；
 * 其它类型保留 hue/sat，周期不合法时置 0（0 = 设备默认）。
 */
export function normalizeLayer(layer: EffectLayer): EffectLayer {
  if (layer.type === NO_EFFECT) return { ...EMPTY_EFFECT };
  if (layer.type === EFFECT_TYPE.OFF) {
    return { type: EFFECT_TYPE.OFF, hue: 0, sat: 0, periodMs: 0, p5: 0, flags: 0, level: layer.level };
  }
  if (layer.type === EFFECT_TYPE.STATIC) {
    return {
      type: EFFECT_TYPE.STATIC,
      hue: layer.hue,
      sat: layer.sat,
      periodMs: 0,
      p5: 0,
      flags: 0,
      level: layer.level,
    };
  }
  return {
    type: layer.type,
    hue: layer.hue,
    sat: layer.sat,
    periodMs: isValidEffectPeriod(layer.type, layer.periodMs) ? layer.periodMs : 0,
    p5: layer.p5,
    flags: layer.flags,
    level: layer.level,
  };
}

/**
 * 切换灯效类型：保留 hue/sat，清掉新类型不适用的参数。
 * 从空层切到真实效果时补默认亮度：叠加层 50，底层 100。
 */
export function switchEffectType(previous: EffectLayer, nextType: number, isOverlay: boolean): EffectLayer {
  const wasEmpty = previous.type === NO_EFFECT;
  const level = wasEmpty
    ? (isOverlay ? OVERLAY_DEFAULT_LEVEL : LAYER_LEVEL_MAX)
    : previous.level;
  return normalizeLayer({
    type: nextType,
    hue: previous.hue,
    sat: previous.sat,
    periodMs: previous.periodMs,
    p5: 0,
    flags: 0,
    level,
  });
}

/** 一层发送前的字段级错误。 */
export interface LayerFieldError {
  /** 出错字段：type / hue / sat / period / p5 / flags / level。 */
  field: "type" | "hue" | "sat" | "period" | "p5" | "flags" | "level";
  /** 用户能直接看懂的说明，含实际值与允许区间。 */
  message: string;
}

/** 校验结果：无任何错误时 errors 为空数组。 */
export interface LayerValidation {
  ok: boolean;
  errors: LayerFieldError[];
  /** 第一条错误文案；无错误时为空串，页面可直接显示。 */
  firstError: string;
}

/**
 * 每个类型允许置位的 flags 位（其余位必须为 0），与固件 effects.c 逐条对齐。
 * 位含义：bit0 reverse / 双脉冲；bit1–2 波形；bit1 拖尾；bit2–3 头数量。
 */
const FLAGS_ALLOWED_MASK: Record<number, number> = {
  [EFFECT_TYPE.STATIC]: 0x00,
  [EFFECT_TYPE.BREATHING]: 0x07,
  [EFFECT_TYPE.RAINBOW]: 0x01,
  [EFFECT_TYPE.COMET]: 0x0f,
  [EFFECT_TYPE.STROBE]: 0x00,
  [EFFECT_TYPE.HEARTBEAT]: 0x01,
  [EFFECT_TYPE.OFF]: 0x00,
  [EFFECT_TYPE.FLICKER]: 0x00,
};

/** 各类型在 UI 里的中文名，用于错误文案。 */
const TYPE_LABEL: Record<number, string> = {
  [EFFECT_TYPE.STATIC]: "静态",
  [EFFECT_TYPE.BREATHING]: "呼吸",
  [EFFECT_TYPE.RAINBOW]: "彩虹",
  [EFFECT_TYPE.COMET]: "流光",
  [EFFECT_TYPE.STROBE]: "爆闪",
  [EFFECT_TYPE.HEARTBEAT]: "心跳",
  [EFFECT_TYPE.OFF]: "熄灭",
  [EFFECT_TYPE.FLICKER]: "随机闪烁",
};

/**
 * 校验一层能否发送（固件 lumen_segment_validate_shape 的前置镜像）。
 *
 * 与 layer-rules.ts 的区别：这里读的是内存里的 EffectLayer，错误定位到字段，
 * 文案给用户看；layer-rules 读 9 字节，只回布尔，给 Mock 设备用。两者规则同源。
 *
 * @param isOverlay layer1 允许空层；layer0 不允许。
 */
export function validateLayerForSend(layer: EffectLayer, options: { isOverlay: boolean }): LayerValidation {
  const errors: LayerFieldError[] = [];
  const add = (field: LayerFieldError["field"], message: string): void => {
    errors.push({ field, message });
  };
  const isOverlay = options.isOverlay;
  const type = layer.type;

  if (type === NO_EFFECT) {
    if (!isOverlay) {
      add("type", "底层不能是空层");
    } else {
      const dirty: string[] = [];
      if (layer.hue !== 0) dirty.push(`hue=${layer.hue}`);
      if (layer.sat !== 0) dirty.push(`sat=${layer.sat}`);
      if (layer.periodMs !== 0) dirty.push(`period=${layer.periodMs}ms`);
      if (layer.p5 !== 0) dirty.push(`p5=${layer.p5}`);
      if (layer.flags !== 0) dirty.push(`flags=0x${layer.flags.toString(16)}`);
      if (layer.level !== 0) dirty.push(`level=${layer.level}`);
      if (dirty.length > 0) {
        add("type", `空层的参数必须全为 0，当前 ${dirty.join("、")}`);
      }
    }
    return finish();
  }

  if (!isKnownEffectType(type)) {
    add("type", `未知灯效类型 0x${type.toString(16)}`);
    return finish();
  }

  if (!Number.isInteger(layer.level) || layer.level < 0 || layer.level > LAYER_LEVEL_MAX) {
    add("level", `亮度 ${layer.level} 超出 0..${LAYER_LEVEL_MAX}`);
  }
  if (!Number.isInteger(layer.hue) || layer.hue < 0 || layer.hue > 0xffff) {
    add("hue", `色相 ${layer.hue} 超出 0..65535`);
  }
  if (!Number.isInteger(layer.sat) || layer.sat < 0 || layer.sat > 0xff) {
    add("sat", `饱和度 ${layer.sat} 超出 0..255`);
  }

  if (type === EFFECT_TYPE.OFF) {
    const dirty: string[] = [];
    if (layer.hue !== 0) dirty.push(`hue=${layer.hue}`);
    if (layer.sat !== 0) dirty.push(`sat=${layer.sat}`);
    if (layer.periodMs !== 0) dirty.push(`period=${layer.periodMs}ms`);
    if (layer.p5 !== 0) dirty.push(`p5=${layer.p5}`);
    if (layer.flags !== 0) dirty.push(`flags=0x${layer.flags.toString(16)}`);
    if (dirty.length > 0) {
      add("type", `熄灭时除亮度外必须全为 0，当前 ${dirty.join("、")}`);
    }
    return finish();
  }

  const bounds = EFFECT_PERIOD_BOUNDS[type];
  const name = TYPE_LABEL[type] ?? `类型 0x${type.toString(16)}`;

  if (!Number.isInteger(layer.periodMs) || layer.periodMs < 0 || layer.periodMs > 0xffff) {
    add("period", `${name}周期 ${layer.periodMs}ms 超出 0..65535`);
  } else if (type === EFFECT_TYPE.STATIC) {
    if (layer.periodMs !== 0) add("period", "静态灯效没有周期，必须为 0");
  } else if (bounds && layer.periodMs !== 0) {
    if (layer.periodMs < bounds.min || layer.periodMs > bounds.max) {
      const range = bounds.max === 0xffff
        ? `${bounds.min}ms 以上`
        : `${bounds.min}–${bounds.max}ms`;
      add("period", `${name}周期 ${layer.periodMs}ms 超出 ${range}`);
    }
  }

  if (type === EFFECT_TYPE.STATIC) {
    if (layer.p5 !== 0) add("p5", "静态灯效没有 p5，必须为 0");
    if (layer.flags !== 0) add("flags", `静态灯效没有 flags，必须为 0（当前 0x${layer.flags.toString(16)}）`);
  } else {
    if (!Number.isInteger(layer.p5) || layer.p5 < 0 || layer.p5 > 0xff) {
      add("p5", `p5 ${layer.p5} 超出 0..255`);
    } else if (type === EFFECT_TYPE.BREATHING && layer.p5 > 100) {
      add("p5", `呼吸 p5 ${layer.p5} 超出 0..100`);
    }
    if (!Number.isInteger(layer.flags) || layer.flags < 0 || layer.flags > 0xff) {
      add("flags", `flags ${layer.flags} 超出 0..255`);
    } else {
      const allowed = FLAGS_ALLOWED_MASK[type] ?? 0;
      const reserved = layer.flags & ~allowed & 0xff;
      if (reserved !== 0) {
        add("flags", `${name} flags 0x${layer.flags.toString(16)} 含保留位 0x${reserved.toString(16)}`);
      }
    }
  }

  return finish();

  function finish(): LayerValidation {
    return {
      ok: errors.length === 0,
      errors,
      firstError: errors.length > 0 ? errors[0].message : "",
    };
  }
}

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
  const name = effectLabel(layer.type);
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

/** 需要重写步骤的写计划：stepCount 与完整的 0..N−1 步骤列表。 */
export interface TimelineStepsPlan {
  kind: "steps";
  stepCount: number;
  steps: SceneStep[];
}

/** 只改循环模式的写计划：不产生任何步骤重写。 */
export interface TimelineLoopPlan {
  kind: "loop";
  stepCount: number;
  loop: number;
}

export type TimelinePlan = TimelineStepsPlan | TimelineLoopPlan;

/** 读回列表重排为连续的 0..N−1，步骤内容原样保留。 */
function reindexSteps(steps: readonly SceneStep[]): SceneStep[] {
  return steps.map((step, index) => ({ ...step, stepIndex: index }));
}

/**
 * 添加步骤的写计划：已有步骤原样保留并补到末尾，新步索引为 N。
 * 固件在 step_count 变化时清空全部步骤，所以调用方必须重写整份列表。
 */
export function planAddStep(
  currentSteps: readonly SceneStep[],
  newStep: SceneStep,
): TimelineStepsPlan {
  if (currentSteps.length >= MAX_STEPS) {
    throw new RangeError(`步数已达上限 ${MAX_STEPS}，不能继续添加`);
  }
  const steps = reindexSteps(currentSteps);
  steps.push({ ...newStep, stepIndex: steps.length });
  return { kind: "steps", stepCount: steps.length, steps };
}

/** 删除末步的写计划：剩余步骤原样保留并重排索引。 */
export function planDeleteLastStep(currentSteps: readonly SceneStep[]): TimelineStepsPlan {
  if (currentSteps.length === 0) {
    throw new RangeError("没有可删除的步骤");
  }
  const steps = reindexSteps(currentSteps.slice(0, -1));
  return { kind: "steps", stepCount: steps.length, steps };
}

/** 循环切换计划：只改 loop，步骤列表不参与写入。 */
export function planLoopChange(currentSteps: readonly SceneStep[], loop: number): TimelineLoopPlan {
  const err = validateLoop(loop);
  if (err) throw new RangeError(err);
  return { kind: "loop", stepCount: currentSteps.length, loop };
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