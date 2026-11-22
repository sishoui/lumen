/**
 * utils/config.js — 全局配置
 */
const BLE = {
  namePrefix: 'BT-',           // 广播名前缀（与固件 BLE_NAME_PREFIX 一致）
  serviceUUID: '0000FFE0-0000-1000-8000-00805F9B34FB',
  writeCharUUID: '0000FFE1-0000-1000-8000-00805F9B34FB',
  notifyCharUUID: '0000FFE2-0000-1000-8000-00805F9B34FB',
  scanTimeout: 10000,
  mtu: 20,
  autoReconnect: true,
  reconnectDelay: 2000,
  maxReconnectAttempts: 3
};

module.exports = { BLE };
