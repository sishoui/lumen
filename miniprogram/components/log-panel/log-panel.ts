/** 隐藏日志面板组件（200 帧环形缓冲 / 暂停 / 清空 / 复制）。 */

import { getSession } from "../../utils/session/singleton";

Component({
  data: {
    entries: [] as Array<{ id: number; dir: string; seqText: string; commandName: string; hex: string }>,
    capacity: 200,
    paused: false,
  },

  lifetimes: {
    attached() {
      this.refresh();
    },
    detached() {
      if (this._off) this._off();
    },
  },

  methods: {
    refresh() {
      const session = getSession() as any;
      const log = session.transport?.log;
      if (!log) return;
      const snapshot = log.snapshot();
      this.setData({
        entries: snapshot.map((e: any) => ({
          id: e.id,
          dir: e.dir,
          seqText: e.seq !== undefined ? `seq=${e.seq}` : "",
          commandName: e.commandName ?? "",
          hex: e.hex,
        })),
        capacity: log.capacity,
      });
      if (!this._off) {
        this._off = log.onAppend(() => {
          if (!this.data.paused) this.refresh();
        });
      }
    },

    onPause() {
      this.setData({ paused: !this.data.paused });
    },

    onClear() {
      const session = getSession() as any;
      session.transport?.log?.clear();
      this.setData({ entries: [] });
    },

    onCopy() {
      const text = this.data.entries
        .map((e) => `${e.dir.toUpperCase()} ${e.seqText} ${e.commandName} ${e.hex}`)
        .join("\n");
      wx.setClipboardData({ data: text });
    },
  },

  _off: null as (() => void) | null,
});