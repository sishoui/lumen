/**
 * ReconnectSupervisor：1s/2s/4s 有限退避（工单 #6 决策 6）。
 *
 * 退避是「会话语义」不是 BLE 细节：何时重连、耗尽后怎么办、旧结果怎么作废，
 * 全是业务决策。传输层只报告（onLinkChange），从不自行重连。
 *
 * 触发源唯一：非主动断线。主动断开、用户扫描、手动连接都清除回连意图。
 * 序列 = [1000, 2000, 4000]，序列长度即最大尝试次数；耗尽 → failed。
 */

import type { LinkState } from "../protocol/types";
import type { TimerApi } from "../ble/throttle";
import type { CachedDevice } from "./device-cache";

const DEFAULT_RECONNECT_DELAYS_MS = [1000, 2000, 4000];

/** 监督者需要宿主提供的连接能力与状态读写。 */
export interface ReconnectHost {
  linkState(): LinkState;
  cached(): CachedDevice | null;
  connect(deviceId: string, name?: string): Promise<unknown>;
  disconnect(): Promise<void>;
  refresh(): Promise<unknown>;
  clearDeviceState(): void;
  onConnected(state: unknown): void;
}

export class ReconnectSupervisor {
  private readonly host: ReconnectHost;
  private readonly timer: TimerApi;
  private readonly delaysMs: number[];

  private desired = false;
  private attempts = 0;
  private handle: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private exhausted = false;
  private manualConnecting = false;
  private suppressAutoReconnect = false;

  /** 连接代次：每次「连接身份」变化都 +1。 */
  private linkEpoch = 0;
  private lastLinkState: LinkState;

  constructor(
    host: ReconnectHost,
    opts: { timer: TimerApi; delaysMs?: number[]; initialLink: LinkState },
  ) {
    this.host = host;
    this.timer = opts.timer;
    this.delaysMs =
      opts.delaysMs !== undefined && opts.delaysMs.length > 0
        ? [...opts.delaysMs]
        : [...DEFAULT_RECONNECT_DELAYS_MS];
    this.lastLinkState = opts.initialLink;
  }

  get epoch(): number { return this.linkEpoch; }
  get pending(): boolean { return this.desired; }
  isStale(epoch: number): boolean { return epoch !== this.linkEpoch; }
  get isManualConnecting(): boolean { return this.manualConnecting; }

  /** 传输层 onLinkChange 进来：判断是否需要触发回连。 */
  onLinkChange(state: LinkState): void {
    const prev = this.lastLinkState;
    this.lastLinkState = state;

    if (state === "ready") {
      this.linkEpoch += 1;
      this.desired = false;
      this.attempts = 0;
      this.exhausted = false;
      this.suppressAutoReconnect = false;
      return;
    }

    if (state === "connecting") {
      return;
    }

    // 进入非 ready：ready → 非 ready 视为非主动断线（除非 suppressAutoReconnect）
    if (prev === "ready" && state !== "ready") {
      if (!this.suppressAutoReconnect) {
        this.desired = true;
        this.scheduleReconnect();
      }
    }
  }

  /** 主动断开：清除回连意图，进前台不再擅自回连。 */
  onManualDisconnect(): void {
    this.desired = false;
    this.suppressAutoReconnect = true;
    this.cancelTimer();
    this.linkEpoch += 1;
  }

  /** 手动连接 / 扫描开始：自动回连让路。 */
  onManualConnectStart(): void {
    this.manualConnecting = true;
    this.desired = false;
    this.cancelTimer();
  }

  onManualConnectEnd(): void {
    this.manualConnecting = false;
  }

  /** 前台 onShow：有缓存 deviceId 且未连接 → 静默回连。 */
  onShow(): void {
    if (this.exhausted) return;
    if (this.suppressAutoReconnect) return;
    const cached = this.host.cached();
    if (cached === null) return;
    const state = this.host.linkState();
    if (state === "ready" || state === "connecting" || state === "reconnecting") return;
    this.desired = true;
    this.scheduleReconnect();
  }

  /** 用户手动连接优先：取消自动回连。 */
  cancelAutoReconnect(): void {
    this.desired = false;
    this.cancelTimer();
  }

  private scheduleReconnect(): void {
    if (!this.desired || this.running) return;
    if (this.attempts >= this.delaysMs.length) {
      this.exhausted = true;
      this.desired = false;
      return;
    }
    const delay = this.delaysMs[this.attempts];
    this.attempts += 1;
    this.handle = this.timer.setTimeout(() => {
      this.handle = null;
      void this.runReconnect();
    }, delay);
  }

  private async runReconnect(): Promise<void> {
    if (!this.desired || this.running) return;
    if (this.manualConnecting) return;
    const cached = this.host.cached();
    if (cached === null) {
      this.desired = false;
      return;
    }
    this.running = true;
    try {
      const state = await this.host.connect(cached.deviceId, cached.broadcastName);
      this.host.onConnected(state);
    } catch {
      // 失败 → 下一档退避
    } finally {
      this.running = false;
    }
    if (this.desired && !this.exhausted) {
      this.scheduleReconnect();
    }
  }

  private cancelTimer(): void {
    if (this.handle !== null) {
      this.timer.clearTimeout(this.handle);
      this.handle = null;
    }
  }
}