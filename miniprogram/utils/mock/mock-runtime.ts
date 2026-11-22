/**
 * MockDeviceRuntime：设备大脑（工单 #6 决策 8）。
 *
 * 命令真的改内部状态（power/brightness/stripPowerMask/activeScene/layout/scenes），
 * 读回的就是刚写进去的。handleCommand(cmd, payload, seq) → 待 notify 的帧：
 * ACK 优先 + 查询报告；ACK 也走 onFrame，与会话层的 ack-waiters 完全同路。
 *
 * 场景（构造选项 scenario）：
 *   normal  即时
 *   slow    ACK/报告延迟 40ms（用 setTimeout）
 *   flaky   seq % 3 === 0 的帧 ACK 丢弃，让会话层 600ms 超时路径可测
 *   offline connect 直接失败
 *
 * 已知差异（刻意保留，写在 mock-transport.ts 头部注释）：无 GATT/MTU/分片；
 * 不因距离断开；无 10006/10008；时间即时（slow 场景除外）。
 */

import {
  MAX_SCENES,
  MAX_STRIPS,
  MAX_PARTS,
  MAX_PART_SEGS,
  MAX_STEPS,
  STATE_BYTES,
  DEVICE_INFO_BYTES,
  STRIP_CONFIG_BYTES,
  LAYOUT_REPORT_BYTES,
  SCENE_STEP_BYTES,
  SCENE_NAME_BYTES,
  CMD,
  DEVICE_CMD,
  RESULT,
} from "../protocol/constants";
import { encodeFrame } from "../protocol/frame";
import { parseState, parseStripConfigReport, parseDeviceInfoReport } from "../protocol/commands";
import type { DeviceInfo, DeviceState, LinkState } from "../protocol/types";
import type { MockDeviceSpec } from "./mock-devices";

export type MockScenario = "normal" | "slow" | "flaky" | "offline";

export interface MockRuntimeOptions {
  scenario?: MockScenario;
  timer?: { setTimeout: (fn: () => void, ms: number) => number; clearTimeout: (h: number) => void };
}

export class MockDeviceRuntime {
  readonly spec: MockDeviceSpec;
  readonly scenario: MockScenario;
  private readonly timer: { setTimeout: (fn: () => void, ms: number) => number; clearTimeout: (h: number) => void };
  private power: number;
  private brightness: number;
  private stripPowerMask: number;
  private activeScene: number;
  private layoutValid: boolean;
  private stripLedCounts: number[];
  private partCounts: number[];
  private layout: Map<number, { partId: number; name: string; segs: Array<[number, number]>; phase: number }[]>;

  constructor(spec: MockDeviceSpec, opts: MockRuntimeOptions = {}) {
    this.spec = spec;
    this.scenario = opts.scenario ?? "normal";
    this.timer = opts.timer ?? { setTimeout: (fn, ms) => setTimeout(fn, ms) as unknown as number, clearTimeout: (h) => clearTimeout(h) };
    this.power = spec.power;
    this.brightness = spec.brightness;
    this.stripPowerMask = spec.stripPowerMask;
    this.activeScene = 0;
    this.layoutValid = spec.parts.length > 0;
    this.stripLedCounts = spec.stripCounts.slice();
    while (this.stripLedCounts.length < MAX_STRIPS) this.stripLedCounts.push(0);
    this.partCounts = Array(MAX_STRIPS).fill(0);
    for (const p of spec.parts) {
      this.partCounts[p.stripId] = Math.max(this.partCounts[p.stripId], p.partId + 1);
    }
    this.layout = new Map();
    for (const p of spec.parts) {
      if (!this.layout.has(p.stripId)) this.layout.set(p.stripId, []);
      this.layout.get(p.stripId)!.push({
        partId: p.partId,
        name: p.name,
        segs: p.segs.map(([s, e]) => [s, e] as [number, number]),
        phase: 0,
      });
    }
  }

  /** 读 State（32B）。 */
  readState(): Uint8Array {
    const state: DeviceState = {
      power: this.power,
      brightness: this.brightness,
      maxBrightness: this.spec.maxBrightness,
      stripCount: this.spec.stripCounts.filter((n) => n > 0).length || 1,
      stripPowerMask: this.stripPowerMask,
      activeScene: this.activeScene,
      layoutValid: this.layoutValid,
      stripLedCounts: this.stripLedCounts.slice(),
      partCounts: this.partCounts.slice(),
    };
    // 编码成 32B State 载荷
    const buf = new Uint8Array(STATE_BYTES);
    buf[0] = state.power;
    buf[1] = state.brightness;
    buf[2] = state.maxBrightness;
    buf[3] = state.stripCount;
    buf[4] = state.stripPowerMask;
    buf[5] = state.activeScene;
    buf[6] = state.layoutValid ? 1 : 0;
    buf[7] = 0;
    for (let i = 0; i < MAX_STRIPS; i += 1) {
      const v = state.stripLedCounts[i] ?? 0;
      buf[8 + i * 2] = v & 0xff;
      buf[9 + i * 2] = (v >> 8) & 0xff;
    }
    for (let i = 0; i < MAX_STRIPS; i += 1) {
      buf[24 + i] = state.partCounts[i] ?? 0;
    }
    return buf;
  }

  /** State 对象（给 MockTransport 的 connect 返回）。 */
  readStateObject(): DeviceState {
    // 复用 parseState 保证同形
    return parseState(this.readState());
  }

  /**
   * 处理一条命令。返回待 notify 的帧列表（ACK 优先 + 查询报告）。
   * flaky 场景下 seq % 3 === 0 的帧 ACK 丢弃（不返回 ACK 帧）。
   */
  handleCommand(cmd: number, payload: Uint8Array, seq: number): Uint8Array[] {
    const frames: Uint8Array[] = [];
    const flakyDrop = this.scenario === "flaky" && seq % 3 === 0;

    // 先决定结果码
    let result = RESULT.OK;
    switch (cmd) {
      case CMD.SET_POWER: {
        const on = payload[0] === 1;
        if (payload.length !== 1 || (payload[0] !== 0 && payload[0] !== 1)) {
          result = RESULT.INVALID_PARAM;
        } else {
          this.power = on ? 1 : 0;
        }
        break;
      }
      case CMD.SET_BRIGHTNESS: {
        if (payload.length !== 1) { result = RESULT.INVALID_PARAM; break; }
        this.brightness = payload[0];
        break;
      }
      case CMD.QUERY_STATE: {
        // ACK + StateReport
        break;
      }
      case CMD.SET_LED_COUNT: {
        if (payload.length !== 3) { result = RESULT.INVALID_PARAM; break; }
        const stripId = payload[0];
        const count = payload[1] | (payload[2] << 8);
        if (stripId >= MAX_STRIPS || count < 1 || count > 100) {
          result = RESULT.INVALID_PARAM;
          break;
        }
        this.stripLedCounts[stripId] = count;
        break;
      }
      case CMD.SELF_TEST: {
        break;
      }
      case CMD.SET_STRIP_POWER: {
        if (payload.length !== 2) { result = RESULT.INVALID_PARAM; break; }
        const stripId = payload[0];
        const on = payload[1] === 1;
        if (stripId >= MAX_STRIPS) { result = RESULT.INVALID_PARAM; break; }
        const bit = 1 << stripId;
        this.stripPowerMask = on ? this.stripPowerMask | bit : this.stripPowerMask & ~bit;
        break;
      }
      case CMD.QUERY_STRIP_CONFIG: {
        break;
      }
      case CMD.QUERY_DEVICE_INFO: {
        break;
      }
      case CMD.LAYOUT_WRITE: {
        if (payload.length !== 2) { result = RESULT.INVALID_PARAM; break; }
        const stripId = payload[0];
        const partCount = payload[1];
        if (stripId >= MAX_STRIPS || partCount > MAX_PARTS) { result = RESULT.INVALID_PARAM; break; }
        this.layout.set(stripId, []);
        this.partCounts[stripId] = partCount;
        break;
      }
      case CMD.LAYOUT_COMMIT: {
        this.layoutValid = true;
        break;
      }
      case CMD.QUERY_LAYOUT: {
        break;
      }
      case CMD.SCENE_PART: {
        break;
      }
      case CMD.ACTIVATE_SCENE: {
        if (payload.length !== 1) { result = RESULT.INVALID_PARAM; break; }
        const sceneId = payload[0];
        if (sceneId >= MAX_SCENES) { result = RESULT.INVALID_PARAM; break; }
        this.activeScene = sceneId;
        break;
      }
      case CMD.QUERY_SCENE: {
        break;
      }
      default: {
        result = RESULT.UNKNOWN_COMMAND;
        break;
      }
    }

    // flaky：丢 ACK（seq % 3 === 0）
    const dropAck = flakyDrop;

    if (!dropAck) {
      // ACK 帧
      const ackPayload = new Uint8Array([cmd, result]);
      frames.push(encodeFrame(DEVICE_CMD.ACK, seq, ackPayload));
    }

    // 查询报告
    if (result === RESULT.OK) {
      if (cmd === CMD.QUERY_STATE) {
        frames.push(encodeFrame(DEVICE_CMD.STATE_REPORT, seq, this.readState()));
      } else if (cmd === CMD.QUERY_STRIP_CONFIG) {
        const buf = new Uint8Array(STRIP_CONFIG_BYTES);
        for (let i = 0; i < MAX_STRIPS; i += 1) {
          const base = i * 3;
          buf[base] = i;
          buf[base + 1] = i < this.spec.stripCounts.filter((n) => n > 0).length ? (i + 1) * 2 : 0xff;
          buf[base + 2] = i < this.spec.stripCounts.filter((n) => n > 0).length ? 0x01 : 0x00;
        }
        frames.push(encodeFrame(DEVICE_CMD.STRIP_CONFIG_REPORT, seq, buf));
      } else if (cmd === CMD.QUERY_DEVICE_INFO) {
        frames.push(encodeFrame(DEVICE_CMD.DEVICE_INFO_REPORT, seq, this.deviceInfoBytes()));
      } else if (cmd === CMD.QUERY_LAYOUT) {
        const stripId = payload[0];
        const parts = this.layout.get(stripId) ?? [];
        for (const p of parts) {
          const segs: Array<[number, number]> = p.segs;
          const buf = new Uint8Array(LAYOUT_REPORT_BYTES);
          buf[0] = stripId;
          buf[1] = p.partId;
          buf[2] = p.name.length; // 近似：名字字节数
          // 名字 UTF-8 编码
          const nameBytes = new TextEncoder().encode(p.name);
          buf.set(nameBytes.subarray(0, 24), 3);
          buf[27] = segs.length;
          buf[28] = p.phase;
          for (let i = 0; i < segs.length && i < 8; i += 1) {
            buf[29 + i * 2] = segs[i][0];
            buf[30 + i * 2] = segs[i][1];
          }
          frames.push(encodeFrame(DEVICE_CMD.LAYOUT_REPORT, seq, buf));
        }
        // LayoutListEnd
        const mask = parts.reduce((m, p) => m | (1 << p.partId), 0);
        frames.push(encodeFrame(DEVICE_CMD.LAYOUT_LIST_END, seq, new Uint8Array([stripId, mask])));
      }
    }

    // slow 场景：延迟派发由 transport 层处理；这里返回 frames，transport 负责 setTimeout
    // 为简单，runtime 直接返回 frames；slow 延迟在 MockTransport.connect/sendFrame 里加
    return frames;
  }

  private deviceInfoBytes(): Uint8Array {
    const buf = new Uint8Array(DEVICE_INFO_BYTES);
    const version = 0x0500;
    buf[0] = version & 0xff;
    buf[1] = (version >> 8) & 0xff;
    // hw_id 6 字节
    const mac = this.spec.hwId.split(":");
    for (let i = 0; i < 6; i += 1) {
      buf[2 + i] = parseInt(mac[i], 16);
    }
    buf[8] = 100; // maxLeds
    buf[9] = MAX_STRIPS; // maxStrips
    buf[10] = MAX_PARTS; // maxParts
    buf[11] = MAX_PART_SEGS; // maxPartSegs
    buf[12] = MAX_STEPS; // maxSteps
    buf[13] = MAX_SCENES; // maxScenes
    buf[14] = 0x01; // caps: 支持两层叠加
    return buf;
  }

  /** 设备自报 MAC（大写冒号分隔，DeviceInfoReport 解析后就是这个）。 */
  get hwId(): string {
    return this.spec.hwId;
  }

  /** hw_id 上报 `hw:` 前缀用的 12 位小写无分隔符形式。 */
  get hwIdFlat(): string {
    return this.spec.hwId.replace(/:/g, "").toLowerCase();
  }
}