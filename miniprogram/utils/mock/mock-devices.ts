/**
 * 演示用设备清单（mock 模式的唯一数据源，工单 #6 决策 8）。
 *
 * 三台形状刻意不同（带数 / 开关 / 亮度），让「能力从设备读」在演示模式可见。
 * 这些 spec 由 MockTransport 播种到 MockDeviceRuntime，由测试断言期望值，
 * 由 conformance 测试当期望态——测试不再抄一份设备参数。
 */

/** 一个部位的初始状态。 */
export interface MockPartSeed {
  stripId: number;
  partId: number;
  name: string;
  segs: Array<[number, number]>;
  hue: number;
  sat: number;
}

/** 一台演示设备能提供的一切（连接后由 mock transport 逐项产出）。 */
export interface MockDeviceSpec {
  deviceId: string;
  /** 设备自报的 6 字节 BT MAC（DeviceInfoReport 0x88）。 */
  hwId: string;
  broadcastName: string;
  remark: string;
  /** 逐带灯珠数（State.led_count[8]）；长度即条数，最多 8。 */
  stripCounts: number[];
  power: 0 | 1;
  brightness: number;
  maxBrightness: number;
  stripPowerMask: number;
  parts: MockPartSeed[];
}

/**
 * 三台演示设备：
 *  - 书桌：2 带 [60,30]、开机亮、brightness 168；
 *  - 客厅：8 带 [100,100,100,100,60,60,60,60]、关机；
 *  - 卧室：1 带 [24]、亮但亮度 34。
 */
export const MOCK_DEVICES: readonly MockDeviceSpec[] = [
  {
    deviceId: "A4:CF:12:9B:3E:01",
    hwId: "3C:71:BF:00:00:01",
    broadcastName: "LUMEN-9B01",
    remark: "书桌",
    stripCounts: [60, 30, 0, 0, 0, 0, 0, 0],
    power: 1,
    brightness: 168,
    maxBrightness: 200,
    stripPowerMask: 0x03,
    parts: [
      { stripId: 0, partId: 0, name: "前半", segs: [[0, 29]], hue: 7281, sat: 255 },
      { stripId: 0, partId: 1, name: "后半", segs: [[30, 59]], hue: 43690, sat: 200 },
      { stripId: 1, partId: 0, name: "", segs: [[0, 29]], hue: 7281, sat: 255 },
    ],
  },
  {
    deviceId: "A4:CF:12:9B:3E:02",
    hwId: "3C:71:BF:00:00:02",
    broadcastName: "LUMEN-9B02",
    remark: "客厅",
    stripCounts: [100, 100, 100, 100, 60, 60, 60, 60],
    power: 0,
    brightness: 120,
    maxBrightness: 200,
    stripPowerMask: 0xff,
    parts: [
      { stripId: 0, partId: 0, name: "顶", segs: [[0, 99]], hue: 36409, sat: 180 },
      { stripId: 1, partId: 0, name: "左", segs: [[0, 99]], hue: 36409, sat: 180 },
      { stripId: 2, partId: 0, name: "右", segs: [[0, 99]], hue: 36409, sat: 180 },
      { stripId: 3, partId: 0, name: "底", segs: [[0, 99]], hue: 36409, sat: 180 },
    ],
  },
  {
    deviceId: "A4:CF:12:9B:3E:03",
    hwId: "3C:71:BF:00:00:03",
    broadcastName: "LUMEN-9B03",
    remark: "卧室",
    stripCounts: [24, 0, 0, 0, 0, 0, 0, 0],
    power: 1,
    brightness: 34,
    maxBrightness: 200,
    stripPowerMask: 0x01,
    parts: [{ stripId: 0, partId: 0, name: "", segs: [[0, 23]], hue: 50000, sat: 200 }],
  },
];

/** 演示模式存储键（无真机记录自动开 + 用户显式开关）。 */
export const MOCK_MODE_KEY = "lumen.mockMode.v1";
/** 真机身份缓存键（连接成功后写）。 */
export const DEVICE_CACHE_KEY = "lumen.device.v1";

export function mockSpecOf(deviceId: string): MockDeviceSpec | undefined {
  return MOCK_DEVICES.find((s) => s.deviceId === deviceId);
}