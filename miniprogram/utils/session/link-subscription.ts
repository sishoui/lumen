/**
 * 页面对链路状态的订阅：重复 bind 先解绑旧订阅，unbind 幂等。
 *
 * 页面生命周期（onLoad / onShow / 模式切换 / onUnload）会多次走到「绑定」，
 * 如果每次都直接调 transport.onLinkChange，旧闭包永远留在传输层里：切页后
 * 继续 setData、切换模式后收到幽灵回调。把「先解绑再绑定」收进一个结构，
 * 页面壳只负责 update。
 */

import type { Transport } from "../ble/transport";
import type { LinkState } from "../protocol/types";

export class LinkSubscription {
  private off: (() => void) | null = null;

  bind(transport: Transport, listener: (state: LinkState) => void): void {
    this.unbind();
    this.off = transport.onLinkChange(listener);
  }

  unbind(): void {
    const off = this.off;
    this.off = null;
    off?.();
  }
}
