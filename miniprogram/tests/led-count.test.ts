/** 每链灯珠数（#25）：提交计划、上限注入、SetLedCount 往返与越界拦截。 */

import { describe, it, expect } from "vitest";
import { ControlSession } from "../utils/session/session";
import { MockTransport } from "../utils/ble/mock-transport";
import { MOCK_DEVICES } from "../utils/mock/mock-devices";
import { createMemoryStorage } from "./helpers/storage";
import {
  ScriptedTransport, ackFrame, idleState, makeRebuildResponder,
} from "./helpers/scripted-transport";
import { ledCountLimit, planLedCountSet } from "../utils/led-count";
import { encodeFrame } from "../utils/protocol/frame";
import { CMD, DEVICE_CMD, MAX_LEDS, RESULT } from "../utils/protocol/constants";
import type { DeviceInfo } from "../utils/protocol/types";

/** 15 字节 DeviceInfoReport，只关心 maxLeds（payload[8]）。 */
function deviceInfoReport(seq: number, maxLeds: number): Uint8Array {
  const payload = new Uint8Array(15);
  payload[8] = maxLeds;
  payload[9] = 8;
  payload[10] = 8;
  payload[11] = 8;
  payload[12] = 8;
  payload[13] = 3;
  payload[14] = 0x01;
  return encodeFrame(DEVICE_CMD.DEVICE_INFO_REPORT, seq, payload);
}

describe("灯珠数领域工具", () => {
  it("上限来自 deviceInfo.maxLeds，缺失时回退协议常量", () => {
    expect(ledCountLimit(null), "无 deviceInfo 时回退 MAX_LEDS").toBe(MAX_LEDS);
    expect(ledCountLimit({ maxLeds: 64 } as DeviceInfo), "有 deviceInfo 时按设备能力").toBe(64);
  });

  it("planLedCountSet：范围内发送、与当前值相同不发、越界拦截且原因含上限", () => {
    expect(planLedCountSet("50", 60, 100), "范围内且不同于当前值").toEqual({ kind: "send", value: 50 });
    expect(planLedCountSet("1", 60, 100), "下限 1 合法").toEqual({ kind: "send", value: 1 });
    expect(planLedCountSet("60", 60, 100).kind, "与当前值相同不发命令").toBe("noop");

    const below = planLedCountSet("0", 60, 64);
    expect(below.kind, "0 越界被拦截").toBe("reject");
    if (below.kind === "reject") {
      expect(below.reason, "拦截原因要带上限数值").toContain("64");
    }
    const above = planLedCountSet("65", 60, 64);
    expect(above.kind, "超过 maxLeds 越界被拦截").toBe("reject");
    if (above.kind === "reject") {
      expect(above.reason, "拦截原因要带上限数值").toContain("64");
    }
    expect(planLedCountSet("", 60, 100).kind, "空输入被拦截").toBe("reject");
    expect(planLedCountSet("abc", 60, 100).kind, "非整数被拦截").toBe("reject");
  });
});

describe("SetLedCount 上限来自注入的 deviceInfo", () => {
  it("maxLeds=64：越界在发送前拦截（0 条命令），合法值只发一条且 State 读回一致", async () => {
    const state = idleState();
    const base = makeRebuildResponder(() => undefined);
    const transport = new ScriptedTransport(state, (request, emit) => {
      if (request.command === CMD.SET_LED_COUNT) {
        // 设备接受：先改内部状态再回 ACK，readState 读到的是同一份状态
        const count = request.payload[1] | (request.payload[2] << 8);
        state.stripLedCounts[request.payload[0]] = count;
        emit(ackFrame(request));
        return;
      }
      if (request.command === CMD.QUERY_DEVICE_INFO) {
        emit(ackFrame(request));
        emit(deviceInfoReport(request.seq, 64));
        return;
      }
      base(request, emit);
    });
    const session = new ControlSession({ transport, storage: createMemoryStorage() });
    await session.connect("scripted");
    await session.queryDeviceInfo(); // 排在重建之后，返回即重建完成

    expect(session.deviceInfo?.maxLeds, "上限应来自注入的 DeviceInfoReport，不是常量").toBe(64);

    // 页面决策路径：只有 send 计划才发命令（控制页 commitLedCount 的接缝）
    const pageCommit = async (text: string): Promise<string> => {
      const current = session.deviceState?.stripLedCounts[0] ?? 0;
      const plan = planLedCountSet(text, current, ledCountLimit(session.deviceInfo));
      if (plan.kind === "reject") return plan.reason;
      if (plan.kind === "noop") return "noop";
      const result = await session.setLedCount(0, plan.value);
      return result.kind === "ok" ? "ok" : `error:${result.kind}`;
    };

    expect(await pageCommit("0"), "0 越界被拦截").toContain("64");
    expect(await pageCommit("65"), "超过 maxLeds=64 越界被拦截").toContain("64");
    expect(await pageCommit("60"), "与当前值相同不发命令").toBe("noop");
    expect(await pageCommit("64"), "上限值 64 合法").toBe("ok");

    const ledRequests = transport.sent.filter((r) => r.command === CMD.SET_LED_COUNT);
    expect(ledRequests.length, `只应发出 1 条 SetLedCount，实际 ${ledRequests.length}`).toBe(1);
    expect(
      ledRequests[0].payload[1] | (ledRequests[0].payload[2] << 8),
      "SetLedCount 载荷数量应为 64",
    ).toBe(64);
    expect(session.deviceState?.stripLedCounts[0], "State 读回 64").toBe(64);
  });
});

describe("SetLedCount 设备拒绝（Mock 与固件同形）", () => {
  it("未分配的链返回参数无效，已分配的链成功并读回", async () => {
    const transport = new MockTransport({ scenario: "normal" });
    const session = new ControlSession({ transport, storage: createMemoryStorage() });
    const desk = MOCK_DEVICES[0];
    await session.connect(desk.deviceId, desk.broadcastName);

    const bad = await session.setLedCount(5, 60); // 书桌只有链 0/1
    expect(bad.kind, "未分配的链应被拒绝").toBe("ack-error");
    if (bad.kind === "ack-error") {
      expect(bad.ack.resultCode, "结果码应为参数无效").toBe(RESULT.INVALID_PARAM);
    }

    const good = await session.setLedCount(1, 40);
    expect(good.kind, "已分配的链 1 应成功").toBe("ok");
    expect(session.deviceState?.stripLedCounts[1], "链 1 State 读回 40").toBe(40);
  });
});