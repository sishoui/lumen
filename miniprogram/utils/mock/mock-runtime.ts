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
  NAME_BYTES,
  LAYER_BYTES,
  LOOP_MAX,
  STEP_MIN_MS,
  STEP_MAX_MS,
  CMD,
  DEVICE_CMD,
  RESULT,
} from "../protocol/constants";
import { encodeFrame } from "../protocol/frame";
import { parseState } from "../protocol/commands";
import { isValidSceneStepLayers } from "../protocol/layer-rules";
import type { DeviceState } from "../protocol/types";
import type { MockDeviceSpec } from "./mock-devices";

/** 已清零 / 未写入的步骤在报告里的样子：时长 0，两层 9 字节全 0。 */
const ZERO_LAYER = new Uint8Array(LAYER_BYTES);

interface MockLayoutPart {
  partId: number;
  name: string;
  segs: Array<[number, number]>;
  phase: number;
}

interface MockScenePartHead {
  stepCount: number;
  loop: number;
  on: boolean;
}

interface MockSceneStep {
  durationMs: number;
  layer0: Uint8Array; // 9 bytes raw
  layer1: Uint8Array; // 9 bytes raw
}

export type MockScenario = "normal" | "slow" | "flaky" | "offline";

export interface MockRuntimeOptions {
  scenario?: MockScenario;
  timer?: { setTimeout: (fn: () => void, ms: number) => number; clearTimeout: (h: number) => void };
}

export class MockDeviceRuntime {
  readonly spec: MockDeviceSpec;
  readonly scenario: MockScenario;
  private readonly timer: { setTimeout: (fn: () => void, ms: number) => number; clearTimeout: (h: number) => void };
  private power: 0 | 1;
  private brightness: number;
  private stripPowerMask: number;
  private activeScene: number;
  private layoutValid: boolean;
  private stripLedCounts: number[];
  private partCounts: number[];
  private layout: Map<number, MockLayoutPart[]>;
  /** 场景数据：sceneId → (stripId, partId) → { head, steps[] } */
  private scenes: Map<number, Map<string, { head: MockScenePartHead; steps: MockSceneStep[] }>>;
  private sceneNames: Map<number, string>;
  /** 布局编辑暂存区（LayoutWrite 之后、LayoutCommit 之前暂存，Commit 时搬到 layout）。 */
  private layoutStaging: Map<number, MockLayoutPart[]>;

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
    this.layoutStaging = new Map();
    this.scenes = new Map();
    this.sceneNames = new Map();
    // 为每套场景初始化空部位表
    for (let sid = 0; sid < MAX_SCENES; sid += 1) {
      this.scenes.set(sid, new Map());
      this.sceneNames.set(sid, `场景 ${sid + 1}`);
    }
  }

  /** 与固件 state.strip_count 同义：已配置的链数（至少 1）。 */
  private get stripCount(): number {
    return this.spec.stripCounts.filter((n) => n > 0).length || 1;
  }

  /** 读 State（32B）。 */
  readState(): Uint8Array {
    const state: DeviceState = {
      power: this.power,
      brightness: this.brightness,
      maxBrightness: this.spec.maxBrightness,
      stripCount: this.stripCount,
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
    let result: number = RESULT.OK;
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
        if (stripId >= this.stripCount || partCount > MAX_PARTS) { result = RESULT.INVALID_PARAM; break; }
        // 暂存到 staging（Commit 前不生效）
        this.layoutStaging.set(stripId, []);
        this.partCounts[stripId] = partCount;
        break;
      }
      case CMD.LAYOUT_PART: {
        // payload: strip_id, part_id, name_len, name[24], seg_count, phase = 29 bytes
        if (payload.length !== 29) { result = RESULT.BAD_LENGTH; break; }
        const stripId = payload[0];
        const partId = payload[1];
        const nameLen = payload[2];
        if (stripId >= this.stripCount || partId >= this.partCounts[stripId] || nameLen > NAME_BYTES) {
          result = RESULT.INVALID_PARAM;
          break;
        }
        const nameBytes = payload.slice(3, 3 + nameLen);
        const name = new TextDecoder().decode(nameBytes);
        const segCount = payload[27];
        const phase = payload[28];
        if (segCount > MAX_PART_SEGS || phase > 1) { result = RESULT.INVALID_PARAM; break; }
        const staging = this.layoutStaging.get(stripId);
        if (!staging) { result = RESULT.INVALID_PARAM; break; }
        // 确保数组足够长
        while (staging.length <= partId) {
          staging.push({ partId: staging.length, name: "", segs: [], phase: 0 });
        }
        staging[partId] = { partId, name, segs: [], phase };
        break;
      }
      case CMD.LAYOUT_SEG: {
        // payload: strip_id, part_id, seg_id, start, end = 5 bytes
        if (payload.length !== 5) { result = RESULT.BAD_LENGTH; break; }
        const stripId = payload[0];
        const partId = payload[1];
        const segId = payload[2];
        const start = payload[3];
        const end = payload[4];
        if (stripId >= this.stripCount || partId >= this.partCounts[stripId] || segId >= MAX_PART_SEGS) {
          result = RESULT.INVALID_PARAM;
          break;
        }
        if (start > end) { result = RESULT.INVALID_PARAM; break; }
        const staging = this.layoutStaging.get(stripId);
        if (!staging || partId >= staging.length) { result = RESULT.INVALID_PARAM; break; }
        const part = staging[partId];
        // 校验段互斥（同链其它部位）
        for (const other of staging) {
          if (other.partId === partId) continue;
          for (const [s, e] of other.segs) {
            if (start <= e && end >= s) { result = RESULT.INVALID_PARAM; break; }
          }
          if (result !== RESULT.OK) break;
        }
        if (result !== RESULT.OK) break;
        // 校验 end < led_count
        const ledCount = this.stripLedCounts[stripId] ?? 100;
        if (end >= ledCount) { result = RESULT.INVALID_PARAM; break; }
        // 确保 segs 数组足够长
        while (part.segs.length <= segId) part.segs.push([0, 0]);
        part.segs[segId] = [start, end];
        break;
      }
      case CMD.LAYOUT_COMMIT: {
        // 把 staging 搬到 layout。part_count 是 LayoutWrite 声明的权威值，
        // 不因某个部位没段而缩水（固件只在 QueryLayout 跳过 seg_count=0 的部位）。
        for (const [stripId, parts] of this.layoutStaging) {
          this.layout.set(stripId, parts.filter((p) => p.segs.length > 0));
        }
        // 也保留已有的 layout（如果有未被 LAYOUT_WRITE 覆盖的链）
        this.layoutStaging.clear();
        this.layoutValid = true;
        break;
      }
      case CMD.QUERY_LAYOUT: {
        break;
      }
      case CMD.SCENE_PART: {
        // payload: scene_id, strip_id, part_id, step_count, loop, on = 6 bytes
        if (payload.length !== 6) { result = RESULT.BAD_LENGTH; break; }
        const sceneId = payload[0];
        const stripId = payload[1];
        const partId = payload[2];
        const stepCount = payload[3];
        const loop = payload[4];
        const on = payload[5];
        if (sceneId >= MAX_SCENES || stripId >= this.stripCount || partId >= MAX_PARTS) { result = RESULT.INVALID_PARAM; break; }
        if (stepCount > MAX_STEPS || loop > LOOP_MAX || on > 1) { result = RESULT.INVALID_PARAM; break; }
        const sceneMap = this.scenes.get(sceneId);
        if (!sceneMap) { result = RESULT.INVALID_PARAM; break; }
        const key = `${stripId}:${partId}`;
        const existing = sceneMap.get(key);
        if (existing) {
          // 只有 stepCount 真的变了才清空已有步骤
          if (existing.head.stepCount !== stepCount) {
            existing.steps = [];
          }
          existing.head = { stepCount, loop, on: on === 1 };
        } else {
          sceneMap.set(key, {
            head: { stepCount, loop, on: on === 1 },
            steps: [],
          });
        }
        break;
      }
      case CMD.SCENE_STEP: {
        // payload: scene_id, strip_id, part_id, step_index, duration_lo, duration_hi, layer0[9], layer1[9] = 24 bytes
        if (payload.length !== SCENE_STEP_BYTES) { result = RESULT.BAD_LENGTH; break; }
        const sceneId = payload[0];
        const stripId = payload[1];
        const partId = payload[2];
        const stepIndex = payload[3];
        const durationMs = payload[4] | (payload[5] << 8);
        if (sceneId >= MAX_SCENES || stripId >= this.stripCount || partId >= MAX_PARTS || stepIndex >= MAX_STEPS) { result = RESULT.INVALID_PARAM; break; }
        if (durationMs < STEP_MIN_MS || durationMs > STEP_MAX_MS) { result = RESULT.INVALID_PARAM; break; }
        const sceneMap = this.scenes.get(sceneId);
        if (!sceneMap) { result = RESULT.INVALID_PARAM; break; }
        const key = `${stripId}:${partId}`;
        const entry = sceneMap.get(key);
        if (!entry || stepIndex >= entry.head.stepCount) { result = RESULT.INVALID_PARAM; break; }
        const layer0 = payload.slice(6, 15);
        const layer1 = payload.slice(15, 24);
        // 与固件同一份层形状校验（docs/protocol.md §9）：非法层不进 RAM。
        if (!isValidSceneStepLayers(layer0, layer1)) { result = RESULT.INVALID_PARAM; break; }
        // 确保 steps 数组足够长
        while (entry.steps.length <= stepIndex) {
          entry.steps.push({
            durationMs: 0,
            layer0: new Uint8Array(LAYER_BYTES),
            layer1: new Uint8Array(LAYER_BYTES),
          });
        }
        entry.steps[stepIndex] = {
          durationMs,
          layer0: layer0.slice(),
          layer1: layer1.slice(),
        };
        break;
      }
      case CMD.SCENE_NAME: {
        // payload: scene_id, name_len, name[24] = 26 bytes
        if (payload.length !== SCENE_NAME_BYTES) { result = RESULT.BAD_LENGTH; break; }
        const sceneId = payload[0];
        const nameLen = payload[1];
        if (sceneId >= MAX_SCENES || nameLen > NAME_BYTES) { result = RESULT.INVALID_PARAM; break; }
        const nameBytes = payload.slice(2, 2 + nameLen);
        const name = new TextDecoder().decode(nameBytes);
        this.sceneNames.set(sceneId, name);
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
          // 名字 UTF-8 编码
          const nameBytes = new TextEncoder().encode(p.name);
          buf[2] = nameBytes.length;
          buf.set(nameBytes.subarray(0, NAME_BYTES), 3);
          buf[27] = segs.length;
          buf[28] = p.phase;
          for (let i = 0; i < segs.length && i < MAX_PART_SEGS; i += 1) {
            buf[29 + i * 2] = segs[i][0];
            buf[30 + i * 2] = segs[i][1];
          }
          frames.push(encodeFrame(DEVICE_CMD.LAYOUT_REPORT, seq, buf));
        }
        // LayoutListEnd
        const mask = parts.reduce((m, p) => m | (1 << p.partId), 0);
        frames.push(encodeFrame(DEVICE_CMD.LAYOUT_LIST_END, seq, new Uint8Array([stripId, mask])));
      } else if (cmd === CMD.QUERY_SCENE) {
        const sceneId = payload[0];
        const sceneMap = this.scenes.get(sceneId);
        const sceneName = this.sceneNames.get(sceneId) ?? "";
        if (sceneMap) {
          // 固件按 strip 0..7、part 0..7 的固定顺序遍历；Map 的插入顺序不是契约。
          const entries = Array.from(sceneMap.entries()).sort((a, b) => {
            const [as, ap] = a[0].split(":").map(Number);
            const [bs, bp] = b[0].split(":").map(Number);
            return as - bs || ap - bp;
          });
          for (const [key, entry] of entries) {
            // 0 步 = 本场景不演（固件 S10）：不报这个部位。
            if (entry.head.stepCount === 0) continue;
            const [stripId, partId] = key.split(":").map(Number);
            const headBuf = new Uint8Array(6);
            headBuf[0] = sceneId;
            headBuf[1] = stripId;
            headBuf[2] = partId;
            headBuf[3] = entry.head.stepCount;
            headBuf[4] = entry.head.loop;
            headBuf[5] = entry.head.on ? 1 : 0;
            frames.push(encodeFrame(DEVICE_CMD.SCENE_PART_REPORT, seq, headBuf));
            // 报告 step_count 内的每一步；没写过的步骤按固件规则报「时长 0、两层全 0」。
            for (let stepIdx = 0; stepIdx < entry.head.stepCount && stepIdx < MAX_STEPS; stepIdx += 1) {
              const step = entry.steps[stepIdx];
              const stepBuf = new Uint8Array(SCENE_STEP_BYTES);
              stepBuf[0] = sceneId;
              stepBuf[1] = stripId;
              stepBuf[2] = partId;
              stepBuf[3] = stepIdx;
              if (step) {
                stepBuf[4] = step.durationMs & 0xff;
                stepBuf[5] = (step.durationMs >> 8) & 0xff;
                stepBuf.set(step.layer0, 6);
                stepBuf.set(step.layer1, 15);
              } else {
                stepBuf.set(ZERO_LAYER, 6);
                stepBuf.set(ZERO_LAYER, 15);
              }
              frames.push(encodeFrame(DEVICE_CMD.SCENE_STEP_REPORT, seq, stepBuf));
            }
          }
        }
        // SceneListEnd
        const endBuf = new Uint8Array(SCENE_NAME_BYTES);
        const nameBytes = new TextEncoder().encode(sceneName);
        endBuf[0] = sceneId;
        endBuf[1] = nameBytes.length;
        endBuf.set(nameBytes.subarray(0, NAME_BYTES), 2);
        frames.push(encodeFrame(DEVICE_CMD.SCENE_LIST_END, seq, endBuf));
      }
    }

    // slow 场景：延迟派发由 transport 层处理；这里返回 frames，transport 负责 setTimeout
    // 为简单，runtime 直接返回 frames；slow 延迟在 MockTransport.connect/sendFrame 里加
    return frames;
  }

  private deviceInfoBytes(): Uint8Array {
    const buf = new Uint8Array(DEVICE_INFO_BYTES);
    // 固件版本 0x0100 = v1.0（docs/protocol.md §8.5）。
    const version = 0x0100;
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