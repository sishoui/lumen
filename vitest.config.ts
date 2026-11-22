import { defineConfig } from 'vitest/config';

// L2 小程序单测（工单 #6 决策 9）。e2e（miniprogram-automator，L4）不在本配置。
// 后端 L3 是 server/ 自含包（#7），用自己的 vitest 跑，不进这里。
// miniprogram/tests 未落地时本 include 空匹配不报错；vitest 由 npm run test:mp 探测后才会运行。
export default defineConfig({
  test: {
    environment: 'node',
    include: ['miniprogram/tests/**/*.test.ts'],
  },
});