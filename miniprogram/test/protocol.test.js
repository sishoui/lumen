// test/protocol.test.js
const assert = require('assert');

global.wx = {
  openBluetoothAdapter: (o) => o.success(),
  onBluetoothAdapterStateChange: () => {},
  getBluetoothAdapterState: (o) => o.success({ available: true, discovering: false }),
  closeBluetoothAdapter: (o) => o.success(),
  offBluetoothDeviceFound: () => {},
  onBluetoothDeviceFound: () => {},
  startBluetoothDevicesDiscovery: (o) => o.success(),
  stopBluetoothDevicesDiscovery: (o) => o.success(),
  createBLEConnection: (o) => o.success(),
  onBLEConnectionStateChange: () => {},
  getBLEDeviceServices: (o) => o.success({ services: [{ uuid: '0000FFE0-0000-1000-8000-00805F9B34FB', isPrimary: true }] }),
  getBLEDeviceCharacteristics: (o) => o.success({ characteristics: [
    { uuid: '0000FFE1-0000-1000-8000-00805F9B34FB', properties: { write: true, writeNoResponse: true } },
    { uuid: '0000FFE2-0000-1000-8000-00805F9B34FB', properties: { notify: true } }
  ]}),
  notifyBLECharacteristicValueChange: (o) => o.success(),
  onBLECharacteristicValueChange: () => {},
  closeBLEConnection: (o) => o.success(),
  showToast: () => {},
  showLoading: () => {},
  hideLoading: () => {},
  showModal: (o) => o.success && o.success({ confirm: true }),
  navigateTo: () => {},
  switchTab: () => {}
};

const ble = require('../utils/ble.js');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try { fn(); passed++; console.log('  PASS  ' + name); }
  catch (e) { failed++; console.log('  FAIL  ' + name + '  ' + e.message); }
}

async function asyncTest(name, fn) {
  try { await fn(); passed++; console.log('  PASS  ' + name); }
  catch (e) { failed++; console.log('  FAIL  ' + name + '  ' + e.message); }
}

// ---------- L1 协议单测（Mock 模式下通过日志捕获命令字符串） ----------
console.log('\n=== L1 协议单测 ===');

let captured = [];
const origLog = console.log;
console.log = (...args) => {
  const msg = args.join(' ');
  if (msg.includes('[BLE MOCK] send:')) {
    const match = msg.match(/"(.+)"/);
    if (match) captured.push(JSON.parse('"' + match[1] + '"'));
  }
};

test('亮度命令字符串', () => {
  captured = [];
  ble.cmd.setBrightness(128);
  assert.deepStrictEqual(captured, ['b128\n']);
});

test('速度命令字符串', () => {
  captured = [];
  ble.cmd.setSpeed(50);
  assert.deepStrictEqual(captured, ['s50\n']);
});

test('相位命令字符串', () => {
  captured = [];
  ble.cmd.setPhase(1);
  assert.deepStrictEqual(captured, ['p1\n']);
});

test('重置命令字符串', () => {
  captured = [];
  ble.cmd.reset();
  assert.deepStrictEqual(captured, ['r\n']);
});

test('查询命令字符串', () => {
  captured = [];
  ble.cmd.query();
  assert.deepStrictEqual(captured, ['?\n']);
});

test('亮度 clamp 0-255', () => {
  captured = [];
  ble.cmd.setBrightness(999);
  assert.deepStrictEqual(captured, ['b255\n']);
});

test('速度 clamp 1-100', () => {
  captured = [];
  ble.cmd.setSpeed(200);
  assert.deepStrictEqual(captured, ['s100\n']);
});

console.log = origLog;

// ---------- L2 Mock 模式测试 ----------
console.log('\n=== L2 Mock 模式测试 ===');

asyncTest('Mock 连接成功', async () => {
  const result = await ble.connect('mock1');
  assert.strictEqual(result.connected, true);
  assert.strictEqual(result.deviceId, 'mock1');
});

asyncTest('Mock 扫描返回设备', async () => {
  let found = null;
  ble.on('scan', (d) => { found = d; });
  await ble.startScan();
  await new Promise((r) => setTimeout(r, 500));
  assert.ok(found, '未收到扫描结果');
  assert.strictEqual(found.name, 'BT-Light-01');
});

// ---------- L3 页面逻辑测试 ----------
console.log('\n=== L3 页面逻辑测试 ===');

let connectPage = null;
let controlPage = null;

const vm = require('vm');
const fs = require('fs');
const path = require('path');

function runPage(code, pageName) {
  const context = {
    require: (p) => p === '../../utils/ble' ? require('../utils/ble.js') : require(p),
    console: { log: () => {}, error: () => {} },
    wx: global.wx,
    getApp: () => ({ globalData: { ble } }),
    ble: ble,
    Page: (config) => {
      config._pageName = pageName;
      if (pageName === 'connect') connectPage = config;
      else controlPage = config;
      return config;
    }
  };
  vm.createContext(context);
  vm.runInContext(code, context);
}

runPage(fs.readFileSync(path.resolve(__dirname, '../pages/connect/connect.js'), 'utf8'), 'connect');
runPage(fs.readFileSync(path.resolve(__dirname, '../pages/control/control.js'), 'utf8'), 'control');

test('连接页 onLoad 初始化', () => { assert.ok(connectPage); assert.strictEqual(typeof connectPage.toggleScan, 'function'); });
test('控制页 onLoad 初始化', () => { assert.ok(controlPage); assert.strictEqual(typeof controlPage.onBrightness, 'function'); });
test('控制页亮度 handler', () => { controlPage.data = { bleConnected: true, brightness: 128, logs: [] }; controlPage.setData = (d) => Object.assign(controlPage.data, d); controlPage._log = () => {}; controlPage.onBrightness({ detail: { value: 200 } }); assert.strictEqual(controlPage.data.brightness, 200); });
test('控制页相位 handler', () => { controlPage.data = { bleConnected: true, phaseMode: 0, logs: [] }; controlPage.setData = (d) => Object.assign(controlPage.data, d); controlPage._log = () => {}; controlPage.onPhase({ currentTarget: { dataset: { v: '1' } } }); assert.strictEqual(controlPage.data.phaseMode, 1); });

// ---------- 汇总 ----------
(async () => {
  await new Promise((r) => setTimeout(r, 2000));
  console.log('\n========================================');
  console.log(`  ${passed} passed, ${failed} failed`);
  console.log('========================================');
  process.exit(failed > 0 ? 1 : 0);
})();