/**
 * 写入串行化：FIFO + 单飞（工单 #6 决策 5）。
 *
 * 小程序官方明确并行写会失败；这里保证任意时刻最多一个 sendOne 在飞，
 * 队列按入队顺序逐条发送。断线时 reset() 会 reject 所有等待者（含正在
 * 在飞的那一帧），避免队列永久卡死。revive() 在连接重建后解除失败态。
 */

interface QueueItem {
  bytes: Uint8Array;
  resolve: () => void;
  reject: (err: Error) => void;
  settled: boolean;
}

export class SerialWriter {
  private readonly sendOne: (bytes: Uint8Array) => Promise<void>;
  private readonly queue: QueueItem[] = [];
  private current: QueueItem | null = null;
  private failure: Error | null = null;

  constructor(sendOne: (bytes: Uint8Array) => Promise<void>) {
    this.sendOne = sendOne;
  }

  enqueue(bytes: Uint8Array): Promise<void> {
    if (this.failure !== null) {
      return Promise.reject(this.failure);
    }
    return new Promise<void>((resolve, reject) => {
      this.queue.push({ bytes, resolve, reject, settled: false });
      this.pump();
    });
  }

  /** 断线时调用：reject 队列与在飞帧，之后的入队立即失败。 */
  reset(reason: Error): void {
    this.failure = reason;
    const pending = this.queue.splice(0, this.queue.length);
    if (this.current !== null && !this.current.settled) {
      this.current.settled = true;
      this.current.reject(reason);
    }
    for (const item of pending) {
      if (!item.settled) {
        item.settled = true;
        item.reject(reason);
      }
    }
  }

  /** 连接重建后解除失败状态，允许继续入队。 */
  revive(): void {
    this.failure = null;
  }

  get busy(): boolean {
    return this.current !== null || this.queue.length > 0;
  }

  private pump(): void {
    if (this.current !== null || this.failure !== null) {
      return;
    }
    const item = this.queue.shift();
    if (item === undefined) {
      return;
    }
    this.current = item;
    this.sendOne(item.bytes).then(
      () => this.finish(item, null),
      (err) => this.finish(item, err instanceof Error ? err : new Error(String(err))),
    );
  }

  private finish(item: QueueItem, err: Error | null): void {
    if (this.current === item) {
      this.current = null;
    }
    if (!item.settled) {
      item.settled = true;
      if (err === null) {
        item.resolve();
      } else {
        item.reject(err);
      }
    }
    this.pump();
  }
}