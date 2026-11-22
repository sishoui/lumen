/**
 * utils/ble.js — BLE 低功耗蓝牙封装（与 bt-light 固件约定）
 *
 * 职责：适配器初始化 / 扫描 / 连接 / 服务发现 / notify 订阅 / 指令写入 / 断线重连
 *
 * 固件约定（src/main.cpp）：
 *   广播名前缀 : BT-
 *   Service     : 0000FFE0-0000-1000-8000-00805F9B34FB
 *   Write       : 0000FFE1-... (手机→设备，下发 ASCII 命令，'\n' 结尾)
 *   Notify      : 0000FFE2-... (设备→手机，ASCII 状态 "b128 s50 p0\n")
 */

// ==================== Mock 模式 ====================
// 默认开启（开发/测试用），生产环境设 BLE_MOCK=0 或 false
let MOCK_MODE = process.env.BLE_MOCK !== '0';
const MOCK_SCENARIOS = {
  normal: { delay: 200, failRate: 0 },
  slow: { delay: 2000, failRate: 0 },
  flaky: { delay: 500, failRate: 0.3 },
  offline: { delay: 100, failRate: 1.0 }
};
let currentScenario = MOCK_SCENARIOS.normal;

function setMockMode(on) { MOCK_MODE = !!on; }

const { BLE } = require('./config');

const state = {
  adapterReady: false,
  scanning: false,
  connected: false,
  deviceId: null,
  serviceId: '',
  writeCharId: '',
  notifyCharId: '',
  reconnectAttempts: 0,
  manualClose: false,
  writeQueue: Promise.resolve(),
  lastError: null,
  // 最近一次上报的状态
  status: null
};

const listeners = {
  status: [],      // ({ brightness, speed, phaseMode, raw })
  connection: [],  // ({ connected, deviceId, reason })
  scan: []         // ({ deviceId, name, RSSI })
};

function on(event, fn) {
  if (listeners[event]) listeners[event].push(fn);
  return () => off(event, fn);
}
function off(event, fn) {
  if (!listeners[event]) return;
  listeners[event] = listeners[event].filter((f) => f !== fn);
}
function emit(event, payload) {
  (listeners[event] || []).forEach((fn) => {
    try { fn(payload); } catch (e) { console.error('[ble] listener error', e); }
  });
}

function getState() {
  return Object.assign({}, state);
}

function call(name, options = {}) {
  return new Promise((resolve, reject) => {
    wx[name](Object.assign({}, options, {
      success: resolve,
      fail: (err) => reject(new Error((err && err.errMsg) || name + ' failed'))
    }));
  });
}

// ---------- 适配器 ----------
async function initAdapter() {
  if (MOCK_MODE) {
    console.log('[BLE MOCK] initAdapter');
    state.adapterReady = true;
    return { available: true, discovering: false };
  }

  try {
    await call('openBluetoothAdapter');
  } catch (e) {
    const msg = e.message || '';
    if (/10001/.test(msg)) throw new Error('蓝牙未开启，请打开手机蓝牙后重试');
    throw e;
  }
  wx.onBluetoothAdapterStateChange((res) => {
    state.adapterReady = !!res.available;
    if (!res.available) handleDisconnect('adapter_off');
  });
  const res = await call('getBluetoothAdapterState');
  state.adapterReady = !!res.available;
  return { available: !!res.available, discovering: !!res.discovering };
}

async function closeAdapter() {
  stopScan();
  try { await call('closeBluetoothAdapter'); } catch (e) { /* ignore */ }
  state.adapterReady = false;
}

// ---------- 扫描 ----------
function startScan(opts = {}) {
  // Mock 模式
  if (MOCK_MODE) {
    console.log('[BLE MOCK] startScan');
    setTimeout(() => {
      emit('scan', { deviceId: 'mock1', name: 'BT-Light-01', RSSI: -50 });
    }, 300);
    return Promise.resolve();
  }

  const timeout = (opts && opts.timeout) || BLE.scanTimeout;
  const prefix = (opts && opts.namePrefix !== undefined) ? opts.namePrefix : BLE.namePrefix;

  return new Promise((resolve, reject) => {
    if (!state.adapterReady) { reject(new Error('蓝牙适配器未初始化')); return; }

    wx.offBluetoothDeviceFound && wx.offBluetoothDeviceFound();

    wx.onBluetoothDeviceFound((res) => {
      (res.devices || []).forEach((dev) => {
        const name = dev.name || dev.localName || '';
        if (!name) return;
        if (prefix && name.indexOf(prefix) < 0) return;
        emit('scan', { deviceId: dev.deviceId, name, RSSI: dev.RSSI });
      });
    });

    state.scanning = true;
    call('startBluetoothDevicesDiscovery', { allowDuplicatesKey: true, powerLevel: 'high' })
      .then(() => {
        setTimeout(() => { stopScan().then(resolve); }, timeout);
      })
      .catch((e) => { state.scanning = false; reject(e); });
  });
}

async function stopScan() {
  if (!state.scanning) return;
  state.scanning = false;
  try { await call('stopBluetoothDevicesDiscovery'); } catch (e) { /* ignore */ }
}

// ---------- 连接 ----------
async function connect(deviceId, opts = {}) {
  // Mock 模式
  if (MOCK_MODE) {
    console.log('[BLE MOCK] connect', deviceId);
    state.connected = true;
    state.deviceId = deviceId;
    setTimeout(() => {
      const st = { brightness: 128, speed: 50, phaseMode: 0, raw: 'b128 s50 p0' };
      state.status = st;
      emit('status', st);
    }, 500);
    emit('connection', { connected: true, deviceId });
    return { connected: true, deviceId };
  }

  await stopScan();
  state.manualClose = false;
  state.reconnectAttempts = 0;

  await call('createBLEConnection', { deviceId, timeout: 10000 });

  // 监听断开
  wx.onBLEConnectionStateChange((res) => {
    if (res.deviceId === state.deviceId && !res.connected) {
      handleDisconnect('remote_closed');
    }
  });

  state.connected = true;
  state.deviceId = deviceId;

  const serviceUUID = (opts && opts.serviceUUID) || BLE.serviceUUID;
  const writeCharUUID = (opts && opts.writeCharUUID) || BLE.writeCharUUID;
  const notifyCharUUID = (opts && opts.notifyCharUUID) || BLE.notifyCharUUID;

  // 发现服务
  const svcRes = await call('getBLEDeviceServices', { deviceId });
  const services = svcRes.services || [];
  let targetSvc = services.find((s) => (s.uuid || '').toUpperCase() === serviceUUID.toUpperCase());
  if (!targetSvc) targetSvc = services.find((s) => s.isPrimary) || services[0];
  if (!targetSvc) throw new Error('未发现可用服务');
  state.serviceId = targetSvc.uuid;

  // 发现特征值
  const charRes = await call('getBLEDeviceCharacteristics', { deviceId, serviceId: state.serviceId });
  const chars = charRes.characteristics || [];
  const writeChar =
    chars.find((c) => (c.uuid || '').toUpperCase() === writeCharUUID.toUpperCase()) ||
    chars.find((c) => c.properties && (c.properties.write || c.properties.writeNoResponse));
  const notifyChar =
    chars.find((c) => (c.uuid || '').toUpperCase() === notifyCharUUID.toUpperCase()) ||
    chars.find((c) => c.properties && (c.properties.notify || c.properties.indicate));

  state.writeCharId = writeChar ? writeChar.uuid : '';
  state.notifyCharId = notifyChar ? notifyChar.uuid : '';

  // 订阅上报
  if (state.notifyCharId) {
    wx.onBLECharacteristicValueChange((res) => {
      if ((res.characteristicId || '').toUpperCase() !== state.notifyCharId.toUpperCase()) return;
      const raw = ab2str(res.value);
      console.log('[ble] notify:', raw);
      const st = parseStatus(raw);
      if (st) {
        state.status = st;
        emit('status', st);
      }
    });
    await call('notifyBLECharacteristicValueChange', {
      deviceId, serviceId: state.serviceId, characteristicId: state.notifyCharId, state: true
    });
  }

  const result = {
    connected: true, deviceId, serviceId: state.serviceId,
    writeCharId: state.writeCharId, notifyCharId: state.notifyCharId,
    hasWrite: !!state.writeCharId, hasNotify: !!state.notifyCharId
  };
  emit('connection', result);
  return result;
}

async function disconnect(deviceId) {
  state.manualClose = true;
  const id = deviceId || state.deviceId;
  if (id) {
    try { await call('closeBLEConnection', { deviceId: id }); } catch (e) { /* ignore */ }
  }
  handleDisconnect('manual');
}

function handleDisconnect(reason) {
  const wasConnected = state.connected;
  state.connected = false;
  state.manualClose = reason === 'manual';
  const deviceId = state.deviceId;

  if (wasConnected) {
    emit('connection', { connected: false, deviceId, reason });
  }

  if (reason !== 'manual' && reason !== 'adapter_off' && BLE.autoReconnect &&
      deviceId && !state.manualClose &&
      state.reconnectAttempts < BLE.maxReconnectAttempts) {
    state.reconnectAttempts++;
    setTimeout(() => {
      if (state.manualClose) return;
      connect(deviceId).catch((e) => {
        console.warn('[ble] 重连失败', state.reconnectAttempts, e.message);
        if (state.reconnectAttempts < BLE.maxReconnectAttempts) {
          handleDisconnect('reconnect_failed');
        } else {
          emit('connection', { connected: false, deviceId, reason: 'reconnect_exhausted' });
        }
      });
    }, BLE.reconnectDelay);
  }
}

// ---------- 写入 ----------
function writeRaw(buffer) {
  return new Promise((resolve, reject) => {
    if (!state.connected || !state.deviceId || !state.writeCharId) {
      reject(new Error('设备未连接或写特征值不可用'));
      return;
    }
    wx.writeBLECharacteristicValue({
      deviceId: state.deviceId,
      serviceId: state.serviceId,
      characteristicId: state.writeCharId,
      value: buffer,
      success: resolve,
      fail: (err) => reject(new Error((err && err.errMsg) || 'write failed'))
    });
  });
}

function send(buffer) {
  let ab;
  if (typeof buffer === 'string') {
    ab = str2ab(buffer);
  } else if (buffer instanceof ArrayBuffer) {
    ab = buffer;
  } else {
    ab = buffer;
  }

  // Mock 模式：模拟设备回执
  if (MOCK_MODE) {
    const text = ab2str(ab);
    console.log('[BLE MOCK] send:', JSON.stringify(text));
    if (Math.random() < currentScenario.failRate) {
      return Promise.reject(new Error('MOCK: 写入失败'));
    }
    return new Promise((resolve) => {
      setTimeout(() => {
        const st = { brightness: 200, speed: 80, phaseMode: 1, raw: 'b200 s80 p1' };
        state.status = st;
        emit('status', st);
        resolve();
      }, currentScenario.delay);
    });
  }

  state.writeQueue = state.writeQueue.then(async () => {
    const chunks = splitByMTU(ab, BLE.mtu);
    for (let i = 0; i < chunks.length; i++) {
      await writeRaw(chunks[i]);
      if (chunks.length > 1) await new Promise((r) => setTimeout(r, 30));
    }
  }).catch((e) => { console.error('[ble] send failed', e); throw e; });
  return state.writeQueue;
}

// ---------- 业务快捷方法 ----------
const cmd = {
  setBrightness: (v) => send('b' + clamp(v, 0, 255) + '\n'),
  setSpeed: (v) => send('s' + clamp(v, 1, 100) + '\n'),
  setPhase: (v) => send('p' + (v ? 1 : 0) + '\n'),
  reset: () => send('r\n'),
  query: () => send('?\n'),
  help: () => send('h\n'),
  raw: (text) => send(text.endsWith('\n') ? text : text + '\n')
};

// ---------- 工具 ----------
function ab2str(buffer) {
  try { return String.fromCharCode.apply(null, new Uint8Array(buffer)); }
  catch (e) { return ''; }
}
function str2ab(str) {
  const u8 = new Uint8Array(str.length);
  for (let i = 0; i < str.length; i++) u8[i] = str.charCodeAt(i) & 0xFF;
  return u8.buffer;
}
function splitByMTU(buffer, mtu) {
  const bytes = new Uint8Array(buffer);
  if (bytes.length <= mtu) return [buffer];
  const chunks = [];
  for (let i = 0; i < bytes.length; i += mtu) {
    const slice = bytes.slice(i, i + mtu);
    chunks.push(slice.buffer);
  }
  return chunks;
}
function clamp(v, lo, hi) {
  v = Number(v);
  if (isNaN(v)) v = lo;
  if (v < lo) v = lo;
  if (v > hi) v = hi;
  return v;
}
function parseStatus(raw) {
  // 期望格式 "b128 s50 p0" 或 "b128 s50 p0\n"
  const m = raw.match(/b(\d+)\s*s(\d+)\s*p([01])/);
  if (!m) return null;
  return { brightness: +m[1], speed: +m[2], phaseMode: +m[3], raw: raw.trim() };
}

module.exports = {
  initAdapter, closeAdapter, startScan, stopScan, connect, disconnect,
  send, getState, on, off, cmd, BLE, setMockMode
};