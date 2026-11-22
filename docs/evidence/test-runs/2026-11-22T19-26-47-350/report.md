# 测试报告

> ⚠️ **发布级证据，但本轮发布未覆盖：渲染回归、真机 e2e。**
>
> 渲染回归：缺微信开发者工具自动化端口（ws://127.0.0.1:9501：Failed connecting to ws://127.0.0.1:9501, check if target project window is opened with automation enabled；缺微信开发者工具自动化端口（ws://127.0.0.1:9502：ECONNREFUSED））。在微信开发者工具里打开 设置 → 安全设置 → 服务端口（开启「自动化」），或按需设置 WS=<ws 地址>；已试 ws://127.0.0.1:9501 / ws://127.0.0.1:9502；真机 e2e：e2e 用例骨架期未落地（#17），网关自检通过，断言待补
>
> 这些层本轮没有跑，不能按通过计。下面每一段都是在「上述层未验证」的前提下写的。

- **运行**：2026-11-22T19:26:47.350Z
- **commit**：`10df895`（分支 `main`）
- **机器**：sishoui · win32 10.0.26200 · 12 核
- **触发了**：firmware / mp / server / ui / ble
- **五层结果**：固件 host 单测 ✅ PASS · 小程序单测 ✅ PASS · 后端单测 ✅ PASS · 渲染回归 ⏭️ SKIP · 真机 e2e ⏭️ SKIP
- **结论**：⚠️ 未全验证（渲染回归、真机 e2e 未跑）
- **本轮未验证**：渲染回归、真机 e2e

## 分层结果

| 层 | 结果 | 用例数 | 耗时 | 说明 |
|---|---|---|---|---|
| 固件 host 单测 | ✅ PASS | 259 断言 | 1.1s | 259 条断言通过 |
| 小程序单测 | ✅ PASS | 99 用例 | 4.7s | 99 个用例通过 |
| 后端单测 | ✅ PASS | 99 用例 | 1.6s | 99 个用例通过 |
| 渲染回归 | ⏭️ SKIP | — | 273ms | 缺微信开发者工具自动化端口（ws://127.0.0.1:9501：Failed connecting to ws://127.0.0.1:9501, check if target project window is opened with automation enabled；缺微信开发者工具自动化端口（ws://127.0.0.1:9502：ECONNREFUSED））。在微信开发者工具里打开 设置 → 安全设置 → 服务端口（开启「自动化」），或按需设置 WS=<ws 地址>；已试 ws://127.0.0.1:9501 / ws://127.0.0.1:9502 |
| 真机 e2e | ⏭️ SKIP | — | 66ms | e2e 用例骨架期未落地（#17），网关自检通过，断言待补 |

## 未验证清单

- **渲染回归**：缺微信开发者工具自动化端口（ws://127.0.0.1:9501：Failed connecting to ws://127.0.0.1:9501, check if target project window is opened with automation enabled；缺微信开发者工具自动化端口（ws://127.0.0.1:9502：ECONNREFUSED））。在微信开发者工具里打开 设置 → 安全设置 → 服务端口（开启「自动化」），或按需设置 WS=<ws 地址>；已试 ws://127.0.0.1:9501 / ws://127.0.0.1:9502
- **真机 e2e**：e2e 用例骨架期未落地（#17），网关自检通过，断言待补

## 明细

### 固件 host 单测：按测试函数的断言数

共 3 个测试函数，3 条断言（按条数降序）。

| 测试函数 | 断言数 |
|---|---|
| `test_checksum_frame` | 1 |
| `test_crc16_kat` | 1 |
| `test_protocol_version` | 1 |

### 固件 host 单测

| 文件 | 覆盖 | 用例数 |
|---|---|---|
| `firmware/test/test_protocol.c` | 固件 host 单测：docs/protocol-testvectors.json 逐 case 断言产品代码 encode/decode 输出 vs frame_hex / payload_hex，CRC16 KAT，协议版本宏 vs JSON protocol_version，分片重组边界 | 259 |
| `scripts/check-protocol-testvectors.mjs` | 向量文件与 docs/protocol.md 契约的独立一致性校验：帧宽 / magic / version、命令表载荷宽度、帧内长度与 CRC 自洽、结果码域、分片规则。不走生成器，专门抓生成器的错 | 259 |

### 小程序单测

| 文件 | 覆盖 | 用例数 |
|---|---|---|
| `miniprogram/tests/ack-waiters.test.ts` | ACK 等待表：seq 匹配 / 超时 / 断线清空 | 6 |
| `miniprogram/tests/boundary.test.ts` | 边界测试（源码扫描）：session/ 下不出现 mock 分支（无 if (mock) / import.*mock）；全仓 wx. 只出现在 utils/ble/ 下 | 3 |
| `miniprogram/tests/frame-chunk.test.ts` | 帧边界 / 分片重组边界 | 11 |
| `miniprogram/tests/mock-scenarios.test.ts` | Mock 场景：normal / slow / flaky / offline 四场景行为 | 4 |
| `miniprogram/tests/protocol.test.ts` | 协议向量断言（工单 #4 / #6 决策 9）：readFileSync + JSON.parse 同一份 docs/protocol-testvectors.json；断言对象是产品代码 encodeFrame/decodeFrame 输出 vs frame_hex / payload_hex；PROTOCOL_VERSION 常量 vs JSON protocol_version | 44 |
| `miniprogram/tests/rebuild.test.ts` | 权威重建编排顺序与部分失败降级 | 2 |
| `miniprogram/tests/reconnect.test.ts` | ReconnectSupervisor：1s/2s/4s 退避 + 耗尽 | 3 |
| `miniprogram/tests/session.test.ts` | 会话全链路（MockTransport）：connect → 重建 → 命令 → disconnect | 6 |
| `miniprogram/tests/throttle.test.ts` | 20Hz latest-wins（vitest 假计时器） | 4 |
| `miniprogram/tests/transport-conformance.test.ts` | Transport 同形：同一断言体对两个实现各跑一遍。能替换实现而测试不改一字——这是「同形」的可执行定义 | 10 |
| `miniprogram/tests/writer.test.ts` | SerialWriter 串行化（假 sendOne） | 6 |

### 后端单测

| 文件 | 覆盖 | 用例数 |
|---|---|---|
| `server/tests/aggregation.test.ts` | 使用日志的聚合查询与视图数据（makeHarness 内存 SQLite + fastify.inject） | 12 |
| `server/tests/api.test.ts` | HTTP 路由与鉴权契约：双鉴权（APP_TOKEN / ADMIN_PASSWORD）与 405 只读拒绝 | 19 |
| `server/tests/identity.test.ts` | device_key 归一：广播名 / 硬件 ID / MAC 的规范化与解析 | 14 |
| `server/tests/readonly.test.ts` | 只读看板对写方法的拒绝 | 43 |
| `server/tests/schema.test.ts` | 两表两视图结构与迁移：SCHEMA_SQL / MIGRATIONS / user_version | 11 |

## 失败详情

本轮没有失败。

## 与上次运行

对比基线：`2026-11-22T19-22-17-391`（2026-11-22T19:22:17.391Z）

**无变化**：本次比对了 18 个测试文件的用例数，与上次一致；也没有新出现的失败或跳过。


