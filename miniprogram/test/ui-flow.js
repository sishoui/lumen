// test/ui-flow.js — miniprogram-automator 模拟用户点击
// 依赖：微信开发者工具开启服务端口，utils/ble.js 的 MOCK_MODE = true
const automator = require('miniprogram-automator');
const path = require('path');

const PROJECT_PATH = path.resolve(__dirname, '..');

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

(async () => {
  const mp = await automator.launch({
    projectPath: PROJECT_PATH,
    timeout: 30000
  });

  // 1. 连接页
  const connectPage = await mp.navigateTo('/pages/connect/connect');
  await sleep(1000);

  // 2. 点扫描
  const scanBtn = await connectPage.$('.scan-btn');
  if (!scanBtn) {
    console.log('[UI] 未找到扫描按钮');
    await mp.close();
    process.exit(1);
  }
  await scanBtn.tap();
  await sleep(2000);

  // 3. 点设备连接
  const devices = await connectPage.$$('.item');
  console.log(`[UI] 扫到 ${devices.length} 个设备`);
  if (devices.length === 0) {
    console.log('[UI] 未扫到设备，检查 Mock 模式是否开启');
    await mp.close();
    process.exit(1);
  }
  await devices[0].tap();
  await sleep(2000);

  // 4. 断言连接状态
  const badge = await connectPage.$('.badge');
  if (badge) {
    const text = await badge.text();
    console.log('[UI] 连接状态:', text);
    if (!text.includes('已连接')) {
      console.log('[UI] 连接失败');
      await mp.close();
      process.exit(1);
    }
  }

  // 5. 控制页
  await mp.navigateTo('/pages/control/control');
  const ctrl = await mp.currentPage();
  await sleep(1000);

  // 6. 模拟滑动亮度
  const sliders = await ctrl.$$('slider');
  console.log(`[UI] 找到 ${sliders.length} 个滑块`);
  if (sliders.length >= 1) {
    await sliders[0].trigger('change', { value: 200 });
    await sleep(500);
  }

  // 7. 模拟滑动速度
  if (sliders.length >= 2) {
    await sliders[1].trigger('change', { value: 80 });
    await sleep(500);
  }

  // 8. 点重置
  const resetBtn = await ctrl.$('.btn.danger');
  if (resetBtn) {
    console.log('[UI] 点击重置');
    await resetBtn.tap();
    await sleep(500);
  }

  // 9. 读取日志
  const logs = await ctrl.$$('.log-line');
  for (const log of logs.slice(0, 5)) {
    console.log('[UI] 日志:', await log.text());
  }

  await mp.close();
  console.log('[UI] 完成 ✅');
  process.exit(0);
})().catch((err) => {
  console.error('[UI] 失败:', err);
  process.exit(1);
});