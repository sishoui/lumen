/**
 * 报告查询原语（#20/#21）：发一条查询命令，收集同一 seq 的报告帧，直到收尾帧。
 *
 * 返回值把「收尾帧」单独交出来。调用方不再从中间帧数组里 find 收尾帧
 * （旧实现把收尾帧吞掉，场景名与 partMask 永远读不到）。
 *
 * 两段超时：
 *   - ACK 等待 600ms（单帧命令的常规节奏）；
 *   - ACK 之后等待报告 5000ms（8 部位 × 8 步的报告可能持续数秒）。
 *
 * 帧校验复用协议层的 decodeFrame：magic / version / 长度 / CRC 任何一项不合法
 * 的帧整帧忽略；seq 不匹配的帧（交错的其它查询报告）也不属于本次查询。
 */

import type { Transport } from "../ble/transport";
import type { TimerApi } from "../ble/throttle";
import { decodeFrame, encodeFrame } from "../protocol/frame";
import { ACK_TIMEOUT_MS, DEVICE_CMD, REPORT_TIMEOUT_MS, commandName } from "../protocol/constants";

/** 一条已解码、已过滤的报告帧。 */
export interface ReportFrame {
  command: number;
  seq: number;
  payload: Uint8Array;
}

export type QueryFailureReason =
  | "ack-timeout"
  | "report-timeout"
  | "ack-error"
  | "send-error";

export type QueryResult =
  | { ok: true; body: ReportFrame[]; tail: ReportFrame }
  | { ok: false; reason: QueryFailureReason; message: string };

export interface QueryOptions {
  /** 等待 ACK 的上限（ms），默认 600。 */
  ackTimeoutMs?: number;
  /** ACK 之后等待收尾帧的上限（ms），默认 5000。 */
  reportTimeoutMs?: number;
  timer?: TimerApi;
}

const defaultTimer: TimerApi = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle),
};

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
  const ackTimeoutMs = opts.ackTimeoutMs ?? ACK_TIMEOUT_MS;
  const reportTimeoutMs = opts.reportTimeoutMs ?? REPORT_TIMEOUT_MS;
  const timer = opts.timer ?? defaultTimer;
  const requestName = commandName(cmd);
  const tailName = commandName(tailCommand);

  return new Promise<QueryResult>((resolve) => {
    const body: ReportFrame[] = [];
    let phase: "ack" | "report" = "ack";
    let settled = false;
    let handle: ReturnType<typeof setTimeout> | null = null;

    const finish = (result: QueryResult): void => {
      if (settled) return;
      settled = true;
      if (handle !== null) timer.clearTimeout(handle);
      off();
      resolve(result);
    };

    const armReportTimeout = (): void => {
      if (handle !== null) timer.clearTimeout(handle);
      handle = timer.setTimeout(() => {
        finish({
          ok: false,
          reason: "report-timeout",
          message: `${requestName} 报告超时：${reportTimeoutMs}ms 内未收到 ${tailName}（seq=${seq}）`,
        });
      }, reportTimeoutMs);
    };

    const ackTimeout = (): void => {
      finish({
        ok: false,
        reason: "ack-timeout",
        message: `${requestName} ACK 超时：${ackTimeoutMs}ms 内未收到 ACK（seq=${seq}）`,
      });
    };

    const off = transport.onFrame((frame) => {
      if (settled) return;
      const decoded = decodeFrame(frame);
      if (!decoded.ok) return;
      if (decoded.seq !== seq) return;
      if (decoded.command === DEVICE_CMD.EVENT) return;

      if (decoded.command === DEVICE_CMD.ACK) {
        if (decoded.payload.length < 2) return;
        if (decoded.payload[0] !== cmd) return;
        const resultCode = decoded.payload[1];
        if (resultCode !== 0) {
          finish({
            ok: false,
            reason: "ack-error",
            message: `${requestName} 被设备拒绝：结果码 0x${resultCode.toString(16).padStart(2, "0")}（seq=${seq}）`,
          });
          return;
        }
        if (phase === "ack") {
          phase = "report";
          armReportTimeout();
        }
        return;
      }

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

    handle = timer.setTimeout(ackTimeout, ackTimeoutMs);

    void transport.sendFrame(encodeFrame(cmd, seq, payload)).catch((err) => {
      finish({
        ok: false,
        reason: "send-error",
        message: `${requestName} 发送失败：${err instanceof Error ? err.message : String(err)}`,
      });
    });
  });
}
