/**
 * 日志面板组件行为（#32 回归）：暂停 / 恢复 / 重复订阅 / 会话重建后改绑。
 *
 * 通过 vi.resetModules + Component 桩重新加载 log-panel.ts，用 setSession
 * 注入可控会话（必须在 resetModules 之后动态 import singleton，让组件和测试
 * 共享同一个模块图），断言用户可观察的行为：暂停期间 entries 冻结、恢复后
 * 立即刷新看到新条目、多次 bind 不叠加订阅（恢复一次只刷新一次）、会话重建
 * 后面板改看新会话（旧会话的帧不再刷新面板）。
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
  /** 面板重绘次数：每次 entries 落到视图都记一次。 */
  renders: number;
  [key: string]: unknown;
}

let captured: CapturedComponent[] = [];

function installComponentStub() {
  const prev = (globalThis as any).Component;
  (globalThis as any).Component = (def: any) => {
    const instance: CapturedComponent = {
      data: JSON.parse(JSON.stringify(def.data ?? {})),
      setData(patch: Record<string, unknown>) {
        if ("entries" in patch) instance.renders += 1;
        Object.assign(instance.data, patch);
      },
      renders: 0,
    };
    for (const [name, fn] of Object.entries(def.methods ?? {})) {
      (instance as any)[name] = (fn as Function).bind(instance);
    }
    // pageLifetimes 的方法在真机上由页面生命周期以组件实例为 this 调用。
    for (const [name, fn] of Object.entries(def.pageLifetimes ?? {})) {
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
 * 构造会话并 setSession。返回新会话与其日志源。
 * 连调两次即模拟「会话重建」：旧会话被 resetSession 销毁，新会话换一份 FrameLog。
 */
async function installSession(): Promise<{ session: ControlSession; log: FrameLog }> {
  const { setSession, resetSession } = await import("../utils/session/singleton");
  resetSession();
  const transport = new ScriptedTransport(idleState());
  const session = new ControlSession({ transport, storage: createMemoryStorage() });
  await session.connect("scripted", "LUMEN-TEST");
  setSession(session);
  return { session, log: transport.logSource };
}

async function injectSessionViaDynamicImport(): Promise<{ log: FrameLog }> {
  const { log } = await installSession();
  return { log };
}

/** 面板最近一次渲染到的 entries（用户实际看到的行）。 */
function entriesOf(instance: CapturedComponent): any[] {
  return (instance.data.entries as any[]) ?? [];
}

function pushFrame(log: FrameLog, seq: number, hex: string): void {
  log.push({ ts: seq, dir: "tx", command: CMD.SET_POWER, seq, hex, parsed: "p", ok: true });
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

describe("log-panel 组件：会话重建后改绑（#32 回归）", () => {
  it("切到新会话后 refresh() 改看新日志源，旧会话的帧不再刷新面板", async () => {
    const { log: logA } = await installSession();
    const wxStub = installWxStub();
    const compStub = installComponentStub();
    try {
      await import("../components/log-panel/log-panel");
      const instance = captured[captured.length - 1];
      expect(instance, "Component 桩应捕获到 log-panel 实例").not.toBeUndefined();

      pushFrame(logA, 1, "AA");
      expect(entriesOf(instance)).toHaveLength(1);

      // 演示模式 off→on / 模式切换都会走「销毁旧会话、建新会话」。
      const { log: logB } = await installSession();
      expect(logB, "重建后的日志源应是新的 FrameLog").not.toBe(logA);

      (instance as any).refresh();

      // 面板不再显示旧会话的帧；新会话还没帧时为空。
      expect(entriesOf(instance), "改绑后面板应显示新会话的快照（此处为空）").toHaveLength(0);

      // 旧会话的帧不再触发面板刷新（旧订阅已解除）。
      const rendersBefore = instance.renders;
      pushFrame(logA, 2, "BB");
      expect(instance.renders, "旧会话 append 不应再刷新面板").toBe(rendersBefore);
      expect(entriesOf(instance)).toHaveLength(0);

      // 新会话的帧可见。
      pushFrame(logB, 3, "CC");
      expect(entriesOf(instance)).toHaveLength(1);
      expect(entriesOf(instance)[0].hex, "面板应显示新会话的帧，而非旧会话的").toBe("CC");
    } finally {
      compStub.restore();
      wxStub.restore();
    }
  });

  it("pageLifetimes.show() 在切回页面时改绑新会话（不依赖别处调 refresh）", async () => {
    const { log: logA } = await installSession();
    const wxStub = installWxStub();
    const compStub = installComponentStub();
    try {
      await import("../components/log-panel/log-panel");
      const instance = captured[captured.length - 1];
      expect(instance, "Component 桩应捕获到 log-panel 实例").not.toBeUndefined();

      pushFrame(logA, 1, "AA");
      expect(entriesOf(instance)).toHaveLength(1);

      const { log: logB } = await installSession();
      pushFrame(logB, 5, "EE");

      // 从设备页切回控制页：组件仍在，页面 show 触发一次刷新。
      (instance as any).show();

      expect(entriesOf(instance)).toHaveLength(1);
      expect(entriesOf(instance)[0].hex, "切回页面后应显示新会话的帧").toBe("EE");
    } finally {
      compStub.restore();
      wxStub.restore();
    }
  });

  it("多次 refresh 不叠加监听：每次 append 只刷新一次", async () => {
    const { log } = await installSession();
    const wxStub = installWxStub();
    const compStub = installComponentStub();
    try {
      await import("../components/log-panel/log-panel");
      const instance = captured[captured.length - 1];
      expect(instance).not.toBeUndefined();

      const rendersBefore = instance.renders;
      for (let i = 0; i < 5; i += 1) (instance as any).refresh();
      const rendersAfterRefreshes = instance.renders;
      expect(rendersAfterRefreshes, "5 次 refresh 应各渲染一次").toBe(rendersBefore + 5);

      pushFrame(log, 1, "AA");
      pushFrame(log, 2, "BB");
      expect(instance.renders, "每条 append 只应触发一次渲染（无重复订阅）")
        .toBe(rendersAfterRefreshes + 2);
      expect(entriesOf(instance)).toHaveLength(2);
    } finally {
      compStub.restore();
      wxStub.restore();
    }
  });
});