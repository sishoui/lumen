# bt-light 协议规格（承袭 lumen v5 契约）

**状态**：定稿（2026-11-23，工单 #15）。本文是四端共同的**字节级契约**（人读），
机器可读的可执行副本是 `docs/protocol-testvectors.json`（gen 产出，工单 #4 定稿的单点持有策略）。

**唯一真相分层**：

| 内容 | 真相位置 |
|---|---|
| 本文（帧布局 / 命令 / 报告 / 结果码的语义） | `docs/protocol.md` |
| 字节测试向量 | `docs/protocol-testvectors.json`（`npm run gen:vectors` 产出） |
| 向量生成与校验 | `scripts/gen-protocol-testvectors.mjs` / `scripts/check-protocol-testvectors.mjs` |
| 为什么这样设计（边界与取舍） | `docs/spec.md` 第 2 章（spec 不复制字节细节） |

改协议 = 本文 + 向量 + 固件实现 + 小程序实现 + 两端测试，同一个 PR（SOP 见 §12）。

> **协议版本 `protocol_version: 5` 是契约血统标识**：承袭 lumen v5 的字节级契约，
> 便于与参考实现的测试向量逐字节对照迁移，不表示本项目迭代了 5 轮。
> 固件版本 `firmware_version: "0100"` 与协议版本**完全独立**（升固件不被迫升协议版本）。

---

## 1. 角色与链路

- **小程序**是 BLE central：写 RX、订阅 TX、读 State。
- **设备**是 peripheral：单连接（NimBLE `CONFIG_BT_NIMBLE_MAX_CONNECTIONS=1`），不配对不绑定；断开后重新开始广播。
- 所有多字节字段**小端**，唯一例外是 `hw_id`（6 字节 BT MAC，按打印顺序原样给出）。
- 广播名 `LUMEN-XXXX`（MAC 末两字节大写 hex，仅供人眼识别，**不是身份**；身份是 `hw_id`）。

### 1.1 GATT 服务

| 特征 | UUID | 属性 | 用途 |
|---|---|---|---|
| Service | `6c756d65-6e00-4b1e-9a3c-000000000001` | primary | — |
| RX | `6c756d65-6e00-4b1e-9a3c-000000000002` | `WRITE_NO_RSP` | 小程序 → 设备（命令帧） |
| TX | `6c756d65-6e00-4b1e-9a3c-000000000003` | `NOTIFY` | 设备 → 小程序（ACK / Event / Report） |
| State | `6c756d65-6e00-4b1e-9a3c-000000000004` | `READ` | 32 字节整机状态裸读（布局与 StateReport 相同） |

### 1.2 MTU 与写容量

- 设备请求 MTU 247；Android 小程序 `wx.setBLEMTU(185)`；两端在 MTU 未知时按 23 处理。
- `chunk_capacity = min(mtu − 3, 180)`；单次 BLE 写的数据上限 = `chunk_capacity − 1`（1 字节分片头），下限 19。

---

## 2. 常量

| 常量 | 值 | 说明 |
|---|---|---|
| `MAX_LEDS` | 100 | 单条灯带的灯珠上限 |
| `MAX_STRIPS` | 8 | 灯组（引脚）数 |
| `MAX_PARTS` | 8 | **每条链**的部位数 |
| `MAX_PART_SEGS` | 8 | **每个部位**的灯珠段数 |
| `MAX_STEPS` | 8 | **每个部位**的步骤数 |
| `MAX_SCENES` | 3 | 设备侧场景数 |
| `MAX_LAYERS` | 2 | 每步最多两层（底层 + 叠加层） |
| `NAME_BYTES` | 24 | 部位名 / 场景名的字节上限（UTF-8，不强制字符边界） |
| `STEP_MIN_MS` | 100 | 步骤时长下限 |
| `STEP_MAX_MS` | 60000 | 步骤时长上限 |
| `NO_EFFECT` | `0xFF` | 层类型表示「该层为空」 |
| `LAYER_LEVEL_MAX` | 100 | 层亮度上限（百分比） |
| `MAX_BRIGHTNESS` | 200 | 整机亮度上限（State 暴露，小程序滑块读它，不硬编码） |
| `MAX_PAYLOAD` | 232 | 单条逻辑帧的载荷上限 |
| `MAX_FRAME` | 240 | `8 + MAX_PAYLOAD` |
| `MAX_CHUNK_DATA` | 179 | 单次 BLE 写的数据上限（§4） |
| `LAYER_BYTES` | 9 | 层编码定宽（§9） |
| `STATE_BYTES` | 32 | State / StateReport 载荷（§8.2） |
| `LAYOUT_PART_BYTES` | 29 | `LayoutPart` 载荷（§7） |
| `LAYOUT_REPORT_BYTES` | 45 | `LayoutReport` 载荷（§8） |
| `SCENE_STEP_BYTES` | 24 | `SceneStep` / `SceneStepReport` 载荷（§7） |
| `SCENE_NAME_BYTES` | 26 | `SceneName` / `SceneListEnd` 载荷（§7） |

`strip_id` / `part_id` / `seg_id` / `step_index` / `scene_id` 均从 **0** 起。

---

## 3. 帧格式

### 3.1 逻辑帧

```
偏移  宽度  字段
0     1     magic   = 0xA6
1     1     version = 0x05
2     1     command
3     1     seq
4     2     length（载荷字节数，小端，0 ≤ length ≤ 232）
6     N     payload
6+N   2     crc16（小端）
```

- 整帧长度 = `8 + length`，上限 **240**。超长帧**整帧拒绝**，不截断执行、不缓冲等待后续包。
- `crc16` 覆盖前 `6 + length` 字节（含帧头 6 字节与载荷）。
- **CRC16 = CCITT-FALSE**：poly `0x1021`、init `0xFFFF`、不反转、无末尾异或；
  标准校验值 `"123456789"` → `0x29B1`。

### 3.2 校验顺序（固定）

```
magic → version → length → crc16 → command → 载荷长度 → 载荷取值
```

- **长度错误优先于校验和**（长度不对无法定位 CRC 字节）。
- 每一步失败回对应错误码整帧拒绝（§6），任何错误都不改变设备状态。

### 3.3 帧示例

`SetPower(on)`、`seq = 1`：

```
A6 05 01 01 01 00 01 <CRC16 小端>
```

CRC16 覆盖 `A6 05 01 01 01 00 01`，整帧 9 字节。

---

## 4. BLE 分片

每个分片带 1 字节 ctrl：

```
bit7   FIRST（该帧的第一个分片）
bit6   LAST （该帧的最后一个分片）
bit5..0 分片序号（从 0 起）
```

- 分片数据容量 = `chunk_capacity − 1`（§1.2）；重组超时 **1000ms**（自上一个分片起算），超时丢弃半帧。
- **单分片帧的 ctrl 恒为 `0xC0`**（FIRST|LAST，序号 0）——不许发裸帧。
- 重组后的逻辑帧再走 §3.2 校验；notify 侧（设备 → 小程序的多帧报告）同样要重组。

---

## 5. 版本

- 设备只接受 `version = 0x05`，其它版本回 `UnsupportedVersion`（`0x07`）。
- JSON 顶层 `protocol_version: 5`、每帧内 version 字节 `0x05`、两端 `PROTOCOL_VERSION` 常量，
  三者是同一语义的三份表示，必须相等（由 check:vectors 与两端测试各自守护）。
- `firmware_version`（字符串 `"0100"` = v1.0）是**字符串语义的 2 字节**，线上小端（`00 01`），
  由 `DeviceInfoReport`（`0x88`）给出；与协议版本完全独立。

---

## 6. 结果码

| 码 | 名称 | 说明 |
|---|---|---|
| `0x00` | OK | |
| `0x01` | InvalidParam | 取值越界 / 结构非法 / 区间重叠 |
| `0x02` | UnknownCommand | 未知命令或退役命令 |
| `0x03` | BadChecksum | |
| `0x04` | BadLength | 载荷长度不符 |
| `0x05` | Busy | 灯珠数重建中（**唯一可重试**的错误） |
| `0x06` | StorageFailed | 落盘失败（ACK 之后只能异步上报 Event `0x81`） |
| `0x07` | UnsupportedVersion | |
| `0x08` | BadMagic | |
| `0x09` | InternalError | |
| `0x0A–0xFF` | — | 保留 |

- **未知命令必须显式拒绝**（回 `0x02`），不静默成功——这是「需要升级固件」在协议层的唯一表达。
- Busy 可重试（稍后重发同一帧）；其余错误不可重试。连续量（亮度/颜色类）永不重传。

---

## 7. 命令（小程序 → 设备）

### 7.1 基础族 `0x01`–`0x07`

| 码 | 名称 | 载荷 | 作用 |
|---|---|---|---|
| `0x01` | `SetPower` | 1 | 整机开关 `0/1` |
| `0x02` | `SetBrightness` | 1 | 整机亮度 0–255（设备按 `max_brightness` 钳位） |
| `0x05` | `QueryState` | 0 | ACK 后补一条 `StateReport` |
| `0x06` | `SetLedCount` | 3 | `strip_id, count_lo, count_hi`（1–100） |
| `0x07` | `SelfTest` | 0 | 红→绿→蓝→白，各 500ms |

`0x03` / `0x04` 已退役（历史命令），收到回 `UnknownCommand`，**编号不复用**。

### 7.2 链路族 `0x1B`–`0x1D`

| 码 | 名称 | 载荷 | 作用 |
|---|---|---|---|
| `0x1B` | `SetStripPower` | 2 | `strip_id, on`（整条链的开关） |
| `0x1C` | `QueryStripConfig` | 0 | ACK 后补 `StripConfigReport` |
| `0x1D` | `QueryDeviceInfo` | 0 | ACK 后补 `DeviceInfoReport` |

### 7.3 布局族 `0x20`–`0x24`

布局是**全局一份**（三个场景共用），整份提交立即落盘。

| 码 | 名称 | 载荷 | 作用 |
|---|---|---|---|
| `0x20` | `LayoutWrite` | 2 | `strip_id, part_count`：声明该链的部位数并清空其部位 |
| `0x21` | `LayoutPart` | 29 | `strip_id, part_id, name_len, name[24], seg_count, phase` |
| `0x22` | `LayoutSeg` | 5 | `strip_id, part_id, seg_id, start, end`（闭区间） |
| `0x23` | `LayoutCommit` | 0 | 校验整份布局并**立即落盘** |
| `0x24` | `QueryLayout` | 1 | `strip_id`：ACK 后逐部位 `LayoutReport` + 一条 `LayoutListEnd` |

- `name_len ≤ 24`；`name` 不足 24 字节的部分**必须补 0**（解码端只信任 `name_len`）。
- `phase ∈ {0 连续, 1 各自起点}`，是**每部位**的布局属性（与名字、段数同命令下发，随布局落盘）。
- `LayoutSeg` 设备侧校验 `start ≤ end`、`end < led_count`、`seg < seg_count`、且与同链其它部位的所有段**互斥**；违反 → 整个命令 `InvalidParam`，旧布局保持不变。
- `LayoutCommit` 成功后重置该链播放头（唯一允许打断时钟的结构改动）。

### 7.4 场景族 `0x25`–`0x29`

场景编辑是**增量的**（无「应用」按钮），2s 防抖落盘。

| 码 | 名称 | 载荷 | 作用 |
|---|---|---|---|
| `0x25` | `ScenePart` | 6 | `scene_id, strip_id, part_id, step_count, loop, on` |
| `0x26` | `SceneStep` | 24 | `scene_id, strip_id, part_id, step_index, duration_lo, duration_hi, layer0[9], layer1[9]` |
| `0x27` | `SceneName` | 26 | `scene_id, name_len, name[24]` |
| `0x28` | `ActivateScene` | 1 | `scene_id`：硬切 + 全部部位从第 1 步重跳 |
| `0x29` | `QueryScene` | 1 | `scene_id`：ACK 后逐部位 `ScenePartReport`、逐步骤 `SceneStepReport`、一条 `SceneListEnd` |

- `ScenePart` 只有 `step_count` 真的变了才清空已有步骤；`loop` 三值见 §8.4；`on ∈ {0,1}`。
- `SceneStep` 是单步增量：直接写 RAM 表并标脏；`step_index ≥ step_count` 时 `InvalidParam`。
  两层的混合方式**不在线上**：`layer1` 为空 → 覆盖；非空 → 按亮度叠加。

---

## 8. 设备 → 小程序报告

### 8.1 报告清单

| 码 | 名称 | 载荷 | 说明 |
|---|---|---|---|
| `0x80` | `ACK` | 2 | `[原命令字, 结果码]`，seq 回显；含义是「已接受并写入 RAM」，不保证已渲染或已落盘 |
| `0x81` | `Event` | 2 | `[event_code, detail]`，seq 恒 0；异步事件（目前仅 `0x01` 存储失败，detail = 触发写入的命令字） |
| `0x82` | `StateReport` | 32 | §8.2，seq 回显 `QueryState`；只在查询时发送，设备不主动推送 |
| `0x87` | `StripConfigReport` | 24 | §8.3，8 × `[strip_id, gpio, flags]`，引脚表只读 |
| `0x88` | `DeviceInfoReport` | 15 | §8.5 |
| `0x89` | `LayoutReport` | 45 | §8.6，与 `LayoutPart` 同构（方向相反） |
| `0x8A` | `LayoutListEnd` | 2 | `[strip_id, part_mask]`（bit i = 部位 i 有段） |
| `0x8B` | `ScenePartReport` | 6 | 与 `ScenePart` 同构（方向相反） |
| `0x8C` | `SceneStepReport` | 24 | 与 `SceneStep` 同构（方向相反） |
| `0x8D` | `SceneListEnd` | 26 | 与 `SceneName` 同构，带场景名 |

- **多帧报告共用一个 seq**，以收尾帧（`LayoutListEnd` / `SceneListEnd`）判定结束——不是靠超时猜。
- 校验语义：载荷长度与命令要求不符 → `BadLength`；载荷取值非法 → `InvalidParam`。

### 8.2 State（32 字节，StateReport 载荷 / State 特征裸读，同一解析器）

```
偏移  字段
0     power（0/1）
1     brightness（已按 max_brightness 钳位的生效值）
2     max_brightness（构建期上限）
3     strip_count（1-8）
4     strip_power_mask（bit i = 第 i 条链的开关）
5     active_scene（0-2）
6     layout_valid（0/1：设备上是否有已提交的布局）
7     reserved = 0
8..23  led_count[8]（u16 小端，每条链自己的灯珠数；未用的槽位为 0）
24..31 part_count[8]（每条链的部位数；未用的槽位为 0）
```

### 8.3 StripConfigReport（24 字节）

8 × `[strip_id(1), gpio(1), flags(1)]`；未分配的链 `gpio = 0xFF, flags = 0`。

### 8.4 循环字段（`loop`）

| 值 | 语义 |
|---|---|
| `0` | 不循环：走完停在最后一帧 |
| `1` | 全部循环：走完回到第 1 步 |
| `2` | 最后一步循环：前 N−1 步各播一次，之后原地重播末步 |

`> 2` 一律 `InvalidParam`。

### 8.5 DeviceInfoReport（15 字节）

```
0..1   firmware_version（u16 小端，"0100" = 0x0100 → 线上 00 01）
2..7   hw_id（6 字节 BT MAC，打印顺序）
8      max_leds（100）
9      max_strips（8）
10     max_parts（8）        —— 每条链
11     max_part_segs（8）    —— 每个部位
12     max_steps（8）        —— 每个部位
13     max_scenes（3）
14     caps：bit0 = 支持两层叠加；bit1 = fade（预留 0）
```

### 8.6 LayoutReport（45 字节，与 `LayoutPart` 同构）

```
0      strip_id
1      part_id
2      name_len（0-24）
3..26  name[24]（NUL 填充）
27     seg_count（0-8）
28     phase（0 连续 / 1 各自起点）
29..44 8 × (start, end)，未用的段为 0/0
```

只有 `seg_count > 0` 的部位才会被 `QueryLayout` 报出来；`part_mask` 与报告条数一致。

---

## 9. 层编码（`layer0` / `layer1`，9 字节）

`type(1) | param[7] | level(1)`；`level` 0–100 是本层母亮度。

| type | 名称 | param[7] 布局与规则 |
|---|---|---|
| `0x00` | 静态 static | `hue(2 LE) sat(1) 保留(4，必须 0)` |
| `0x01` | 呼吸 breath | `hue(2 LE) sat(1) period(2 LE) p5(1) flags(1)`；period 为 0 或 ≥ 334ms；p5 ≤ 100；flags 保留位必须 0 |
| `0x02` | 彩虹 rainbow | 同上；period 为 0 或 ≥ 200ms |
| `0x03` | 流光 streak | 同上；flags 低 4 位是密度，bit4–7 必须 0 |
| `0x04` | 爆闪 flash | 同上；flags 必须 0；period 为 0 或 ≥ 100ms |
| `0x05` | 心跳 heartbeat | 同上；flags 仅 bit0；period 为 0 或 500–1500ms |
| `0x06` | 熄灭 off | param 全 0 |
| `0x07` | 随机闪烁 random | 同上；flags 必须 0；period 为 0 或 ≥ 334ms |
| `0xFF` | 空层 | param 与 level **必须全 0** |

- `layer0` 必须非空（场景步骤）；`layer1` 可以为空。
- 参数语义（hue/sat/period/p5/flags 的量纲）沿用蓝图 §3.6 与 lumen effects 规格；本文锁定编码宽度与校验规则。

---

## 10. seq 语义

- 每条小程序 → 设备的命令带自己的 `seq`（0–255 循环），设备**原样回显、不去重**（命令都是绝对值，重传不会造成状态翻转）。
- ACK 的 `seq` 回显请求；多帧报告**全部用同一个 `seq`**，以收尾帧判定结束。
- 设备主动帧（`Event`）的 `seq` 恒 `0x00`。
- 小程序一次只发一帧、等 ACK 再发下一帧；`SceneStep` 的串行化由会话层保证，设备侧不排队。

---

## 11. 测试向量

- **唯一机器可读向量源**：`docs/protocol-testvectors.json`（无版本后缀；版本进 JSON 内容的
  `protocol_version` 字段，不进文件名）。
- 生成器 `scripts/gen-protocol-testvectors.mjs`（持契约常量；`--check` 幂等模式：重新生成并与
  磁盘文件逐字节比对，不一致 exit 非 0）。独立校验器 `scripts/check-protocol-testvectors.mjs`
  （**只读 JSON，手抄常量表，不 import 生成器**——生成器自身的 bug 由它兜底）。
- 字段形态（与 lumen v5 同构）：`name / direction / command / command_name / seq / payload_hex /
  payload_len / frame_hex / frame_len / chunks_hex / frame_valid / result_code`（`note` 可选）。
  所有字节串**大写 hex**；`note` 取值禁止包含 `{}`、双引号、反斜杠（C 端极简扫描器的前提）。
- 语义约定：`frame_valid` 表示「这条命令应当成功」，不是「信封合法」。坏帧用例
  （`bad_magic` / `bad_length` / `bad_checksum` / 退役命令）是 `frame_valid: false` + 对应错误码，
  但**退役命令的信封必须完好**——证明拒收来自命令字退役，不是来自坏信封。
  `result_code` 是「该帧对应的请求的期望结果」：app_to_device 帧是设备应回的结果码；
  device_to_app 帧恒 0（帧本身合法），ACK 载荷内的结果码看 `payload_hex`。
- 双端消费：C 端 `fopen` + 极简扫描器（argv 传路径，缺文件 exit 2 大声失败）；TS 端
  `readFileSync` + `JSON.parse`。两端测试的断言对象是**产品代码的 encode/decode 输出**。
- 骨架期的 case 集合是最小子集（三条骨架命令 + ACK + 坏帧）；布局 / 场景 / 报告的向量
  随对应命令的实现在后续工单里扩充（每次扩充 = 改生成器 case 表 + 重跑 gen + 人工抽查 diff）。

---

## 12. 变更规则（改协议 SOP）

1. 改本文（`docs/protocol.md`）契约描述。
2. 同步改 `scripts/gen-protocol-testvectors.mjs` 常量 **和**
   `scripts/check-protocol-testvectors.mjs` 手抄常量表（两份独立，check 不许 import gen）。
3. `npm run gen:vectors` 重新生成向量；人工抽查 diff（尤其新增/修改 case 的字节）。
4. 改固件实现 + 小程序实现。
5. `npm run test` 全绿（check:vectors + gen:vectors:check + 各层测试）。
6. 同一个 PR 提交；CI 全绿才 merge。

三层执行机制：本地 `npm test` 前置 check（快速反馈）→ CI 硬 gate（全绿才可 merge）→
本文与 `docs/spec.md` §2.7 的软层说明（让人知道机制存在）。