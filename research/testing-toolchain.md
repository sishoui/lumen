# 测试工具链方案调研（ticket #10 / #8 输入素材）

> 调研对象：`C:\Users\13092\Desktop\项目\zcode\lumen\`（git master @ `7bf1e31`）
> 对照文档：lumen 蓝图 §5.8 / §8；lumen 自身 `docs/testing.md`
> 产出日期：2026-11-23

## 一、lumen 的五层测试体系（结论先行）

lumen 的五层测试体系与蓝图 §5.8 的 mermaid 图一一对应，全部有真实可运行实现。但「一条命令」的载体是 `node scripts/test-run.mjs`（**不存在 `npm run test:all`**），且 lumen 自己的 `docs/testing.md` 与 verify-lumen-ble SKILL.md 存在 v4→v5 迁移后的文档漂移。

### 1. L1 固件 host 单测

| 项 | 实现 |
|---|---|
| 框架 | **自研极简框架**（非 Unity/CMocka）。单文件 `firmware/test/test_skeleton.c`（约 8100 行），两个宏 `CHECK(cond)` / `CHECK_BYTES(actual, hex, len)` 维护全局 `g_checks` / `g_failures` |
| 目录 | `firmware/test/`（`test_skeleton.c` + `run-tests.cmd`）；被测源码直接编 `firmware/main/*.c` 中可脱离 ESP-IDF 的部分（protocol.c / command.c / effects.c / layout_store.c / scene_store.c / scene_compose.c / state_blob.c / chunk_reasm.c 等 15 个文件） |
| 协议向量接入 | `docs/protocol-testvectors-v5.json`（113 条用例）由 `run-tests.cmd` 作为 **argv[1]** 传给编译出的 exe；C 侧 `for_each_case()` 手写极简 JSON 扫描器（`strstr` 找 `"cases"`，逐对象切 8KB 静态缓冲） |
| 运行命令 | `node scripts/test-run.mjs firmware`，或直接 `cmd.exe /c firmware\test\run-tests.cmd`。产物编到 `%TEMP%\lumen-host-tests`（避开非 ASCII 仓库路径 + 不污染仓库），`gcc -std=c11 -Wall -Wextra -Werror` |
| 附加 | 跑完自动执行 `scripts/check-protocol-testvectors-v5.mjs`（向量文件 vs `docs/protocol-v5.md` 的独立静态校验，防生成器 bug）；node 缺失时打印 `SKIPPED: v5 vector self-check (node not found)` 并以 0 退出 |
| 实测基线 | **12976 断言 / 114 个测试函数 / 113 向量**（`docs/evidence/test-runs/2026-11-07T06-22-16-894/report.md`） |

### 2. L2 小程序单测

| 项 | 实现 |
|---|---|
| 框架/配置 | vitest 2.1，`miniprogram/vitest.config.ts`：`environment: "node"`，`include: ["tests/*.test.ts"]`——**刻意不含 `tests/e2e/`** |
| mock-device 共享策略 | 三层共享：(a) **产品代码 `utils/ble/mock-transport.ts`**（与 BleTransport 同形，测试直接当传输层用）+ `utils/control/mock-devices.ts`（3 台演示设备 spec）；(b) `miniprogram/tests/helpers/` 共享底座——`page-harness.ts`、`page-registry.ts`、`page-runtime.ts`、`storage.ts`、`state.ts`；(c) 原则：**只替换 spec 允许的假件（storage），传输层用产品代码本身** |
| 运行命令 | `cd miniprogram && npm test`（= `vitest run`）；编排器路径是 `node scripts/test-run.mjs mp`（vitest JSON reporter 落临时文件 + `tsc --noEmit` 合成一层） |
| 实测基线 | **1203 用例 / 61 个测试文件**（日常报告 2026-11-07；发布归档那次是 1200） |

### 3. L3 后端单测

| 项 | 实现 |
|---|---|
| 框架/配置 | vitest 3.2，`server/vitest.config.ts`：`environment: "node"`，`pool: "forks"`，注释明确「全部走 fastify.inject + 内存 SQLite，不监听端口、不联网」 |
| sqlite | **Node 内置 `node:sqlite`（DatabaseSync）**，不是 better-sqlite3——better-sqlite3 是原生模块需要 C++ 编译器（Node 24 上 `gyp ERR! find VS`），node:sqlite 零编译零依赖 |
| 数据隔离 | `server/tests/helpers.ts` 的 `makeHarness()`：**每个用例一套独立 `openDatabase(":memory:")` + buildApp + app.ready()**，用例结束 close；`logBody()` 用 `process.pid + 自增 seq` 生成唯一 `clientEventId`（幂等键测试的隔离基础） |
| 运行命令 | `cd server && npm test`；编排器 `node scripts/test-run.mjs server` |
| 实测基线 | **140 用例 / 6 个文件**（aggregation / api / devices / readonly / schema-migration / session） |

### 4. L4 UI 渲染回归

| 项 | 实现 |
|---|---|
| 用什么 | **miniprogram-automator 0.13.0**（官方 automator，`createRequire(miniprogram/package.json)` 解析加载）。**注意：它没写进 `miniprogram/package.json` 的 devDependencies**，只存在于 `node_modules/.package-lock.json`（npmmirror 装的）——clone 后 `npm install` 不会带上它，脚本会报「缺 miniprogram-automator」SKIP。这是可复现性上的一个坑 |
| 脚本位置 | `scripts/verify-v5.mjs`（763 行，**刻意放 scripts/ 而不是 .auto/**——.auto/ 整个被 gitignore，放那里换机器就丢层） |
| `--auto-port` 隐性参数 | 它是**微信开发者工具 CLI 的参数**：`cli.bat auto --project <路径> --auto-port 9502 --trust-project`。不带它时 CLI 照样打印 `✔ auto` 但只有 9501（IDE HTTP 端口）监听，automator 的 ws 端口根本不监听。工具链的应对：① AGENTS.md 明文记录该坑 + 判据必须是 `netstat -ano \| grep :9502` 有 LISTENING；② verify-v5.mjs 端口候选依次试 `ws://127.0.0.1:9501` / `9502`（`WS=` 环境变量可强制）；③ **探测做真 WebSocket 握手而非只测 TCP**；④ 编排器 ui 层先跑 `verify-v5.mjs --probe`（3s TCP + 8s 握手预算），不通直接 SKIP 不浪费一分多钟跑断言 |
| 48 条用例组织 | 单文件内 48 个 `rec(name, ok, detail)` 调用，按 8 节组织：§0 启动 / §1 主题三处同步 / §2 首页 / §3 设备页 / §4 灯组行就地展开 / §5 部位编辑器 / §6 开关层级 / §7 深色主题回归 |
| 「点得动 + 设备真收到」如何验证 | 点击通过 `mp.evaluate(() => getCurrentPages().pop().onXxxTap(...))` 调**页面自己的事件处理器**；「真收到」= 点完之后**读回**：如部位改名后 `navigateBack` 回设备页，从 `p.data.stripCards` 读回 label 断言是「眼灯」。注意口径：**verify-v5.mjs 驱动的是模拟器 + 演示设备**（传输层是 MockTransport、会话层是真 ControlSession），它证明「渲染 + 事件 + 会话栈」通了；**真机收到**由 L5 的 ble 层与探针证明 |
| 输出/退出码 | `PASS  名称` / `FAIL  名称  — 差异` 行 + 末尾 `===== N passed / M failed =====`；缺环境只有一行 `SKIPPED: 原因` 且**退出码 0**；脚本幂等（自切浅色/深色并复位），整轮约 114–120 秒 |
| L4 环境搭建 | ① 装微信开发者工具；② `cli.bat auto --project <repo>\miniprogram --auto-port 9502 --trust-project`（**必须带 --auto-port**，完了 `netstat` 验证 9502 LISTENING；带中文路径的 .ps1 必须 UTF-8 with BOM）；③ `cd miniprogram && npm install`（含手动补装 miniprogram-automator）；④ `WS=ws://127.0.0.1:9502 node scripts/test-run.mjs ui` |

### 5. L5 真机 e2e

**BLE 网关形态：自研 Python 网关（bleak），不是 bleno/noble。** 原因：微信开发者工具蓝牙是桩（`createBLEConnection` 回「暂时不支持此 API 调试」），noble 在 Node 24 编译不过。

链路：`vitest（真实 TS 产品代码）→ miniprogram/tests/e2e/wx-bridge.mjs（只替换全局 wx 对象）→ JSON over stdio → scripts/ble-gateway.py（bleak）→ PC 真实蓝牙 → ESP32-C3`。BLE 服务/特征 UUID：`6c756d65-6e00-4b1e-9a3c-00000000000{1,2,3,4}`（service/rx/tx/state）。网关协议：stdin 一行一 JSON 请求、stdout 一行一响应或事件（device_found / notify / disconnect），字节用整数数组。Windows 细节：stdin 读取必须放线程（ProactorEventLoop 不支持 connect_read_pipe）。

| 项 | 实现 |
|---|---|
| e2e 用例 | `miniprogram/tests/e2e/real-device.test.ts`，**当前实际只有这一个文件、7 条用例**（1 条扫描 + 6 条 itReal）：扫描 Lumen 设备 → 32 字节 State + MTU≥23 → SetPower/SetBrightness 真实 ACK 往返 → 布局往返 → 越界段被设备拒绝 → 每带开关位语义 → QueryDeviceInfo 真实 MAC/caps。`vitest.e2e.config.ts`：`testTimeout: 90s`、`fileParallelism: false`（单连接不并行） |
| 执行器 | `.zcode/skills/verify-lumen-ble/scripts/drive.mjs`。三件事：① 先跑 `doctor.py` 只读体检 → 不满足退出码 3；② `npx vitest run --config vitest.e2e.config.ts --reporter=json`；③ 收尾核对现场。**退出码语义：0 过 / 1 断言失败 / 3 SKIP**，证据写 `miniprogram/.auto/evidence-ble/<RUN_ID>/` |
| 「未验证」标记写入方式 | 三层机制：① 用例层——`itReal(name, fn)` 包装，`if (!device) ctx.skip()`（vitest 记 skipped 而非 passed）；② 执行器层——doctor 失败退出码 3、或「全部 skip」也退出 3（不红）；③ 编排器层——`parseE2eJson` 判「skipped>0 且 passed≤1」→ 整层 SKIP，退出码 3 一律 SKIP |
| 协议探针（「58 项」） | `scripts/probe-v5.py`（656 行，bleak 直连，不经 Node）。9 节：§1 断崖（v4 帧回 0x07、7 条退役命令回 0x02）/ §2 能力位 / §3 State 32 字节 / §4 布局往返 / §5 段互斥 / §6 场景往返 / §7 未覆盖灯珠恒黑 / §8 断电恢复 / §9 收尾恢复现场。代码里 61 处 `chk.check()` 调用点（含 7 条退役命令循环展开），最近一次记录的实际运行数是 58/58 |
| 整合验收（「31 项」） | `scripts/probe-v5-acceptance.py`（#162 专写）。四组：体积实测（8链×8部位×8步×两层最大场景 512 步写入+读回，209s）/ 存储压测（三场景写满+断电恢复）/ 时间漂移（串口 playhead 日志闭式解残差）/ 帧率基线（800 颗/64 播放头 5.54ms/轮）。33 处 check 调用点，最近记录 **31/31** |
| 断电恢复实现 | 两次连接之间做（同一条连接读回是假证明）：BLE 断开 → `hard_reset(port)` 用 **pyserial DTR/RTS**（`setDTR(False)` → `setRTS(True)` → 0.1s → `setRTS(False)`）→ sleep 3s → 重新扫描等设备广播（20s 超时）→ 重连 → `readback_after_reset()` 读回布局/场景/State 断言仍在 → 才 cleanup |
| L5 环境搭建 | ① 烧 v5 固件（ESP-IDF v6.1；**仓库路径含中文会让 riscv gcc 截错 picolibc.specs，必须在 ASCII 路径编译**——`scripts/build-firmware.cmd` 拷到 `%TEMP%\lumen-firmware` 就是为此）；② 设备上电、不被手机连着（单连接，连上就停广播）；③ `python -m pip install bleak`（e2e 还需 pyserial 做复位）；④ `cd miniprogram && npm install`；⑤ `node .zcode/skills/verify-lumen-ble/scripts/drive.mjs --scenario all`；⑥ 协议探针 `python scripts/probe-v5.py`、整合验收 `python scripts/probe-v5-acceptance.py --power-cycle` |

### 6. 测试编排器

| 项 | 实现 |
|---|---|
| 命令 | **`node scripts/test-run.mjs`**（零依赖 Node 脚本，1864 行）。**lumen 没有 `npm run test:all`**——蓝图 §5.8 说「一条命令跑全部层」，代码的载体是 `node scripts/test-run.mjs`（默认还只跑便宜三层，全五层要 `--release` 或显式列层） |
| 报告归档 | 双池设计：日常 → `.reports/<RUN_ID>/`（**gitignore，不进 git**）；`--release` → `docs/evidence/test-runs/<RUN_ID>/`（**git tracked**，实测 `git ls-files` 有 5 份归档，随发布提交）。两份产物：`report.md`（人读）+ `report.json`（机器比） |
| 报告格式（六段） | ① 头部（时间/commit+dirty 标记/机器/触发的层/结论）；② 分层结果表；③ **未验证清单（最重要的段落）**；④ 明细（固件按测试函数的断言数 + 每测试文件「文件/覆盖/用例数」）；⑤ 失败详情；⑥ 与上次运行的差异（只比**用例数**不比用例名；缺失数字记「无法比对」绝不当 0） |
| 「没跑」可见性的具体实现 | ① **三态 PASS/FAIL/SKIP**，SKIP 必须带 skipReason，不影响退出码但影响结论文字；② 层内 skip（skipped 数组）：固件 `SKIPPED:` 前缀标签、e2e 用例 skip、已知分歧——层可以 PASS 但这些进未验证清单；③ 结论行口径：有 SKIP 层 → `⚠️ 未全验证（哪几层未跑）`，只有层内 skip → `✅ 通过（N 项层内跳过）`，全绿才 `✅ 通过`；④ 发布归档且有层没跑 → 标题正下方插 `⚠️ 发布级证据，但本轮发布未覆盖：…` 横幅；⑤ 差异节单列「新出现的跳过」；⑥ 前置条件**主动探测**（probe 不通直接 SKIP 带原因）；⑦ 非法状态降级 FAIL（防 undefined 渲染成假绿）；⑧ 编排器自己也有测试 |
| 测试清单 | `docs/test-manifest.json`：layers（5 层定义）+ files（70 条登记：mp 61、server 6、firmware 2、ble 1；粒度=测试文件，含 covers 中文行为说明）。`scripts/check-test-manifest.mjs` 每轮跑，五类问题任一 → 整轮 FAIL 并追加「清单查漏」层 |

## 二、与蓝图 §5.8 / §8 的差异（以代码为准）

1. **`npm run test:all` 不存在**。蓝图 §5.8 说「测试编排器：一条命令跑全部层」，代码的载体是 `node scripts/test-run.mjs`（默认还只跑便宜三层，全五层要 `--release` 或显式列层）。bt-light ticket #8 grilling 时应把「一条命令」重新定义为 `node scripts/test-run.mjs --release`。
2. **§8 基线数字与最近一次实测吻合**：固件 12976 断言 + 113 向量 ✅、mp 1203 ✅、server 140 ✅、UI 48 ✅、真机 e2e 7 用例 ✅。但「协议探针 58 项 / 整合验收 31 项」是**单次运行数**而非代码静态数：probe-v5.py 有 61 处 `chk.check()` 调用点（含循环与条件分支），probe-v5-acceptance.py 有 33 处；且 lumen 自己 AGENTS.md 写 probe-v5 是「67 项」、handoff.md 记录「58/58」——**lumen 内部口径已不一致**。bt-light grilling 时应问：探针数字是否也应「取实际运行数不手抄」。
3. **lumen 自身文档 v4→v5 漂移**（比蓝图差异更严重，直接影响照抄）：`docs/testing.md` 仍写「v4 向量静态校验」「check-protocol-testvectors-v4.mjs」，并声称 e2e 覆盖 `real-device.test.ts / complex-plan.test.ts / page-click.test.ts / walkthrough.test.ts` 四个文件——**实际 `miniprogram/tests/e2e/` 只有 `real-device.test.ts`（7 用例）**，其余三个文件在 v5 迁移时已不存在；verify-lumen-ble SKILL.md 前置条件还写「固件是 v4」而 doctor.py 已是 v5 契约。**「页面处理器→真机」的 e2e 链路（v4 page-click.test.ts）当前缺失**，只有「模拟器+演示设备」（L4）与「协议级真机」（L5 探针）两段，中间的桥没有自动化用例——这是 bt-light 建体系时值得决策的点。
4. **miniprogram-automator 未进 package.json**（只 --no-save 装在 node_modules），clone + npm install 的机器 L4 直接 SKIP。
5. 蓝图 §5.8 的其余要素（SKIP 而非 PASS、发布级证据单独归档、报告数字引自最近一次报告不抄旧数）在代码中全部真实落地，且有测试守护。

## 三、bt-light 的对应适配建议

### 1. 编排器

- **命令**：`node scripts/test-run.mjs`（默认便宜三层）+ `--release`（全五层 + 归档）+ `--list`（列层）
- **目录**：根目录新建 `scripts/`（当前 bt-light 没有这个目录）
- **报告双池**：`.reports/<RUN_ID>/`（gitignore）+ `docs/evidence/test-runs/<RUN_ID>/`（git tracked）
- **「没跑」可见性**：三态 PASS/FAIL/SKIP + 未验证清单 + 结论行口径 + 主动探测 + 非法状态降级 FAIL
- **测试清单**：`docs/test-manifest.json`（layers + files 登记）+ `scripts/check-test-manifest.mjs` 每轮跑

### 2. L4 miniprogram-automator 的处理

- **加入 `miniprogram/package.json` 的 devDependencies**（lumen 的坑）
- **AGENTS.md 明文记录 `--auto-port` 坑** + 判据必须是 `netstat` 有 LISTENING
- **脚本放 `scripts/` 而不是 `.auto/`**（`.auto/` 被 gitignore）

### 3. L5 BLE 网关

- **自研 Python 网关（bleak）+ pyserial DTR/RTS 复位**（lumen 验证过的方案，避开 noble/bleno 的坑）
- **ASCII 路径编译**：bt-light 当前仓库路径 `C:\Users\13092\Desktop\project\bt-light\bt-light` 是 ASCII，但要注意以后改名 `lumen` 后仍是 ASCII；如果用户的 Windows 用户名含中文，build 脚本要拷到 `%TEMP%\` 编
- **退出码语义**：0 过 / 1 断言失败 / 3 SKIP
- **「页面处理器→真机」的 e2e 链路**：lumen 缺失，bt-light 可考虑补上（`page-click` 类用例）

### 4. 协议向量接入

- **L1 固件 host 单测**：`fopen(argv[1])` + 手写极简 JSON 解析（lumen 验证过，113 条用例够用）
- **L2 小程序单测**：vitest `readFileSync` + `JSON.parse` 同一份 JSON
- **独立校验器**：`check-protocol-testvectors.mjs`（只读 JSON 不信生成器）
- **变更流程**：靠约定（`docs/protocol.md` + `AGENTS.md` 字节契约节）+ 编排器兜底 + **可加 `check-protocol-sync.mjs` 断言 JSON 版本 == 两端常量 == 帧内 VER**（lumen 没做、值得做）

## 四、关键文件路径速查

- 编排器：`lumen/scripts/test-run.mjs`（+ `check-test-manifest.mjs`）
- L1：`lumen/firmware/test/run-tests.cmd`、`lumen/firmware/test/test_skeleton.c`、`lumen/docs/protocol-testvectors-v5.json`、`lumen/scripts/check-protocol-testvectors-v5.mjs`
- L2：`lumen/miniprogram/vitest.config.ts`、`lumen/miniprogram/tests/helpers/`（page-harness/page-registry/page-runtime/storage/state）、`lumen/miniprogram/utils/ble/mock-transport.ts`
- L3：`lumen/server/vitest.config.ts`、`lumen/server/tests/helpers.ts`、`lumen/server/src/db.ts`（node:sqlite）
- L4：`lumen/scripts/verify-v5.mjs`（48 断言）、`lumen/miniprogram/.auto/check-bindings.mjs`、skill `lumen/.zcode/skills/verify-lumen/`
- L5：`lumen/scripts/ble-gateway.py`、`lumen/miniprogram/tests/e2e/wx-bridge.mjs`、`lumen/miniprogram/tests/e2e/real-device.test.ts`、`lumen/miniprogram/vitest.e2e.config.ts`、skill `lumen/.zcode/skills/verify-lumen-ble/scripts/{drive.mjs,doctor.py}`
- 探针：`lumen/scripts/probe-v5.py`（协议回归）、`lumen/scripts/probe-v5-acceptance.py`（整合验收，含 `--power-cycle` 断电恢复）
- 清单/文档：`lumen/docs/test-manifest.json`、`lumen/docs/testing.md`、`lumen/docs/evidence/test-runs/`（归档报告）、`lumen/AGENTS.md`（L4 踩坑记录）

## 五、残留风险 / 未验证

- probe 58/31/67 三个数字的来源未能完全对齐到同一次运行（证据目录里 11-07 归档只含编排器五层报告，探针原始输出在 `.scratch/` 未入库）
- 未实际执行任何测试（只读约束），所有数字引自 lumen 自己的报告文件与 handoff
- e2e 其余三个文件（complex-plan 等）是否存在于 lumen 的其它 worktree/分支未核查（`.worktrees/` 存在但未查）