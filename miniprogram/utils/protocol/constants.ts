/**
 * 协议常量（docs/protocol.md 的字节级照抄）。
 *
 * 协议版本 5（契约血统标识，承袭 lumen v5；不向后兼容）。
 * UUID 统一大写比较（微信跨平台大小写不一致）。
 */

export const SERVICE_UUID = "6C756D65-6E00-4B1E-9A3C-000000000001";
export const RX_UUID = "6C756D65-6E00-4B1E-9A3C-000000000002";
export const TX_UUID = "6C756D65-6E00-4B1E-9A3C-000000000003";
export const STATE_UUID = "6C756D65-6E00-4B1E-9A3C-000000000004";

/** 广播名前缀（设备自报 LUMEN-XXXX；身份仍是 hw_id）。 */
export const BLE_NAME_PREFIX = "LUMEN-";

/** 逻辑帧信封：magic(1) version(1) command(1) seq(1) length(2 LE) payload crc16(2 LE)。 */
export const MAGIC = 0xa6;
export const PROTOCOL_VERSION = 0x05;
export const HEADER_BYTES = 6;
export const FRAME_OVERHEAD = 8;

/** 逻辑帧上限：载荷 232、整帧 240。 */
export const MAX_PAYLOAD_BYTES = 232;
export const MAX_FRAME_BYTES = 240;

/** BLE 默认 ATT MTU 23 − 3；MTU 未知时两端都按这个工作。 */
export const DEFAULT_MTU = 23;
export const DEFAULT_CHUNK_CAPACITY = DEFAULT_MTU - 3;
/** 单次写上限 180；数据上限 = capacity − 1（1 字节分片头）。 */
export const MAX_CHUNK_CAPACITY = 180;
export const MAX_CHUNK_DATA = MAX_CHUNK_CAPACITY - 1;
/** 分片头：bit7 FIRST、bit6 LAST、bit5-0 序号。 */
export const CHUNK_FIRST = 0x80;
export const CHUNK_LAST = 0x40;
export const CHUNK_INDEX_MASK = 0x3f;
/** 重组超时（自上一个分片起算）。 */
export const ASSEMBLY_TIMEOUT_MS = 1000;

/** 设备能力上限（docs/protocol.md §2）。 */
export const MAX_LEDS = 100;
export const MIN_LEDS = 1;
export const MAX_STRIPS = 8;
/** 每条链的部位数。 */
export const MAX_PARTS = 8;
/** 每个部位的灯珠段数。 */
export const MAX_PART_SEGS = 8;
/** 每个部位的步骤数。 */
export const MAX_STEPS = 8;
/** 设备侧场景数。 */
export const MAX_SCENES = 3;
/** 部位名 / 场景名的字节上限（UTF-8）。 */
export const NAME_BYTES = 24;
/** 步骤时长区间。 */
export const STEP_MIN_MS = 100;
export const STEP_MAX_MS = 60000;
/** 层类型 0xFF 表示「该层为空」。 */
export const NO_EFFECT = 0xff;
/** 每层亮度上限（百分比）。 */
export const LAYER_LEVEL_MAX = 100;
/** 整机亮度上限（State 暴露，不硬编码 255）。 */
export const MAX_BRIGHTNESS = 200;
/** 每段最多两层。 */
export const MAX_LAYERS = 2;

/** 部位相位模式。 */
export const PHASE = {
  CONTINUOUS: 0,
  PER_SEGMENT: 1,
} as const;
export type PhaseMode = (typeof PHASE)[keyof typeof PHASE];

/** 层编码定宽 9 字节。 */
export const LAYER_BYTES = 9;
/** State 固定 32 字节。 */
export const STATE_BYTES = 32;
/** LayoutPart 0x21 / LayoutReport 0x89 载荷 29/45 字节。 */
export const LAYOUT_PART_BYTES = 29;
export const LAYOUT_REPORT_BYTES = 45;
/** SceneStep / SceneStepReport 载荷 24 字节。 */
export const SCENE_STEP_BYTES = 24;
/** SceneName / SceneListEnd 载荷 26 字节。 */
export const SCENE_NAME_BYTES = 26;
/** StripConfigReport 0x87 / DeviceInfoReport 0x88 载荷 24/15 字节。 */
export const STRIP_CONFIG_BYTES = 24;
export const STRIP_CONFIG_RECORD_BYTES = 3;
export const DEVICE_INFO_BYTES = 15;

/** 连续量节流上限：20Hz。 */
export const CONTINUOUS_INTERVAL_MS = 50;

/** ACK 等待超时（ms）。 */
export const ACK_TIMEOUT_MS = 600;
/** 查询报告（多帧收尾 / 单条报告）等待超时（ms）；BLE 多帧报告可能持续数秒。 */
export const REPORT_TIMEOUT_MS = 5000;

/** 小程序 → 设备命令字（docs/protocol.md §7）。 */
export const CMD = {
  SET_POWER: 0x01,
  SET_BRIGHTNESS: 0x02,
  QUERY_STATE: 0x05,
  SET_LED_COUNT: 0x06,
  SELF_TEST: 0x07,

  SET_STRIP_POWER: 0x1b,
  QUERY_STRIP_CONFIG: 0x1c,
  QUERY_DEVICE_INFO: 0x1d,

  LAYOUT_WRITE: 0x20,
  LAYOUT_PART: 0x21,
  LAYOUT_SEG: 0x22,
  LAYOUT_COMMIT: 0x23,
  QUERY_LAYOUT: 0x24,

  SCENE_PART: 0x25,
  SCENE_STEP: 0x26,
  SCENE_NAME: 0x27,
  ACTIVATE_SCENE: 0x28,
  QUERY_SCENE: 0x29,
} as const;

/** 设备 → 小程序命令字。 */
export const DEVICE_CMD = {
  ACK: 0x80,
  EVENT: 0x81,
  STATE_REPORT: 0x82,
  STRIP_CONFIG_REPORT: 0x87,
  DEVICE_INFO_REPORT: 0x88,
  LAYOUT_REPORT: 0x89,
  LAYOUT_LIST_END: 0x8a,
  SCENE_PART_REPORT: 0x8b,
  SCENE_STEP_REPORT: 0x8c,
  SCENE_LIST_END: 0x8d,
} as const;

/** ACK 载荷第二个字节（docs/protocol.md §6）。 */
export const RESULT = {
  OK: 0x00,
  INVALID_PARAM: 0x01,
  UNKNOWN_COMMAND: 0x02,
  BAD_CHECKSUM: 0x03,
  BAD_LENGTH: 0x04,
  BUSY: 0x05,
  STORAGE_FAILED: 0x06,
  UNSUPPORTED_VERSION: 0x07,
  BAD_MAGIC: 0x08,
  INTERNAL_ERROR: 0x09,
} as const;

/** 结果码中文名（docs/protocol.md §6；页面提示与日志共用）。 */
export const RESULT_NAMES: Record<number, string> = {
  [RESULT.OK]: "成功",
  [RESULT.INVALID_PARAM]: "参数无效",
  [RESULT.UNKNOWN_COMMAND]: "未知命令",
  [RESULT.BAD_CHECKSUM]: "校验和错误",
  [RESULT.BAD_LENGTH]: "长度错误",
  [RESULT.BUSY]: "设备忙",
  [RESULT.STORAGE_FAILED]: "存储失败",
  [RESULT.UNSUPPORTED_VERSION]: "版本不支持",
  [RESULT.BAD_MAGIC]: "帧头错误",
  [RESULT.INTERNAL_ERROR]: "内部错误",
};

export function resultName(code: number): string {
  return RESULT_NAMES[code] ?? `未知结果码 0x${code.toString(16).padStart(2, "0").toUpperCase()}`;
}

/** 异步事件码（docs/protocol.md §8.1）。 */
export const EVENT = {
  STORAGE_FAILED: 0x01,
} as const;

/** 灯效层类型（docs/protocol.md §9）。 */
export const EFFECT_TYPE = {
  STATIC: 0x00,
  BREATHING: 0x01,
  RAINBOW: 0x02,
  COMET: 0x03,
  STROBE: 0x04,
  HEARTBEAT: 0x05,
  OFF: 0x06,
  FLICKER: 0x07,
  EMPTY: 0xff,
} as const;

/** 真实灯效类型清单（不含空层 0xFF）。 */
export const KNOWN_EFFECT_TYPES: readonly number[] = [
  EFFECT_TYPE.STATIC,
  EFFECT_TYPE.BREATHING,
  EFFECT_TYPE.RAINBOW,
  EFFECT_TYPE.COMET,
  EFFECT_TYPE.STROBE,
  EFFECT_TYPE.HEARTBEAT,
  EFFECT_TYPE.OFF,
  EFFECT_TYPE.FLICKER,
];

export function isKnownEffectType(type: number): boolean {
  return KNOWN_EFFECT_TYPES.includes(type);
}

/**
 * 各灯效类型的周期合法区间（docs/protocol.md §9）。
 * period = 0 表示「使用设备默认」，任何类型的 0 都合法。
 * COMET 沿用彩虹下限：固件 effects.c 的 COMET 分支用的就是
 * LUMEN_RAINBOW_MIN_PERIOD_MS。
 */
export const EFFECT_PERIOD_BOUNDS: Record<number, { min: number; max: number }> = {
  [EFFECT_TYPE.BREATHING]: { min: 334, max: 0xffff },
  [EFFECT_TYPE.RAINBOW]: { min: 200, max: 0xffff },
  [EFFECT_TYPE.COMET]: { min: 200, max: 0xffff },
  [EFFECT_TYPE.STROBE]: { min: 100, max: 0xffff },
  [EFFECT_TYPE.HEARTBEAT]: { min: 500, max: 1500 },
  [EFFECT_TYPE.FLICKER]: { min: 334, max: 0xffff },
};

/** 该类型是否使用周期，且给定时长是否落在协议允许区间。 */
export function isValidEffectPeriod(type: number, periodMs: number): boolean {
  if (periodMs === 0) return true;
  const bounds = EFFECT_PERIOD_BOUNDS[type];
  if (!bounds) return false;
  return periodMs >= bounds.min && periodMs <= bounds.max;
}

/** 循环三值（docs/protocol.md §8.4）。 */
export const LOOP = {
  NONE: 0,
  ALL: 1,
  LAST: 2,
} as const;
export const LOOP_MAX = LOOP.LAST;
export type LoopMode = (typeof LOOP)[keyof typeof LOOP];

/** 命令名表（日志与提示用，不参与协议）。 */
export const COMMAND_NAMES: Record<number, string> = {
  [CMD.SET_POWER]: "SetPower",
  [CMD.SET_BRIGHTNESS]: "SetBrightness",
  [CMD.QUERY_STATE]: "QueryState",
  [CMD.SET_LED_COUNT]: "SetLedCount",
  [CMD.SELF_TEST]: "SelfTest",
  [CMD.SET_STRIP_POWER]: "SetStripPower",
  [CMD.QUERY_STRIP_CONFIG]: "QueryStripConfig",
  [CMD.QUERY_DEVICE_INFO]: "QueryDeviceInfo",
  [CMD.LAYOUT_WRITE]: "LayoutWrite",
  [CMD.LAYOUT_PART]: "LayoutPart",
  [CMD.LAYOUT_SEG]: "LayoutSeg",
  [CMD.LAYOUT_COMMIT]: "LayoutCommit",
  [CMD.QUERY_LAYOUT]: "QueryLayout",
  [CMD.SCENE_PART]: "ScenePart",
  [CMD.SCENE_STEP]: "SceneStep",
  [CMD.SCENE_NAME]: "SceneName",
  [CMD.ACTIVATE_SCENE]: "ActivateScene",
  [CMD.QUERY_SCENE]: "QueryScene",
  [DEVICE_CMD.ACK]: "ACK",
  [DEVICE_CMD.EVENT]: "Event",
  [DEVICE_CMD.STATE_REPORT]: "StateReport",
  [DEVICE_CMD.STRIP_CONFIG_REPORT]: "StripConfigReport",
  [DEVICE_CMD.DEVICE_INFO_REPORT]: "DeviceInfoReport",
  [DEVICE_CMD.LAYOUT_REPORT]: "LayoutReport",
  [DEVICE_CMD.LAYOUT_LIST_END]: "LayoutListEnd",
  [DEVICE_CMD.SCENE_PART_REPORT]: "ScenePartReport",
  [DEVICE_CMD.SCENE_STEP_REPORT]: "SceneStepReport",
  [DEVICE_CMD.SCENE_LIST_END]: "SceneListEnd",
};

export function commandName(command: number): string {
  return COMMAND_NAMES[command] ?? `0x${command.toString(16).padStart(2, "0").toUpperCase()}`;
}