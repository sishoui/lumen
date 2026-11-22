#!/usr/bin/env node
/*
 * 校验 docs/protocol-testvectors.json 与 docs/protocol.md 契约的一致性。
 *
 * 为什么需要：向量是生成出来的，生成器本身可能有 bug（参考实现 lumen 真实发生过
 * 生成器把层载荷整体错位 1 字节的事故）。所以要有独立的校验器：只读 JSON、
 * 手抄契约常量表、不 import 生成器——不信生成器。
 *
 * 校验面：
 *   - 顶层结构（protocol_version / firmware_version / magic / cases 数组）；
 *   - 每个 case 的信封自洽（magic / version / length 字段 / CRC16 覆盖范围、
 *     frame_len == 8 + payload_len、帧长与载荷上限）；
 *   - 分片 ctrl 合法（FIRST / LAST / 序号、单分片 ctrl == 0xC0、数据 ≤ 179B、
 *     剥掉 ctrl 后能拼回逻辑帧）；
 *   - 大写 hex 与字段类型（C 端扫描器的前提）；
 *   - 按结果码核对坏帧「声称的缺陷真的存在」（0x02 信封必须完好、0x03 CRC 必须坏、
 *     0x04 长度必须不符、0x07 版本必须错、0x08 magic 必须错）；
 *   - 结果码域 0x00–0x09；note 无 {} " \ 禁忌字符。
 *
 * 用法：node scripts/check-protocol-testvectors.mjs
 * 退出码：0 = 全部通过；1 = 有失败项（逐条打印哪条 case 坏了）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VECTORS = path.join(ROOT, 'docs', 'protocol-testvectors.json');
const REL = path.relative(ROOT, VECTORS).replaceAll('\\', '/');

/* ---------------- 手抄契约常量表（docs/protocol.md，独立于生成器） ---------------- */

const MAGIC = 0xa6;
const VERSION = 0x05;
const HEADER = 8; // magic1 + ver1 + cmd1 + seq1 + len2 + crc2（含 CRC）
const MAX_FRAME = 240;
const MAX_PAYLOAD = 232;
const MAX_CHUNK_DATA = 179;
const PROTOCOL_VERSION = 5;
const FIRMWARE_VERSION = '0100';
const RESULT_CODES = new Set([0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09]);

/* 命令表（小程序 → 设备）：码 -> { 名称, 载荷字节数 }。 */
const COMMANDS = new Map([
  [0x01, { name: 'SetPower', payload: 1 }],
  [0x02, { name: 'SetBrightness', payload: 1 }],
  [0x05, { name: 'QueryState', payload: 0 }],
  [0x06, { name: 'SetLedCount', payload: 3 }],
  [0x07, { name: 'SelfTest', payload: 0 }],
  [0x1b, { name: 'SetStripPower', payload: 2 }],
  [0x1c, { name: 'QueryStripConfig', payload: 0 }],
  [0x1d, { name: 'QueryDeviceInfo', payload: 0 }],
  [0x20, { name: 'LayoutWrite', payload: 2 }],
  [0x21, { name: 'LayoutPart', payload: 29 }],
  [0x22, { name: 'LayoutSeg', payload: 5 }],
  [0x23, { name: 'LayoutCommit', payload: 0 }],
  [0x24, { name: 'QueryLayout', payload: 1 }],
  [0x25, { name: 'ScenePart', payload: 6 }],
  [0x26, { name: 'SceneStep', payload: 24 }],
  [0x27, { name: 'SceneName', payload: 26 }],
  [0x28, { name: 'ActivateScene', payload: 1 }],
  [0x29, { name: 'QueryScene', payload: 1 }],
]);

/* 报告表（设备 → 小程序）：码 -> { 名称, 载荷字节数 }。 */
const REPORTS = new Map([
  [0x80, { name: 'ACK', payload: 2 }],
  [0x81, { name: 'Event', payload: 2 }],
  [0x82, { name: 'StateReport', payload: 32 }],
  [0x87, { name: 'StripConfigReport', payload: 24 }],
  [0x88, { name: 'DeviceInfoReport', payload: 15 }],
  [0x89, { name: 'LayoutReport', payload: 45 }],
  [0x8a, { name: 'LayoutListEnd', payload: 2 }],
  [0x8b, { name: 'ScenePartReport', payload: 6 }],
  [0x8c, { name: 'SceneStepReport', payload: 24 }],
  [0x8d, { name: 'SceneListEnd', payload: 26 }],
]);

/*
 * 载荷取值非法用例（ InvalidParam 的语义证据）：case 名 -> 谓词。
 * 信封/命令/宽度由通用规则校验，这里只补「值确实越界」这一层。
 */
const INVALID_VALUE = new Map([
  ['set_power_bad_value', (p) => p.length === 1 && p[0] > 0x01],
]);

/* ---------------- 工具 ---------------- */

let failures = 0;
function check(ok, msg) {
  if (!ok) {
    console.log(`FAIL: ${msg}`);
    failures++;
  }
}

/** CRC16 CCITT-FALSE（手抄标准实现，与生成器零共享）。 */
function crc16(bytes) {
  let crc = 0xffff;
  for (const b of bytes) {
    crc ^= b << 8;
    for (let i = 0; i < 8; i++) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc;
}

function unhex(h) {
  const out = [];
  for (let i = 0; i < h.length; i += 2) out.push(parseInt(h.slice(i, i + 2), 16));
  return out;
}

const isUpperHex = (h) => typeof h === 'string' && h.length % 2 === 0 && /^[0-9A-F]*$/.test(h);

/* ---------------- 载入与顶层结构 ---------------- */

let doc;
try {
  doc = JSON.parse(fs.readFileSync(VECTORS, 'utf8'));
} catch (e) {
  console.log(`FAIL: 无法读取/解析 ${REL}: ${e.message}`);
  process.exit(1);
}

check(doc.protocol_version === PROTOCOL_VERSION, `protocol_version 必须是 ${PROTOCOL_VERSION}`);
check(doc.firmware_version === FIRMWARE_VERSION, `firmware_version 必须是 "${FIRMWARE_VERSION}"`);
check(doc.magic === '0xA6', 'magic 必须是 "0xA6"');
check(typeof doc.frame_layout === 'string' && doc.frame_layout.length > 0, 'frame_layout 缺失');
check(typeof doc.chunk_layout === 'string' && doc.chunk_layout.length > 0, 'chunk_layout 缺失');
check(Array.isArray(doc.cases) && doc.cases.length > 0, 'cases 必须是非空数组');

const cases = doc.cases ?? [];
const names = new Set();
for (const c of cases) {
  check(typeof c.name === 'string' && c.name.length > 0 && !names.has(c.name),
    `case 名重复或缺失: ${c.name}`);
  names.add(c.name);
}

/* ---------------- 逐 case：字段类型与信封 ---------------- */

for (const c of cases) {
  check(c.direction === 'app_to_device' || c.direction === 'device_to_app',
    `${c.name}: direction 必须是 app_to_device / device_to_app`);
  check(Number.isInteger(c.command) && c.command >= 0 && c.command <= 0xff,
    `${c.name}: command 必须是 0..255 的整数`);
  check(typeof c.command_name === 'string' && c.command_name.length > 0,
    `${c.name}: command_name 缺失`);
  check(Number.isInteger(c.seq) && c.seq >= 0 && c.seq <= 0xff,
    `${c.name}: seq 必须是 0..255 的整数`);
  check(isUpperHex(c.payload_hex), `${c.name}: payload_hex 必须是偶数长度大写 hex`);
  check(isUpperHex(c.frame_hex), `${c.name}: frame_hex 必须是偶数长度大写 hex`);
  check(Array.isArray(c.chunks_hex) && c.chunks_hex.length > 0
    && c.chunks_hex.every(isUpperHex), `${c.name}: chunks_hex 必须是非空大写 hex 数组`);
  check(Number.isInteger(c.payload_len) && c.payload_len === c.payload_hex.length / 2,
    `${c.name}: payload_len 与 payload_hex 不一致`);
  check(Number.isInteger(c.frame_len) && c.frame_len === c.frame_hex.length / 2,
    `${c.name}: frame_len 与 frame_hex 不一致`);
  check(typeof c.frame_valid === 'boolean', `${c.name}: frame_valid 必须是布尔`);
  check(RESULT_CODES.has(c.result_code),
    `${c.name}: result_code 0x${(c.result_code ?? 0).toString(16)} 超出结果码域 0x00-0x09`);
  if (c.note !== undefined) {
    check(/[{}"]/.test(c.note) === false && !c.note.includes('\\'),
      `${c.name}: note 含 C 扫描器禁忌字符（{} " \）`);
  }

  /* 分片：剥掉 1 字节 ctrl 头后必须正好拼回逻辑帧。 */
  const reassembled = c.chunks_hex.map((h) => h.slice(2)).join('');
  check(reassembled === c.frame_hex, `${c.name}: chunks 剥掉 ctrl 后拼不回 frame_hex`);

  c.chunks_hex.forEach((h, i) => {
    const ctrl = parseInt(h.slice(0, 2), 16);
    const isFirst = i === 0;
    const isLast = i === c.chunks_hex.length - 1;
    check(((ctrl & 0x80) !== 0) === isFirst, `${c.name}: chunk ${i} FIRST 位错误`);
    check(((ctrl & 0x40) !== 0) === isLast, `${c.name}: chunk ${i} LAST 位错误`);
    check((ctrl & 0x3f) === i, `${c.name}: chunk ${i} 序号位必须是 ${i}`);
    const dataLen = h.length / 2 - 1;
    check(dataLen >= 1 && dataLen <= MAX_CHUNK_DATA,
      `${c.name}: chunk ${i} 数据 ${dataLen}B 超出 1..${MAX_CHUNK_DATA}`);
  });
  if (c.chunks_hex.length === 1) {
    check(c.chunks_hex[0].slice(0, 2) === 'C0',
      `${c.name}: 单分片帧 ctrl 必须是 0xC0`);
  }
}

/* ---------------- 逐 case：信封与结果码语义 ---------------- */

/** 信封完好：magic / version / length / CRC 全部正确。返回首个坏掉的环节名或 null。 */
function envelopeDefect(c) {
  const b = unhex(c.frame_hex);
  if (b.length < HEADER) return 'frame 短于 8 字节帧头';
  if (b[0] !== MAGIC) return 'magic';
  if (b[1] !== VERSION) return 'version';
  const declared = b[4] | (b[5] << 8);
  if (declared !== c.frame_len - HEADER) return 'length';
  if (declared > MAX_PAYLOAD) return 'length';
  const payload = b.slice(6, 6 + declared);
  const want = crc16(b.slice(0, 6 + declared));
  const got = b[6 + declared] | (b[7 + declared] << 8);
  if (want !== got) return 'crc';
  return null;
}

for (const c of cases) {
  const b = unhex(c.frame_hex);
  const tag = `${c.name} (result 0x${c.result_code.toString(16)})`;

  if (c.direction === 'app_to_device') {
    const known = COMMANDS.get(c.command);

    if (c.frame_valid) {
      check(c.result_code === 0, `${tag}: frame_valid=true 的 result_code 必须是 0`);
      check(envelopeDefect(c) === null,
        `${tag}: 信封必须完好，坏在 ${envelopeDefect(c)}`);
      check(known !== undefined,
        `${tag}: 命令 0x${c.command.toString(16)} 不在命令表`);
      if (known) {
        check(c.command_name === known.name,
          `${tag}: command_name ${c.command_name} != 契约名 ${known.name}`);
        check(c.payload_len === known.payload,
          `${tag}: 命令 0x${c.command.toString(16)} 载荷 ${c.payload_len}B != 契约 ${known.payload}B`);
      }
      check(c.frame_len <= MAX_FRAME, `${tag}: 帧 ${c.frame_len}B 超过上限 ${MAX_FRAME}`);
      check(c.payload_len <= MAX_PAYLOAD, `${tag}: 载荷 ${c.payload_len}B 超过上限 ${MAX_PAYLOAD}`);
    } else if (c.result_code === 0x02) {
      /* UnknownCommand：信封必须完好——拒收来自命令字退役，不是坏信封。 */
      check(envelopeDefect(c) === null,
        `${tag}: UnknownCommand 的信封必须完好，坏在 ${envelopeDefect(c)}`);
      check(!known, `${tag}: 回 UnknownCommand 的命令不得在命令表里`);
    } else if (c.result_code === 0x01) {
      /* InvalidParam：信封与命令都合法，值越界由 INVALID_VALUE 谓词证明。 */
      check(envelopeDefect(c) === null,
        `${tag}: InvalidParam 的信封必须完好，坏在 ${envelopeDefect(c)}`);
      check(known !== undefined, `${tag}: InvalidParam 的命令必须在命令表里`);
      const pred = INVALID_VALUE.get(c.name);
      check(pred !== undefined, `${tag}: 缺少载荷取值越界的谓词（手抄表未覆盖）`);
      if (pred && known) {
        check(c.payload_len === known.payload, `${tag}: InvalidParam 载荷宽度必须合法`);
        check(pred(unhex(c.payload_hex)), `${tag}: 载荷取值必须真的越界`);
      }
    } else if (c.result_code === 0x03) {
      /* BadChecksum：length 一致、CRC 坏。 */
      check(b[0] === MAGIC, `${tag}: BadChecksum 的 magic 必须正确`);
      check(b[1] === VERSION, `${tag}: BadChecksum 的 version 必须正确`);
      const declared = b[4] | (b[5] << 8);
      check(declared === c.frame_len - HEADER,
        `${tag}: BadChecksum 的 length 字段必须一致（坏在 CRC）`);
      const payload = b.slice(6, 6 + declared);
      const want = crc16(b.slice(0, 6 + declared));
      const got = b[6 + declared] | (b[7 + declared] << 8);
      check(want !== got, `${tag}: BadChecksum 的 CRC 必须真的错`);
    } else if (c.result_code === 0x04) {
      /* BadLength：length 字段与实际载荷不符（或超出上限）。 */
      const declared = b.length >= 6 ? b[4] | (b[5] << 8) : -1;
      check(declared !== c.frame_len - HEADER || declared > MAX_PAYLOAD,
        `${tag}: BadLength 的 length 字段必须与实际不符`);
    } else if (c.result_code === 0x07) {
      /* UnsupportedVersion：magic 正确、version 错。 */
      check(b[0] === MAGIC, `${tag}: UnsupportedVersion 的 magic 必须正确`);
      check(b[1] !== VERSION, `${tag}: UnsupportedVersion 的 version 必须是 0x05 以外的值`);
    } else if (c.result_code === 0x08) {
      /* BadMagic：magic 错（magic 先于 CRC，其余字段任意）。 */
      check(b[0] !== MAGIC, `${tag}: BadMagic 的 magic 必须是 0xA6 以外的值`);
    } else {
      check(false, `${tag}: 骨架期不支持的结果码 ${c.result_code}（Busy/StorageFailed/InternalError 无坏帧用例）`);
    }
  } else {
    /* device_to_app：帧本身必须是合法帧；ACK 载荷内的结果码看 payload_hex。 */
    check(c.frame_valid, `${c.name}: device_to_app 帧必须 frame_valid=true`);
    check(c.result_code === 0, `${c.name}: device_to_app 帧 result_code 必须恒 0`);
    check(envelopeDefect(c) === null,
      `${c.name}: 信封必须完好，坏在 ${envelopeDefect(c)}`);
    const known = REPORTS.get(c.command);
    check(known !== undefined, `${c.name}: 报告 0x${c.command.toString(16)} 不在报告表`);
    if (known) {
      check(c.command_name === known.name,
        `${c.name}: command_name ${c.command_name} != 契约名 ${known.name}`);
      check(c.payload_len === known.payload,
        `${c.name}: 报告 0x${c.command.toString(16)} 载荷 ${c.payload_len}B != 契约 ${known.payload}B`);
    }
  }
}

/* ---------------- 骨架最小子集的存在性 ---------------- */

const validCmds = new Set(
  cases.filter((c) => c.direction === 'app_to_device' && c.frame_valid).map((c) => c.command),
);
for (const cmd of [0x01, 0x02, 0x05]) {
  check(validCmds.has(cmd),
    `骨架命令 0x${cmd.toString(16)} 缺少合法向量`);
}
check(cases.some((c) => c.command === 0x80 && c.direction === 'device_to_app'),
  'ACK（0x80）缺少向量');
check(cases.some((c) => c.result_code === 0x08), '坏帧 BadMagic 缺少向量');
check(cases.some((c) => c.result_code === 0x04), '坏帧 BadLength 缺少向量');
check(cases.some((c) => c.result_code === 0x03), '坏帧 BadChecksum 缺少向量');
check(cases.some((c) => c.result_code === 0x02), '坏帧 UnknownCommand 缺少向量');

if (failures === 0) {
  console.log(`OK: ${cases.length} vectors 与 docs/protocol.md 契约一致`);
  process.exit(0);
}
console.log(`\n${failures} failure(s)`);
process.exit(1);