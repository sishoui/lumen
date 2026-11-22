/**
 * mock-device.js — 用 Node.js 模拟 ESP32-C3 的 BLE 外设
 *
 * 它实现与固件相同的 GATT 服务：
 *   Service  : 0000FFE0-0000-1000-8000-00805F9B34FB
 *   Write    : 0000FFE1-...   (手机→设备，ASCII 命令 '\n' 结尾)
 *   Notify   : 0000FFE2-...   (设备→手机，状态 "b128 s50 p0\n")
 *
 * 设备端命令处理逻辑与 src/main.cpp 的 handleCommand 完全一致。
 * 当收到 b/s/p/r/? 命令时，会更新内部状态并通过 notify 回执。
 *
 * 使用方式：
 *   node test/mock-device.js
 *   然后在微信开发者工具里扫描连接 "BT-Light-01"。
 */

const util = require('util');

// 尝试加载 @abandonware/bleno；没有则给出友好提示
let bleno = null;
try {
  bleno = require('@abandonware/bleno');
} catch (e) {
  try {
    bleno = require('bleno');
  } catch (e2) {
    bleno = null;
  }
}

// ---------- 设备状态 ----------
const state = {
  brightness: 128,
  speed: 50,
  phaseMode: 0
};

let notifyCallback = null;

function buildStatusReply() {
  return `b${state.brightness} s${state.speed} p${state.phaseMode}\n`;
}

function notifyStatus() {
  if (notifyCallback) {
    const buf = Buffer.from(buildStatusReply(), 'utf8');
    notifyCallback(buf);
    console.log('[设备] notify:', JSON.stringify(buf.toString()));
  }
}

function handleCommand(cmd) {
  const line = (cmd || '').trim();
  if (!line) return;
  console.log('[设备] 收到命令:', JSON.stringify(line));

  const c = line[0];
  switch (c) {
    case 'b': {
      let v = parseInt(line.slice(1), 10);
      if (isNaN(v)) v = 0;
      v = Math.max(0, Math.min(255, v));
      state.brightness = v;
      console.log(`[设备] 亮度 -> ${state.brightness}`);
      notifyStatus();
      break;
    }
    case 's': {
      let v = parseInt(line.slice(1), 10);
      if (isNaN(v)) v = 1;
      v = Math.max(1, Math.min(100, v));
      state.speed = v;
      console.log(`[设备] 速度 -> ${state.speed}`);
      notifyStatus();
      break;
    }
    case 'p': {
      const v = parseInt(line.slice(1), 10);
      state.phaseMode = (v === 1) ? 1 : 0;
      console.log(`[设备] 相位 -> ${state.phaseMode ? '错相位' : '同相位'}`);
      notifyStatus();
      break;
    }
    case 'r': {
      state.brightness = 128;
      state.speed = 50;
      state.phaseMode = 0;
      console.log('[设备] 灯效已重置');
      notifyStatus();
      break;
    }
    case '?': {
      console.log('[设备] 查询当前状态');
      notifyStatus();
      break;
    }
    case 'h': {
      const help = '命令: b<0-255> 亮度 | s<1-100> 速度 | p<0|1> 相位 | r 重置 | ? 查询 | h 帮助\n';
      if (notifyCallback) {
        notifyCallback(Buffer.from(help, 'utf8'));
        console.log('[设备] 帮助');
      }
      break;
    }
    default: {
      console.log('[设备] 未知命令:', line);
      if (notifyCallback) notifyCallback(Buffer.from('unknown cmd\n', 'utf8'));
      break;
    }
  }
}

function startBle() {
  if (!bleno) {
    console.error('[错误] 未安装 bleno，无法启动 BLE 模拟设备。');
    console.error('请尝试: npm install @abandonware/bleno 或 npm install bleno');
    process.exit(1);
  }

  const SERVICE_UUID = 'ffe0';
  const WRITE_UUID = 'ffe1';
  const NOTIFY_UUID = 'ffe2';
  const DEVICE_NAME = 'BT-Light-01';

  bleno.on('stateChange', (stateName) => {
    if (stateName === 'poweredOn') {
      console.log('[BLE] 适配器已开启，开始广播:', DEVICE_NAME);
      bleno.startAdvertising(DEVICE_NAME, [SERVICE_UUID]);
    } else if (stateName === 'poweredOff') {
      console.log('[BLE] 适配器已关闭');
      bleno.stopAdvertising();
    }
  });

  bleno.on('advertisingStart', (err) => {
    if (err) {
      console.error('[BLE] 广播失败:', err);
      return;
    }
    console.log('[BLE] 广播中，等待手机连接...');
    bleno.setServices([
      new bleno.PrimaryService({
        uuid: SERVICE_UUID,
        characteristics: [
          new bleno.Characteristic({
            uuid: WRITE_UUID,
            properties: ['write', 'writeWithoutResponse'],
            onWriteRequest: (data, offset, withoutResponse, callback) => {
              const text = data.toString('utf8');
              console.log('[BLE] 收到原始:', JSON.stringify(text));
              // 按 \n 拆行
              text.split('\n').forEach((line) => {
                if (line.trim()) handleCommand(line);
              });
              callback(bleno.Characteristic.RESULT_SUCCESS);
            }
          }),
          new bleno.Characteristic({
            uuid: NOTIFY_UUID,
            properties: ['notify'],
            onSubscribe: (maxValueSize, updateValueCallback) => {
              console.log('[BLE] 手机已订阅 notify');
              notifyCallback = updateValueCallback;
              // 连上后主动推一次状态
              notifyStatus();
            },
            onUnsubscribe: () => {
              console.log('[BLE] 手机取消订阅');
              notifyCallback = null;
            }
          })
        ]
      })
    ]);
  });

  bleno.on('accept', (address) => {
    console.log('[BLE] 手机已连接:', address);
  });

  bleno.on('disconnect', () => {
    console.log('[BLE] 手机断开');
  });

  console.log('模拟设备启动中...');
}

if (require.main === module) {
  startBle();
}

module.exports = { handleCommand, state, notifyStatus };