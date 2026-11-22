// pages/control/control.js
const ble = require('../../utils/ble');

Page({
  data: {
    bleConnected: false,
    deviceName: '',
    brightness: 128,
    speed: 50,
    phaseMode: 0,
    logs: []
  },

  onLoad() {
    this._onConn = (info) => {
      this.setData({ bleConnected: info.connected, deviceName: info.deviceId ? this.data.deviceName : '' });
      if (info.connected) this._log('已连接');
      else this._log('已断开');
    };
    this._onStatus = (st) => {
      this.setData({ brightness: st.brightness, speed: st.speed, phaseMode: st.phaseMode });
      this._log('状态: ' + st.raw);
    };
    ble.on('connection', this._onConn);
    ble.on('status', this._onStatus);
  },

  onShow() {
    const st = ble.getState();
    this.setData({
      bleConnected: st.connected,
      deviceName: st.deviceId ? (this.data.deviceName || '') : ''
    });
    if (st.connected) ble.cmd.query();
  },

  onUnload() {
    ble.off('connection', this._onConn);
    ble.off('status', this._onStatus);
  },

  onBrightness(e) {
    const v = e.detail.value;
    this.setData({ brightness: v });
    ble.cmd.setBrightness(v).catch(() => this._log('发送失败'));
  },

  onSpeed(e) {
    const v = e.detail.value;
    this.setData({ speed: v });
    ble.cmd.setSpeed(v).catch(() => this._log('发送失败'));
  },

  onPhase(e) {
    const v = +e.currentTarget.dataset.v;
    this.setData({ phaseMode: v });
    ble.cmd.setPhase(v).catch(() => this._log('发送失败'));
  },

  onReset() {
    ble.cmd.reset().then(() => this._log('已发送重置')).catch(() => this._log('发送失败'));
  },

  onQuery() {
    ble.cmd.query().catch(() => this._log('发送失败'));
  },

  goConnect() {
    wx.navigateTo({ url: '/pages/connect/connect' });
  },

  _log(msg) {
    const t = new Date();
    const ts = `[${String(t.getHours()).padStart(2,'0')}:${String(t.getMinutes()).padStart(2,'0')}:${String(t.getSeconds()).padStart(2,'0')}]`;
    const logs = [ts + ' ' + msg].concat(this.data.logs).slice(0, 30);
    this.setData({ logs });
  }
});