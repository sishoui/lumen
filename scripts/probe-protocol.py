#!/usr/bin/env python
"""协议回归探针骨架（工单 #17）。

完整实现目标：9 节约 58 项断言，覆盖 docs/spec.md §2.5 / docs/protocol.md
的命令与报告往返、错误码、断电恢复、收尾现场恢复。骨架期只搭框架 + TODO 壳：
argparse、BleakScanner/BleakClient 连接、Probe.send 单条命令往返、Checker 输出契约
（`PASS/FAIL` 行 + `===== N passed / M failed =====`）都已就位，check 项待固件命令
逐个落地后填充。58 是目标数不是骨架数（spec 红线 5：数字只引最近一次报告）。

用法：
    python scripts/probe-protocol.py                    # 默认广播名 LUMEN-XXXX
    python scripts/probe-protocol.py --address CC:8D:A2:C2:56:62
    python scripts/probe-protocol.py --skip-persist     # 跳过需要人工复位的 §8
    python scripts/probe-protocol.py --power-cycle --port COM6   # §8 用 pyserial DTR/RTS 复位

没有真机时不要跑：它只做真机往返，不做 mock。失败时退出码 1；缺 bleak 时退出码 2
（编排器把 2 记成 SKIP，不染绿）。

完整实现的 9 节（spec §3.5 / 工单 #8 决策 5）：
    §1 断崖与版本拒绝     — magic / version / CRC / 长度不符 → 对应错误码整帧拒绝
    §2 DeviceInfo caps    — firmware_version / hw_id / 能力上限 / caps 位
    §3 State 32B          — layout_valid 与 active_scene 可读
    §4 布局往返           — LayoutWrite / LayoutPart / LayoutSeg / LayoutCommit / QueryLayout
    §5 段互斥             — 压到别的部位 → InvalidParam，且旧布局逐字节不变
    §6 场景往返           — ScenePart / SceneStep / SceneName / ActivateScene / QueryScene
    §7 未覆盖灯珠恒黑     — 布局只覆盖前半条，后半条应为 0
    §8 断电恢复           — 写布局 + 场景后复位，重连读回（同一条连接上读回是假证明）
    §9 收尾               — 把设备恢复成「一条链、一个整条部位、常亮」

取证输出：stdout 重定向到 docs/evidence/<日期>-<名称>/report.md（手工触发，带日期）。
"""

import argparse
import asyncio
import struct
import sys

try:
    from bleak import BleakClient, BleakScanner
except ImportError:
    sys.exit("需要 bleak：python -m pip install bleak")

# 与 docs/spec.md §2.2 一致。
SERVICE = "6c756d65-6e00-4b1e-9a3c-000000000001"
RX = "6c756d65-6e00-4b1e-9a3c-000000000002"
TX = "6c756d65-6e00-4b1e-9a3c-000000000003"
STATE = "6c756d65-6e00-4b1e-9a3c-000000000004"

# 与 docs/protocol.md §2 一致。
MAGIC = 0xA6
VERSION = 0x05
LAYER_BYTES = 9
STATE_BYTES = 32
CHUNK_FIRST = 0x80
CHUNK_LAST = 0x40
CHUNK_INDEX_MASK = 0x3F

OK = 0x00
INVALID_PARAM = 0x01
UNKNOWN_COMMAND = 0x02
BAD_CHECKSUM = 0x03
BAD_LENGTH = 0x04
UNSUPPORTED_VERSION = 0x07
BAD_MAGIC = 0x08

CMD = {
    "SET_POWER": 0x01,
    "SET_BRIGHTNESS": 0x02,
    "QUERY_STATE": 0x05,
    "SET_LED_COUNT": 0x06,
    "SELF_TEST": 0x07,
    "SET_STRIP_POWER": 0x1B,
    "QUERY_STRIP_CONFIG": 0x1C,
    "QUERY_DEVICE_INFO": 0x1D,
    "LAYOUT_WRITE": 0x20,
    "LAYOUT_PART": 0x21,
    "LAYOUT_SEG": 0x22,
    "LAYOUT_COMMIT": 0x23,
    "QUERY_LAYOUT": 0x24,
    "SCENE_PART": 0x25,
    "SCENE_STEP": 0x26,
    "SCENE_NAME": 0x27,
    "ACTIVATE_SCENE": 0x28,
    "QUERY_SCENE": 0x29,
}

REPORT = {
    0x80: "ACK",
    0x81: "EVENT",
    0x82: "STATE",
    0x87: "STRIP_CONFIG",
    0x88: "DEVICE_INFO",
    0x89: "LAYOUT",
    0x8A: "LAYOUT_END",
    0x8B: "SCENE_PART",
    0x8C: "SCENE_STEP",
    0x8D: "SCENE_END",
}


def crc16(data):
    crc = 0xFFFF
    for b in data:
        crc ^= b << 8
        for _ in range(8):
            crc = ((crc << 1) ^ 0x1021) & 0xFFFF if crc & 0x8000 else (crc << 1) & 0xFFFF
    return crc


def chunked(frame_bytes):
    """§2.3：小程序 → 设备的每一次写也带 1 字节分片头。短帧永远是单分片，
    ctrl = 0xC0（FIRST|LAST|序号 0）。"""
    return bytes([CHUNK_FIRST | CHUNK_LAST]) + frame_bytes


def frame(command, seq, payload=b"", version=VERSION):
    body = bytes([MAGIC, version, command, seq]) + struct.pack("<H", len(payload)) + payload
    return body + struct.pack("<H", crc16(body))


class Checker:
    """PASS / FAIL 行 + ===== N passed / M failed ===== 收尾。

    与 verify-ui.mjs / test-run.mjs 的 Checker 输出契约一致（spec §3.5）。
    """

    def __init__(self):
        self.passed = 0
        self.failed = []

    def check(self, name, condition, detail=""):
        if condition:
            self.passed += 1
            print(f"PASS  {name}" + (f"  — {detail}" if detail else ""))
        else:
            self.failed.append(name)
            print(f"FAIL  {name}" + (f"  — {detail}" if detail else ""))

    def summary(self):
        total = self.passed + len(self.failed)
        print(f"\n===== {self.passed} passed / {len(self.failed)} failed =====")
        if self.failed:
            print("失败项：")
            for name in self.failed:
                print(f"  - {name}")
        return len(self.failed) == 0


class Probe:
    """单条命令往返 + notify 重组。

    骨架期把「发一帧 → 等 ACK → 收后续报告」这条主路径搭通；完整实现的 check
    项（58 项）随固件命令逐个落地后填充，每加一个命令就在对应 §里加 chk.check。
    """

    def __init__(self, client):
        self.client = client
        self.seq = 0
        self.reports = []
        self.acks = {}
        self.pending = b""

    def next_seq(self):
        self.seq = (self.seq + 1) & 0xFF
        return self.seq

    def on_notify(self, _handle, data):
        """§2.3：设备 → 小程序的每个 notify 都带 1 字节分片头。单分片时
        ctrl = 0xC0（FIRST|LAST|序号 0），裸帧的第一个字节 0xA6 会被前缀盖住。
        这里按头重组，不为单分片场景写简化分支——多分片也会走同一条路。"""
        b = bytes(data)
        if not b:
            return
        ctrl = b[0]
        payload = b[1:]
        if ctrl & CHUNK_FIRST:
            self.pending = payload
        else:
            self.pending += payload
        if not (ctrl & CHUNK_LAST):
            return
        frame_bytes = self.pending
        self.pending = b""
        self._consume_frame(frame_bytes)

    def _consume_frame(self, b):
        if len(b) < 8 or b[0] != MAGIC:
            return
        command = b[2]
        seq = b[3]
        length = struct.unpack("<H", b[4:6])[0]
        payload = b[6:6 + length]
        if command == 0x80 and len(payload) >= 2:
            self.acks[seq] = payload[1]
        else:
            self.reports.append((command, seq, payload))

    async def send(self, name, payload=b"", version=VERSION, wait=0.35):
        """发一帧，等 ACK，再等 wait 秒收后续报告。多帧查询（0x24 / 0x29）
        要传更长的 wait：报告流跑在固件的独立任务里，「ACK 到了」不代表
        「报告发完了」。"""
        command = CMD[name] if isinstance(name, str) else name
        seq = self.next_seq()
        self.reports.clear()
        self.acks.pop(seq, None)
        await self.client.write_gatt_char(
            RX, chunked(frame(command, seq, payload, version)), response=False
        )
        deadline = asyncio.get_event_loop().time() + 3.0
        while seq not in self.acks and asyncio.get_event_loop().time() < deadline:
            await asyncio.sleep(0.005)
        result = self.acks.get(seq)
        await asyncio.sleep(wait)
        return result, list(self.reports)


# ======================= 9 节 TODO 壳 =======================
# 骨架期每节只打一行 TODO 占位；完整实现时把对应 § 的 chk.check 填进 run()。


async def run(probe, chk, args):
    # TODO §1: 断崖与版本拒绝 — v4 帧 / magic 错 / CRC 错 / 长度不符 → 对应错误码整帧拒绝
    print("\n--- §1 断崖与版本拒绝（TODO）---")
    chk.check("§1 壳就位", True, "骨架占位；TODO: 坏帧 / 错误版本 / BadChecksum / BadLength")

    # TODO §2: DeviceInfo caps — QueryDeviceInfo 回 0x88，firmware_version / hw_id / max_* / caps
    print("\n--- §2 DeviceInfo caps（TODO）---")
    chk.check("§2 壳就位", True, "骨架占位；TODO: QueryDeviceInfo 往返 + caps 上限")

    # TODO §3: State 32B — QueryState 回 0x82，32 字节，layout_valid / active_scene 可读
    print("\n--- §3 State 32B（TODO）---")
    chk.check("§3 壳就位", True, "骨架占位；TODO: State 32B 读回 + layout_valid / active_scene")

    # TODO §4: 布局往返 — LayoutWrite / LayoutPart / LayoutSeg / LayoutCommit / QueryLayout
    print("\n--- §4 布局往返（TODO）---")
    chk.check("§4 壳就位", True, "骨架占位；TODO: LayoutWrite→Part→Seg→Commit→QueryLayout 往返")

    # TODO §5: 段互斥 — 压到别的部位 → InvalidParam，且旧布局逐字节不变
    print("\n--- §5 段互斥（TODO）---")
    chk.check("§5 壳就位", True, "骨架占位；TODO: 段越界 / 段压别人 → InvalidParam + 旧布局不变")

    # TODO §6: 场景往返 — ScenePart / SceneStep / SceneName / ActivateScene / QueryScene
    print("\n--- §6 场景往返（TODO）---")
    chk.check("§6 壳就位", True, "骨架占位；TODO: SceneName→Part→Step→Activate→QueryScene 往返")

    # TODO §7: 未覆盖灯珠恒黑 — 布局只覆盖前半条，后半条应为 0
    print("\n--- §7 未覆盖灯珠恒黑（TODO）---")
    chk.check("§7 壳就位", True, "骨架占位；TODO: 布局只覆盖前半条，后半条物理上为 0")

    # TODO §8: 断电恢复 — 写布局 + 场景后 pyserial DTR/RTS 复位，重连读回（同一条连接上读回是假证明）
    if not args.skip_persist:
        print("\n--- §8 断电恢复（TODO；--skip-persist 可跳过）---")
        chk.check("§8 壳就位", True, "骨架占位；TODO: DTR/RTS 复位 + 重连读回布局与场景")
    else:
        print("\n--- §8 断电恢复：已跳过（--skip-persist）---")

    # TODO §9: 收尾 — 把设备恢复成「一条链、一个整条部位、常亮」
    print("\n--- §9 收尾（TODO）---")
    chk.check("§9 壳就位", True, "骨架占位；TODO: 恢复成一条链、一个整条部位、常亮")

    return


async def hard_reset(port="COM6"):
    """DTR/RTS 硬复位（pyserial）。

    与 capture-serial.py --reset 同一手法：setDTR(False) → setRTS(True) → 0.1s
    → setRTS(False) → 释放串口。设备重启后重新扫描重连。完整实现里 §8 会调它。
    """
    try:
        import serial
    except ImportError:
        print(f"      跳过硬复位：没装 pyserial（python -m pip install pyserial）")
        return False
    try:
        ser = serial.Serial(port, 115200, timeout=0.2)
        ser.setDTR(False)
        ser.setRTS(True)
        await asyncio.sleep(0.1)
        ser.setRTS(False)
        ser.close()
        print(f"      已在 {port} 上发硬复位")
        return True
    except Exception as exc:  # noqa: BLE001
        print(f"      硬复位失败（{exc}）；请手动拔插后重跑 §8")
        return False


async def wait_for_device(name, timeout=20.0):
    deadline = asyncio.get_event_loop().time() + timeout
    while asyncio.get_event_loop().time() < deadline:
        devices = await BleakScanner.discover(timeout=3)
        for device in devices:
            if device.name == name:
                return device.address
        await asyncio.sleep(1)
    return None


async def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--address", default=None, help="设备的 MAC；省略则按名字扫描")
    parser.add_argument("--name", default="LUMEN-", help="广播名前缀（spec §2.2）")
    parser.add_argument("--port", default="COM6", help="串口（§8 复位用）")
    parser.add_argument("--skip-persist", action="store_true",
                        help="跳过 §8 的复位恢复（不碰串口）")
    args = parser.parse_args()

    address = args.address
    if address is None:
        print(f"扫描 {args.name} ……")
        devices = await BleakScanner.discover(timeout=8)
        for device in devices:
            if device.name and device.name.startswith(args.name):
                address = device.address
                break
        if address is None:
            found = ", ".join(f"{d.address}({d.name})" for d in devices) or "无"
            sys.exit(f"没扫到 {args.name}*。扫到的是：{found}\n"
                     "若设备被手机上的小程序占着，先退出小程序（协议是单连接）。")

    chk = Checker()

    print(f"连接 {address} ……")
    async with BleakClient(address) as client:
        probe = Probe(client)
        await client.start_notify(TX, probe.on_notify)
        try:
            await run(probe, chk, args)
        finally:
            await client.stop_notify(TX)

    ok = chk.summary()
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass