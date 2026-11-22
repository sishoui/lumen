# Lumen 落地 spec 总纲

**状态**：定稿（2026-11-23，工单 #3）。本文是四端实现（固件 / 小程序 / 后端 / 测试工具链）的共同输入：定义「为什么这样设计」与「边界在哪」，**不复制字节级细节**。

**字节级契约的唯一真相**分层：

| 内容 | 真相位置 |
|---|---|
| 帧布局、命令字、载荷、结果码 | `docs/protocol.md`（人读契约，随骨架工单落地） |
| 字节测试向量（机器可读） | `docs/protocol-testvectors.json`（gen 产出，工单 #4 定稿的单点持有策略） |
| 向量生成与校验脚本 | `scripts/gen-protocol-testvectors.mjs` / `scripts/check-protocol-testvectors.mjs` |

**来源**：合成自蓝图《项目功能文档》（第 1–8 节）、wayfinder 地图 [issue #1](https://github.com/sishoui/lumen/issues/1)、工单 #2（继承与扬弃）、工单 #4（协议契约）与 #9/#10（研究）的 resolution。与蓝图冲突处以蓝图为准；字节细节以协议文档为准。

**范围**：ESP32-C3FH4 锁死的 BLE 直连灯控系统。协议契约 + 四端设计 + 测试工具链。**不含**完整功能实现（地图终点是 spec 定稿 + 骨架 smoke 通过）。

---

## 1. 项目意图与设计取舍

微信小程序通过 BLE 直连控制 ESP32-C3FH4 驱动的 WS2812B 灯带——像一盏普通灯一样使用：不装 App、不注册账号、不连 Wi-Fi、不依赖云端。

五条核心取舍（蓝图的「性格」），是后续所有决策的仲裁标准：

1. **设备是唯一真相源**。灯光配置全部存在设备 NVS；小程序连上后从设备读回重建 UI；后端不存任何配置副本，后端挂了不影响控制。
2. **协议是字节级契约**。协议文档 + 可执行的测试向量 + 两端实现必须同一 PR；向量由代码侧单点持有（第 2 章），spec 只引用不复制。
3. **不做向后兼容**。协议与持久化是整体契约：模型变化时旧 blob 整份拒绝、设备回默认值。迁移复杂度不值得，断崖升级。
4. **渲染永远取最新状态（latest-wins）**。快速拖动时只渲染最后一个值，不排队重放——控制感是「跟手」而不是「追尾」。
5. **可靠性与可观测性是一等公民**。每帧有 ACK；两端日志按 seq 对齐；有自检命令；有隐藏帧日志面板；测试里「没跑」和「跑过了」必须长得不一样。

## 2. 协议契约

### 2.1 为什么是字节帧（设计理由）

原型用 ASCII 文本命令（`b128\ns50\np1\n`）的三个死结（工单 #2 结论）：不可扩展（加参数就发明新字母）、解析脆弱（两端各自 `atoi`/正则，格式漂移静默失败）、无完整性校验（丢字节或截断不可检测）。字节帧契约用固定头 + 命令字 + CRC + 分片重组解决；具体布局是 `docs/protocol.md` 的职责，本节只定边界。

### 2.2 GATT 服务

| 特征 | UUID（尾号） | 属性 | 用途 |
|---|---|---|---|
| Service | `…0001` | primary | `6c756d65-6e00-4b1e-9a3c-000000000001` |
| RX | `…0002` | WRITE_NO_RSP | 小程序 → 设备（命令帧） |
| TX | `…0003` | NOTIFY | 设备 → 小程序（ACK / Event / Report） |
| State | `…0004` | READ | 32 字节整机状态裸读 |

- UUID 沿用原型已验证的 FFE0/FFE1/FFE2 兼容组（128-bit 形式，尾号 …0001–0004）。16-bit 够用且微信小程序 + NimBLE 兼容性已验证，不升级 128-bit 自定义。
- 广播名 `LUMEN-XXXX`（MAC 末两字节大写 hex，仅供人眼识别，**不是身份**）。身份是 `hw_id`（6 字节 BT MAC，DeviceInfoReport 给出）。
- 单连接（NimBLE `CONFIG_BT_NIMBLE_MAX_CONNECTIONS=1`），不配对不绑定；断开后重新开始广播。
- 连接参数：interval 15–30ms、latency 0、supervision timeout 4s——拖动跟手优先，不追求省电。
- **MTU 策略**：设备请求 247；Android 小程序 `wx.setBLEMTU(185)`；两端在 MTU 未知时按 23 处理。`chunk_capacity = min(mtu − 3, 180)`，单分片数据上限 = capacity − 1（1 字节分片头），下限 19。

### 2.3 帧格式与分片（边界描述，字节细节在 protocol.md）

```
逻辑帧（≤ 240 B）：
  magic(0xA6) | version(0x05) | command(1) | seq(1) | length(2, 小端) | payload(≤232) | crc16(2, 小端)
  CRC16 = CCITT-FALSE，覆盖前 6+length 字节。

BLE 分片：
  每片 1 字节 ctrl = FIRST(bit7) | LAST(bit6) | 序号(bit5..0)
  容量 = chunk_capacity − 1；重组超时 1000ms；单分片帧 ctrl 恒为 0xC0（不许裸帧）。
```

边界规则：

- 总长上限 240 B 是硬边界。超长帧整帧拒绝，不截断执行、不缓冲等待后续包。
- **magic 不是 0xA6 / version 不是 0x05 / CRC 错 / 长度不符 → 对应错误码整帧拒绝**，校验顺序固定（magic → version → length → CRC → command → payload 长度 → payload 取值）。长度错误优先于校验和（长度不对无法定位 CRC 字节）。
- `seq` 0–255 循环，设备原样回显、不去重。命令都是绝对值，重传不会造成状态翻转。
- 一次一帧、等 ACK 再发下一帧（由小程序会话层保证，设备侧不排队）。

### 2.4 命令族分类

| 族 | 命令字范围 | 内容 | 为什么这样分 |
|---|---|---|---|
| 基础 | `0x01`–`0x07` | 整机开关 / 亮度 / 查状态 / 灯珠数 / 自检 | 原型已验证的最小控制面，单帧可完成 |
| 链路 | `0x1B`–`0x1D` | 链开关 / 引脚表查询 / 设备能力查询 | 多链管理与能力发现；引脚表只读，协议不能改引脚映射 |
| 布局 | `0x20`–`0x24` | 部位声明 / 段归属 / 整份提交 / 读回 | 布局是全局一份（三场景共用），整份提交立即落盘 |
| 场景 | `0x25`–`0x29` | 时间轴头 / 单步增量 / 场景名 / 激活 / 读回 | 场景编辑是增量的（无「应用」按钮），2s 防抖落盘 |

- 命令字不复用退役编号（v5 起 `0x03`/`0x04`/`0x10`–`0x1A` 已退役，收到回 UnknownCommand）。本项目**没有历史包袱**，直接采用蓝图命令表，不存在「旧命令兼容」问题。
- 校验语义：载荷长度与命令要求不符 → BadLength；载荷取值非法 → InvalidParam；任何错误都不改变状态。

### 2.5 设备 → 小程序报告类型

| 命令字 | 报告 | 语义 |
|---|---|---|
| `0x80` | ACK | 回显 `[原命令字, 结果码]` + seq。**含义是「已接受并写入 RAM」**，不保证已渲染或已落盘 |
| `0x81` | Event | 异步事件（存储失败等），seq 恒 0 |
| `0x82` | StateReport | 32 字节整机状态，与 State 特征值 read 布局完全一致（单一解析器） |
| `0x87` | StripConfigReport | 8 × `[strip_id, gpio, flags]`，引脚表只读 |
| `0x88` | DeviceInfoReport | firmware_version / hw_id / 能力上限 / caps 位 |
| `0x89`+`0x8A` | LayoutReport + LayoutListEnd | 逐部位读回，收尾帧判定结束 |
| `0x8B`–`0x8D` | ScenePart / SceneStep / SceneListEnd | 逐部位逐步骤读回，收尾帧判定结束 |

- **多帧报告共用一个 seq**，以收尾帧（…ListEnd）判定结束——不是靠超时猜。
- 设备不主动推送状态；StateReport 只在查询时发送。
- `firmware_version` 是**字符串语义的 2 字节**（`"0100"` = v1.0，线上小端），与 `protocol_version`（0x05）完全独立——升固件不被迫升协议版本（工单 #4 决策 5，修 lumen 的版本纠缠坑）。

### 2.6 结果码语义

`00` OK / `01` InvalidParam / `02` UnknownCommand / `03` BadChecksum / `04` BadLength / `05` Busy（灯珠数重建中）/ `06` StorageFailed / `07` UnsupportedVersion / `08` BadMagic / `09` InternalError。`0x0A–0xFF` 保留。

语义边界：

- **Busy 可重试，其余不可**：Busy 是「稍后重发同一帧」的唯一合法理由；连续量（亮度/颜色）永不重传（见 §4.2 节流）。
- **未知命令必须显式拒绝**（回 `0x02`），不静默成功——这是「需要升级固件」在协议层的唯一表达。
- NVS 写失败发生在 ACK 之后，只能异步上报 Event `0x81`（detail = 触发写入的命令字）；ACK 不受影响。

### 2.7 字节向量的单点持有策略（引用工单 #4，不复制）

- **唯一机器可读向量源**：`docs/protocol-testvectors.json`（无版本后缀，旧版删除不并存；版本进 JSON 内容的 `protocol_version` 字段，不进文件名）。spec **只引用路径**，向量本体、字段清单、case 集合以该文件与最近一次 gen 产出为准。
- **gen/check 双脚本**：`scripts/gen-protocol-testvectors.mjs`（持生成常量，`--check` 幂等守门）+ `scripts/check-protocol-testvectors.mjs`（独立校验器，手抄常量表，不信生成器）。
- **双端运行时读取同一文件**：C 端 `fopen` + 极简扫描器（argv 传路径，缺文件 exit 2 大声失败）；TS 端 `readFileSync` + `JSON.parse`。两端测试的断言对象是**产品代码的 encode/decode 输出**，不是测试内嵌的实现。
- **版本三重守护**：JSON 顶层 `protocol_version:5` = 帧内 0x05 = 两端 `PROTOCOL_VERSION` 常量；`firmware_version:"0100"` 独立。
- **变更流程三层机制**：npm test 前置 check（本地快速反馈）+ CI 硬 gate（全绿才可 merge）+ AGENTS.md/spec 软层（人知道机制存在）。改协议 SOP：

  1. 改 `docs/protocol.md` 契约描述。
  2. 同步改 gen 常量 **和** check 手抄常量表（两份独立，check 不许 import gen）。
  3. `npm run gen:vectors` 重新生成；人工抽查 diff。
  4. 改两端实现。
  5. `npm run test` 全绿。
  6. 同一个 PR 提交；CI 全绿才 merge。

- **版本号语义**：`protocol_version:5` 是「契约血统标识」（承袭 lumen v5 契约，便于与参考实现逐字节对照迁移），不表示本项目迭代了 5 轮。

## 3. 四端设计

### 3.1 系统架构

```
手机侧                          设备侧（自供电）                    旁路（可选）
微信小程序 (原生+TS)  <--BLE-->  ESP32-C3FH4 固件 (ESP-IDF+NimBLE)  -->  后端 (Fastify+SQLite)
  ControlSession / Writer           ble_link → led_engine → state_store      使用日志 + 只读看板
  Mock 传输层（演示模式）            led_strip (RMT) → WS2812B × ≤8 链          永不在控制链路里
```

三端职责与明确不做（蓝图 §2.2）：

| 端 | 技术栈 | 职责 | 明确不做 |
|---|---|---|---|
| 固件端 | ESP-IDF、NimBLE、led_strip（RMT） | GATT 服务、协议编解码、灯效渲染、NVS 持久化 | 不联网、不接云 |
| 小程序端 | 微信小程序原生 + TypeScript | 扫描/连接/回连、控制会话、部位与场景编辑、诊断面板、演示模式 | 不做灯效渲染（只下发参数） |
| 后端 | Node + Fastify + SQLite | 使用日志 + 只读看板 | 不做归属/共享/权限/远程控制，不存任何灯光配置 |

### 3.2 固件端

#### ESP-IDF 工程结构

```
firmware/
├── main/
│   ├── app_main.c          # 初始化编排，无业务逻辑
│   ├── protocol.c          # 帧信封解码、CRC、ACK/Event/Report 编码（纯函数，可 host 编译）
│   ├── chunk_reasm.c       # 分片重组（纯函数）
│   ├── command.c           # 命令 reducer：旧状态 + 命令 → 新状态 + 结果码（纯函数）
│   ├── layout_store.c      # 布局 RAM 表与 blob 编解码（纯函数）
│   ├── scene_store.c       # 场景 RAM 表与 blob 编解码（纯函数）
│   ├── effects.c           # 8 种灯效像素计算（纯函数）
│   ├── gamma.c             # gamma 表 + 亮度乘算（纯函数）
│   ├── ble_link.c          # NimBLE GATT / 广播 / RX 回调 / TX notify
│   ├── led_engine.c        # 共享状态所有者 + latest-wins 邮箱 + 渲染任务
│   └── state_store.c       # NVS 防抖写入
├── test/
│   ├── test_protocol.c     # host 单测：argv[1] 读向量 + 逐 case 断言（工单 #4 决策 3 形态）
│   └── run-tests.cmd       # gcc 编译纯 C 子集 + 传向量绝对路径 + 缺文件 exit 2
└── CMakeLists.txt / sdkconfig.defaults
```

模块化的理由（工单 #2 扬弃「单文件」）：纯函数模块（protocol / command / layout / scene / effects / gamma）不依赖 FreeRTOS/NVS/led_strip，可被 host 单测直接编译——可测性本身就是架构约束，**不可 host 编译的逻辑不许进纯模块**。

初始化顺序（lumen 已验证）：`nvs_flash_init` → `state_store`（起存储任务）→ `led_engine`（恢复状态 → 建句柄 → 起渲染任务 → 首次渲染）→ `ble_link`（nimble 初始化 → GAP/GATT → 广播）。NVS 必须在 led_engine 之前（恢复状态发生在引擎初始化内部）。

#### FreeRTOS 任务模型（ESP32-C3 单核）

| 任务 | 优先级 | 栈 | 职责 |
|---|---|---|---|
| NimBLE 主机任务 | **21**（IDF 硬编码，不覆盖） | 4096 | GATT/GAP 回调、RX 写回调。所有协议处理在这个上下文 |
| 渲染任务 | **4** | 4096 | 等二值信号量；醒来取最新快照 → scene_compose → gamma → `led_strip_refresh()` |
| 存储任务 | **2** | 3072 | 等信号量 + debounce，然后写 NVS |
| IDLE / app_main | 0 / 1 | — | 初始化完即返回 |

优先级理由（单核是设计前提）：主机任务最高，因为任何比它高的任务长时间运行都会推迟射频/连接事件，直接表现为断连；渲染任务低于主机任务，因为 `led_strip_refresh()` 是阻塞调用，期间 RMT 在 ISR 跑，主机任务必须能随时抢占；存储任务最低，flash 写期间会短暂关 cache，不能拖累渲染与协议栈。

**BLE 回调允许 / 禁止**（ RX 回调运行在主机任务上）：

- 允许：拷贝 mbuf 到栈上定长缓冲 → 解帧信封 → reducer 算新状态 → `commit`（O(1)：写共享状态 + 邮箱 + 信号量）→ 发 ACK → 打**一行**汇总日志（cmd/seq/len/result）。
- 禁止：刷灯（`led_strip_*`）、写 NVS（`nvs_*`）、大段日志或 hex dump、阻塞等待（`vTaskDelay` / 等渲染）、长持锁。

#### NVS 持久化

| 键 | 内容 | 落盘时机 | 上限 |
|---|---|---|---|
| `state` | 整机状态 blob v1（32 B，magic + 版本 + 字段） | 变更后 **500ms debounce** | 32 B |
| `layout` | 布局 blob `LML1`（2824 B 设计值） | `LayoutCommit` **立即** | 4096 B |
| `scene0/1/2` | 场景 blob `LMS1` ×3 | 场景编辑后 **2s debounce** | 12288 B |

- blob 格式 = magic(4) + 版本(1–2) + 字段；解码校验（长度精确、magic、版本、区间互斥、取值域），**任一失败整份拒绝回默认值**，不做「尽量解析」。
- debounce 策略的理由：状态是高频小变更（拖动亮度），500ms 只写最后一次快照；场景是低频大 blob（≤12KB），2s 防抖避免编辑期反复擦写。flash 磨损是真实成本，防抖是唯一的节流机制。
- 上电无有效 blob → 出厂默认：全黑、亮度 128、`strip_power_mask=0xFF`、strip_count=1。
- NVS 写失败 → 异步 Event `0x81`（ACK 已发，只能异步上报）。

#### 渲染管线

```
渲染任务醒来（信号量）→ 取最新快照 → 自检激活？
  ├─ 是：红→绿→蓝→白 各 500ms 覆盖全部链（忽略布局），任何状态改变命令取消自检
  └─ 否：按链：像素缓冲清零（灰缝恒黑）
       → 逐部位：算播放头 (now − origin) mod 轴总长（闭式解，不累加）
       → 取当前步 layer0/layer1（layer1 空 → 覆盖；非空 → 按亮度叠加）
       → 效果像素计算（按相位模式生成逻辑像素）→ 按段区间散回物理灯珠
       → 门控：链开关 && 整机开关 && 部位开关，否则保持黑
       → 整帧一次：亮度 × 层 level → gamma → RMT 刷新（画面相同则跳过）
```

- 播放头是**闭式解**：只存 `origin_ms`，步号与步内时间由 `(now − origin)` 一次算出，不累加——30 分钟实测残差 0ms 的设计来源。
- 部位开关只灭灯、不停时钟；`ActivateScene` 硬切时全部部位播放头重置（唯一另一个打断点）；`LayoutCommit` 成功后重置该链播放头（唯一允许打断时钟的结构改动）。
- 渲染任务独占灯带句柄；`led_strip_set_pixel + refresh` 非原子，禁止并发刷新；用同步 `refresh()`（阻塞但渲染任务无别的事可做；主机任务可抢占）。
- 灯珠数重建（SetLedCount）：渲染任务重建句柄，重建期间其它命令照常进邮箱；重建完成 ACK；减少数量时先用旧数量整条写 0 再删句柄（WS2812B 会锁存最后一帧）。

#### latest-wins 邮箱

```
BLE 回调：commit(next) → lock → s_state = next; s_mailbox = next; dirty = true → unlock
          → give(二值信号量) → request_save（重置 debounce）

渲染任务：take(信号量, ∞) → lock → dirty ? snapshot = mailbox : state → dirty = false → unlock
          → render_snapshot(snapshot)（出锁再刷灯）
```

- 二值信号量只保留一个 pending 唤醒：连续 N 次 commit 只让渲染任务醒一次，醒来时邮箱已被最后一次提交覆盖——**永远不排队旧帧**。
- 相同快照跳过：渲染任务记住上次写进灯带的像素，状态没造成像素变化时不调用 `set_pixel`/`refresh`。
- 空闲不空转：渲染任务唯一阻塞点是信号量，无固定帧率、无轮询。

### 3.3 小程序端

#### 页面结构

| 页面 | 职责 |
|---|---|
| 连接页（设备 tab） | 扫描 `LUMEN-XXXX`（Service UUID 过滤 + RSSI）→ 点设备卡连接 → 连接状态条 |
| 控制页 | 整机开关 / 亮度滑块 / 每链开关与灯珠数 / 场景切换 / 自检入口 |
| 部位编辑器 | 灯珠方格拖选划分部位 + 名字 + 相位模式；`LayoutCommit` 整份提交 |
| 场景编辑器 | 每部位时间轴：步数 / 每步时长 / 两层灯效 / 循环档；增量保存无「应用」按钮 |
| 隐藏日志面板 | 连点版本号 5 次开启（组件级，不占页面路由） |

UI 信息架构的最终组织依赖骨架工单落地后 sketch（地图 Not-yet-specified 项），本表是约束不是定稿：连接与控制必须分离（连接是低频操作），部位/场景编辑必须是独立页面（编辑是高频多步交互）。

#### ControlSession 会话层

- 页面不直接调 `wx.*`：所有 BLE 细节封在传输层，会话层只拿一个「传输层」接口。
- 会话层职责：语义命令（setBrightness / layoutCommit / sceneStep…）→ 串行下发（一帧一 ACK）→ ACK 按 seq 匹配（超时 600ms 重试一次）→ 多帧报告按收尾帧聚合。
- 重连后 UI 重建的权威路径：读 State(32B) → QueryStripConfig → 每条 `part_count>0` 的链 QueryLayout → QueryScene(当前场景) → QueryDeviceInfo。上限与能力全部从设备读，不硬编码 8/8/8/3。
- 断线是唯一重连触发源；`10006`（连接断开）不重试写，走重连；`10008` 视为「notify 后立即写」踩坑信号，加间隔重试一次；`10001` 非致命（适配器未就绪，等状态事件）。
- iOS fail state 0–4（未知/重置中/不支持/未授权/未开启）映射为可读文案，不报错退出。

#### Writer + Throttle（20Hz latest-wins）

- 写入串行化：同一时刻最多一帧在飞（原型 `writeQueue` 模式的提炼）。
- 连续量（亮度/颜色类）20Hz 节流 + latest-wins：同通道只保留最新值，节流窗口内新值覆盖旧值。开关类命令可重传一次（幂等安全）；连续量永不重传。
- ACK 超时只作为「可能断线」信号触发连接检查，不作为重传连续量的理由。
- MTU 分包：单帧 > `chunk_capacity − 1` 时自动分片（ctrl 字节 FIRST/LAST/序号），重组超时 1000ms 由设备侧守。

#### 自动回连

- 断线后按 **1s / 2s / 4s** 退避有限次静默重连；成功 → 走权威重建路径；失败 → 明确显示「未连接」+ 手动入口，不无限空转。
- 缓存 deviceId，进前台静默重连（原型已验证模式）。

#### Mock 传输层（演示模式）

- 无真机记录时自动开启：3 台虚拟设备，Mock 传输层与真实传输层**同形、同一套接口**。
- 会话层没有任何 mock 分支——它只拿到一个传输层，所以演示与生产共用同一套业务代码。这是「测试文化」在小程序端的延伸：Mock 场景（normal/slow/flaky/offline）继承原型 `BLE_MOCK` 模式，进 L2 测试。

#### 隐藏日志面板

- 连点版本号 5 次开启；**200 帧环形缓冲**；可暂停（冻结视图、继续记录）/ 清空 / 复制。
- 每行：时间 + 方向 + hex + 解析后的人话。与固件串口日志按 seq 对齐（时间戳不要求跨端同步）。

### 3.4 后端

```
server/
├── src/
│   ├── index.ts          # Fastify 启动、插件注册
│   ├── db.ts             # SQLite 连接、迁移（两表两视图）
│   ├── auth.ts           # app token / Basic Auth 双鉴权
│   └── routes/
│       ├── usage.ts      # /api/v1/** 写方法（app token）
│       └── admin.ts      # /admin/** 只读看板（Basic Auth，写方法 405）
└── tests/                # vitest + node:sqlite（L3）
```

- **两表**：`users`（openid / 昵称 / 创建时间）、`usage_logs`（一条 = 一次「谁 × 哪台 × 什么时候连过」的连接会话，**不是心跳**；`clientEventId` 幂等键支持断网补报）。
- **两视图**：`v_devices`（按 `device_key` 聚合：连接次数、最后连接时间、使用手机数）、`v_users`（按用户聚合）。
- **device_key 归一**（优先级）：设备自报 MAC（`hw:…`，来自 DeviceInfoReport 的 `hw_id`）> 广播名（`name:LUMEN-XXXX`）> 平台 deviceId（`raw:…`）——同一台设备跨手机聚成一行。具体实现依赖小程序骨架定下 MAC 上报方式（地图 Not-yet-specified 项），spec 只锁优先级语义。
- **双鉴权**：写方法 `/api/v1/**` 用 app token；只读看板 `/admin/**` 用 Basic Auth，且**写方法一律 405**（405 是语义不是 fallback——看板永不可写）。
- 后端是旁路：小程序上报失败静默排队补报（幂等键），控制链路零影响；后端永远不存灯光配置。
- 技术选型：Fastify + SQLite + `node:sqlite`（Node 内置，免原生编译；vitest 3.2 支持，工单 #10 结论）。

### 3.5 测试工具链

#### L1–L5 分层（按环境成本划分，不是按目录）

| 层 | 范围 | 环境成本 | 默认跑 |
|---|---|---|---|
| L1 固件 host 单测 | gcc 编译纯 C 子集 + 协议向量逐 case 断言 + reducer/effects/gamma 边界 | gcc + node | 是 |
| L2 小程序单测 | vitest：codec 向量断言、节流 latest-wins、写入串行化、错误码分诊、页面行为（页面底座） | 无 | 是 |
| L3 后端单测 | vitest + node:sqlite：两表两视图、device_key 归一、双鉴权、405 | 无 | 是 |
| L4 UI 渲染回归 | miniprogram-automator 驱动真实渲染层（点得动 + 设备真收到）；**须 `--auto-port`** | 微信开发者工具 + 自动化端口 | 否 |
| L5 真机 e2e | 自研 Python bleak 网关（BLE → JSON stdio）+ pyserial DTR/RTS 复位 | 真机 + python + bleak | 否 |

- 编排器：`node scripts/test-run.mjs [--release]`，前置条件**主动探测**（缺环境 → SKIP，不是跑一遍失败再猜）。
- CI 必跑面（工单 #4 决策 4 层 2）：`check:vectors` + `gen:vectors:check` + L1 + L2。L4/L5 无法在 CI 跑，由 SKIP 可见性处理。
- 不属于五层的取证工具（协议探针、相位漂移实测、分片压力测试）产出一次性证据，写 `docs/evidence/`，不进编排器。

#### 测试文化（本工程的红线）

1. **「没跑」必须可见**：三态 PASS / FAIL / SKIP，SKIP 必须带原因；层内 skip（如缺 node 时的向量自检）同样进「未验证清单」。**没有未验证项时明确写「本轮没有未验证的层」**。
2. **SKIP 而非 PASS**：缺自动化端口、缺真机、缺 bleak——报 SKIP 并列出缺什么，绝不染绿。发布级报告有层没跑时，标题下必须有未覆盖声明。
3. **真机标「未验证」**：真机验收项在自动化报告里是「未验证」，不是「通过」——只有带日期的真机验收记录（docs/evidence/）才是通过证据。
4. **测试断言对象 = 产品代码行为**：两端协议测试断言产品代码的 encode/decode 输出，不在测试里重写实现（假绿的最大来源）。
5. **数字只引最近一次报告**：文档不写「当前基线」的具体数字，只写指针；手抄的数字每抄一次漂一次。
6. **测行为不测实现**：页面测试走页面自己的事件处理器 + 断言设备侧状态；直接 `setData` 造期望状态不算证明。

## 4. 继承与扬弃（相对原型 bt-light）

### 4.1 继承（已验证，直接进 spec）

- **硬件接线**：GPIO 0/1/3/4/5/6/7/10 对应灯带 1–8（GPIO10 建议外部 10kΩ 下拉）；每路数据线串 330Ω 电阻；WS2812B **独立 5V 供电 + 与 ESP32-C3 共地**（不共地数据信号无参考地，灯带乱闪或不亮）；**74AHCT125 电平转换**（3.3V 直驱 5V 灯带 VIH=3.5V 不达标，必须进 BOM，不能用 74HC125）；最多 8 链 × 100 颗。
- **GRB 颜色顺序**：字节帧颜色字节顺序沿用 GRB（原型 FastLED `COLOR_ORDER=GRB` 已验证颜色正确）。
- **亮度上限 `max_brightness = 200`**：64 灯满白实测约 3.8A，200 亮度约 3.0A，给蓝通道留线损余量；协议 State 暴露该上限，小程序滑块最大值读它，不硬编码。
- **小程序交互模式**：两页架构（连接 → 控制）+ 自动重连（有限退避）+ 写队列串行化 + MTU 分包 + Mock 场景（normal/slow/flaky/offline）。
- **UUID 组与广播名前缀**：UUID 沿用 FFE0/FFE1/FFE2 兼容组；广播名前缀统一 `LUMEN-`（固件 `BLE_NAME_PREFIX` 与小程序 `namePrefix` 必须一致）。

### 4.2 扬弃（为什么换）

| 原型 | 本项目 | 理由 |
|---|---|---|
| Arduino + FastLED 3.6.0 | **ESP-IDF + led_strip（RMT）** | FastLED 的 RMT 驱动在 C3 上 8 路刷新内存管理不透明；NimBLE-Arduino 回调签名有破坏性变更；PlatformIO 靠 fix.py 打补丁说明 Arduino 层抽象泄漏。ESP-IDF 原生组件直接管 RMT 通道/中断/缓冲，`sdkconfig` 直配 |
| ASCII 文本命令（`b128\n`） | **字节级二进制帧契约** | 不可扩展、解析脆弱（两端正则/atoi）、无完整性校验。字节帧：固定头 + CRC + 分片重组 + 版本内嵌 + 双端共读向量 |
| 单文件 main.cpp（357 行） | **模块化 firmware/main/** | 单文件无法单测（全部逻辑耦合在 loop() + 全局状态）；模块化后纯函数模块可 host 编译，可测性成为架构约束 |

## 5. 验收基线（目标，非已达成）

完整实现应当能通过五层验证。数字是蓝图 §8 参考实现达到的水平，作为**验收目标**：

| 层 | 基线（目标） |
|---|---|
| L1 固件 host 单测 | 12976 断言 + 113 条协议向量（新项目向量数以最近一次 gen 产出为准） |
| L2 小程序单测 | 1203 用例 |
| L3 后端单测 | 140 用例 |
| L4 UI 渲染回归 | 48 条 |
| L5 真机 e2e | 7 条用例 + 协议探针 58 项 + 整合验收 31 项（含断电恢复） |

**性能基线（目标）**：800 颗灯珠 / 64 播放头下渲染 round ≈ 5.53ms（预算 50ms）；播放头相位漂移 30 分钟实测残差 0ms。

**已知物理边界**（设计时接受，属硬件问题非代码缺陷）：相机拍到的色域压缩、长线压降、多链共 5V 供电时的电流阶跃。

骨架阶段（地图终点）的验收不是这些数字，而是：四端各一个能 build + 跑通 smoke test 的骨架，L1–L3 在 CI 上 SKIP 语义正确，L4/L5 明确标「未验证」。

## 6. 非功能特性（可靠性设计）

| 风险 | 设计应对 |
|---|---|
| 高频拖动排队导致「追尾」 | 两端 latest-wins：小程序 20Hz 节流 + 固件邮箱只保留最新快照 |
| BLE 与灯带刷新互相拖累 | 任务优先级（21 > 4 > 2）+ 渲染出锁刷灯 + 相同画面跳过刷新 |
| 灯珠数重建时的并发冲突 | 渲染任务独占句柄；重建期间其它命令照常进邮箱，重建后按最新状态重绘 |
| flash 磨损 | 状态 500ms debounce、场景 2s debounce，只写最后一次快照 |
| 长时运行时钟漂移 | 播放头闭式解 `(now − origin)`，不累加 |
| iOS 超长写入静默失败 | 分片重组 + 单分片帧规范 + 帧总长上限 240B + 小程序 encode 后硬断言 |
| 坏帧 / 旧版本帧 | magic/长度/CRC/版本逐层校验，明确错误码，超长帧整帧拒绝不截断 |
| 后端不可用 | 后端是旁路：日志本地排队补报（幂等键），控制链路零影响 |

## 7. 边界：明确不做什么

- 不做云端控制 / 远程控制（后端永不进控制链路）。
- 不做账号体系（用户标识只是「能区分手机」的稳定串或 openid）。
- 不做设备归属、共享、角色权限（扫到就能连，个人测试阶段的前提）。
- 不做 OTA、不做配置同步、不存灯光配置副本。
- 不做协议向后兼容（版本即契约，断崖升级）。
- 不做多硬件抽象（ESP32-C3FH4 锁死，不抽象）。
- 不在本 spec 范围内做完整功能实现（骨架之后的编码工作是下一个 effort）。

## 8. 与蓝图 / 参考实现的差异

| 项 | 蓝图 / lumen | 本项目 | 原因 |
|---|---|---|---|
| 协议版本 | lumen v5（0x05） | `protocol_version:5` 承袭 | 便于与 lumen 113 条向量逐字节对照迁移；是契约血统标识不是迭代次数（工单 #4） |
| 固件版本 | lumen `0x0500`（与协议纠缠） | `"0100"`（v1.0，独立于协议） | 修 lumen 的版本纠缠坑（工单 #4 决策 5） |
| 向量文件 | lumen `protocol-testvectors-v5.json`（带版本后缀，多代并存） | `docs/protocol-testvectors.json`（无后缀，旧版删除） | 修 lumen 坑 #1：文件名带版本导致旧文件被误消费 |
| State 布局 | lumen v5 32B（无颜色摘要） | 同 32B 语义（power/brightness/max_brightness/strip_count/strip_power_mask/active_scene/layout_valid/led_count[8]/part_count[8]） | 一致；字节级以 protocol.md 为准 |
| 灯效类型 | lumen 8 种 + 空层（static/breath/rainbow/streak/flash/heartbeat/off/random） | 同 8 种 + `0xFF` 空层 | 蓝图 §3.6 已锁定 |
| 层编码 | lumen 9B（type + 7 参数 + level） | 同 9B；参数块细节以 protocol.md/effects 文档为准 | 一致 |
| L5 网关 | lumen：复用 `.zcode/skills/verify-lumen-ble` 的 drive.mjs 包住 | **自研 Python bleak 网关**（BLE → JSON stdio） | 新仓库无 skills 资产；自研更可控（工单 #10） |
| L1 框架 | lumen：自研断言宏 + TESTCOUNT 前缀 | 同自研框架 + TESTCOUNT（工单 #10：Unity 不必要） | 零依赖、断言计数可解析 |
| 小程序语言 | lumen：TS | TS（新仓库直接 TS 化，无 CommonJS 过渡期） | 工单 #4 过渡期说明在新仓库不适用 |
| CI | lumen：无 CI（靠约定） | **CI 硬 gate**（check:vectors + gen --check + L1 + L2） | 修 lumen 坑 #5：同 commit 纪律不可执行 |
| 广播名 | lumen `Lumen-XXXX` | `LUMEN-XXXX`（全大写） | 工单 #2：统一前缀规范 |

## 9. 遗留风险与未验证项

- **本 spec 的所有硬件与协议数字来自蓝图与 lumen 参考实现，未在 bt-light/lumen 新仓库上实测**：GPIO 接线、GRB、5V 供电、74AHCT125、max_brightness=200、渲染性能 5.53ms——全部是「继承的已验证结论 + 目标值」，骨架阶段不重新验证。
- **C 端极简扫描器在数百条向量规模下的行为未实测**（工单 #4 残留风险；预期无问题，扫描是线性无状态）。
- **CI 未在本仓库建立**（#8 落地时验证 runner 上 gcc 可用性与路径）。
- **ESP-IDF host 编译的纯 C 源文件清单未定**（#5 组件划分落地后固化进 run-tests.cmd）。
- **小程序 UI 信息架构未 sketch**（地图 Not-yet-specified；#6 骨架完成后 sketch 决定最终页面组织）。
- **场景编辑器交互模型（增量写 vs 整份写）未定**：spec 锁定「增量写 + 2s 防抖落盘」（蓝图 §3.5），具体编辑器交互依赖骨架后 prototype。
- **后端 device_key 归一的具体实现未定**：依赖小程序骨架定下 MAC 上报方式。
- **firmware_version `"0100"` 与 2 字节小端的转换断言归 #5/#6 实现**（工单 #4 残留风险）。