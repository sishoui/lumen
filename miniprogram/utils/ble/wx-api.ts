/**
 * wx.* BLE API 的唯一接触点（工单 #6 决策 4「wx 边界」）。
 *
 * 所有 wx 引用都在函数体内（typeof wx !== "undefined" 守卫），保证 vitest
 * node 环境 import 产品代码不炸。BleTransport 构造时注入 WxApi 实例；
 * 测试传 fake-wx 假件。这样 `import { BleTransport }` 在 node 里安全。
 *
 * 真实 wx 对象在开发者工具 / 真机里是全局的；这里只是把它包成一个接口，
 * 让传输层依赖接口而不是全局变量。
 */

import type { AdapterState, DiscoveredDevice, LinkState } from "../protocol/types";

/** 微信 BLE 操作的最小接口集（BleTransport 用到的全部）。 */
export interface WxApi {
  openBluetoothAdapter(): Promise<void>;
  closeBluetoothAdapter(): Promise<void>;
  getBluetoothAdapterState(): Promise<{ available: boolean; discovering: boolean }>;

  startBluetoothDevicesDiscovery(opts: {
    services?: string[];
    allowDuplicatesKey?: boolean;
  }): Promise<void>;
  stopBluetoothDevicesDiscovery(): Promise<void>;
  onBluetoothDeviceFound(
    cb: (devices: Array<{ deviceId: string; name?: string; localName?: string; RSSI?: number }>) => void,
  ): void;
  offBluetoothDeviceFound?(): void;

  createBLEConnection(deviceId: string): Promise<void>;
  closeBLEConnection(deviceId: string): Promise<void>;
  onBLEConnectionStateChange(
    cb: (res: { deviceId: string; connected: boolean }) => void,
  ): void;

  getBLEDeviceServices(deviceId: string): Promise<{ services: Array<{ uuid: string; isPrimary: boolean }> }>;
  getBLEDeviceCharacteristics(
    deviceId: string,
    serviceId: string,
  ): Promise<{ characteristics: Array<{ uuid: string; properties: Record<string, boolean> }> }>;

  notifyBLECharacteristicValueChange(opts: {
    deviceId: string;
    serviceId: string;
    characteristicId: string;
    state: boolean;
  }): Promise<void>;
  onBLECharacteristicValueChange(
    cb: (res: { deviceId: string; serviceId: string; characteristicId: string; value: ArrayBuffer }) => void,
  ): void;

  writeBLECharacteristicValue(opts: {
    deviceId: string;
    serviceId: string;
    characteristicId: string;
    value: ArrayBuffer;
  }): Promise<void>;

  readBLECharacteristicValue(opts: {
    deviceId: string;
    serviceId: string;
    characteristicId: string;
  }): Promise<void>;
  onBLECharacteristicValueChangeRead(
    cb: (res: { deviceId: string; serviceId: string; characteristicId: string; value: ArrayBuffer }) => void,
  ): void;

  setBLEMTU?(opts: { deviceId: string; mtu: number }): Promise<{ mtu: number }>;

  onBluetoothAdapterStateChange(cb: (res: { available: boolean; discovering: boolean }) => void): void;

  /** 仅用于 mock / 测试标记当前适配器状态；真实 wx 无此方法。 */
  getMockLinkState?(): LinkState;
  getMockAdapterState?(): AdapterState;
  getMockDiscovered?(): DiscoveredDevice[];
}

/** 默认 wx 适配器：懒访问全局 wx.*，不存在时抛错。 */
export class DefaultWxApi implements WxApi {
  private wxObj(): any {
    const g: any = typeof wx !== "undefined" ? wx : undefined;
    if (g === undefined) {
      throw new Error("DefaultWxApi 在非 wx 环境下不可用：请注入 WxApi 假件");
    }
    return g;
  }

  openBluetoothAdapter(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.wxObj().openBluetoothAdapter({ success: () => resolve(), fail: reject });
    });
  }

  closeBluetoothAdapter(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.wxObj().closeBluetoothAdapter({ success: () => resolve(), fail: reject });
    });
  }

  getBluetoothAdapterState(): Promise<{ available: boolean; discovering: boolean }> {
    return new Promise((resolve, reject) => {
      this.wxObj().getBluetoothAdapterState({
        success: (res: any) => resolve({ available: res.available, discovering: res.discovering }),
        fail: reject,
      });
    });
  }

  startBluetoothDevicesDiscovery(opts: {
    services?: string[];
    allowDuplicatesKey?: boolean;
  }): Promise<void> {
    return new Promise((resolve, reject) => {
      this.wxObj().startBluetoothDevicesDiscovery({
        services: opts.services ?? [],
        allowDuplicatesKey: opts.allowDuplicatesKey ?? false,
        success: () => resolve(),
        fail: reject,
      });
    });
  }

  stopBluetoothDevicesDiscovery(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.wxObj().stopBluetoothDevicesDiscovery({ success: () => resolve(), fail: reject });
    });
  }

  onBluetoothDeviceFound(
    cb: (devices: Array<{ deviceId: string; name?: string; localName?: string; RSSI?: number }>) => void,
  ): void {
    this.wxObj().onBluetoothDeviceFound({ onBluetoothDeviceFound: cb } as any);
    // 微信实际签名：wx.onBluetoothDeviceFound(cb) 或 wx.onBluetoothDeviceFound({onBluetoothDeviceFound: cb})
    // 兼容两种形态：直接传函数
    try {
      (this.wxObj() as any).onBluetoothDeviceFound(cb);
    } catch {
      /* 已用对象形态注册，忽略 */
    }
  }

  offBluetoothDeviceFound?(): void {
    try {
      (this.wxObj() as any).offBluetoothDeviceFound?.();
    } catch {
      /* ignore */
    }
  }

  createBLEConnection(deviceId: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.wxObj().createBLEConnection({
        deviceId,
        success: () => resolve(),
        fail: reject,
      });
    });
  }

  closeBLEConnection(deviceId: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.wxObj().closeBLEConnection({
        deviceId,
        success: () => resolve(),
        fail: reject,
      });
    });
  }

  onBLEConnectionStateChange(cb: (res: { deviceId: string; connected: boolean }) => void): void {
    this.wxObj().onBLEConnectionStateChange(cb);
  }

  getBLEDeviceServices(deviceId: string): Promise<{ services: Array<{ uuid: string; isPrimary: boolean }> }> {
    return new Promise((resolve, reject) => {
      this.wxObj().getBLEDeviceServices({
        deviceId,
        success: (res: any) =>
          resolve({
            services: res.services.map((s: any) => ({ uuid: s.uuid, isPrimary: s.isPrimary })),
          }),
        fail: reject,
      });
    });
  }

  getBLEDeviceCharacteristics(
    deviceId: string,
    serviceId: string,
  ): Promise<{ characteristics: Array<{ uuid: string; properties: Record<string, boolean> }> }> {
    return new Promise((resolve, reject) => {
      this.wxObj().getBLEDeviceCharacteristics({
        deviceId,
        serviceId,
        success: (res: any) =>
          resolve({
            characteristics: res.characteristics.map((c: any) => ({
              uuid: c.uuid,
              properties: c.properties,
            })),
          }),
        fail: reject,
      });
    });
  }

  notifyBLECharacteristicValueChange(opts: {
    deviceId: string;
    serviceId: string;
    characteristicId: string;
    state: boolean;
  }): Promise<void> {
    return new Promise((resolve, reject) => {
      this.wxObj().notifyBLECharacteristicValueChange({
        ...opts,
        success: () => resolve(),
        fail: reject,
      });
    });
  }

  onBLECharacteristicValueChange(
    cb: (res: { deviceId: string; serviceId: string; characteristicId: string; value: ArrayBuffer }) => void,
  ): void {
    this.wxObj().onBLECharacteristicValueChange(cb);
  }

  writeBLECharacteristicValue(opts: {
    deviceId: string;
    serviceId: string;
    characteristicId: string;
    value: ArrayBuffer;
  }): Promise<void> {
    return new Promise((resolve, reject) => {
      this.wxObj().writeBLECharacteristicValue({
        ...opts,
        success: () => resolve(),
        fail: reject,
      });
    });
  }

  readBLECharacteristicValue(opts: {
    deviceId: string;
    serviceId: string;
    characteristicId: string;
  }): Promise<void> {
    return new Promise((resolve, reject) => {
      this.wxObj().readBLECharacteristicValue({
        ...opts,
        success: () => resolve(),
        fail: reject,
      });
    });
  }

  onBLECharacteristicValueChangeRead(
    cb: (res: { deviceId: string; serviceId: string; characteristicId: string; value: ArrayBuffer }) => void,
  ): void {
    this.wxObj().onBLECharacteristicValueChange(cb);
  }

  setBLEMTU(opts: { deviceId: string; mtu: number }): Promise<{ mtu: number }> {
    return new Promise((resolve, reject) => {
      const wxObj = this.wxObj();
      if (typeof wxObj.setBLEMTU !== "function") {
        resolve({ mtu: opts.mtu });
        return;
      }
      wxObj.setBLEMTU({
        deviceId: opts.deviceId,
        mtu: opts.mtu,
        success: (res: any) => resolve({ mtu: res.mtu ?? opts.mtu }),
        fail: reject,
      });
    });
  }

  onBluetoothAdapterStateChange(cb: (res: { available: boolean; discovering: boolean }) => void): void {
    this.wxObj().onBluetoothAdapterStateChange(cb);
  }
}