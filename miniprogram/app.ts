/**
 * 小程序入口（工单 #6 决策 1）。
 *
 * 会话是 App 级单例：切 tab / push 二级页都不能重建它。App 只负责三件
 * 生命周期的活：
 *   1. onLaunch：mock 判定 → 建会话单例（getSession）；
 *   2. onShow：session.onShow() 静默回连；
 *   3. onHide：不断链（设备侧时间轴要继续跑）。
 */

import { getSession } from "./utils/session/singleton";

App<IAppOption>({
  globalData: {},

  onLaunch() {
    void getSession();
  },

  onShow() {
    getSession().onShow();
  },

  onHide() {
    // 进后台不断链
  },
});