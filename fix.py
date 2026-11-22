import re
p = r'C:\Users\13092\Desktop\project\bt-light\bt-light\platformio.ini'
s = open(p, encoding='utf-8').read()
s = s.replace('board_build.flash_mode = dio', 'board_build.flash_mode = qio')
# remove duplicate flags if any
s = s.replace('    -D ARDUINO_USB_MODE=1\n    -D ARDUINO_USB_CDC_ON_BOOT=1\n', '')
# append after FASTLED_RMT_MEM_DRIVER
s = s.replace('    -D FASTLED_RMT_MEM_DRIVER=1\n',
              '    -D FASTLED_RMT_MEM_DRIVER=1\n    -D ARDUINO_USB_MODE=1\n    -D ARDUINO_USB_CDC_ON_BOOT=1\n')
open(p, 'w', encoding='utf-8').write(s)
print('done')