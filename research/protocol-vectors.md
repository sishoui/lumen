# 协议向量形态与跨语言消费调研（ticket #9）

> 调研对象：`C:\Users\13092\Desktop\项目\zcode\lumen\`（参考实现）
> 产出日期：2026-11-23
> 用途：作为 wayfinder ticket #4（协议契约 grilling）的输入素材

## 一、lumen 的方案（结论先行）

**方案 B：JSON 单文件 + 两端测试运行时读取**。

- **向量源**：`lumen/docs/protocol-testvectors-v5.json`（56KB，113 条用例），单一真相源，零复制
- **固件 C 单测**：`fopen(argv[1])` + 手写极简 JSON 解析（`strstr` 扫描，无转义/嵌套，单用例 8KB 上限），运行时读取，**不是 include**
- **小程序 TS 单测**：vitest `readFileSync` + `JSON.parse` 同一份 JSON
- **生成器 + 独立校验器**：
  - `scripts/gen-protocol-testvectors-v5.mjs`：从布局常量算帧/CRC/分片 → 输出 JSON
  - `scripts/check-protocol-testvectors-v5.mjs`：只读 JSON 对契约常量表，**不信生成器**（因为历史上真的出过生成器 bug：彩虹 span 按 2 字节传值导致整体错位 1 字节）
- **变更流程**：靠约定（`docs/protocol-v5.md` §13 + `AGENTS.md` 字节契约节）+ 测试编排器兜底，**无 CI、无 pre-commit**
- **版本字段**：`protocol_version: 5`（数字元信息）+ 帧内 `0x05`（实际字节）+ 固件 `LUMEN_FIRMWARE_VERSION = 0x0500`（独立，DeviceInfoReport 用）——三份表示同一语义，无独立版本号

## 二、lumen 的实际目录结构

```
lumen/
├── docs/
│   ├── protocol-v5.md                    # 人读契约（§12 测试向量、§13 变更规则）
│   ├── protocol-testvectors-v5.json      # ★ 唯一机器可读源（gen 产出，113 条）
│   └── test-manifest.json                # checker 登记进 firmware 层（编排器强制点）
├── scripts/
│   ├── gen-protocol-testvectors-v5.mjs   # 生成器：布局常量→帧/CRC/分片→JSON
│   └── check-protocol-testvectors-v5.mjs # 独立校验器：只读 JSON 对契约常量表
├── firmware/test/
│   ├── test_skeleton.c                   # host 单测：fopen(argv[1]) + 手写 JSON 解析
│   └── run-tests.cmd                     # gcc 编译 + 传向量路径 + 缺文件大声失败 + 调 checker
└── miniprogram/tests/
    └── codec.test.ts                     # vitest：readFileSync 同一份 JSON
```

## 三、lumen 的坑（bt-light 要避开）

1. **旧版本文件残留消费**：蓝图/AGENTS.md 说 v4 向量「不再被任何测试消费」，但 `miniprogram/tests/color.test.ts:55` 仍 `readFileSync` `protocol-testvectors-v4.json`——bt-light 迁移时要连旧向量文件一起删。
2. **断言数漂移**：蓝图 §8 写「12976 断言 + 113 条向量」；test_skeleton.c 注释已是 13996（v5 增长后未同步蓝图）——bt-light 的 spec 不要写死数字，写「以最近一次报告为准」。
3. **蓝图未提生成/校验脚本**：§1.2 只说「协议文档 + 可执行测试向量 + 两端实现」，未提 gen/check 双脚本与「独立校验器不信生成器」这一关键设计——这是代码里最有价值、文档里缺失的部分，bt-light spec 要补上。
4. **注释漂移**：`miniprogram/utils/protocol/frame.ts:5` 仍引用 v3 向量——bt-light 手抄常量时不要带版本号注释。
5. **无 CI**：同 commit 强制完全靠约定 + 编排器运行时兜底——bt-light 可加一个 `scripts/check-protocol-sync.mjs` 断言 JSON 版本 == 两端常量 == 帧内 VER，重跑 gen 无 diff，挂进 test。

## 四、子代理的改进建议（相对 lumen 的净改进）

1. **加 npm script 别名**：`package.json` 加 `"gen:vectors": "node scripts/gen-protocol-testvectors.mjs"` 和 `"check:vectors": "node scripts/check-protocol-testvectors.mjs"`，挂进 `npm run test` 前置
2. **协议版本与固件版本显式分名**：照 lumen 的教训，JSON 里只锁 `protocol_version`（帧内 1 字节）；固件版本（DeviceInfoReport 2 字节）单独字段，不要复用同一常量
3. **共享常量 JS 让两端 import**：把「手抄」降级为「一次 import」，gen 脚本和两端 constants 都 import 同一份 `shared/protocol-constants.js`，消除手抄漂移
4. **加 `scripts/check-protocol-sync.mjs`**：断言 JSON 的 `protocol_version` == 两端常量 == 帧内 VER，重跑 gen 无 diff——lumen 没做、值得做的点

## 五、bt-light 的对应适配

bt-light 当前是 JS 小程序（非 TS）+ PlatformIO（非 ESP-IDF）。迁移时：

- `docs/protocol.md`（人读契约）+ `docs/protocol-testvectors.json`（机器源，gen 产出）
- `scripts/gen-protocol-testvectors.mjs` + `scripts/check-protocol-testvectors.mjs`（根目录新建 `scripts/`）
- `miniprogram/test/protocol.test.js` 改为读 JSON（替代当前的 ASCII 命令字符串断言）
- 固件 host 单测：`firmware/test/` 下用 `pio test -e native` 或 gcc 直接编译 + 传向量路径

## 六、关键文件路径引用

- 向量源：`C:\Users\13092\Desktop\项目\zcode\lumen\docs\protocol-testvectors-v5.json`
- 生成器：`C:\Users\13092\Desktop\项目\zcode\lumen\scripts\gen-protocol-testvectors-v5.mjs`
- 校验器：`C:\Users\13092\Desktop\项目\zcode\lumen\scripts\check-protocol-testvectors-v5.mjs`
- C 端消费：`C:\Users\13092\Desktop\项目\zcode\lumen\firmware\test\test_skeleton.c`（JSON 解析 333-600 行，main/argv 7979 行起）
- C 端编排：`C:\Users\13092\Desktop\项目\zcode\lumen\firmware\test\run-tests.cmd`
- TS 端消费：`C:\Users\13092\Desktop\项目\zcode\lumen\miniprogram\tests\codec.test.ts`（49-51 行读取）
- 契约文档：`C:\Users\13092\Desktop\项目\zcode\lumen\docs\protocol-v5.md`（§12/§13）
- 变更规则：`C:\Users\13092\Desktop\项目\zcode\lumen\AGENTS.md`「字节契约」节（167-175 行）
- 强制点登记：`C:\Users\13092\Desktop\项目\zcode\lumen\docs\test-manifest.json`

## 七、残留风险 / 未验证

- lumen C 端手写 JSON 解析器是「够用主义」（strstr/strchr 扫描，无转义/嵌套处理，单用例 8KB 上限）——对 lumen 自有格式安全，但 bt-light 若将来在 note 字段加逗号/花括号会踩坑；建议 gen 时保证字段值不含 `{}`，或用 ArduinoJson
- 未验证 lumen 在真实 CI 环境的行为（无 CI，全部证据来自本地 git 历史与测试报告）
- bt-light 是 JS 小程序（非 TS）+ PlatformIO（非 ESP-IDF），上述行号引用均为 lumen 对应物，迁移时需按 bt-light 目录重写路径