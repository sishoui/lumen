/** 部位编辑器（navigateTo，带 stripId）。骨架为壳。 */

Page({
  data: {
    stripId: 0,
  },

  onLoad(query: Record<string, string>) {
    const stripId = parseInt(query.stripId ?? "0", 10);
    this.setData({ stripId: Number.isFinite(stripId) ? stripId : 0 });
  },
});