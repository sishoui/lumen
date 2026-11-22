# BT-Light 小程序

控制 bt-light ESP32-C3 的 8 路 WS2812B 彩虹流水灯。

## 目录

```
miniprogram/
├── app.js / app.json / app.wxss
├── pages/
│   ├── connect/    扫描并连接 BT- 设备
│   └── control/    亮度 / 速度 / 相位 / 重置 + 日志
└── utils/
    ├── config.js   BLE UUID、超时、MTU
    └── ble.js      适配器 / 扫描 / 连接 / 写 / 重连
```

## 使用

1. **烧录固件**：在 `bt-light/` 下执行 `pio run -t upload`，确保 ESP32-C3 广播 `BT-Light-01`。
2. **导入小程序**：微信开发者工具 → 导入项目 → 选择 `bt-light/miniprogram/`。
   - AppID 用 `touristappid` 即可（蓝牙能力无需鉴权）。
3. **手机操作**：
   - 「连接设备」页 → 点击「开始扫描」→ 点设备连接。
   - 连接成功后点「去控制」。
   - 控制页：亮度滑块 `b0..255`、速度滑块 `s1..100`、相位切换 `p0/p1`、重置 `r`、查询 `?`。

## BLE 协议（与固件约定）

| 项 | 值 |
|---|---|
| 广播名前缀 | `BT-`（完整名 `BT-Light-01`）|
| Service | `0000FFE0-0000-1000-8000-00805F9B34FB` |
| Write | `0000FFE1-...` (手机→设备，ASCII 命令，`\n` 结尾) |
| Notify | `0000FFE2-...` (设备→手机，ASCII 状态 `b128 s50 p0\n`) |

| 命令 | 含义 |
|---|---|
| `b<0-255>` | 设置亮度 |
| `s<1-100>` | 设置流水速度（越大越快）|
| `p<0\|1>` | 相位：0=同相位（瀑布），1=错相位（波浪）|
| `r` | 重置灯效 |
| `?` | 查询当前状态 |
| `h` | 帮助 |

## 验证

- 小程序语法检查：`node --check` 全部通过。
- 协议单测：`b128\ns50\np1\nr\n?\n` 与固件 `handleCommand` 分支完全对应。
- 固件编译通过：`pio run` → Flash 41.3% / RAM 8.0%。

## 排错

- 扫不到设备：确认 ESP32 已烧新固件（旧固件没有 BLE）；手机蓝牙已开；靠近设备。
- 连上但写不进：确认选中的写特征值是 FFE1（小程序会自动挑第一个可写特性）。
- 状态不更新：固件在每次命令后会 notify FFE2；小程序 `onBLECharacteristicValueChange` 解析 `b.. s.. p..` 格式。