/**
 * 层编码校验：docs/protocol.md §9 与 firmware/main/effects.c
 * （lumen_segment_validate_shape / lumen_segment_validate_params）的镜像。
 *
 * Mock 设备用它拒绝真固件会拒绝的 SceneStep。纯函数，无 wx 依赖。
 * 这里是「设备侧规则」，不是发送前提示：页面校验可以更早、更细，但
 * Mock 必须按同一份规则回 InvalidParam，否则「操作 → 读回」测试会被宽容的
 * 演示设备染绿。
 */

import { EFFECT_TYPE, LAYER_BYTES, LAYER_LEVEL_MAX, isKnownEffectType } from "./constants";

interface LayerRule {
  /** flags 里必须为 0 的位。 */
  flagsMask: number;
  /** period != 0 时的下限（0 表示不限制）。 */
  minPeriodMs: number;
  /** period != 0 时的上限（0 表示不限制）。 */
  maxPeriodMs: number;
  /** 静态：param[3..6]（period / p5 / flags）必须全 0。 */
  reservedParamTail: boolean;
  /** 熄灭：param[1..7] 全部必须为 0。 */
  allParamsZero: boolean;
  /** 呼吸：p5 是相对百分比，必须 ≤ 100。 */
  p5Percent: boolean;
}

const RULES: Record<number, LayerRule> = {
  [EFFECT_TYPE.STATIC]: {
    flagsMask: 0xff,
    minPeriodMs: 0,
    maxPeriodMs: 0,
    reservedParamTail: true,
    allParamsZero: false,
    p5Percent: false,
  },
  [EFFECT_TYPE.BREATHING]: {
    flagsMask: 0xf8,
    minPeriodMs: 334,
    maxPeriodMs: 0,
    reservedParamTail: false,
    allParamsZero: false,
    p5Percent: true,
  },
  [EFFECT_TYPE.RAINBOW]: {
    flagsMask: 0xfe,
    minPeriodMs: 200,
    maxPeriodMs: 0,
    reservedParamTail: false,
    allParamsZero: false,
    p5Percent: false,
  },
  [EFFECT_TYPE.COMET]: {
    flagsMask: 0xf0,
    minPeriodMs: 200,
    maxPeriodMs: 0,
    reservedParamTail: false,
    allParamsZero: false,
    p5Percent: false,
  },
  [EFFECT_TYPE.STROBE]: {
    flagsMask: 0xff,
    minPeriodMs: 100,
    maxPeriodMs: 0,
    reservedParamTail: false,
    allParamsZero: false,
    p5Percent: false,
  },
  [EFFECT_TYPE.HEARTBEAT]: {
    flagsMask: 0xfe,
    minPeriodMs: 500,
    maxPeriodMs: 1500,
    reservedParamTail: false,
    allParamsZero: false,
    p5Percent: false,
  },
  [EFFECT_TYPE.OFF]: {
    flagsMask: 0xff,
    minPeriodMs: 0,
    maxPeriodMs: 0,
    reservedParamTail: false,
    allParamsZero: true,
    p5Percent: false,
  },
  [EFFECT_TYPE.FLICKER]: {
    flagsMask: 0xff,
    minPeriodMs: 334,
    maxPeriodMs: 0,
    reservedParamTail: false,
    allParamsZero: false,
    p5Percent: false,
  },
};

function zeroRange(bytes: Uint8Array, from: number, to: number): boolean {
  for (let i = from; i < to; i += 1) {
    if (bytes[i] !== 0) return false;
  }
  return true;
}

/**
 * 一层 9 字节是否合法。
 *
 * @param bytes 9 字节编码：type(1) | param[7] | level(1)
 * @param allowEmpty layer1 允许 0xFF 空层；layer0 不允许
 */
export function isValidLayer(bytes: Uint8Array, allowEmpty: boolean): boolean {
  if (bytes.length !== LAYER_BYTES) return false;
  const type = bytes[0];
  const level = bytes[8];

  if (type === EFFECT_TYPE.EMPTY) {
    /* 空层：type=0xFF，param[7] 与 level 必须全 0（含 level，§9）。 */
    return allowEmpty && zeroRange(bytes, 1, LAYER_BYTES);
  }
  if (!isKnownEffectType(type)) return false;
  if (level > LAYER_LEVEL_MAX) return false;

  const rule = RULES[type];
  const periodMs = bytes[4] | (bytes[5] << 8);
  const p5 = bytes[6];
  const flags = bytes[7];

  if ((flags & rule.flagsMask) !== 0) return false;
  if (periodMs !== 0) {
    if (periodMs < rule.minPeriodMs) return false;
    if (rule.maxPeriodMs !== 0 && periodMs > rule.maxPeriodMs) return false;
  }
  if (rule.p5Percent && p5 > 100) return false;
  if (rule.reservedParamTail && !zeroRange(bytes, 4, 8)) return false;
  if (rule.allParamsZero && !zeroRange(bytes, 1, 8)) return false;
  return true;
}

/** SceneStep 的两层：layer0 必须非空，layer1 允许空层。 */
export function isValidSceneStepLayers(layer0: Uint8Array, layer1: Uint8Array): boolean {
  return isValidLayer(layer0, false) && isValidLayer(layer1, true);
}
