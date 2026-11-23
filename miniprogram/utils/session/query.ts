/**
 * 报告查询原语（#20）：发一条查询命令，收集同一 seq 的报告帧，直到收尾帧。
 *
 * 返回值把「收尾帧」单独交出来。调用方不再从中间帧数组里 find 收尾帧
 * （旧实现把收尾帧吞掉，场景名与 partMask 永远读不到）。
 *
 * 帧校验复用协议层的 decodeFrame：magic / version / 长度 / CRC 任何一项不合法
 * 的帧整帧忽略；seq 不匹配的帧也不属于本次查询。
 */

import type { Transport } from "../ble/transport";
import type { TimerApi } from "../ble/throttle";
import { decodeFrame, encodeFrame } from "../protocol/frame";
import { DEVICE_CMD, commandName } from "../protocol/constants";

/** 一条已解码、已过滤的报告帧。 */
export interface ReportFrame {
  command: number;
  seq: number;
  payload: Uint8Array;
}

export type QueryResult =
  | { ok: true; body: ReportFrame[]; tail: ReportFrame }
  | { ok: false; message: string };

export interface QueryOptions {
  /** 等待收尾帧的上限（ms）。 */
  timeoutMs?: number;
  timer?: TimerApi;
}

const defaultTimer: TimerApi = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle),
};

const DEFAULT_QUERY_TIMEOUT_MS = 5000;

/**
 * 多帧查询：正文帧按到达顺序返回；收尾帧单独返回，不在正文里。
 */
export function queryMultiFrame(
  transport: Transport,
  cmd: number,
  payload: Uint8Array,
  seq: number,
  endCommand: number,
  opts: QueryOptions = {},
): Promise<QueryResult> {
  return runQuery(transport, cmd, payload, seq, endCommand, opts);
}

/**
 * 单帧查询：唯一的报告帧就是收尾帧；正文恒为空。
 */
export function querySingle(
  transport: Transport,
  cmd: number,
  payload: Uint8Array,
  seq: number,
  reportCommand: number,
  opts: QueryOptions = {},
): Promise<QueryResult> {
  return runQuery(transport, cmd, payload, seq, reportCommand, opts);
}

function runQuery(
  transport: Transport,
  cmd: number,
  payload: Uint8Array,
  seq: number,
  tailCommand: number,
  opts: QueryOptions,
): Promise<QueryResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_QUERY_TIMEOUT_MS;
  const timer = opts.timer ?? defaultTimer;
  const requestName = commandName(cmd);
  const tailName = commandName(tailCommand);

  return new Promise<QueryResult>((resolve) => {
    const body: ReportFrame[] = [];
    let settled = false;
    let handle: ReturnType<typeof setTimeout> | null = null;

    const finish = (result: QueryResult): void => {
      if (settled) return;
      settled = true;
      if (handle !== null) timer.clearTimeout(handle);
      off();
      resolve(result);
    };

    const off = transport.onFrame((frame) => {
      if (settled) return;
      const decoded = decodeFrame(frame);
      if (!decoded.ok) return;
      if (decoded.seq !== seq) return;
      if (decoded.command === DEVICE_CMD.ACK || decoded.command === DEVICE_CMD.EVENT) return;

      const report: ReportFrame = {
        command: decoded.command,
        seq: decoded.seq,
        payload: decoded.payload,
      };
      if (report.command === tailCommand) {
        finish({ ok: true, body, tail: report });
        return;
      }
      body.push(report);
    });

    handle = timer.setTimeout(() => {
      finish({
        ok: false,
        message: `${requestName} 超时：${timeoutMs}ms 内未收到 ${tailName}（seq=${seq}）`,
      });
    }, timeoutMs);

    void transport.sendFrame(encodeFrame(cmd, seq, payload)).catch((err) => {
      finish({
        ok: false,
        message: `${requestName} 发送失败：${err instanceof Error ? err.message : String(err)}`,
      });
    });
  });
}
