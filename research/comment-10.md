## Resolution

调研完成。完整产出：`research/testing-toolchain.md`（仓库内）。

### 核心结论
- **编排器**：`node scripts/test-run.mjs`（默认便宜三层）+ `--release`（全五层 + 归档）+ `--list`（列层）。**lumen 没有 `npm run test:all`**，蓝图 §5.8 说的「一条命令」对应的是 `node scripts/test-run.mjs --release`
- **L1 固件 host 单测**：自研极简框架（`CHECK` / `CHECK_BYTES` 宏），`fopen(argv[1])` + 手写 JSON 解析读向量，gcc `-std=c11 -Wall -Wextra -Werror`，跑完自动调 `check-protocol-testvectors-v5.mjs`
- **L2 小程序单测**：vitest 2.1，`environment: "node"`，刻意不含 `tests/e2e/`；mock 三层共享（产品代码 mock-transport + tests/helpers + 内存 storage）
- **L3 后端单测**：vitest 3.2 + `node:sqlite`（DatabaseSync，不是 better-sqlite3），每用例独立内存 DB，fastify.inject 不出网
- **L4 UI 渲染回归**：miniprogram-automator 0.13.0（**未进 package.json，clone 后 SKIP**），`cli.bat auto --auto-port 9502`（不带就不监听），48 条用例单文件 8 节组织
- **L5 真机 e2e**：自研 Python BLE 网关（bleak）+ pyserial DTR/RTS 复位；vitest e2e 单文件 7 用例；协议探针 58 项（probe-v5.py）+ 整合验收 31 项（probe-v5-acceptance.py）
- **「没跑」可见性**：三态 PASS/FAIL/SKIP + 未验证清单 + 结论行口径 + 主动探测 + 非法状态降级 FAIL + 测试清单登记

### 与蓝图的差异（以代码为准）
1. `npm run test:all` 不存在，对应物是 `node scripts/test-run.mjs --release`
2. §8 基线数字与最近一次实测吻合，但「协议探针 58 项 / 整合验收 31 项」是单次运行数而非代码静态数，lumen 自己 AGENTS.md 写「67 项」、handoff.md 记录「58/58」——口径不一致
3. lumen 自身文档 v4→v5 漂移：`docs/testing.md` 仍写 v4 向量、声称 e2e 覆盖 4 个文件（实际只有 1 个 7 用例）；verify-lumen-ble SKILL.md 还写「固件是 v4」
4. **「页面处理器→真机」的 e2e 链路（v4 page-click.test.ts）当前缺失**——bt-light 可考虑补上
5. miniprogram-automator 未进 package.json（clone + npm install 的机器 L4 直接 SKIP）

### 对 #8 的输入
- 每层给出框架 + 目录 + 运行命令
- L4/L5 的环境搭建步骤写清
- 测试编排器的命令 + 报告格式
- 「没跑」可见性的具体实现
- 残留风险：探针数字口径不一致、未实际执行测试（只读）、e2e 其余文件未核查