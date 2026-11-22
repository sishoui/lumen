/** 场景编辑器（navigateTo，带 sceneId）。骨架为壳。 */

Page({
  data: {
    sceneId: 0,
  },

  onLoad(query: Record<string, string>) {
    const sceneId = parseInt(query.sceneId ?? "0", 10);
    this.setData({ sceneId: Number.isFinite(sceneId) ? sceneId : 0 });
  },
});