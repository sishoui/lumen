const ble = require('./utils/ble');

App({
  onLaunch() {
    ble.initAdapter().catch((e) => {
      console.log('蓝牙适配器初始化失败:', e && e.message);
    });
  },
  globalData: {
    ble: ble
  }
});
