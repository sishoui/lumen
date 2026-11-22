## Resolution

调研完成。完整产出：`research/protocol-vectors.md`（仓库内）。

### 核心结论
- **方案 B**：JSON 单文件 + 两端测试运行时读取。lumen v3/v4/v5 三代验证，零复制、结构上消灭「各写一份期望值」的假绿
- **形态**：`docs/protocol-testvectors-v5.json`（113 条用例），gen 脚本从布局常量算帧/CRC/分片，check 脚本只读 JSON 不信生成器
- **固件消费**：`fopen(argv[1])` + 手写极简 JSON 解析（strstr 扫描，无转义/嵌套，单用例 8KB 上限），不是 include
- **小程序消费**：vitest `readFileSync` + `JSON.parse` 同一份 JSON
- **版本字段**：`protocol_version: 5`（数字元信息）+ 帧内 `0x05`（实际字节）+ 固件 `LUMEN_FIRMWARE_VERSION = 0x0500`（独立）——三份表示同一语义，无独立版本号

### 改进建议（相对 lumen 的净改进）
1. 加 npm script 别名（`gen:vectors` / `check:vectors`）挂进 test 前置
2. 协议版本与固件版本显式分名
3. 共享常量 JS 让两端 import（消除手抄漂移）
4. 加 `check-protocol-sync.mjs` 断言 JSON 版本 == 两端常量 == 帧内 VER

### 对 #4 的输入
- 形态选定：方案 B（JSON 单文件 + 双端运行时读取）
- 变更流程：约定 + 编排器兜底 + 可加 sync checker
- 版本字段：三份表示，无独立版本号
- 目录结构：`docs/protocol.md` + `docs/protocol-testvectors.json` + `scripts/gen|check-protocol-testvectors.mjs`

### Pitfalls（bt-light 要避开）
- 旧版本向量文件残留消费（`color.test.ts` 仍读 v4）
- 断言数漂移（蓝图 12976 vs 实测 13996）
- 蓝图未提 gen/check 双脚本
- 无 CI（靠约定 + 编排器兜底）