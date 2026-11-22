// main.cpp - ESP32-C3FH4 8 路彩虹流水灯（BLE 控制版）
//
// 硬件接线（WS2812B 5V 供电，与 ESP32 共地）：
//   灯带 DIN 分别接 GPIO0, 1, 3, 4, 5, 6, 7, 10
//   每路数据线串 330Ω 电阻，GPIO10 加 10kΩ 下拉（启动防乱闪）
//
// BLE 服务（与小程序约定）：
//   Service UUID : 0000FFE0-0000-1000-8000-00805F9B34FB
//   Write  UUID  : 0000FFE1-0000-1000-8000-00805F9B34FB  (手机→设备，下发命令)
//   Notify UUID  : 0000FFE2-0000-1000-8000-00805F9B34FB  (设备→手机，状态上报)
//   广播名前缀   : BT-
//   命令格式     : ASCII 文本，与串口命令同构，'\n' 结尾
//                  b<0-255>   设置亮度
//                  s<1-100>   设置流水速度（越大越快）
//                  p<0|1>     相位模式：0=同相位 1=错相位
//                  r           重置灯效
//                  h           帮助
//                  ?           查询当前状态
//
// 串口命令（115200，与 BLE 命令完全等价）：
//   同上，外加任何调试输出

#include <Arduino.h>
#include <FastLED.h>
#include <NimBLEDevice.h>

// ===================== 可调参数区（现场改这里即可） =====================
#define NUM_STRIPS              8      // 灯带数量
#define NUM_LEDS_PER_STRIP      60     // 每条灯带灯珠数
#define LED_PIN_0               0      // 第 1 条灯带数据引脚
#define LED_PIN_1               1      // 第 2 条
#define LED_PIN_2               3      // 第 3 条
#define LED_PIN_3               4      // 第 4 条
#define LED_PIN_4               5      // 第 5 条
#define LED_PIN_5               6      // 第 6 条
#define LED_PIN_6               7      // 第 7 条
#define LED_PIN_7               10     // 第 8 条
#define COLOR_ORDER             GRB    // WS2812B 常用 GRB；如颜色不对可改 RGB/BRG
#define DEFAULT_BRIGHTNESS      128    // 默认亮度 (0-255)
#define DEFAULT_SPEED           50     // 默认流水速度 (1-100)，越大越快
#define DEFAULT_PHASE_MODE      0      // 0=同相位(并排瀑布) 1=错相位(波浪)
#define SPEED_MIN               1      // 速度下限
#define SPEED_MAX               100    // 速度上限
// 速度映射：speed 1~100 -> 每帧前进 0.05~20 颗灯（线性映射到 0~255）
#define SPEED_STEP_NUM          255    // 映射上限

// ===================== BLE 参数（与小程序约定，改这里要同步小程序） =====================
#define BLE_NAME_PREFIX         "BT-"  // 广播名前缀，小程序按此过滤
#define BLE_DEVICE_NAME         "BT-Light-01"  // 完整广播名
#define SERVICE_UUID            "0000FFE0-0000-1000-8000-00805F9B34FB"
#define WRITE_CHAR_UUID         "0000FFE1-0000-1000-8000-00805F9B34FB"
#define NOTIFY_CHAR_UUID        "0000FFE2-0000-1000-8000-00805F9B34FB"
// ========================================================================

// ===================== 全局状态 =====================
struct Config {
    uint8_t brightness;    // 亮度
    uint8_t speed;         // 流水速度
    uint8_t phaseMode;     // 相位模式
};
static Config cfg = { DEFAULT_BRIGHTNESS, DEFAULT_SPEED, DEFAULT_PHASE_MODE };

// 每条灯带的 LED 缓冲区
static CRGB leds[NUM_STRIPS][NUM_LEDS_PER_STRIP];

// 色带相位偏移量（0~255 的彩虹波，随帧推进）
static uint16_t phasePos = 0;

// 帧率
#define FRAME_INTERVAL_MS 20   // 50fps

// BLE 对象
static NimBLEServer*          gBleServer = nullptr;
static NimBLECharacteristic*  gWriteChar  = nullptr;
static NimBLECharacteristic*  gNotifyChar = nullptr;
static bool                   gBleConnected = false;
static std::string            gBleRxBuffer;   // 接收缓冲，按 '\n' 拆行

// 前向声明
static void handleCommand(const std::string& cmd, bool echo);
static void notifyStatus();

// ===================== BLE 回调类 =====================
// 注意：NimBLE-Arduino 1.4.x 使用旧版回调签名（无 NimBLEConnInfo 参数）。
// 必须定义在 setup() 之前，setup() 才能 new 它们。
class ServerCallbacks : public NimBLEServerCallbacks {
    void onConnect(NimBLEServer* s) override {
        gBleConnected = true;
        Serial.println("[BLE] 手机已连接");
        notifyStatus();
    }

    void onDisconnect(NimBLEServer* s) override {
        gBleConnected = false;
        gBleRxBuffer.clear();
        Serial.println("[BLE] 手机断开");
        NimBLEDevice::startAdvertising();
        Serial.println("[BLE] 重新开始广播");
    }
};

class WriteCallbacks : public NimBLECharacteristicCallbacks {
    void onWrite(NimBLECharacteristic* c) override {
        std::string value = c->getValue();
        if (value.empty()) return;

        Serial.print("[BLE] 收到: ");
        for (unsigned char ch : value) {
            if (ch >= 0x20 && ch < 0x7f) Serial.print((char)ch);
            else Serial.printf("\\x%02X", ch);
        }
        Serial.println();

        // 按 '\n' 拆行（容错：也接受 '\r' 结尾）
        gBleRxBuffer += value;
        size_t pos;
        while ((pos = gBleRxBuffer.find('\n')) != std::string::npos) {
            std::string line = gBleRxBuffer.substr(0, pos);
            gBleRxBuffer.erase(0, pos + 1);
            while (!line.empty() && (line.back() == '\r' || line.back() == ' ')) {
                line.pop_back();
            }
            if (!line.empty()) {
                handleCommand(line, false);
            }
        }
        if (gBleRxBuffer.size() > 128) {
            gBleRxBuffer.clear();
        }
    }
};

// ===================== 初始化 =====================
void setup() {
    Serial.begin(115200);
    delay(1500);  // 等 USB-CDC 枚举完成（C3 用原生 USB 时）

    Serial.println();
    Serial.println("========================================");
    Serial.println("  ESP32-C3FH4 8 路彩虹流水灯  BLE v1.1");
    Serial.println("========================================");
    Serial.printf("  灯带数: %d x %d 颗\n", NUM_STRIPS, NUM_LEDS_PER_STRIP);
    Serial.printf("  引脚:  0,1,3,4,5,6,7,10\n");
    Serial.printf("  亮度:  %d (0-255)\n", cfg.brightness);
    Serial.printf("  速度:  %d (1-100)\n", cfg.speed);
    Serial.printf("  相位:  %s\n", cfg.phaseMode ? "错相位" : "同相位");
    Serial.println("----------------------------------------");
    Serial.println("命令: b<0-255> 亮度 | s<1-100> 速度 | p<0|1> 相位 | r 重置 | ? 查询 | h 帮助");
    Serial.println("========================================");

    // 初始化 8 路灯带（RMT 驱动 WS2812B）
    FastLED.addLeds<WS2812B, LED_PIN_0, COLOR_ORDER>(leds[0], NUM_LEDS_PER_STRIP);
    FastLED.addLeds<WS2812B, LED_PIN_1, COLOR_ORDER>(leds[1], NUM_LEDS_PER_STRIP);
    FastLED.addLeds<WS2812B, LED_PIN_2, COLOR_ORDER>(leds[2], NUM_LEDS_PER_STRIP);
    FastLED.addLeds<WS2812B, LED_PIN_3, COLOR_ORDER>(leds[3], NUM_LEDS_PER_STRIP);
    FastLED.addLeds<WS2812B, LED_PIN_4, COLOR_ORDER>(leds[4], NUM_LEDS_PER_STRIP);
    FastLED.addLeds<WS2812B, LED_PIN_5, COLOR_ORDER>(leds[5], NUM_LEDS_PER_STRIP);
    FastLED.addLeds<WS2812B, LED_PIN_6, COLOR_ORDER>(leds[6], NUM_LEDS_PER_STRIP);
    FastLED.addLeds<WS2812B, LED_PIN_7, COLOR_ORDER>(leds[7], NUM_LEDS_PER_STRIP);

    FastLED.setBrightness(cfg.brightness);
    FastLED.clear(true);  // 上电先全灭

    // GPIO10 显式低电平（防启动瞬间乱闪，条件允许时外部加 10kΩ 下拉更稳妥）
    pinMode(LED_PIN_7, OUTPUT);
    digitalWrite(LED_PIN_7, LOW);

    // 初始化 BLE
    NimBLEDevice::init(BLE_DEVICE_NAME);
    NimBLEDevice::setPower(ESP_PWR_LVL_P9);  // 最大发射功率（C3 可选 P9）
    NimBLEDevice::setMTU(64);                // 协商更大 MTU，减少分包

    gBleServer = NimBLEDevice::createServer();
    gBleServer->setCallbacks(new ServerCallbacks());

    NimBLEService* svc = gBleServer->createService(SERVICE_UUID);

    // 写特性：手机→设备，支持 write + writeNoResponse
    gWriteChar = svc->createCharacteristic(
        WRITE_CHAR_UUID,
        NIMBLE_PROPERTY::WRITE | NIMBLE_PROPERTY::WRITE_NR
    );
    gWriteChar->setCallbacks(new WriteCallbacks());

    // 通知特性：设备→手机
    gNotifyChar = svc->createCharacteristic(
        NOTIFY_CHAR_UUID,
        NIMBLE_PROPERTY::NOTIFY
    );

    svc->start();

    // 广播
    NimBLEAdvertising* adv = NimBLEDevice::getAdvertising();
    adv->addServiceUUID(SERVICE_UUID);
    adv->setName(BLE_DEVICE_NAME);
    NimBLEDevice::startAdvertising();

    Serial.println("[BLE] 广播已启动: " BLE_DEVICE_NAME);
    Serial.println("[BLE] Service: " SERVICE_UUID);
}

// ===================== 彩虹色带填充 =====================
// 把整条灯带填成一条彩虹色带：颜色沿灯带位置循环渐变
// offset 控制彩虹波整体平移，实现"流水"效果
void fillRainbowStrip(CRGB* strip, uint16_t offset, uint8_t deltaScale) {
    for (uint16_t i = 0; i < NUM_LEDS_PER_STRIP; i++) {
        // 用 CHSV 色相沿灯带均匀分布一圈彩虹，并加整体偏移量实现流动
        uint8_t hue = (uint8_t)(i * 256 / NUM_LEDS_PER_STRIP + offset);
        strip[i] = CHSV(hue, 255, 255);
    }
}

// ===================== 渲染一帧 =====================
// deltaScale：本帧前进量（0~255 映射到 0~NUM_LEDS 颗灯）
void renderFrame() {
    // 1) 计算本帧前进量：speed 1~100 -> 0.05~20 颗灯/帧
    //    线性映射到 0~255 的整数，再换算成色相偏移
    uint16_t advanceHue = (uint16_t)((uint32_t)cfg.speed * SPEED_STEP_NUM / SPEED_MAX) / 8;

    // 2) 每条灯带填充彩虹色带，相位偏移按模式区分
    for (uint8_t s = 0; s < NUM_STRIPS; s++) {
        uint16_t offset = phasePos;
        if (cfg.phaseMode == 1) {
            // 错相位：每条灯带依次偏移 1/8 彩虹波，形成波浪
            offset = phasePos + (uint16_t)s * 32;
        }
        fillRainbowStrip(leds[s], offset, 255);
    }

    // 3) 推进色相相位（8 位色相环：255 为整圈）
    phasePos += advanceHue;

    // 4) 输出到灯带
    FastLED.show();
}

// ===================== 命令处理 =====================
// echo=true 时同时把回执写到串口（调试用）
static void handleCommand(const std::string& cmdRaw, bool echo) {
    if (cmdRaw.empty()) return;

    if (echo) Serial.printf(">> %s\n", cmdRaw.c_str());

    char c = cmdRaw[0];
    switch (c) {
        case 'b': {
            int v = atoi(cmdRaw.c_str() + 1);
            if (v < 0) v = 0;
            if (v > 255) v = 255;
            cfg.brightness = (uint8_t)v;
            FastLED.setBrightness(cfg.brightness);
            if (echo) Serial.printf("    亮度 -> %d\n", cfg.brightness);
            notifyStatus();
            break;
        }
        case 's': {
            int v = atoi(cmdRaw.c_str() + 1);
            if (v < SPEED_MIN) v = SPEED_MIN;
            if (v > SPEED_MAX) v = SPEED_MAX;
            cfg.speed = (uint8_t)v;
            if (echo) Serial.printf("    速度 -> %d\n", cfg.speed);
            notifyStatus();
            break;
        }
        case 'p': {
            int v = atoi(cmdRaw.c_str() + 1);
            cfg.phaseMode = (v == 1) ? 1 : 0;
            if (echo) Serial.printf("    相位模式 -> %s\n", cfg.phaseMode ? "错相位(波浪)" : "同相位(瀑布)");
            notifyStatus();
            break;
        }
        case 'r': {
            FastLED.clear(true);
            phasePos = 0;
            if (echo) Serial.println("    灯效已重置");
            notifyStatus();
            break;
        }
        case '?': {
            // 查询状态：回一行 b<speed><phase>，例如 "b128 s50 p0"
            notifyStatus();
            break;
        }
        case 'h': {
            const char* help =
                "命令: b<0-255> 亮度 | s<1-100> 速度 | p<0|1> 相位 | r 重置 | ? 查询 | h 帮助\n";
            if (echo) Serial.println("命令列表:");
            if (echo) Serial.println("  b<0-255>   亮度 (例: b128)");
            if (echo) Serial.println("  s<1-100>   速度 (例: s50)");
            if (echo) Serial.println("  p<0|1>     相位: 0=同相位 1=错相位");
            if (echo) Serial.println("  r          重置灯效");
            if (echo) Serial.println("  ?          查询当前状态");
            if (echo) Serial.println("  h          帮助");
            if (gBleConnected && gNotifyChar) {
                gNotifyChar->setValue(help);
                gNotifyChar->notify();
            }
            break;
        }
        default:
            if (echo) Serial.println("    未知命令，输入 h 查看帮助");
            if (gBleConnected && gNotifyChar) {
                gNotifyChar->setValue("unknown cmd\n");
                gNotifyChar->notify();
            }
            break;
    }
}

// 状态上报：通过 notify 发回手机，格式 "b<亮度> s<速度> p<相位>\n"
static void notifyStatus() {
    if (!gBleConnected || !gNotifyChar) return;
    char buf[48];
    snprintf(buf, sizeof(buf), "b%u s%u p%u\n", cfg.brightness, cfg.speed, cfg.phaseMode);
    gNotifyChar->setValue(buf);
    gNotifyChar->notify();
}

// ===================== 串口命令处理 =====================
void handleSerial() {
    static std::string serialBuf;
    while (Serial.available()) {
        char ch = (char)Serial.read();
        if (ch == '\n' || ch == '\r') {
            if (!serialBuf.empty()) {
                // 去掉可能的尾部\r
                while (!serialBuf.empty() && (serialBuf.back() == '\r' || serialBuf.back() == ' ')) {
                    serialBuf.pop_back();
                }
                if (!serialBuf.empty()) {
                    handleCommand(serialBuf, true);
                }
                serialBuf.clear();
            }
        } else {
            serialBuf.push_back(ch);
            // 防止异常输入把缓冲撑爆
            if (serialBuf.size() > 64) serialBuf.clear();
        }
    }
}

// ===================== 主循环 =====================
void loop() {
    static uint32_t lastFrame = 0;
    uint32_t now = millis();

    // 帧率控制（50fps）
    if (now - lastFrame >= FRAME_INTERVAL_MS) {
        lastFrame = now;
        renderFrame();
    }

    handleSerial();
    delay(1);  // 让出 CPU 给 BLE 协议栈
}
