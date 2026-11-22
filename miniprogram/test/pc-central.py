"""
pc-central.py — 用 Python bleak 作为 BLE central，连接 ESP32-C3 并下发命令
模拟"小程序"的 BLE 控制流程，无需手机。

使用：
  python test/pc-central.py
"""
import asyncio
from bleak import BleakScanner, BleakClient

SERVICE_UUID = "0000FFE0-0000-1000-8000-00805F9B34FB"
WRITE_UUID   = "0000FFE1-0000-1000-8000-00805F9B34FB"
NOTIFY_UUID  = "0000FFE2-0000-1000-8000-00805F9B34FB"

received = []

def on_notify(sender, data):
    text = data.decode("utf-8", errors="replace")
    print(f"[ESP32 -> PC] {text!r}")
    received.append(text)

async def main():
    print("扫描 BT- 设备...")
    devices = await BleakScanner.discover(timeout=10.0)
    target = None
    for d in devices:
        if d.name and d.name.startswith("BT-"):
            target = d
            print(f"找到设备: {d.name} ({d.address})")
            break
    if not target:
        print("未找到 BT- 设备，请确认 ESP32 已上电并广播")
        return

    print(f"连接 {target.name} ...")
    async with BleakClient(target.address) as client:
        print("已连接")
        await client.start_notify(NOTIFY_UUID, on_notify)
        await asyncio.sleep(1)

        print("\n[测试] 设亮度 200")
        await client.write_gatt_char(WRITE_UUID, b"b200\n")
        await asyncio.sleep(1)

        print("[测试] 设速度 80")
        await client.write_gatt_char(WRITE_UUID, b"s80\n")
        await asyncio.sleep(1)

        print("[测试] 设相位 1")
        await client.write_gatt_char(WRITE_UUID, b"p1\n")
        await asyncio.sleep(1)

        print("[测试] 重置")
        await client.write_gatt_char(WRITE_UUID, b"r\n")
        await asyncio.sleep(1)

        print("[测试] 查询")
        await client.write_gatt_char(WRITE_UUID, b"?\n")
        await asyncio.sleep(1)

        await client.stop_notify(NOTIFY_UUID)
        print(f"\n[测试] 全部命令已发送，收到回执: {len(received)} 条")

asyncio.run(main())