#!/usr/bin/env python
"""整合验收探针骨架（工单 #17）。

完整实现目标：四组约 31 项断言，覆盖 docs/spec.md §5 与工单 #8 决策 5：

    1. 体积实测   —— 真机写出 8 链 × 8 部位 × 8 步 × 两层 的最大场景，
                     用 QueryScene 读回条数核对，并给出编码后的实际字节数
                     （字节数是 host 侧算术值，真机只能验「全部写进去且读得回来」）
    2. 存储压测   —— 三个场景轮流写满 + 断电恢复（--power-cycle 段）
    3. 时间漂移   —— 两个部位不同步数不同时长跑固定时长，用串口帧日志核对
                     播放头是否按绝对时间推进
    4. 帧率基线   —— 800 颗灯 / 64 播放头的轮周期（串口 `TDM round` 行）

骨架期只搭框架 + TODO 壳：argparse、BleakScanner/BleakClient 连接、Probe.send 单条
命令往返、Checker 输出契约、pyserial DTR/RTS 复位参数（--power-cycle --port COMx）
都已就位，check 项待固件命令逐个落地后填充。31 是目标数不是骨架数
（spec 红线 5：数字只引最近一次报告）。

用法：
    python scripts/probe-acceptance.py                    # 1 + 4（不动持久化）
    python scripts/probe-acceptance.py --power-cycle      # 加 2（要串口复位）
    python scripts/probe-acceptance.py --drift-minutes 30 # 加 3
    python scripts/probe-acceptance.py --power-cycle --port COM6

退出码：0 全部通过；1 有失败项；2 连不上设备（编排器记 SKIP）。

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
RX_UUID = "6c756d65-6e00-4b1e-9a3c-000000000002"
TX_UUID = "6c756d65-6e00-4b1e-9a3c-000000000003"
STATE_UUID = "6c756d65-6e00-4b1e-9a3c-000000000004"

MAGIC = 0xA6
VERSION = 0x05
MAX_STRIPS = 8
MAX_PARTS = 8
MAX_STEPS = 8
SCENE_STEP_BYTES = 24
LAYOUT_PART_BYTES = 29

OK = 0x00

CMD = {
    "SET_POWER": 0x01,
    "SET_BRIGHTNESS": 0x02,
    "QUERY_STATE": 0x05,
    "SET_LED_COUNT": 0x06,
    "SET_STRIP_POWER": 0x1B,
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

LAYOUT_REPORT = 0x89
LAYOUT_LIST_END = 0x8A
SCENE_PART_REPORT = 0x8B
SCENE_STEP_REPORT = 0x8C
SCENE_LIST_END = 0x8D

CHUNK_FIRST = 0x80
CHUNK_LAST = 0x40
CHUNK_INDEX_MASK = 0x3F


def _hex(value):
    return "无 ACK" if value is None else f"0x{value:02X}"


class Checks:
    def __init__(self):
        self.passed = 0
        self.failed = []

    def check(self, name, ok, detail=""):
        if ok:
            self.passed += 1
            print(f"PASS  {name}" + (f"  — {detail}" if detail else ""))
        else:
            self.failed.append(name)
            print(f"FAIL  {name}" + (f"  — {detail}" if detail else ""))

    def report(self):
        total = self.passed + len(self.failed)
        print(f"\n=== {self.passed}/{total} 通过 ===")
        if self.failed:
            print("失败项：")
            for item in self.failed:
                print(f"  - {item}")
        return 0 if not self.failed else 1


def crc16(data):
    crc = 0xFFFF
    for byte in data:
        crc ^= byte << 8
        for _ in range(8):
            crc = ((crc << 1) ^ 0x1021) & 0xFFFF if crc & 0x8000 else (crc << 1) & 0xFFFF
    return crc


def build_frame(command, seq, payload=b""):
    body = bytes([MAGIC, VERSION, command, seq]) + struct.pack("<H", len(payload)) + payload
    return body + struct.pack("<H", crc16(body))


def chunked(frame_bytes):
    """分片头：bit7 FIRST、bit6 LAST、bit5-0 序号。短帧单分片 ctrl=0xC0。"""
    chunks = []
    capacity = 20
    total = (len(frame_bytes) + capacity - 1) // capacity
    for index in range(total):
        piece = frame_bytes[index * capacity:(index + 1) * capacity]
        head = (0x80 if index == 0 else 0) | (0x40 if index == total - 1 else 0) | index
        chunks.append(bytes([head]) + piece)
    return chunks


class Probe:
    """单条命令往返 + notify 重组。骨架期把主路径搭通，check 项待填充。"""

    def __init__(self, client):
        self.client = client
        self.seq = 0
        self.pending_reports = []
        self.acks = {}
        self._reassembly = b""

    def on_notify(self, _sender, data):
        blob = bytes(data)
        if not blob:
            return
        ctrl = blob[0]
        piece = blob[1:]
        if ctrl & 0x80:
            self._reassembly = piece
        else:
            self._reassembly += piece
        if not (ctrl & 0x40):
            return
        frame_bytes = self._reassembly
        self._reassembly = b""
        self._consume(frame_bytes)

    def _consume(self, raw):
        if len(raw) < 8 or raw[0] != MAGIC:
            return
        command = raw[2]
        seq = raw[3]
        length = struct.unpack("<H", raw[4:6])[0]
        body = raw[6:6 + length]
        if command == 0x80 and len(body) >= 2:
            self.acks[seq] = body[1]
        else:
            self.pending_reports.append((command, seq, body))

    async def send(self, name, payload=b"", wait=0.30):
        command = CMD[name]
        self.seq = (self.seq + 1) & 0xFF
        seq = self.seq
        frame = build_frame(command, seq, payload)
        self.acks.pop(seq, None)
        for piece in chunked(frame):
            await self.client.write_gatt_char(RX_UUID, piece, response=False)
        deadline = asyncio.get_event_loop().time() + 8.0
        while seq not in self.acks and asyncio.get_event_loop().time() < deadline:
            await asyncio.sleep(0.005)
        result = self.acks.get(seq)
        await asyncio.sleep(wait)
        return result, [item for item in self.pending_reports if item[1] == seq]

    async def read_state(self):
        data = await self.client.read_gatt_char(STATE_UUID)
        payload = bytes(data)
        return {
            "power": payload[0],
            "brightness": payload[1],
            "strip_count": payload[3],
            "strip_power_mask": payload[4],
            "active_scene": payload[5],
            "layout_valid": payload[6],
            "led_counts": [payload[8 + i * 2] | (payload[9 + i * 2] << 8) for i in range(8)],
            "part_counts": list(payload[24:32]),
        }


async def connect(name):
    print(f"扫描 {name}* ……")
    devices = await BleakScanner.discover(timeout=8)
    target = None
    for device in devices:
        if device.name and device.name.startswith(name):
            target = device
            break
    if target is None:
        found = ", ".join(f"{d.address}({d.name})" for d in devices) or "无"
        sys.exit(f"没扫到 {name}*。扫到的是：{found}\n"
                 "若设备被手机上的小程序占着，先退出小程序（协议是单连接）。")
    print(f"连接 {target.address} ……")
    client = BleakClient(target.address, timeout=20)
    await client.connect()
    probe = Probe(client)
    await client.start_notify(TX_UUID, probe.on_notify)
    try:
        await client.write_gatt_char(RX_UUID, b"", response=False)
    except Exception:
        pass
    return client, probe


async def hard_reset(port="COM6"):
    """DTR/RTS 硬复位（pyserial）。

    --power-cycle 时调用：setDTR(False) → setRTS(True) → 0.2s → setRTS(False) →
    释放串口 → 等设备起完 → 重新扫描重连。同一条连接上读回是假证明，必须复位。
    """
    try:
        import serial
    except ImportError:
        print(f"      跳过硬复位：没装 pyserial（python -m pip install pyserial）")
        return False
    try:
        ser = serial.Serial(port, 115200, timeout=0.3)
        ser.setDTR(False)
        ser.setRTS(True)
        await asyncio.sleep(0.2)
        ser.setRTS(False)
        ser.close()
        print(f"      已在 {port} 上发硬复位")
        return True
    except Exception as exc:  # noqa: BLE001
        print(f"      硬复位失败（{exc}）；请手动拔插后重跑")
        return False


# ======================= 四组 TODO 壳 =======================


async def measured_volume(probe, chk):
    # TODO §1 体积实测：8 链 × 8 部位 × 8 步 × 两层，QueryScene 读回条数核对
    print("\n--- §1 体积实测（TODO）---")
    chk.check("§1 壳就位", True, "骨架占位；TODO: 最坏场景写入 + QueryScene 读回条数核对 + 编码字节数")


async def storage_stress(probe, chk, power_cycle, port, device_name):
    # TODO §2 存储压测：三个场景轮流写满 + 断电恢复
    print("\n--- §2 存储压测（TODO）---")
    chk.check("§2 壳就位", True, "骨架占位；TODO: 三个场景写满 + 断电恢复 + 读回")
    if power_cycle:
        print("      --power-cycle：调用 hard_reset 复位后再读回")
        await hard_reset(port)


async def drift_check(probe, chk, minutes, device_name):
    # TODO §3 时间漂移：两个部位不同步数不同时长跑固定时长
    print(f"\n--- §3 时间漂移 {minutes} 分钟（TODO）---")
    chk.check("§3 壳就位", True, "骨架占位；TODO: 采样 State + 串口帧日志核对播放头")


async def framerate_check(probe, chk, port):
    # TODO §4 帧率基线：800 颗灯 / 64 播放头的轮周期
    print("\n--- §4 帧率基线（TODO）---")
    chk.check("§4 壳就位", True, "骨架占位；TODO: 抓串口 tdm 行 + round < 50ms")


async def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--name", default="LUMEN-", help="广播名前缀")
    parser.add_argument("--power-cycle", action="store_true",
                        help="做断电恢复（用串口 DTR/RTS 复位）")
    parser.add_argument("--drift-minutes", type=float, default=0,
                        help="时间漂移的观察时长（分钟）；0 = 跳过")
    parser.add_argument("--port", default="COM6", help="串口（--power-cycle 用）")
    parser.add_argument("--skip-volume", action="store_true", help="跳过 §1 体积实测")
    parser.add_argument("--skip-storage", action="store_true", help="跳过 §2 存储压测")
    parser.add_argument("--framerate", action="store_true", help="跑 §4 帧率基线")
    parser.add_argument("--framerate-seconds", type=float, default=25, help="帧率观察时长")
    args = parser.parse_args()

    client, probe = await connect(args.name)
    chk = Checks()
    try:
        state = await probe.read_state()
        print(f"设备：{state['strip_count']} 条链，strip0 = {state['led_counts'][0]} 颗，"
              f"active_scene={state['active_scene']}")

        if not args.skip_volume:
            await measured_volume(probe, chk)
        if not args.skip_storage:
            await storage_stress(probe, chk, args.power_cycle, args.port, args.name)
        if args.framerate:
            await framerate_check(probe, chk, args.port)
        if args.drift_minutes > 0:
            await drift_check(probe, chk, args.drift_minutes, args.name)
    finally:
        try:
            await client.stop_notify(TX_UUID)
        except Exception:
            pass
        await client.disconnect()

    sys.exit(chk.report())


if __name__ == "__main__":
    try:
        sys.exit(asyncio.run(main()))
    except KeyboardInterrupt:
        pass