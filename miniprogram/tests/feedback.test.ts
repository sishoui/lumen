/**
 * 失败反馈助手（#31）：
 * - resultName 0–9 + 未知码的中文文案
 * - describeCommandFailure 四个失败分支（ack-error / stale / error / storage）
 * - FailureNotifier 节流：窗口内第一次 true、重复 false、窗口后 true；离散命令不节流
 * - scanFailureText / connectFailureText 蓝牙未开启 / 权限 / 其他错误
 * - 部位/场景 ack-error 使用同一映射（文本断言）
 */

import { describe, it, expect } from "vitest";
import { resultName } from "../utils/protocol/constants";
import { describeCommandFailure, FailureNotifier } from "../utils/feedback";
import { scanFailureText, connectFailureText } from "../utils/device-feedback";
import { layoutCommitFeedback } from "../utils/part-editor";
import { editFailureText } from "../utils/scene-writer";
import { CMD, RESULT } from "../utils/protocol/constants";

describe("resultName（docs/protocol.md §6）", () => {
  it("0–9 全部映射为中文文案", () => {
    expect(resultName(0x00)).toBe("成功");
    expect(resultName(0x01)).toBe("参数无效");
    expect(resultName(0x02)).toBe("未知命令");
    expect(resultName(0x03)).toBe("校验和错误");
    expect(resultName(0x04)).toBe("长度错误");
    expect(resultName(0x05)).toBe("设备忙");
    expect(resultName(0x06)).toBe("存储失败");
    expect(resultName(0x07)).toBe("版本不支持");
    expect(resultName(0x08)).toBe("帧头错误");
    expect(resultName(0x09)).toBe("内部错误");
  });

  it("未知码带十六进制提示，不返回 undefined", () => {
    expect(resultName(0x0a)).toContain("未知结果码");
    expect(resultName(0xff)).toContain("0xFF");
    expect(resultName(-1)).toContain("未知结果码");
  });
});

describe("describeCommandFailure", () => {
  it("ack-error →「<动作>失败：参数无效（0x01）」", () => {
    const text = describeCommandFailure(
      { kind: "ack-error", ack: { seq: 1, command: CMD.SET_POWER, resultCode: RESULT.INVALID_PARAM, ok: false } },
      "开机",
    );
    expect(text).toBe("开机失败：参数无效（0x01）");
  });

  it("ack-error 未知码也带十六进制", () => {
    const text = describeCommandFailure(
      { kind: "ack-error", ack: { seq: 1, command: CMD.SELF_TEST, resultCode: 0x7f, ok: false } },
      "自检",
    );
    expect(text).toContain("自检失败");
    expect(text).toContain("0x7F");
  });

  it("stale → 连接已变化，请重试", () => {
    const text = describeCommandFailure({ kind: "stale" }, "自检");
    expect(text).toBe("连接已变化，请重试");
  });

  it("error → 原始 message 透传", () => {
    const text = describeCommandFailure(
      { kind: "error", message: "ACK 超时 seq=3 cmd=7" },
      "自检",
    );
    expect(text).toBe("自检失败：ACK 超时 seq=3 cmd=7");
  });

  it("storage → 本地存储失败：message", () => {
    const text = describeCommandFailure(
      { kind: "storage", message: "quota exceeded" },
      "保存",
    );
    expect(text).toContain("本地存储失败");
    expect(text).toContain("quota exceeded");
  });

  it("ok → 成功文案", () => {
    expect(describeCommandFailure({ kind: "ok" }, "开机")).toBe("开机成功");
  });
});

describe("FailureNotifier 节流", () => {
  function makeNotifier() {
    let now = 0;
    const notifier = new FailureNotifier({ windowMs: 2000, now: () => now });
    return {
      notifier,
      advance: (ms: number) => { now += ms; },
    };
  }

  it("同一 key：窗口内第一次 true、重复 false、窗口后 true", () => {
    const { notifier, advance } = makeNotifier();
    expect(notifier.allow("brightness")).toBe(true);
    advance(500);
    expect(notifier.allow("brightness")).toBe(false);
    advance(500);
    expect(notifier.allow("brightness")).toBe(false);
    advance(1500); // 累计 2500 > 2000
    expect(notifier.allow("brightness")).toBe(true);
  });

  it("不同 key 互不干扰", () => {
    const { notifier } = makeNotifier();
    expect(notifier.allow("brightness")).toBe(true);
    expect(notifier.allow("color")).toBe(true);
  });

  it("reset 后下一次提示立即放行", () => {
    const { notifier, advance } = makeNotifier();
    expect(notifier.allow("brightness")).toBe(true);
    advance(100);
    expect(notifier.allow("brightness")).toBe(false);
    notifier.reset("brightness");
    expect(notifier.allow("brightness")).toBe(true);
  });

  it("reset() 无参数清全部 key", () => {
    const { notifier } = makeNotifier();
    notifier.allow("a");
    notifier.allow("b");
    notifier.reset();
    expect(notifier.allow("a")).toBe(true);
    expect(notifier.allow("b")).toBe(true);
  });

  it("离散命令不节流：页面不调用 allow，每次失败都提示", () => {
    // 页面契约：离散路径直接 showToast，不经过 notifier。
    // 用 FailureNotifier 模拟连续路径与离散路径的差异：
    const { notifier, advance } = makeNotifier();
    // 连续路径走 notifier
    expect(notifier.allow("brightness")).toBe(true);
    advance(100);
    expect(notifier.allow("brightness")).toBe(false);
    // 离散路径（新 notifier 实例或每个动作独立 key）不受影响
    const discrete = new FailureNotifier({ windowMs: 2000, now: () => 0 });
    expect(discrete.allow("power")).toBe(true);
    expect(discrete.allow("selftest")).toBe(true);
    expect(discrete.allow("strip-0")).toBe(true);
  });
});

describe("设备页失败文案（scanFailureText / connectFailureText）", () => {
  it("扫描失败：蓝牙未开启（errCode 10001）", () => {
    const text = scanFailureText({ errCode: 10001, errMsg: "bluetooth not available" });
    expect(text).toBe("扫描失败：请打开蓝牙");
  });

  it("扫描失败：权限拒绝（errCode 10002）", () => {
    const text = scanFailureText({ errCode: 10002, errMsg: "auth denied" });
    expect(text).toContain("扫描失败");
    expect(text).toContain("未授权");
  });

  it("扫描失败：其他错误透传 errMsg", () => {
    const text = scanFailureText({ errCode: 99999, errMsg: "weird failure" });
    expect(text).toBe("扫描失败：weird failure");
  });

  it("连接失败：蓝牙未开启（errCode 10001）", () => {
    const text = connectFailureText({ errCode: 10001, errMsg: "bluetooth not available" });
    expect(text).toBe("连接失败：请打开蓝牙");
  });

  it("连接失败：权限/占用（errCode 10003）", () => {
    const text = connectFailureText({ errCode: 10003, errMsg: "connect fail" });
    expect(text).toContain("连接失败");
    expect(text).toContain("占用");
  });

  it("连接失败：其他错误透传 errMsg", () => {
    const text = connectFailureText({ errCode: 99999, errMsg: "weird failure" });
    expect(text).toBe("连接失败：weird failure");
  });

  it("连接失败：Error 实例透传 message", () => {
    const text = connectFailureText(new Error("socket closed"));
    expect(text).toBe("连接失败：socket closed");
  });

  it("连接失败：适配器未初始化类 SDK 原文给人话（#31 回归）", () => {
    const text = connectFailureText({
      errMsg: "getBluetoothAdapterState:fail 请先调用 wx.openBluetoothAdapter 接口进行初始化操作",
    });
    expect(text).not.toContain("getBluetoothAdapterState");
    expect(text).toContain("蓝牙");
    expect(text).toMatch(/开启|初始化|就绪/);
  });

  it("扫描失败：适配器未初始化类 SDK 原文同样给人话（#31 回归）", () => {
    const text = scanFailureText({
      errMsg: "getBluetoothAdapterState:fail 请先调用 wx.openBluetoothAdapter 接口进行初始化操作",
    });
    expect(text).not.toContain("getBluetoothAdapterState");
    expect(text).toContain("蓝牙");
    expect(text).toMatch(/开启|初始化|就绪/);
  });
});

describe("部位/场景 ack-error 使用同一映射", () => {
  it("layoutCommitFeedback 走 resultName", () => {
    const hint = layoutCommitFeedback(
      { kind: "ack-error", ack: { seq: 1, command: CMD.LAYOUT_COMMIT, resultCode: RESULT.STORAGE_FAILED, ok: false } },
      false,
    );
    expect(hint).toBe("提交失败：存储失败（0x06）");
  });

  it("editFailureText 走 resultName", () => {
    const text = editFailureText({
      kind: "ack-error", ack: { seq: 1, command: CMD.SCENE_STEP, resultCode: RESULT.INVALID_PARAM, ok: false },
    });
    expect(text).toContain("参数无效");
    expect(text).toContain("0x01");
  });
});