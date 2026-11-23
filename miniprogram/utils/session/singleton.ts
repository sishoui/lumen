/**
 * App 级会话单例（工单 #6 决策 8）。
 *
 * 小程序只有一条 BLE 连接，切 tab 不能断链。会话里放着链路状态机、seq 分配、
 * ACK 等待、State 镜像——任何一次「页面卸载就 destroy」都会把连接、回连意图
 * 和这些缓存一起丢掉。
 *
 * 纪律：页面永远不调用 session.destroy()；页面在 onShow 订阅、onHide 退订；
 * 读取一律走 getSession()，不要自己 new ControlSession。
 *
 * singleton 是 app.ts 的依赖注入点，允许 import mock（构造注入）。
 * 这是唯一例外；其他 session/ 文件不许 import mock。
 */

import { ControlSession, type SessionOptions } from "./session";
import { mockModeEnabled, createWxStorage } from "../mock/mock-mode";
import { MockTransport } from "../ble/mock-transport";
import { DefaultWxApi } from "../ble/wx-api";
import { BleTransport } from "../ble/ble-transport";

let session: ControlSession | null = null;
let mockMode: boolean | null = null;

function buildSession(): ControlSession {
  const storage = createWxStorage();
  mockMode = mockModeEnabled(storage);
  const transport = mockMode
    ? new MockTransport({ scenario: "normal" })
    : new BleTransport({ wxApi: new DefaultWxApi() });
  return new ControlSession({ transport, storage });
}

export function getSession(): ControlSession {
  if (session !== null) return session;
  session = buildSession();
  return session;
}

/**
 * 演示模式开关拨动后调用：按当前 storage 偏好重建会话。
 *
 * 「重启生效」曾经是这个开关的契约，用户报「打开演示模式后扫不出设备」——
 * 开关只写了 storage，transport 却还是旧的。重建让开关即时生效：
 * 旧会话 destroy（订阅与定时器一并回收），新会话按新偏好构造。
 *
 * @returns 是否真的重建了（mock 模式没变时 false，调用方可跳过清列表）。
 */
export function rebuildSessionForCurrentMockMode(): boolean {
  const next = mockModeEnabled(createWxStorage());
  if (next === mockMode && session !== null) return false;
  const prev = session;
  session = buildSession();
  if (prev !== null) prev.destroy();
  return true;
}

export function setSession(next: ControlSession): void {
  if (session !== null && session !== next) {
    session.destroy();
  }
  session = next;
}

export function isMockSession(): boolean {
  return mockMode === true;
}

/** 仅供测试：重置单例。 */
export function resetSession(): void {
  if (session !== null) {
    session.destroy();
    session = null;
  }
  mockMode = null;
}

export type { SessionOptions };