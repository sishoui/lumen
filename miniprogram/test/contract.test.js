// test/contract.test.js — 契约单点化比对
// 从 docs/contract.json 读 single truth，对比 src/main.cpp 和 miniprogram/utils/config.js + ble.js 是否一致
// 用法: npm run contract   （在 miniprogram/ 下）或 node test/contract.test.js

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..'); // bt-light/
const contract = JSON.parse(fs.readFileSync(path.join(ROOT, 'docs/contract.json'), 'utf8'));
const mainCpp = fs.readFileSync(path.join(ROOT, 'src/main.cpp'), 'utf8');
const configJs = fs.readFileSync(path.join(__dirname, '..', 'utils/config.js'), 'utf8');
const bleJs = fs.readFileSync(path.join(__dirname, '..', 'utils/ble.js'), 'utf8');

let pass = 0, fail = 0;
function check(name, ok, detail) {
  if (ok) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (detail ? '  ' + detail : '')); }
}

console.log('=== 契约比对（src/main.cpp vs docs/contract.json vs miniprogram/utils）===');

// 1. 固件里的 UUID / 名字
check('固件 Service UUID 与契约一致', mainCpp.includes(contract.Service), contract.Service);
check('固件 Write UUID 与契约一致', mainCpp.includes(contract.Write), contract.Write);
check('固件 Notify UUID 与契约一致', mainCpp.includes(contract.Notify), contract.Notify);
check('固件 广播名前缀 与契约一致', mainCpp.includes('BLE_NAME_PREFIX') && mainCpp.includes(contract.广播名前缀.replace(/"/g, '"')), contract.广播名前缀);

// 2. 小程序 config.js 的 UUID
check('小程序 config.js Service UUID 与契约一致', configJs.includes(contract.Service), contract.Service);
check('小程序 config.js Write UUID 与契约一致', configJs.includes(contract.Write), contract.Write);
check('小程序 config.js Notify UUID 与契约一致', configJs.includes(contract.Notify), contract.Notify);
check('小程序 config.js 广播名前缀 与契约一致', configJs.includes(contract.广播名前缀), contract.广播名前缀);

// 3. 命令处理：固件 handleCommand 的 case 分支
const caseB = /case 'b':/.test(mainCpp);
const caseS = /case 's':/.test(mainCpp);
const caseP = /case 'p':/.test(mainCpp);
const caseR = /case 'r':/.test(mainCpp);
const caseQ = /case '\?':/.test(mainCpp);
const caseH = /case 'h':/.test(mainCpp);
check('固件 handleCommand 有 b 分支', caseB);
check('固件 handleCommand 有 s 分支', caseS);
check('固件 handleCommand 有 p 分支', caseP);
check('固件 handleCommand 有 r 分支', caseR);
check('固件 handleCommand 有 ? 分支', caseQ);
check('固件 handleCommand 有 h 分支', caseH);

// 4. 小程序 cmd 快捷方法与契约命令对应
check('小程序 cmd.setBrightness 发 b 命令', /setBrightness:\s*\(v\)\s*=>\s*send\('b'/.test(bleJs));
check('小程序 cmd.setSpeed 发 s 命令', /setSpeed:\s*\(v\)\s*=>\s*send\('s'/.test(bleJs));
check('小程序 cmd.setPhase 发 p 命令', /setPhase:\s*\(v\)\s*=>\s*send\('p'/.test(bleJs));
check('小程序 cmd.reset 发 r 命令', /reset:\s*\(\)\s*=>\s*send\('r/.test(bleJs));
check('小程序 cmd.query 发 ? 命令', /query:\s*\(\)\s*=>\s*send\('\?/.test(bleJs));

// 5. 状态报文格式：固件 notifyStatus 与小程序 parseStatus 一致
const notifyOk = /b%u s%u p%u/.test(mainCpp) || /b%u s%u p%u\\n/.test(mainCpp) || /b%u s%u p%u/.test(mainCpp.replace(/\\n/g, ''));
check('固件 notifyStatus 格式 b..s..p.. 与契约一致', notifyOk);
const parseOk = /b\(\\d\+\)\\s\*s\(\\d\+\)\\s\*p\(\[01\]\)/.test(bleJs) || /match\(.\/b\(\\d\+\)/.test(bleJs);
check('小程序 parseStatus 正则与契约一致', parseOk);

console.log('\n========================================');
console.log(`  ${pass} passed, ${fail} failed`);
console.log('========================================');
process.exit(fail > 0 ? 1 : 0);