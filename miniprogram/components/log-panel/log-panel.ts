/** 隐藏日志面板组件（200 帧环形缓冲 / 暂停 / 清空 / 复制）。 */

import { getSession } from "../../utils/session/singleton";
import type { FrameLog } from "../../utils/ble/log";

interface LogPanelEntry {
  id: number;
  dir: "tx" | "rx";
  seqText: string;
  commandName: string;
  hex: string;
}

Component({
  data: {
    entries: [] as LogPanelEntry[],
    capacity: 200,
    paused: false,
  },

  lifetimes: {
    attached() {
      this.bindLog();
    },
    detached() {
      this.unbindLog();
    },
  },

  // 面板随控制页常驻；会话重建（演示模式开关、模式切换）不会让组件重新 attached。
  pageLifetimes: {
    show() {
      this.refresh();
    },
  },

  methods: {
    /** 取当前会话的公开日志源；绑定追加监听；切换会话后旧监听自动失效。 */
    bindLog() {
      this.unbindLog();
      const log: FrameLog = getSession().logSource;
      this._log = log;
      this.setData({ capacity: log.capacity });
      this.refresh();
      this._off = log.onAppend(() => {
        if (!this.data.paused) this.refresh();
      });
    },

    unbindLog() {
      const off = this._off;
      this._off = null;
      this._log = null;
      if (off) off();
    },

    refresh() {
      // 会话重建后 logSource 会换一份 FrameLog，而组件仍 attached：
      // 只在 refresh 时改绑，面板才不会继续读旧会话的日志。
      const log = getSession().logSource;
      if (log !== this._log) {
        this.unbindLog();
        this._log = log;
        this.setData({ capacity: log.capacity });
        this._off = log.onAppend(() => {
          if (!this.data.paused) this.refresh();
        });
      }
      const bound = this._log;
      if (!bound) return;
      const snapshot = bound.snapshot();
      this.setData({
        entries: snapshot.map((e) => ({
          id: e.id,
          dir: e.dir,
          seqText: e.seq !== undefined ? `seq=${e.seq}` : "",
          commandName: e.commandName ?? "",
          hex: e.hex,
        })),
        capacity: bound.capacity,
      });
    },

    onPause() {
      const next = !this.data.paused;
      this.setData({ paused: next });
      // 恢复时立即刷新，把暂停期间新增的条目补到面板上；
      // 仍然暂停时不动 UI，保持「日志继续写、面板冻结」的语义。
      if (!next) this.refresh();
    },

    onClear() {
      this._log?.clear();
      this.setData({ entries: [] });
    },

    onCopy() {
      // 行格式：DIR seq=<n> <commandName> <hex>；无 seq 的事件行不输出空 seq 段。
      const text = this.data.entries
        .map((e) => `${e.dir.toUpperCase()}${e.seqText ? ` ${e.seqText}` : ""} ${e.commandName} ${e.hex}`)
        .join("\n");
      wx.setClipboardData({ data: text });
    },
  },

  _off: null as (() => void) | null,
  _log: null as FrameLog | null,
});