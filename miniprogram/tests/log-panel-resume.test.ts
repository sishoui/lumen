/**
 * 日志面板组件行为（#32 回归）：暂停 / 恢复 / 重复订阅。
 *
 * 通过 vi.resetModules + Component 桩重新加载 log-panel.ts，用 setSession
 * 注入可控会话（必须在 resetModules 之后动态 import singleton，让组件和测试
 * 共享同一个模块图），断言用户可观察的行为：暂停期间 entries 冻结、恢复后
 * 立即刷新看到新条目、多次 bind 不叠加订阅（恢复一次只刷新一次）。
 *
 * log-panel.ts 没有 export，import 仅为触发 Component() 注册；每个用例前
 * resetModules 让模块重新执行，Component 桩重新捕获新实例。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { FrameLog } from "../utils/ble/log";
import { CMD } from "../utils/protocol/constants";
import { ControlSession } from "../utils/session/session";
import { ScriptedTransport, idleState } from "./helpers/scripted-transport";
import { createMemoryStorage } from "./helpers/storage";

interface CapturedComponent {
  data: Record<string, unknown>;
  setData(patch: Record<string, unknown>): void;
  [key: string]: unknown;
}

let captured: CapturedComponent[] = [];

function installComponentStub() {
  const prev = (globalThis as any).Component;
  (globalThis as any).Component = (def: any) => {
    const instance: CapturedComponent = {
      data: JSON.parse(JSON.stringify(def.data ?? {})),
      setData(patch: Record<string, unknown>) {
        Object.assign(instance.data, patch);
      },
    };
    for (const [name, fn] of Object.entries(def.methods ?? {})) {
      (instance as any)[name] = (fn as Function).bind(instance);
    }
    if (typeof def.lifetimes?.attached === "function") {
      (def.lifetimes.attached as Function).call(instance);
    }
    captured.push(instance);
  };
  return {
    restore() {
      if (prev === undefined) delete (globalThis as any).Component;
      else (globalThis as any).Component = prev;
    },
  };
}

function installWxStub() {
  const prev = (globalThis as any).wx;
  (globalThis as any).wx = {
    setClipboardData: () => {},
    getStorageSync: () => "",
    setStorageSync: () => {},
    removeStorageSync: () => {},
  };
  return {
    restore() {
      if (prev === undefined) delete (globalThis as any).wx;
      else (globalThis as any).wx = prev;
    },
  };
}

/**
 * 在 resetModules 之后：动态 import singleton（与组件共享同一模块图），
 * 构造会话并 setSession。返回 FrameLog。
 */
async function injectSessionViaDynamicImport(): Promise<{ log: FrameLog }> {
  const { setSession, resetSession } = await import("../utils/session/singleton");
  resetSession();
  const transport = new ScriptedTransport(idleState());
  const session = new ControlSession({ transport, storage: createMemoryStorage() });
  await session.connect("scripted", "LUMEN-TEST");
  setSession(session);
  return { log: transport.logSource };
}

function entriesOf(instance: CapturedComponent): any[] {
  return (instance.data.entries as any[]) ?? [];
}

beforeEach(() => {
  vi.resetModules();
  captured = [];
});

afterEach(async () => {
  const { resetSession } = await import("../utils/session/singleton");
  resetSession();
});

describe("log-panel 组件：暂停 / 恢复 / 重复订阅", () => {
  it("暂停期间 append 不刷新；恢复后立即刷新看到暂停期间新增条目", async () => {
    const { log } = await injectSessionViaDynamicImport();
    const wxStub = installWxStub();
    const compStub = installComponentStub();
    try {
      await import("../components/log-panel/log-panel");
      const instance = captured[captured.length - 1];
      expect(instance, "Component 桩应捕获到 log-panel 实例").not.toBeUndefined();

      expect(entriesOf(instance)).toHaveLength(0);

      log.push({ ts: 1, dir: "tx", command: CMD.SET_POWER, seq: 1, hex: "AA", parsed: "p", ok: true });
      log.push({ ts: 2, dir: "rx", command: CMD.ACK, seq: 1, hex: "BB", parsed: "p", ok: true });
      expect(entriesOf(instance)).toHaveLength(2);

      (instance as any).onPause();
      expect(instance.data.paused).toBe(true);
      const duringBefore = entriesOf(instance).length;

      log.push({ ts: 3, dir: "tx", command: CMD.SET_POWER, seq: 2, hex: "CC", parsed: "p", ok: true });
      log.push({ ts: 4, dir: "rx", command: CMD.ACK, seq: 2, hex: "DD", parsed: "p", ok: true });
      expect(entriesOf(instance)).toHaveLength(duringBefore);
      expect(log.snapshot()).toHaveLength(4);

      (instance as any).onPause();
      expect(instance.data.paused).toBe(false);
      expect(entriesOf(instance)).toHaveLength(4);
    } finally {
      compStub.restore();
      wxStub.restore();
    }
  });

  it("仍在暂停时（paused 已是 true 再调不应刷新）", async () => {
    const { log } = await injectSessionViaDynamicImport();
    const wxStub = installWxStub();
    const compStub = installComponentStub();
    try {
      await import("../components/log-panel/log-panel");
      const instance = captured[captured.length - 1];
      expect(instance).not.toBeUndefined();

      log.push({ ts: 1, dir: "tx", command: CMD.SET_POWER, seq: 1, hex: "AA", parsed: "p", ok: true });
      expect(entriesOf(instance)).toHaveLength(1);

      (instance as any).onPause();
      expect(instance.data.paused).toBe(true);
      expect(entriesOf(instance)).toHaveLength(1);

      log.push({ ts: 2, dir: "tx", command: CMD.SET_POWER, seq: 2, hex: "BB", parsed: "p", ok: true });
      expect(entriesOf(instance)).toHaveLength(1);
    } finally {
      compStub.restore();
      wxStub.restore();
    }
  });

  it("多次 bindLog 不叠加订阅：恢复后 entries 等于 snapshot 长度（不重复）", async () => {
    const { log } = await injectSessionViaDynamicImport();
    const wxStub = installWxStub();
    const compStub = installComponentStub();
    try {
      await import("../components/log-panel/log-panel");
      const instance = captured[captured.length - 1];
      expect(instance).not.toBeUndefined();

      (instance as any).bindLog();
      (instance as any).bindLog();

      log.push({ ts: 1, dir: "tx", command: CMD.SET_POWER, seq: 1, hex: "AA", parsed: "p", ok: true });
      expect(entriesOf(instance)).toHaveLength(1);

      (instance as any).onPause();
      log.push({ ts: 2, dir: "tx", command: CMD.SET_POWER, seq: 2, hex: "BB", parsed: "p", ok: true });
      log.push({ ts: 3, dir: "tx", command: CMD.SET_POWER, seq: 3, hex: "CC", parsed: "p", ok: true });
      expect(entriesOf(instance)).toHaveLength(1);

      (instance as any).onPause();
      expect(entriesOf(instance)).toHaveLength(3);
    } finally {
      compStub.restore();
      wxStub.restore();
    }
  });
});