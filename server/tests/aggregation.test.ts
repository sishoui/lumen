import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { APP_TOKEN, logBody, makeHarness, type Harness } from "./helpers.ts";

let h: Harness;

beforeEach(async () => {
  h = await makeHarness();
});

afterEach(async () => {
  await h.close();
});

async function post(payload: Record<string, unknown>): Promise<void> {
  const res = await h.app.inject({
    method: "POST",
    url: "/api/v1/usage-logs",
    headers: { "x-lumen-app-token": APP_TOKEN },
    payload,
  });
  if (res.statusCode !== 201) {
    throw new Error(`写入失败 ${res.statusCode}: ${res.body}`);
  }
}

describe("设备聚合（跨手机归一）", () => {
  it("同一台设备在 Android 与 iOS 上 deviceId 不同，但广播名相同 → 聚成一台", async () => {
    await post(
      logBody({
        clientEventId: "agg-android",
        startedAt: 1_000,
        device: {
          deviceName: "LUMEN-1A2B",
          deviceId: "AA:BB:CC:DD:1A:2B",
          platform: "android",
        },
      }),
    );
    await post(
      logBody({
        clientEventId: "agg-ios",
        startedAt: 2_000,
        device: {
          deviceName: "LUMEN-1A2B",
          deviceId: "8B5F4A2C-1111-2222-3333-444455556666",
          platform: "ios",
        },
      }),
    );

    const devices = h.db.prepare("SELECT * FROM v_devices").all() as Array<{
      device_key: string;
      device_name: string;
      use_count: number;
      user_count: number;
      mac_count: number;
    }>;
    expect(devices).toHaveLength(1);
    expect(devices[0]).toMatchObject({
      device_key: "name:LUMEN-1A2B",
      device_name: "LUMEN-1A2B",
      use_count: 2,
      user_count: 1,
      mac_count: 1,
    });
  });

  it("两台不同设备用了同一个广播名（撞车）→ 仍算一台，但看板会标出 mac_count = 2", async () => {
    await post(
      logBody({
        clientEventId: "collide-1",
        device: { deviceName: "LUMEN-FFFF", deviceId: "11:22:33:44:FF:FF", platform: "android" },
      }),
    );
    await post(
      logBody({
        clientEventId: "collide-2",
        device: { deviceName: "LUMEN-FFFF", deviceId: "11:22:33:44:FF:FE", platform: "android" },
      }),
    );

    const row = h.db
      .prepare("SELECT use_count, mac_count FROM v_devices WHERE device_key = 'name:LUMEN-FFFF'")
      .get() as { use_count: number; mac_count: number };
    expect(row).toEqual({ use_count: 2, mac_count: 2 });
  });

  it("有 hardwareId 时以硬件 id 为准，广播名只作为展示", async () => {
    await post(
      logBody({
        clientEventId: "hw-1",
        device: { hardwareId: "24:6F:28:AA:BB:CC", deviceName: "LUMEN-1A2B", platform: "android" },
      }),
    );
    await post(
      logBody({
        clientEventId: "hw-2",
        device: { hardwareId: "24:6F:28:AA:BB:CC", deviceName: "LUMEN-FFFF", platform: "ios" },
      }),
    );

    const rows = h.db.prepare("SELECT device_key, use_count FROM v_devices").all();
    expect(rows).toEqual([{ device_key: "hw:24:6f:28:aa:bb:cc", use_count: 2 }]);
  });

  it("同一 MAC 的三种书写形态（冒号 / 短横线 / 无分隔）→ 同一个 device_key", async () => {
    for (const [i, hardwareId] of [
      "AA:BB:CC:DD:EE:FF",
      "aa-bb-cc-dd-ee-ff",
      "aabbccddeeff",
    ].entries()) {
      await post(
        logBody({
          clientEventId: `mac-form-${i}`,
          startedAt: 1_000 + i,
          device: {
            hardwareId,
            deviceName: "LUMEN-1A2B",
            platform: "android",
          },
        }),
      );
    }

    const rows = h.db.prepare("SELECT device_key, use_count, user_count FROM v_devices").all();
    expect(rows).toEqual([{ device_key: "hw:aa:bb:cc:dd:ee:ff", use_count: 3, user_count: 1 }]);
  });

  it("老客户端不带 hardwareId：按广播名聚合，仍入库", async () => {
    const res = await h.app.inject({
      method: "POST",
      url: "/api/v1/usage-logs",
      headers: { "x-lumen-app-token": APP_TOKEN },
      payload: logBody({
        clientEventId: "legacy-no-hw",
        device: { deviceName: "LUMEN-1A2B", deviceId: "AA:BB:CC:DD:1A:2B", platform: "android" },
      }),
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ deviceKey: "name:LUMEN-1A2B", deviceKeyKind: "name" });
  });

  it("hardwareId 格式不认（NULL / 非字符串 / 脏串）→ 不 400，退化为广播名聚合", async () => {
    for (const [i, hardwareId] of [
      null,
      42,
      "not-a-mac",
      "",
      "AA:BB:CC:DD:EE",
    ].entries()) {
      const res = await h.app.inject({
        method: "POST",
        url: "/api/v1/usage-logs",
        headers: { "x-lumen-app-token": APP_TOKEN },
        payload: logBody({
          clientEventId: `bad-hw-${i}`,
          device: { hardwareId, deviceName: "LUMEN-1A2B", platform: "android" },
        }),
      });
      expect(res.statusCode, `hardwareId=${String(hardwareId)}`).toBe(201);
      expect(res.json()).toMatchObject({ deviceKeyKind: "name" });
    }

    const rows = h.db.prepare("SELECT device_key, use_count FROM v_devices").all();
    expect(rows).toEqual([{ device_key: "name:LUMEN-1A2B", use_count: 5 }]);
  });

  it("全零 MAC 不当 hw，回落广播名（不挤进 hw:00:00…）", async () => {
    const res = await h.app.inject({
      method: "POST",
      url: "/api/v1/usage-logs",
      headers: { "x-lumen-app-token": APP_TOKEN },
      payload: logBody({
        clientEventId: "zero-mac",
        device: {
          hardwareId: "00:00:00:00:00:00",
          deviceName: "LUMEN-1A2B",
          platform: "android",
        },
      }),
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ deviceKey: "name:LUMEN-1A2B", deviceKeyKind: "name" });
  });

  it("没有广播名时按 platform+deviceId 兜底，分组按手机分裂但数据不丢", async () => {
    await post(
      logBody({
        clientEventId: "raw-1",
        device: { deviceId: "AA:BB:CC:DD:EE:FF", platform: "android" },
      }),
    );

    const rows = h.db.prepare("SELECT device_key FROM v_devices").all();
    expect(rows).toEqual([{ device_key: "raw:android:aa:bb:cc:dd:ee:ff" }]);
  });

  it("v_devices 的 use_count 是会话数（每行一条），不是心跳", async () => {
    for (let i = 0; i < 5; i += 1) {
      await post(
        logBody({
          clientEventId: `count-${i}`,
          startedAt: 1_000 + i * 10_000,
          device: { deviceName: "LUMEN-0001", platform: "android" },
        }),
      );
    }
    const row = h.db
      .prepare("SELECT use_count FROM v_devices WHERE device_key = 'name:LUMEN-0001'")
      .get() as { use_count: number };
    expect(row.use_count).toBe(5);
  });

  it("last_seen_at 取 ended_at 与 started_at 中较大的那条", async () => {
    await post(
      logBody({
        clientEventId: "last-1",
        startedAt: 1_000,
        endedAt: 9_000,
        device: { deviceName: "LUMEN-0002", platform: "android" },
      }),
    );
    const row = h.db
      .prepare("SELECT last_seen_at FROM v_devices WHERE device_key = 'name:LUMEN-0002'")
      .get() as { last_seen_at: number };
    expect(row.last_seen_at).toBe(9_000);
  });
});

describe("v_users LEFT JOIN：有用户但零日志也列得出来", () => {
  it("用户 upsert 后即使没有日志，v_users 仍能看到（use_count=0, device_count=0）", async () => {
    // 先 upsert 一个用户（POST 一次日志，再删掉日志不可行；改为直接 SQL 建用户）。
    h.db
      .prepare(
        "INSERT INTO users (user_key, display_name, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?)",
      )
      .run("local-aaaaaaaaaaaaaaaa", "零日志用户", 1_000, 1_000);

    const rows = h.db.prepare("SELECT * FROM v_users").all() as Array<{
      user_key: string;
      display_name: string;
      use_count: number;
      device_count: number;
    }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      user_key: "local-aaaaaaaaaaaaaaaa",
      display_name: "零日志用户",
      use_count: 0,
      device_count: 0,
    });
  });

  it("多用户多设备：v_users 聚合每个用户的会话数与设备数", async () => {
    for (const [i, userKey] of [
      "local-aaaaaaaaaaaaaaaa",
      "local-bbbbbbbbbbbbbbbb",
      "local-aaaaaaaaaaaaaaaa",
    ].entries()) {
      await post(
        logBody({
          clientEventId: `vu-${i}`,
          userKey,
          startedAt: 1_000 + i,
          device: {
            hardwareId: `24:6F:28:AA:BB:0${i}`,
            platform: "android",
          },
        }),
      );
    }

    const a = h.db
      .prepare("SELECT use_count, device_count FROM v_users WHERE user_key = 'local-aaaaaaaaaaaaaaaa'")
      .get() as { use_count: number; device_count: number };
    expect(a).toEqual({ use_count: 2, device_count: 2 });

    const b = h.db
      .prepare("SELECT use_count, device_count FROM v_users WHERE user_key = 'local-bbbbbbbbbbbbbbbb'")
      .get() as { use_count: number; device_count: number };
    expect(b).toEqual({ use_count: 1, device_count: 1 });
  });
});