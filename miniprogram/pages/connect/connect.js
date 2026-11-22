// pages/connect/connect.js
const app = getApp();
const ble = require('../../utils/ble');

Page({
  data: {
    scanning: false,
    connected: false,
    deviceId: '',
    deviceName: '',
    devices: [],
    logs: []
  },

  onLoad() {
    this._onScan = (d) => this._onDevice(d);
    this._onConn = (info) => {
      this.setData({ connected: info.connected, deviceId: info.deviceId || '' });
      if (info.connected) {
        this.setData({ deviceName: this.data.deviceName || '已连接设备' });
        this._log('已连接');
        ble.cmd.query();
      } else {
        this._log('已断开: ' + (info.reason || ''));
      }
    };
    this._onStatus = (st) => {
      this._log('状态: ' + st.raw);
    };
    ble.on('scan', this._onScan);
    ble.on('connection', this._onConn);
    ble.on('status', this._onStatus);
  },

  onShow() {
    this._refreshConnected();
  },

  onHide() { this.stopScan(); },
  onUnload() {
    ble.off('scan', this._onScan);
    ble.off('connection', this._onConn);
    ble.off('status', this._onStatus);
    this.stopScan();
  },

  _refreshConnected() {
    const st = ble.getState();
    this.setData({
      connected: st.connected,
      deviceId: st.deviceId || '',
      deviceName: st.deviceId ? this.data.deviceName : ''
    });
  },

  _onDevice(d) {
    const list = this.data.devices;
    const idx = list.findIndex((x) => x.deviceId === d.deviceId);
    if (idx >= 0) list[idx] = d; else list.push(d);
    this.setData({ devices: list });
  },

  toggleScan() {
    if (this.data.scanning) this.stopScan();
    else this.startScan();
  },

  async startScan() {
    this.setData({ scanning: true, devices: [] });
    this._log('开始扫描...');
    try {
      await ble.initAdapter();
      await ble.startScan({ timeout: 10000 });
      this.setData({ scanning: false });
      this._log('扫描结束');
    } catch (e) {
      this.setData({ scanning: false });
      this._log('扫描失败: ' + (e && e.message));
    }
  },

  stopScan() {
    ble.stopScan();
    this.setData({ scanning: false });
  },

  async connect(e) {
    const d = e.currentTarget.dataset.device;
    if (!d) return;
    this._log('连接 ' + d.name + ' ...');
    wx.showLoading({ title: '连接中' });
    try {
      await ble.connect(d.deviceId);
      this.setData({ deviceName: d.name, connected: true, deviceId: d.deviceId });
      wx.hideLoading();
      wx.showToast({ title: '连接成功', icon: 'success' });
      this._log('连接成功');
    } catch (err) {
      wx.hideLoading();
      this._log('连接失败: ' + (err && err.message));
      wx.showModal({ title: '连接失败', content: err.message, showCancel: false });
    }
  },

  async disconnect() {
    await ble.disconnect();
    this.setData({ connected: false, deviceId: '', deviceName: '' });
    this._log('已断开');
  },

  goControl() {
    wx.navigateTo({ url: '/pages/control/control' });
  },

  _log(msg) {
    const t = new Date();
    const ts = `[${String(t.getHours()).padStart(2,'0')}:${String(t.getMinutes()).padStart(2,'0')}:${String(t.getSeconds()).padStart(2,'0')}]`;
    const logs = [ts + ' ' + msg].concat(this.data.logs).slice(0, 30);
    this.setData({ logs });
  }
});