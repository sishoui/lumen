/**
 * 测试用可控 Transport：按脚本回复帧，不经过 MockDeviceRuntime。
 * 用来精确控制帧的顺序、seq、CRC 与到达时间（#20/#21 的可靠性测试）。
 */

import { decodeFrame, encodeFrame } from "../../utils/protocol/frame";
import { cmdSceneName } from "../../utils/protocol/commands";
import { CMD, DEVICE_CMD } from "../../utils/protocol/constants";
import type { Transport } from "../../utils/ble/transport";
import type { AdapterState, DeviceState, DiscoveredDevice, LinkState } from "../../utils/protocol/types";

export interface SentRequest {
  command: number;
  seq: number;
  payload: Uint8Array;
}

export type RequestResponder = (request: SentRequest, emit: (frame: Uint8Array) => void) => void;

export function ackFrame(request: SentRequest, resultCode = 0): Uint8Array {
  return encodeFrame(DEVICE_CMD.ACK, request.seq, new Uint8Array([request.command, resultCode]));
}

export class ScriptedTransport implements Transport {
  readonly sent: SentRequest[] = [];
  private frameListeners: Array<(frame: Uint8Array) => void> = [];
  private linkListeners: Array<(state: LinkState) => void> = [];
  private adapterListeners: Array<(state: AdapterState) => void> = [];
  private _linkState: LinkState = "idle";
  private _currentDeviceId: string | null = null;

  constructor(
    private readonly state: DeviceState,
    private readonly respond: RequestResponder = () => undefined,
  ) {}

  get linkState(): LinkState { return this._linkState; }
  get currentDeviceId(): string | null { return this._currentDeviceId; }
  get chunkCapacity(): number { return 179; }

  async connect(deviceId: string): Promise<DeviceState> {
    this._currentDeviceId = deviceId;
    this._linkState = "ready";
    for (const fn of this.linkListeners.slice()) fn("ready");
    return this.state;
  }

  async disconnect(): Promise<void> {
    this._currentDeviceId = null;
    this._linkState = "idle";
    for (const fn of this.linkListeners.slice()) fn("idle");
  }

  async sendFrame(frame: Uint8Array): Promise<void> {
    const decoded = decodeFrame(frame);
    if (!decoded.ok) throw new Error(`测试 transport 收到非法帧：${decoded.reason}`);
    const request: SentRequest = { command: decoded.command, seq: decoded.seq, payload: decoded.payload };
    this.sent.push(request);
    this.respond(request, (out) => this.emit(out));
  }

  async readState(): Promise<DeviceState> {
    return this.state;
  }

  async startScan(onDevice: (device: DiscoveredDevice) => void): Promise<void> {
    onDevice({ deviceId: "scripted", name: "LUMEN-TEST", rssi: -40 });
  }

  stopScan(): void {}

  onFrame(listener: (frame: Uint8Array) => void): () => void {
    this.frameListeners.push(listener);
    return () => {
      const i = this.frameListeners.indexOf(listener);
      if (i >= 0) this.frameListeners.splice(i, 1);
    };
  }

  onLinkChange(listener: (state: LinkState) => void): () => void {
    this.linkListeners.push(listener);
    return () => {
      const i = this.linkListeners.indexOf(listener);
      if (i >= 0) this.linkListeners.splice(i, 1);
    };
  }

  onAdapterState(listener: (state: AdapterState) => void): () => void {
    this.adapterListeners.push(listener);
    return () => {
      const i = this.adapterListeners.indexOf(listener);
      if (i >= 0) this.adapterListeners.splice(i, 1);
    };
  }

  destroy(): void {
    this.frameListeners.length = 0;
    this.linkListeners.length = 0;
    this.adapterListeners.length = 0;
  }

  emit(frame: Uint8Array): void {
    for (const fn of this.frameListeners.slice()) fn(frame);
  }

  /** 模拟链路状态变化（非主动断线 → 会话回连）。 */
  emitLink(state: LinkState): void {
    this._linkState = state;
    for (const fn of this.linkListeners.slice()) fn(state);
  }
}

/** 一份全零 partCounts 的 State，用于让重建跳过逐链布局查询。 */
export function idleState(overrides: Partial<DeviceState> = {}): DeviceState {
  return {
    power: 1,
    brightness: 100,
    maxBrightness: 200,
    stripCount: 1,
    stripPowerMask: 1,
    activeScene: 0,
    layoutValid: true,
    stripLedCounts: [60, 0, 0, 0, 0, 0, 0, 0],
    partCounts: [0, 0, 0, 0, 0, 0, 0, 0],
    ...overrides,
  };
}

/**
 * 重建期间的固定回复；第 2 次及以后的 QueryScene 交给页面查询脚本。
 * 覆盖 QueryStripConfig / QueryScene / QueryDeviceInfo 三条重建命令。
 */
export function makeRebuildResponder(
  pageQuery: RequestResponder,
): RequestResponder {
  let sceneQueries = 0;
  return (request, emit) => {
    if (request.command === CMD.QUERY_STRIP_CONFIG) {
      emit(ackFrame(request));
      emit(encodeFrame(DEVICE_CMD.STRIP_CONFIG_REPORT, request.seq, new Uint8Array(24)));
      return;
    }
    if (request.command === CMD.QUERY_DEVICE_INFO) {
      emit(ackFrame(request));
      emit(encodeFrame(DEVICE_CMD.DEVICE_INFO_REPORT, request.seq, new Uint8Array(15)));
      return;
    }
    if (request.command === CMD.QUERY_SCENE) {
      sceneQueries += 1;
      if (sceneQueries === 1) {
        emit(ackFrame(request));
        emit(encodeFrame(DEVICE_CMD.SCENE_LIST_END, request.seq, cmdSceneName(0, "重建场景").payload));
        return;
      }
      pageQuery(request, emit);
    }
  };
}
