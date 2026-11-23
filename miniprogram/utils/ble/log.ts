/**
 * 帧日志：200 帧环形缓冲（工单 #6 决策 1 / spec §3.3）。
 * 这是隐藏日志面板的数据源，也可在开发版镜像到 console。
 */

import { commandName } from "../protocol/constants";

export type FrameDirection = "tx" | "rx";

export interface FrameLogEntry {
  id: number;
  ts: number;
  dir: FrameDirection;
  hex: string;
  command?: number;
  commandName?: string;
  seq?: number;
  parsed: string;
  ok?: boolean;
}

export interface FrameLogOptions {
  capacity?: number;
  mirrorToConsole?: boolean;
}

const DEFAULT_CAPACITY = 200;

export class FrameLog {
  readonly capacity: number;
  private readonly mirrorToConsole: boolean;
  private readonly entries: FrameLogEntry[] = [];
  private readonly listeners: Array<(entry: FrameLogEntry) => void> = [];
  private nextId = 1;

  constructor(opts: FrameLogOptions = {}) {
    this.capacity = opts.capacity ?? DEFAULT_CAPACITY;
    this.mirrorToConsole = opts.mirrorToConsole ?? false;
  }

  push(entry: Omit<FrameLogEntry, "id">): FrameLogEntry {
    const full: FrameLogEntry = {
      ...entry,
      // commandName 在入口补全：面板、复制、测试读到的是同一份，不靠展示层回填。
      commandName: entry.commandName ?? (entry.command !== undefined ? commandName(entry.command) : undefined),
      id: this.nextId,
    };
    this.nextId += 1;
    this.entries.push(full);
    if (this.entries.length > this.capacity) {
      this.entries.splice(0, this.entries.length - this.capacity);
    }

    if (this.mirrorToConsole) {
      const name = full.commandName ?? "";
      console.log(
        `[bt-light] ${full.dir.toUpperCase()} seq=${full.seq ?? "-"} cmd=${name} ${full.parsed} ${full.hex}`,
      );
    }

    for (const fn of this.listeners.slice()) {
      try {
        fn(full);
      } catch {
        /* 监听者异常不能影响协议 */
      }
    }
    return full;
  }

  snapshot(): FrameLogEntry[] {
    return this.entries.slice();
  }

  clear(): void {
    this.entries.length = 0;
  }

  onAppend(fn: (entry: FrameLogEntry) => void): () => void {
    this.listeners.push(fn);
    return () => {
      const index = this.listeners.indexOf(fn);
      if (index >= 0) this.listeners.splice(index, 1);
    };
  }

  /** 环形缓冲是否已满（测试用）。 */
  get full(): boolean {
    return this.entries.length >= this.capacity;
  }
}