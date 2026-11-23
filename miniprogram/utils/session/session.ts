/**
 * ControlSession：页面与传输层之间唯一的门面（工单 #6 决策 3）。
 *
 * 会话层零 mock 分支的三重保障：
 *   1. 构造注入：SessionOptions.transport 是 Transport 接口，会话层不知道具体实现；
 *   2. import 纪律：utils/session/** 不许 import utils/mock/**；
 *   3. boundary.test.ts 源码扫描：把约定变成可执行检查。
 *
 * 命令泵：一条 Promise 链，所有离散命令排进泵里，泵内每步等 ACK 再走下一步。
 * epoch：连接身份每次变化 +1；旧连接飞行命令的结果 → stale。
 * seq：每连接从 0x01 起递增；重试重用同一 seq。
 */

import type { Transport } from "../ble/transport";
import {
  parseLayoutReport, parseLayoutListEnd,
  parseScenePartReport, parseSceneStepReport, parseSceneListEnd, buildSceneReport,
} from "../protocol/commands";
import type { TimerApi } from "../ble/throttle";
import { LatestWinsThrottle } from "../ble/throttle";
import type { AdapterState, DeviceInfo, DeviceState, DiscoveredDevice, LayoutPart, LayoutReadback, LinkState, SceneReport, SceneStep, StripConfig } from "../protocol/types";
import type { AckResult } from "../protocol/types";
import {
  cmdSetPower, cmdSetBrightness, cmdSetLedCount, cmdSetStripPower, cmdActivateScene, cmdSelfTest,
  cmdLayoutWrite, cmdLayoutPart, cmdLayoutSeg, cmdLayoutCommit,
  cmdScenePart, cmdSceneStep, cmdSceneName,
} from "../protocol/commands";
import { encodeFrame } from "../protocol/frame";
import { DEVICE_CMD, CMD } from "../protocol/constants";
import { rebuildFromDevice } from "./rebuild";
import { queryMultiFrame } from "./query";
import { ReconnectSupervisor } from "./reconnect";
import type { SessionStorage, CachedDevice } from "./device-cache";
import { loadCachedDevice, saveCachedDevice, createWxStorage } from "./device-cache";

export type CommandResult =
  | { kind: "ok"; state: DeviceState }
  | { kind: "ack-error"; ack: AckResult }
  | { kind: "stale" }
  | { kind: "error"; message: string };

export type EditResult =
  | { kind: "ok"; state?: DeviceState | null }
  | { kind: "storage"; message: string }
  | { kind: "ack-error"; ack: AckResult }
  | { kind: "stale" }
  | { kind: "error"; message: string };

export type LayoutResult =
  | { kind: "ok"; layout: LayoutReadback }
  | { kind: "stale" }
  | { kind: "error"; message: string; layout?: LayoutReadback };

export type SceneResult =
  | { kind: "ok"; scene: SceneReport }
  | { kind: "stale" }
  | { kind: "error"; message: string; scene?: SceneReport };

export type StripConfigResult =
  | { kind: "ok"; config: StripConfig }
  | { kind: "stale" }
  | { kind: "error"; message: string };

export type DeviceInfoResult =
  | { kind: "ok"; info: DeviceInfo }
  | { kind: "stale" }
  | { kind: "error"; message: string };

export interface SessionOptions {
  transport: Transport;
  timer?: TimerApi;
  reconnectDelaysMs?: number[];
  ackTimeoutMs?: number;
  storage?: SessionStorage;
}

const defaultTimer: TimerApi = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle),
};

export class ControlSession {
  private readonly transport: Transport;
  private readonly timer: TimerApi;
  private readonly ackTimeoutMs: number;
  private readonly storage: SessionStorage;
  private readonly reconnect: ReconnectSupervisor;

  private _linkState: LinkState = "idle";
  private latestState: DeviceState | null = null;
  private latestDeviceInfo: DeviceInfo | null = null;
  private latestStripConfig: StripConfig | null = null;
  private latestLayout: Array<LayoutReadback | null> = Array.from({ length: 8 }, () => null);
  private latestScene: SceneReport | null = null;
  private pumpTail: Promise<void> = Promise.resolve();
  private brightnessThrottle: LatestWinsThrottle<number> | null = null;
  private seqCounter = 1;
  private epoch = 0;
  private destroyed = false;

  constructor(opts: SessionOptions) {
    this.transport = opts.transport;
    this.timer = opts.timer ?? defaultTimer;
    this.ackTimeoutMs = opts.ackTimeoutMs ?? 600;
    this.storage = opts.storage ?? createWxStorage();

    this.reconnect = new ReconnectSupervisor(
      {
        linkState: () => this._linkState,
        cached: () => this.cachedDevice(),
        connect: (id, name) => this.connect(id, name),
        disconnect: () => this.disconnect(),
        refresh: () => this.transport.readState(),
        clearDeviceState: () => this.clearDeviceState(),
        onConnected: (state) => this.handleConnected(state as DeviceState),
      },
      {
        timer: this.timer,
        delaysMs: opts.reconnectDelaysMs,
        initialLink: this.transport.linkState,
      },
    );

    // 亮度节流：仅一条通道
    this.brightnessThrottle = new LatestWinsThrottle<number>(
      (value) => { void this.sendBrightness(value); },
      { timer: this.timer },
    );

    // 订阅传输层事件
    this.transport.onLinkChange((state) => {
      this._linkState = state;
      this.reconnect.onLinkChange(state);
    });
  }

  get linkState(): LinkState { return this._linkState; }
  /** 当前传输层（只读，页面用来读 currentDeviceId / 挂监听）。 */
  get transportRef(): Transport { return this.transport; }
  get deviceState(): DeviceState | null { return this.latestState; }
  get deviceInfo(): DeviceInfo | null { return this.latestDeviceInfo; }
  get stripConfig(): StripConfig | null { return this.latestStripConfig; }
  get layout(): ReadonlyArray<LayoutReadback | null> { return this.latestLayout; }
  get scene(): SceneReport | null { return this.latestScene; }
  get epochValue(): number { return this.epoch; }

  private cachedDevice(): CachedDevice | null {
    return loadCachedDevice(this.storage);
  }

  private clearDeviceState(): void {
    this.latestState = null;
    this.latestDeviceInfo = null;
    this.latestStripConfig = null;
    this.latestLayout = Array.from({ length: 8 }, () => null);
    this.latestScene = null;
  }

  private nextSeq(): number {
    const s = this.seqCounter;
    this.seqCounter = (this.seqCounter + 1) & 0xff;
    if (this.seqCounter === 0) this.seqCounter = 1;
    return s;
  }

  /** 连接 + 初始化流水线 + 权威重建。 */
  async connect(deviceId: string, broadcastName?: string): Promise<DeviceState> {
    if (this.destroyed) throw new Error("session 已 destroy");
    this.reconnect.cancelAutoReconnect();
    this.reconnect.onManualConnectStart();
    try {
      const state = await this.transport.connect(deviceId, broadcastName);
      this.epoch += 1;
      this.handleConnected(state);
      // 权威重建（异步，不阻塞 connect 返回）
      void this.runRebuild(state);
      return state;
    } finally {
      this.reconnect.onManualConnectEnd();
    }
  }

  private handleConnected(state: DeviceState): void {
    this.latestState = state;
    this.epoch += 1;
    const cached = this.cachedDevice();
    const deviceId = this.transport.currentDeviceId;
    if (deviceId) {
      saveCachedDevice(this.storage, deviceId, cached?.broadcastName, this.latestDeviceInfo?.hwId);
    }
  }

  private async runRebuild(state: DeviceState): Promise<void> {
    try {
      const result = await rebuildFromDevice(this.transport, state, { ackTimeoutMs: this.ackTimeoutMs });
      if (this.reconnect.isStale(this.epoch - 1)) return;
      this.latestStripConfig = result.stripConfig;
      this.latestLayout = result.layout;
      this.latestScene = result.scene;
      this.latestDeviceInfo = result.deviceInfo;
      // 缓存 hwId
      if (result.deviceInfo && this.transport.currentDeviceId) {
        const cached = this.cachedDevice();
        saveCachedDevice(this.storage, this.transport.currentDeviceId, cached?.broadcastName, result.deviceInfo.hwId);
      }
    } catch {
      /* 重建失败不阻塞 connect */
    }
  }

  async disconnect(): Promise<void> {
    this.reconnect.onManualDisconnect();
    this.epoch += 1;
    this.brightnessThrottle?.cancel();
    await this.transport.disconnect();
    this.clearDeviceState();
  }

  onShow(): void {
    this.reconnect.onShow();
  }

  // ---------------- 命令泵 ----------------

  private enqueue<T>(fn: (epoch: number) => Promise<T>): Promise<T> {
    const epochAtEnqueue = this.epoch;
    const run = this.pumpTail.then(() => {
      if (this.destroyed) throw new Error("session 已 destroy");
      if (epochAtEnqueue !== this.epoch) {
        return { __stale: true } as T;
      }
      return fn(epochAtEnqueue);
    });
    this.pumpTail = run.then(() => undefined, () => undefined);
    return run;
  }

  private async sendFrameAndWaitAck(command: number, payload: Uint8Array, epochAtSend: number): Promise<AckResult> {
    const seq = this.nextSeq();
    const frame = encodeFrame(command, seq, payload);
    return new Promise<AckResult>((resolve, reject) => {
      let settled = false;
      const off = this.transport.onFrame((f) => {
        if (settled) return;
        if (f.length < 3) return;
        if (f[2] !== DEVICE_CMD.ACK) return;
        if (f.length < 8) return;
        const ackSeq = f[3];
        if (ackSeq !== seq) return;
        settled = true;
        clearTimeout(timer);
        off();
        // ACK payload: [原命令字, 结果码]，位于 offset 6..7
        const ackCmd = f[6];
        const ackResult = f[7];
        resolve({ seq: ackSeq, command: ackCmd, resultCode: ackResult, ok: ackResult === 0 });
      });
      const timer = this.timer.setTimeout(() => {
        if (settled) return;
        settled = true;
        off();
        reject(new Error(`ACK 超时 seq=${seq} cmd=${command}`));
      }, this.ackTimeoutMs);
      void this.transport.sendFrame(frame).catch((err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        off();
        reject(err instanceof Error ? err : new Error(String(err)));
      });
    });
  }

  private async runCommand(command: number, payload: Uint8Array): Promise<CommandResult> {
    const epochAtSend = this.epoch;
    try {
      const ack = await this.sendFrameAndWaitAck(command, payload, epochAtSend);
      if (epochAtSend !== this.epoch) return { kind: "stale" };
      if (ack.ok) {
        const state = await this.transport.readState().catch(() => this.latestState);
        if (state) this.latestState = state;
        return { kind: "ok", state: state ?? this.latestState! };
      }
      return { kind: "ack-error", ack };
    } catch (err) {
      if (epochAtSend !== this.epoch) return { kind: "stale" };
      return { kind: "error", message: err instanceof Error ? err.message : String(err) };
    }
  }

  setPower(on: boolean): Promise<CommandResult> {
    return this.enqueue(() => this.runCommand(CMD.SET_POWER, cmdSetPower(on).payload));
  }

  setLedCount(stripId: number, ledCount: number): Promise<CommandResult> {
    return this.enqueue(() => this.runCommand(CMD.SET_LED_COUNT, cmdSetLedCount(stripId, ledCount).payload));
  }

  setStripPower(stripId: number, on: boolean): Promise<CommandResult> {
    return this.enqueue(() => this.runCommand(CMD.SET_STRIP_POWER, cmdSetStripPower(stripId, on).payload));
  }

  activateScene(sceneId: number): Promise<CommandResult> {
    return this.enqueue(() => this.runCommand(CMD.ACTIVATE_SCENE, cmdActivateScene(sceneId).payload));
  }

  selfTest(): Promise<CommandResult> {
    return this.enqueue(() => this.runCommand(CMD.SELF_TEST, cmdSelfTest().payload));
  }

  // ---------------- 连续量（亮度）----------------

  setBrightness(value: number): void {
    const max = this.latestState?.maxBrightness ?? 200;
    const clamped = Math.max(0, Math.min(value, max));
    if (this.latestState) {
      this.latestState = { ...this.latestState, brightness: clamped };
    }
    this.brightnessThrottle?.push(clamped);
  }

  flushBrightness(): void {
    this.brightnessThrottle?.flush();
  }

  private async sendBrightness(value: number): Promise<void> {
    const epochAtSend = this.epoch;
    try {
      const ack = await this.sendFrameAndWaitAck(CMD.SET_BRIGHTNESS, cmdSetBrightness(value).payload, epochAtSend);
      // 连续量：ACK 超时只触发连接检查，永不重传
      if (!ack.ok && epochAtSend === this.epoch) {
        void this.transport.readState().catch(() => undefined);
      }
    } catch {
      // 超时只触发连接检查
      if (epochAtSend === this.epoch) {
        void this.transport.readState().catch(() => undefined);
      }
    }
  }

  // ---------------- 布局编辑 ----------------

  layoutCommit(parts: LayoutPart[]): Promise<EditResult> {
    return this.enqueue(async (epochAtSend) => {
      try {
        // 按 strip 分组
        const byStrip = new Map<number, LayoutPart[]>();
        for (const p of parts) {
          if (!byStrip.has(p.stripId)) byStrip.set(p.stripId, []);
          byStrip.get(p.stripId)!.push(p);
        }
        for (const [stripId, stripParts] of byStrip) {
          const w = await this.sendFrameAndWaitAck(CMD.LAYOUT_WRITE, cmdLayoutWrite(stripId, stripParts.length).payload, epochAtSend);
          if (!w.ok) return { kind: "ack-error", ack: w };
          for (const p of stripParts) {
            const partCmd = cmdLayoutPart(p.stripId, p.partId, p.name, p.segs.length, p.phase);
            const r = await this.sendFrameAndWaitAck(CMD.LAYOUT_PART, partCmd.payload, epochAtSend);
            if (!r.ok) return { kind: "ack-error", ack: r };
            for (let i = 0; i < p.segs.length; i += 1) {
              const segCmd = cmdLayoutSeg(p.stripId, p.partId, i, p.segs[i][0], p.segs[i][1]);
              const sr = await this.sendFrameAndWaitAck(CMD.LAYOUT_SEG, segCmd.payload, epochAtSend);
              if (!sr.ok) return { kind: "ack-error", ack: sr };
            }
          }
        }
        const commit = await this.sendFrameAndWaitAck(CMD.LAYOUT_COMMIT, cmdLayoutCommit().payload, epochAtSend);
        if (!commit.ok) return { kind: "ack-error", ack: commit };
        if (epochAtSend !== this.epoch) return { kind: "stale" };
        const state = await this.transport.readState().catch(() => this.latestState);
        return { kind: "ok", state };
      } catch (err) {
        return { kind: "error", message: err instanceof Error ? err.message : String(err) };
      }
    });
  }

  // ---------------- 场景编辑 ----------------

  scenePart(sceneId: number, stripId: number, partId: number, head: { stepCount: number; loop: number; on: boolean }): Promise<EditResult> {
    return this.enqueue(async (epochAtSend) => {
      try {
        const cmd = cmdScenePart(sceneId, stripId, partId, head.stepCount, head.loop, head.on);
        const r = await this.sendFrameAndWaitAck(CMD.SCENE_PART, cmd.payload, epochAtSend);
        if (epochAtSend !== this.epoch) return { kind: "stale" };
        if (r.ok) return { kind: "ok" };
        return { kind: "ack-error", ack: r };
      } catch (err) {
        return { kind: "error", message: err instanceof Error ? err.message : String(err) };
      }
    });
  }

  sceneStep(sceneId: number, stripId: number, partId: number, stepIndex: number, step: SceneStep): Promise<EditResult> {
    return this.enqueue(async (epochAtSend) => {
      try {
        const cmd = cmdSceneStep({ ...step, sceneId, stripId, partId, stepIndex });
        const r = await this.sendFrameAndWaitAck(CMD.SCENE_STEP, cmd.payload, epochAtSend);
        if (epochAtSend !== this.epoch) return { kind: "stale" };
        if (r.ok) return { kind: "ok" };
        return { kind: "ack-error", ack: r };
      } catch (err) {
        return { kind: "error", message: err instanceof Error ? err.message : String(err) };
      }
    });
  }

  sceneName(sceneId: number, name: string): Promise<EditResult> {
    return this.enqueue(async (epochAtSend) => {
      try {
        const cmd = cmdSceneName(sceneId, name);
        const r = await this.sendFrameAndWaitAck(CMD.SCENE_NAME, cmd.payload, epochAtSend);
        if (epochAtSend !== this.epoch) return { kind: "stale" };
        if (r.ok) return { kind: "ok" };
        return { kind: "ack-error", ack: r };
      } catch (err) {
        return { kind: "error", message: err instanceof Error ? err.message : String(err) };
      }
    });
  }

  // ---------------- 查询 ----------------

  queryStripConfig(): Promise<StripConfigResult> {
    return this.enqueue(async () => {
      try {
        const res = await rebuildFromDevice(this.transport, this.latestState!, { ackTimeoutMs: this.ackTimeoutMs });
        if (res.stripConfig) {
          this.latestStripConfig = res.stripConfig;
          return { kind: "ok", config: res.stripConfig };
        }
        return { kind: "error", message: "QueryStripConfig 失败" };
      } catch (err) {
        return { kind: "error", message: err instanceof Error ? err.message : String(err) };
      }
    });
  }

  queryLayout(stripId: number): Promise<LayoutResult> {
    return this.enqueue(async (epochAtSend) => {
      try {
        // 每次都从设备重新查询（不读缓存），保证编辑器读到最新数据
        const result = await this.runLayoutQuery(stripId);
        if (epochAtSend !== this.epoch) return { kind: "stale" };
        this.latestLayout[stripId] = result;
        return { kind: "ok", layout: result };
      } catch (err) {
        return { kind: "error", message: err instanceof Error ? err.message : String(err) };
      }
    });
  }

  private async runLayoutQuery(stripId: number): Promise<LayoutReadback> {
    const res = await queryMultiFrame(
      this.transport,
      CMD.QUERY_LAYOUT,
      new Uint8Array([stripId]),
      this.nextSeq(),
      DEVICE_CMD.LAYOUT_LIST_END,
      { timeoutMs: this.ackTimeoutMs, timer: this.timer },
    );
    if (!res.ok) throw new Error(res.message);
    const parts = res.body
      .filter((f) => f.command === DEVICE_CMD.LAYOUT_REPORT)
      .map((f) => parseLayoutReport(f.payload));
    const end = parseLayoutListEnd(res.tail.payload);
    return { stripId, parts, partMask: end.partMask };
  }

  queryScene(sceneId: number): Promise<SceneResult> {
    return this.enqueue(async (epochAtSend) => {
      try {
        // 每次都从设备重新查询（不读缓存），保证编辑器读到最新数据
        const result = await this.runSceneQuery(sceneId);
        if (epochAtSend !== this.epoch) return { kind: "stale" };
        this.latestScene = result;
        return { kind: "ok", scene: result };
      } catch (err) {
        return { kind: "error", message: err instanceof Error ? err.message : String(err) };
      }
    });
  }

  private async runSceneQuery(sceneId: number): Promise<SceneReport> {
    const res = await queryMultiFrame(
      this.transport,
      CMD.QUERY_SCENE,
      new Uint8Array([sceneId]),
      this.nextSeq(),
      DEVICE_CMD.SCENE_LIST_END,
      { timeoutMs: this.ackTimeoutMs, timer: this.timer },
    );
    if (!res.ok) throw new Error(res.message);
    const parts = res.body
      .filter((f) => f.command === DEVICE_CMD.SCENE_PART_REPORT)
      .map((f) => parseScenePartReport(f.payload));
    const steps = res.body
      .filter((f) => f.command === DEVICE_CMD.SCENE_STEP_REPORT)
      .map((f) => parseSceneStepReport(f.payload));
    const end = parseSceneListEnd(res.tail.payload);
    return buildSceneReport(sceneId, end.name, parts, steps);
  }

  queryDeviceInfo(): Promise<DeviceInfoResult> {
    return this.enqueue(async () => {
      const cached = this.latestDeviceInfo;
      if (cached) return { kind: "ok", info: cached };
      return { kind: "error", message: "QueryDeviceInfo 未缓存" };
    });
  }

  // ---------------- 扫描（委托传输层，页面零分支）----------------

  startScan(onDevice: (device: DiscoveredDevice) => void): Promise<void> {
    this.reconnect.cancelAutoReconnect();
    return this.transport.startScan(onDevice);
  }

  stopScan(): void {
    this.transport.stopScan();
  }

  destroy(): void {
    this.destroyed = true;
    this.brightnessThrottle?.cancel();
    this.clearDeviceState();
  }
}