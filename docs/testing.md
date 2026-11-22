# 测试怎么跑

这份文档独立成立：只读它就能知道 L4（UI 渲染回归）与 L5（真机 e2e）这两层
各验什么、改了某类代码该跑哪几层、报告在哪、探针怎么用。**所有测试数字的唯一
来源是最近一次报告**，本文只贴指针（spec 红线 5）。

L1/L2/L3 的契约与编排器见 docs/spec.md §3.5 与 AGENTS.md。本文件只覆盖 L4/L5
以及两个独立取证探针（probe-protocol.py / probe-acceptance.py）。

---

## 1. 五层分层回顾（spec §3.5）

层是按**环境成本**划分的，不是按被测代码的目录划分：

| 层 | 范围 | 环境成本 | 默认跑 |
|---|---|---|---|
| L1 固件 host 单测 | gcc 编译纯 C 子集 + 协议向量逐 case 断言 | gcc + node | 是 |
| L2 小程序单测 | vitest：codec 向量、节流 latest-wins、写入串行化、错误码分诊、页面行为 | 无 | 是 |
| L3 后端单测 | vitest + node:sqlite：两表两视图、device_key 归一、双鉴权、405 | 无 | 是 |
| L4 UI 渲染回归 | `scripts/verify-ui.mjs`：miniprogram-automator 驱动真实渲染层（点得动 + 设备真收到）；**须 `--auto-port`** | 微信开发者工具 + 自动化端口 | 否 |
| L5 真机 e2e | 自研 Python bleak 网关（BLE → JSON stdio）+ pyserial DTR/RTS 复位 | 真机 + python + bleak | 否 |

- 编排器：`node scripts/test-run.mjs [--release]`（**待 #16 落地**；当前骨架期 L4/L5
  直跑 `scripts/verify-ui.mjs` 与探针即可，环境缺失整层 SKIP、退出码 0）。
- CI 必跑面（spec §3.5）：`check:vectors` + `gen:vectors:check` + L1 + L2。L4/L5
  无法在 CI 跑，由 SKIP 可见性处理——`npm test` 跑 L4/L5 的别名会 SKIP 而非 FAIL。

---

## 2. L4 UI 渲染回归

### 2.1 它验什么

L4 用 miniprogram-automator 驱动微信开发者工具里的真实小程序，按 §0–§7 八节
组织断言。**完整实现目标 48 条**（spec §5），骨架期每节只挂 describe 壳 + 1 条
「壳就位」占位断言；48 条随页面实现逐个加。

| 节 | 断言对象 | 骨架期 |
|---|---|---|
| §0 启动 | 5 页注册、tabBar 两 tab、无白屏 | 壳 |
| §1 演示模式 | 无真机记录自动开、3 台设备 spec 形状差异可见 | 壳 |
| §2 设备 tab | 扫描列表、点卡连接、连接状态条、演示开关 | 壳 |
| §3 控制 tab | 整机开关 / 亮度滑块 / 每链开关与灯珠数 / 场景切换 / 自检入口 | 壳 |
| §4 部位编辑器（壳） | navigateTo 带参 stripId、占位渲染、返回后控制页镜像不丢 | 壳 |
| §5 场景编辑器（壳） | navigateTo 带参 sceneId、占位渲染、返回后控制页镜像不丢 | 壳 |
| §6 开关层级与镜像读回 | 切开关 → ACK → 镜像更新；亮度拖动跟手（latest-wins） | 壳 |
| §7 日志面板 | 版本号×5 唤出、环形 200 帧、暂停 / 清空 / 复制 | 壳 |

判定口径（spec 红线 6）：

- 「点得动」= 点击走页面自己的事件处理器（`mp.evaluate(() => getCurrentPages().pop().onXxxTap(...))` 或 automator click），断言对象是页面 data 与会话镜像，不 `setData` 造期望态。
- 「设备真收到」= 点完后从 MockDeviceRuntime 状态 / 日志面板读回。**骨架期 L4 的「设备」是演示模式虚拟设备，证明渲染 + 事件 + 会话栈通了；真机收到由 L5 证明。**

### 2.2 为什么住在 scripts/ 而不是 miniprogram/.auto/

`.auto/` 整个在 `.gitignore` 里，换台机器 clone 下来这一层就凭空消失了——而它是
唯一能发现白屏与 `bindtap` 全失效的一层。`scripts/verify-ui.mjs` 与真机探针、
串口工具同类：都是「需要外部环境」的脚本，必须进 git。

### 2.3 9501 是 IDE 的 HTTP 端口，不是自动化 ws

**必须 `--auto-port`**。固定命令形态（PowerShell 包装脚本须 UTF-8 with BOM）：

```powershell
& 'C:\Program Files (x86)\Tencent\微信web开发者工具\cli.bat' auto `
  --project '<repo>\miniprogram' --auto-port 9502 --trust-project
```

判据是 `netstat -ano | findstr :9502` 有 LISTENING。**不带 `--auto-port` 时 CLI
照样打印 `✔ auto` 但 ws 端口根本不监听**——这就是 L4 跑 SKIP 的最常见原因。

### 2.4 L4 环境搭建步骤（本机）

1. 装微信开发者工具，并登录过一次（自动化端口要求已登录的 IDE 实例）。
2. `cd miniprogram && npm install`（miniprogram-automator 在根 `devDependencies`，
   `npm install` 即装）。
3. 关掉同项目的其他开发者工具窗口（自动化单实例）。
4. 跑 §2.3 的 `cli.bat auto` 命令；判据是 `netstat -ano | findstr :9502` 有 LISTENING。
5. `node scripts/verify-ui.mjs --probe` 打印 `PORT: ws://127.0.0.1:9502 可连`。
6. `node scripts/verify-ui.mjs`（或 `WS=ws://127.0.0.1:9502 node scripts/verify-ui.mjs`）。
   整轮约 2 分钟，超时 10 分钟。

### 2.5 输出契约与退出码

stdout（编排器 `parseUiOutput` 按此解析）：

```
PASS  <断言名>
FAIL  <断言名>  — <差异>
===== <N> passed / <M> failed =====
SKIPPED: <原因>        （缺环境时唯一一行，exit 0）
```

退出码 0 全过或环境缺失 / 1 断言失败。编排器层状态映射：`SKIPPED:` 行 → 层 SKIP
带原因进未验证清单；断言全过但退出码非 0 → 层 FAIL（收尾失败不能算过）；输出里
找不到断言行 → FAIL。

### 2.6 --auto-port 三层处理（spec §3.5 / 工单 #8 决策 4）

`--auto-port` 是隐性参数：不带就不监听 ws，但 CLI 照样打印成功。三层处理：

1. **文档**：本文件与 `scripts/verify-ui.mjs` 文件头都明文记录。
2. **启动命令固定形态**：见 §2.3。
3. **probe 做真 WebSocket 握手**（不只 TCP）：端口候选 `ws://127.0.0.1:9501` /
   `9502`，`WS=` 环境变量可强制；`node scripts/verify-ui.mjs --probe` 不通 → SKIP，
   不浪费一分多钟跑断言。

---

## 3. L5 真机 e2e

### 3.1 它验什么

L5 用自研 Python BLE 网关（bleak）把 PC 的真实蓝牙暴露成 JSON stdio，Node 侧
`miniprogram/tests/e2e/wx-bridge.mjs` 只替换全局 `wx` 对象——于是 `BleTransport` /
`ControlSession` / 帧编解码都是原封不动的产品代码，不是重写替身。

**完整实现目标**（spec §5）：7 条 vitest e2e 用例 + 协议探针 58 项 + 整合验收 31 项。
骨架期 wx-bridge.mjs + ble-gateway.py + 两个探针框架都已就位；e2e 用例与探针 check
项待固件命令逐个落地后填充。**L5 的真机验收项在自动化报告里永远是「未验证」，
只有 `docs/evidence/<日期>-*/` 下带日期的真机记录才是通过证据**（spec 红线 3）。

### 3.2 网关协议

`scripts/ble-gateway.py`：stdin 一行一条 JSON 请求，stdout 一行一条 JSON 响应或事件。

```
请求  {"id": 1, "op": "scan_start", "args": {...}}
响应  {"id": 1, "ok": true, "value": ...}  /  {"id": 1, "ok": false, "error": "..."}
事件  {"event": "device_found", "value": {...}}
      {"event": "notify", "value": {"char": "...", "data": [..字节..]}}
      {"event": "disconnect", "value": {...}}
      {"event": "ready", "value": {"service": "...", "rx": "...", "tx": "...", "state": "..."}}
```

- 字节一律用整数数组（JSON 没有 bytes）。
- UUID 用 spec §2.2 锁定的 `6c756d65-6e00-4b1e-9a3c-00000000000{1,2,3,4}`（service / rx / tx / state）。
- 诊断走 stderr，绝不污染 stdout 的 JSON 流。
- Windows 下 stdin 读取放线程（ProactorEventLoop 不支持 `connect_read_pipe`）。

`scripts/wx-bridge.mjs`：spawn 网关，把 `wx.*` 的 BLE 调用转 JSON over stdio，
非 BLE 调用（storage / request / navigate）走最小降级实现。e2e 用例通过
`import { createWxStub, startGateway } from "../../scripts/wx-bridge.mjs"` 引入
（e2e 用例落地时由 `vitest.e2e.config.ts` 决定路径）。

### 3.3 L5 环境搭建步骤（本机）

1. 固件：ESP-IDF v6.1 烧录（ASCII 路径编译；仓库路径含中文时 build 脚本先拷 `%TEMP%`，
   riscv gcc 会在中文路径截错 picolibc.specs）；`idf.py -p <COM> flash monitor`。
2. 设备独立 5V 供电、共地、74AHCT125 电平转换（spec §4.1 接线），且不被手机连着
   （单连接，连上即停广播）。
3. `python -m pip install bleak pyserial`。
4. `cd miniprogram && npm install`。
5. 跑 e2e 用例（骨架期待 #16 落地后由 `node scripts/test-run.mjs ble` 编排；当前
   骨架期 e2e 用例尚未落地）。
6. 探针独立跑：
   - `python scripts/probe-protocol.py`（默认广播名 `LUMEN-`）
   - `python scripts/probe-acceptance.py --power-cycle --port COM6`

### 3.4 「未验证」三层标记（spec §3.5 / 工单 #8 决策 5）

1. **用例层**：`itReal(name, fn)` 包装，无设备时 `ctx.skip()`，vitest 记 skipped 不是 passed。
2. **层执行层**：编排器 ble 层先探测（python + `import bleak` + miniprogram vitest 存在），不满足直接 SKIP 不跑；运行中扫不到设备 / 被手机抢连 → SKIP（doctor 语义，整层不红）。
3. **汇总层**：vitest JSON 里 `skipped > 0 且 passed == 0` → 整层 SKIP；报告 `layers[ble].status = "SKIP"` + skipReason 进未验证清单。

---

## 4. 探针：独立取证，不进编排器

`scripts/probe-protocol.py` 与 `scripts/probe-acceptance.py` 是**独立取证工具**，
不进编排器（spec §3.5 已锁）：它们产出的是一次性证据而不是稳定的回归断言。
stdout 重定向归档到 `docs/evidence/<日期>-<名称>/report.md`（手工触发，带日期）。

### 4.1 probe-protocol.py（协议回归，9 节，完整目标 58 项）

骨架期每节只打一行 `TODO` 占位；完整实现时把对应 § 的 `chk.check` 填进 `run()`。

| 节 | 范围 |
|---|---|
| §1 断崖与版本拒绝 | magic / version / CRC / 长度不符 → 对应错误码整帧拒绝 |
| §2 DeviceInfo caps | firmware_version / hw_id / 能力上限 / caps 位 |
| §3 State 32B | layout_valid 与 active_scene 可读 |
| §4 布局往返 | LayoutWrite / LayoutPart / LayoutSeg / LayoutCommit / QueryLayout |
| §5 段互斥 | 压到别的部位 → InvalidParam，且旧布局逐字节不变 |
| §6 场景往返 | ScenePart / SceneStep / SceneName / ActivateScene / QueryScene |
| §7 未覆盖灯珠恒黑 | 布局只覆盖前半条，后半条应为 0 |
| §8 断电恢复 | 写布局 + 场景后复位，重连读回（同一条连接上读回是假证明） |
| §9 收尾 | 把设备恢复成「一条链、一个整条部位、常亮」 |

用法：

```bash
python scripts/probe-protocol.py                    # 默认广播名 LUMEN-*
python scripts/probe-protocol.py --address CC:8D:A2:C2:56:62
python scripts/probe-protocol.py --skip-persist     # 跳过需要人工复位的 §8
```

### 4.2 probe-acceptance.py（整合验收，四组，完整目标 31 项）

| 组 | 范围 | 参数 |
|---|---|---|
| §1 体积实测 | 8 链 × 8 部位 × 8 步 × 两层，QueryScene 读回条数核对 | 默认跑 |
| §2 存储压测 | 三个场景轮流写满 + 断电恢复 | `--power-cycle` |
| §3 时间漂移 | 两个部位不同步数不同时长跑固定时长 | `--drift-minutes N` |
| §4 帧率基线 | 800 颗灯 / 64 播放头的轮周期 | `--framerate` |

用法：

```bash
python scripts/probe-acceptance.py                    # 1 + 4（不动持久化）
python scripts/probe-acceptance.py --power-cycle      # 加 2（要串口复位）
python scripts/probe-acceptance.py --drift-minutes 30 # 加 3
python scripts/probe-acceptance.py --power-cycle --port COM6
```

### 4.3 断电恢复：pyserial DTR/RTS 复位

`--power-cycle --port COMx` 触发：`setDTR(False)` → `setRTS(True)` → 0.1–0.2s →
`setRTS(False)` → 释放串口 → sleep 3–8s → 重新扫描重连 → 读回断言。**同一条
连接上读回是假证明**，必须复位。DTR/RTS 是原生 USB-JTAG 板触发复位的唯一办法。

### 4.4 Checker 输出契约

两个探针共用：

```
PASS  <项名>  — <可选差异>
FAIL  <项名>  — <可选差异>
===== <N> passed / <M> failed =====
```

退出码 0 全部通过 / 1 有失败项 / 2 连不上设备（编排器记 SKIP）。失败项清单在
`===== ... =====` 之后追加「失败项：」段。

---

## 5. 改哪类代码 → 跑哪几层

| 改了哪里 | 必须跑 | 理由 |
|---|---|---|
| `miniprogram/pages/**` 或页面交互 | L4（开发者工具 + 自动化端口） | 白屏 / bindtap 失效 / 主题 class 没挂 / tabBar 没渲染只有渲染层能发现 |
| `miniprogram/utils/ble/**` 或 `ControlSession` | L2 + L5 e2e + 探针 | L2 验单测，L5 验真机往返，探针验字节级语义 |
| `firmware/main/**` 或协议字节布局 | L1 + 真机探针（`probe-protocol.py`） | 字节布局的契约是固件与小程序共用的，向量与两端实现必须同一个 commit |
| `scripts/verify-ui.mjs` 自身 | L4（直跑） | 修改断言结构后直跑确认 8 节壳仍就位 |
| `scripts/ble-gateway.py` / `wx-bridge.mjs` | L5 e2e（待 #16 落地后由 test-run.mjs 编排） | 网关协议变更是契约变更 |

日常不要每次全量：按这张表跑对应层即可。

---

## 6. 不用编排器时

编排器只是把下面这些命令包起来并记录结果。调某一层时可以直接跑：

```bash
node scripts/verify-ui.mjs                  # L4
node scripts/verify-ui.mjs --probe          # L4 仅探端口
python scripts/probe-protocol.py            # 协议探针
python scripts/probe-acceptance.py --power-cycle --port COM6   # 整合验收探针
```

这些命令只把结果打到终端，不留报告、不进差异比较。要留证据就用
`python ... | tee docs/evidence/<日期>-<名称>/report.md`（手工触发，带日期）。

---

## 7. 文档里的测试数字

**规则：文档不写「当前基线」的具体数字，只写指针。**

- 要数字 → 看最近一次报告：日常在 `reports/`，发布级在 `docs/evidence/test-runs/`；
- 已归档的**带日期的**证据（`docs/evidence/*-2026-*.md`）里的实测数字是当时的事实，
  一字不改；
- 完整实现目标的 48 / 7 / 58 / 31 是**目标数不是骨架数**（spec 红线 5：数字只引
  最近一次报告）。骨架期这些数字是待填的壳，不是已经跑过的断言数。

原因很简单：手抄的数字每抄一次漂一次，而且没有任何一处能证明它是跑出来的。