"""
mock-device.py — 用 Windows WinRT API 模拟 ESP32-C3 的 BLE 外设
依赖：pip install winrt-runtime winrt-Windows.Devices.Bluetooth winrt-Windows.Devices.Bluetooth.GenericAttributeProfile winrt-Windows.Storage.Streams
使用：python test/mock-device.py
"""

import asyncio
import uuid
import winrt.windows.devices.bluetooth.genericattributeprofile as gatt
import winrt.windows.storage.streams as streams

SERVICE_UUID = uuid.UUID("0000FFE0-0000-1000-8000-00805F9B34FB")
WRITE_UUID   = uuid.UUID("0000FFE1-0000-1000-8000-00805F9B34FB")
NOTIFY_UUID  = uuid.UUID("0000FFE2-0000-1000-8000-00805F9B34FB")

state = {"brightness": 128, "speed": 50, "phaseMode": 0}
notify_char = None

def build_status():
    return f"b{state['brightness']} s{state['speed']} p{state['phaseMode']}\n"

async def notify_status():
    if notify_char:
        try:
            writer = streams.DataWriter()
            writer.write_bytes(build_status().encode("utf-8"))
            await notify_char.notify_value_async(writer.detach_buffer())
            print(f"[设备] notify: {build_status()!r}")
        except Exception as e:
            print(f"[设备] notify 失败: {e}")

async def _handle_write(args):
    try:
        request = await args.get_request_async()
        reader = streams.DataReader.from_buffer(request.value)
        n = reader.unconsumed_buffer_length
        data = bytes(reader.read_bytes(n))
        text = data.decode("utf-8")
        print(f"[BLE] 收到原始: {text!r}")
        for line in text.split("\n"):
            line = line.strip()
            if not line:
                continue
            print(f"[设备] 收到命令: {line!r}")
            c = line[0]
            if c == "b":
                v = int(line[1:]) if len(line) > 1 else 0
                v = max(0, min(255, v))
                state["brightness"] = v
                print(f"[设备] 亮度 -> {v}")
                await notify_status()
            elif c == "s":
                v = int(line[1:]) if len(line) > 1 else 1
                v = max(1, min(100, v))
                state["speed"] = v
                print(f"[设备] 速度 -> {v}")
                await notify_status()
            elif c == "p":
                v = int(line[1:]) if len(line) > 1 else 0
                state["phaseMode"] = 1 if v == 1 else 0
                print(f"[设备] 相位 -> {'错相位' if state['phaseMode'] else '同相位'}")
                await notify_status()
            elif c == "r":
                state["brightness"] = 128
                state["speed"] = 50
                state["phaseMode"] = 0
                print("[设备] 灯效已重置")
                await notify_status()
            elif c == "?":
                print("[设备] 查询当前状态")
                await notify_status()
            elif c == "h":
                print("[设备] 帮助")
            else:
                print(f"[设备] 未知命令: {line}")
        try:
            await request.respond_async(gatt.GattWriteResult.SUCCESS)
        except Exception:
            pass
    except Exception as e:
        print(f"[设备] 处理写入失败: {e}")

def on_write_requested(sender, args):
    try:
        asyncio.get_event_loop().create_task(_handle_write(args))
    except Exception as e:
        print(f"[设备] on_write_requested 外层失败: {e}")

async def main():
    global notify_char
    service_result = await gatt.GattServiceProvider.create_async(SERVICE_UUID)
    service = service_result.service_provider.service
    print("[BLE] 服务已创建")

    write_params = gatt.GattLocalCharacteristicParameters()
    write_params.characteristic_properties = (
        gatt.GattCharacteristicProperties.WRITE
        | gatt.GattCharacteristicProperties.WRITE_WITHOUT_RESPONSE
    )
    write_result = await service.create_characteristic_async(WRITE_UUID, write_params)
    write_char = write_result.characteristic
    write_char.add_write_requested(on_write_requested)
    print("[BLE] 写特征已添加")

    notify_params = gatt.GattLocalCharacteristicParameters()
    notify_params.characteristic_properties = gatt.GattCharacteristicProperties.NOTIFY
    notify_result = await service.create_characteristic_async(NOTIFY_UUID, notify_params)
    notify_char = notify_result.characteristic
    print("[BLE] 通知特征已添加")

    adv_params = gatt.GattServiceProviderAdvertisingParameters()
    adv_params.is_connectable = True
    adv_params.is_discoverable = True
    service_provider = service_result.service_provider
    service_provider.start_advertising(adv_params)
    print("[BLE] 开始广播 BT-Light-01 ...")
    print("[BLE] 广播中，等待手机连接 (Ctrl+C 停止)")

    try:
        while True:
            await asyncio.sleep(1)
    except KeyboardInterrupt:
        service_provider.stop_advertising()
        print("[BLE] 已停止")

if __name__ == "__main__":
    asyncio.run(main())