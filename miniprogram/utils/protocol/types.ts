/** 协议层与会话层共用的数据类型（docs/protocol.md §8）。 */

/**
 * 一步的一层灯效（§9 的 9 字节定宽编码在内存里的形状）。
 * 空层用 `type = NO_EFFECT`（0xFF），其参数与 level 必须全 0。
 */
export interface EffectLayer {
  type: number;
  hue: number;
  sat: number;
  periodMs: number;
  p5: number;
  flags: number;
  level: number;
}

/** 空层常量（type=0xFF，其余全 0）。 */
export const EMPTY_EFFECT: EffectLayer = {
  type: 0xff,
  hue: 0,
  sat: 0,
  periodMs: 0,
  p5: 0,
  flags: 0,
  level: 0,
};

/** 一个步骤：时长 + 两层。 */
export interface SceneStep {
  sceneId: number;
  stripId: number;
  partId: number;
  stepIndex: number;
  durationMs: number;
  layer0: EffectLayer;
  layer1: EffectLayer;
}

/** 一个部位在某链上的「灯珠划分」。 */
export interface LayoutPart {
  stripId: number;
  partId: number;
  nameLen: number;
  name: string;
  segCount: number;
  phase: number;
  segs: Array<[number, number]>;
}

/** 一条 LayoutReport 0x89。 */
export type LayoutReport = LayoutPart;

/** 一条 LayoutListEnd 0x8A：某链的部位位图。 */
export interface LayoutListEnd {
  stripId: number;
  partMask: number;
}

/** 一条布局读回（QueryLayout 的多帧收尾组成）。 */
export interface LayoutReadback {
  stripId: number;
  parts: LayoutPart[];
  partMask: number;
}

/** ScenePartReport 0x8B。 */
export interface ScenePartReport {
  sceneId: number;
  stripId: number;
  partId: number;
  stepCount: number;
  loop: number;
  on: boolean;
}

/** SceneStepReport 0x8C。 */
export type SceneStepReport = SceneStep;

/** SceneListEnd 0x8D。 */
export interface SceneListEnd {
  sceneId: number;
  nameLen: number;
  name: string;
}

/** 一份完整的场景读回（QueryScene 的多帧收尾组成）。 */
export interface SceneReport {
  sceneId: number;
  name: string;
  parts: ScenePartReport[];
  steps: SceneStepReport[];
}

/** StripConfigReport 0x87 的一条记录。 */
export interface StripConfigChannel {
  stripId: number;
  gpio: number;
  flags: number;
  assigned: boolean;
}

/** StripConfigReport 0x87 的整条报告：固定 8 路。 */
export interface StripConfig {
  channels: StripConfigChannel[];
}

/** DeviceInfoReport 0x88。 */
export interface DeviceInfo {
  /** "0100" = 0x0100 → 线上 00 01 小端。 */
  firmwareVersion: number;
  firmwareMajor: number;
  firmwareMinor: number;
  /** 6 字节 BT MAC，按 "AA:BB:CC:DD:EE:FF" 的自然顺序（大写）。 */
  hwId: string;
  maxLeds: number;
  maxStrips: number;
  maxParts: number;
  maxPartSegs: number;
  maxSteps: number;
  maxScenes: number;
  caps: number;
  supportsTwoLayers: boolean;
  fadeImplemented: boolean;
}

/**
 * 设备 32 字节 State 的内存表示（§8.2）。
 * v5 不含部位开关、播放位置、颜色摘要——细节走 QueryLayout / QueryScene。
 */
export interface DeviceState {
  power: 0 | 1;
  brightness: number;
  maxBrightness: number;
  stripCount: number;
  stripPowerMask: number;
  activeScene: number;
  layoutValid: boolean;
  stripLedCounts: number[];
  partCounts: number[];
}

/** 一条待下发的命令。payload 由 commands.ts 的构造器生成。 */
export interface CommandRequest {
  command: number;
  payload: Uint8Array;
}

/** ACK 解析结果。 */
export interface AckResult {
  seq: number;
  command: number;
  resultCode: number;
  ok: boolean;
}

/**
 * 连接状态机（docs/protocol.md §3.3 / 工单 #6 决策 4）。
 *   idle          未连接（初始 / 主动断开后）
 *   connecting    首次或手动连接进行中
 *   ready         已连接且初始化流水线完成
 *   reconnecting  断线后自动退避回连进行中
 *   failed        退避耗尽，等用户手动入口
 */
export type LinkState =
  | "idle"
  | "connecting"
  | "ready"
  | "reconnecting"
  | "failed";

/** 适配器状态（wx 10001 / iOS fail states 的分诊入口）。 */
export type AdapterState = "on" | "off" | "unknown";

/** 扫描结果：名字优先取 localName；deviceId 是平台分配的连接 ID。 */
export interface DiscoveredDevice {
  deviceId: string;
  name: string;
  rssi: number;
}