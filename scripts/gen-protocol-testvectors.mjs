#!/usr/bin/env node
/*
 * 生成 docs/protocol-testvectors.json（骨架最小子集）。
 *
 * 为什么要有生成器：docs/protocol.md §12 规定「改协议 = 契约 + 向量 + 两端实现
 * 同一个 PR」。手写向量在改布局时必然漂移，所以向量由本脚本从契约常量算出，
 * CRC16 与分片也一并算出。独立校验器 check-protocol-testvectors.mjs 只读 JSON、
 * 手抄常量表、不 import 本脚本（不信生成器）。
 *
 * 骨架期 case 集合（docs/protocol.md §11）：三条骨架命令（SetPower / SetBrightness /
 * QueryState）的编码 + ACK + 坏帧（BadMagic / BadLength / BadChecksum /
 * UnknownCommand）。布局 / 场景 / 报告的向量随对应命令的实现在后续工单里扩充：
 * 加一行 addApp/addDevice 即可，字段与既有 case 同构。
 *
 * 用法：
 *   node scripts/gen-protocol-testvectors.mjs           # 写 docs/protocol-testvectors.json
 *   node scripts/gen-protocol-testvectors.mjs --check   # 幂等守门：与磁盘文件逐字节比对
 * 退出码：0 成功（--check 一致）；1 不一致 / 缺文件 / 自检失败。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'docs', 'protocol-testvectors.json');
const REL = path.relative(ROOT, OUT).replaceAll('\\', '/');

/* ---------------- 契约常量（docs/protocol.md，改动须同步 check 手抄表） ---------------- */

const MAGIC = 0xa6;
const VER = 5;
const FIRMWARE_VERSION = '0100';
const MAX_PAYLOAD = 232;
const MAX_FRAME = 240;
const DEFAULT_CHUNK_CAPACITY = 180; // min(mtu - 3, 180)

/* ---------------- 编码工具 ---------------- */

/** CRC16 CCITT-FALSE：poly 0x1021，init 0xFFFF，不反转，无 xorout。 */
function crc16(bytes) {
  let crc = 0xffff;
  for (const b of bytes) {
    crc ^= (b << 8) & 0xffff;
    for (let i = 0; i < 8; i++) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc;
}

const hex = (arr) => arr.map((x) => x.toString(16).toUpperCase().padStart(2, '0')).join('');
const u16 = (v) => [v & 0xff, (v >> 8) & 0xff];

function logicalFrame(command, seq, payload) {
  const body = [MAGIC, VER, command, seq, ...u16(payload.length), ...payload];
  return [...body, ...u16(crc16(body))];
}

/** BLE 分片：每片 1 字节 ctrl（bit7 FIRST / bit6 LAST / bits5..0 序号）。 */
function chunkFrame(frame, capacity = DEFAULT_CHUNK_CAPACITY) {
  const dataCap = capacity - 1;
  const count = Math.max(1, Math.ceil(frame.length / dataCap));
  const out = [];
  for (let i = 0; i < count; i++) {
    const slice = frame.slice(i * dataCap, (i + 1) * dataCap);
    let ctrl = i & 0x3f;
    if (i === 0) ctrl |= 0x80;
    if (i === count - 1) ctrl |= 0x40;
    out.push([ctrl, ...slice]);
  }
  return out;
}

/* ---------------- 用例收集 ---------------- */

const cases = [];

/* note 是 C 端极简扫描器的前提：取值禁止 {}、双引号、反斜杠。 */
function checkNote(note) {
  if (note === undefined) return;
  if (/[{}"]/.test(note) || note.includes('\\')) {
    throw new Error(`note 含 C 扫描器禁忌字符（{} " \）: ${note}`);
  }
}

function addApp(c) {
  if (!Number.isInteger(c.seq) || c.seq < 0 || c.seq > 0xff) {
    throw new Error(`${c.name}: seq ${c.seq} out of range 0..255`);
  }
  if (c.payload.length > MAX_PAYLOAD) {
    throw new Error(`${c.name}: payload ${c.payload.length}B exceeds MAX_PAYLOAD ${MAX_PAYLOAD}`);
  }
  checkNote(c.note);
  const frame = logicalFrame(c.command, c.seq, c.payload);
  cases.push({
    name: c.name,
    direction: 'app_to_device',
    command: c.command,
    command_name: c.commandName,
    seq: c.seq,
    payload_hex: hex(c.payload),
    payload_len: c.payload.length,
    frame_hex: hex(frame),
    frame_len: frame.length,
    chunks_hex: chunkFrame(frame).map(hex),
    frame_valid: c.result === undefined,
    result_code: c.result ?? 0,
    ...(c.note ? { note: c.note } : {}),
  });
}

function addDevice(c) {
  checkNote(c.note);
  const frame = logicalFrame(c.command, c.seq, c.payload);
  cases.push({
    name: c.name,
    direction: 'device_to_app',
    command: c.command,
    command_name: c.commandName,
    seq: c.seq,
    payload_hex: hex(c.payload),
    payload_len: c.payload.length,
    frame_hex: hex(frame),
    frame_len: frame.length,
    chunks_hex: chunkFrame(frame).map(hex),
    frame_valid: true,
    result_code: 0,
    ...(c.note ? { note: c.note } : {}),
  });
}

/* 信封层坏帧：直接给字节，不走构造器（坏帧的字节本来就是「构造出来的非法」）。 */
function rawCase(c) {
  checkNote(c.note);
  const bytes = Array.from({ length: c.frameHex.length / 2 }, (_, i) =>
    parseInt(c.frameHex.slice(i * 2, i * 2 + 2), 16),
  );
  cases.push({
    name: c.name,
    direction: 'app_to_device',
    command: c.command,
    command_name: c.commandName,
    seq: c.seq,
    payload_hex: c.payloadHex,
    payload_len: c.payloadHex.length / 2,
    frame_hex: c.frameHex,
    frame_len: bytes.length,
    chunks_hex: chunkFrame(bytes).map(hex),
    frame_valid: false,
    result_code: c.result,
    note: c.note,
  });
}

/* ---------------- 骨架最小子集 ---------------- */

/* 基础族：SetPower / SetBrightness / QueryState（#5/#6 骨架实现的三个命令）。 */
addApp({ name: 'set_power_on', command: 0x01, commandName: 'SetPower', seq: 1, payload: [0x01] });
addApp({ name: 'set_power_off', command: 0x01, commandName: 'SetPower', seq: 2, payload: [0x00] });
addApp({
  name: 'set_power_bad_value', command: 0x01, commandName: 'SetPower', seq: 3, payload: [0x02],
  result: 0x01, note: 'power 只允许 0/1，取值越界回 InvalidParam',
});
addApp({ name: 'set_brightness_128', command: 0x02, commandName: 'SetBrightness', seq: 4, payload: [0x80] });
addApp({ name: 'set_brightness_0', command: 0x02, commandName: 'SetBrightness', seq: 5, payload: [0x00] });
addApp({ name: 'query_state', command: 0x05, commandName: 'QueryState', seq: 6, payload: [] });

/* 退役命令：信封完好但命令字不收，回 UnknownCommand（拒收不依赖载荷长度）。 */
addApp({
  name: 'retired_set_color', command: 0x03, commandName: 'SetColor', seq: 7,
  payload: [0xff, 0x00, 0x00], result: 0x02,
  note: '0x03 已退役：信封完好但命令字不收，回 UnknownCommand',
});

/* 信封层坏帧：magic / version / length / checksum 各一条。 */
rawCase({
  name: 'bad_magic', command: 0x01, commandName: 'SetPower', seq: 8, payloadHex: '01',
  frameHex: hex([0xa5, VER, 0x01, 8, 0x01, 0x00, 0x01, 0x00, 0x00]),
  result: 0x08,
  note: 'magic 0xA5：magic 先于 CRC 校验，CRC 位填 0',
});
rawCase({
  name: 'bad_version', command: 0x01, commandName: 'SetPower', seq: 9, payloadHex: '01',
  frameHex: hex([MAGIC, 0x04, 0x01, 9, 0x01, 0x00, 0x01, 0x00, 0x00]),
  result: 0x07,
  note: 'version 0x04：v5 固件只收 0x05，回 UnsupportedVersion',
});
{
  /* length 字段声明 200，实际只有 1 字节载荷：长度错误优先于校验和。 */
  const bad = logicalFrame(0x01, 10, [0x01]);
  bad[4] = 200;
  rawCase({
    name: 'bad_length', command: 0x01, commandName: 'SetPower', seq: 10, payloadHex: '01',
    frameHex: hex(bad), result: 0x04,
    note: 'length 声明 200 但实际只有 1 字节载荷，回 BadLength',
  });
}
{
  const bad = logicalFrame(0x01, 11, [0x01]);
  bad[bad.length - 1] ^= 0xff;
  rawCase({
    name: 'bad_checksum', command: 0x01, commandName: 'SetPower', seq: 11, payloadHex: '01',
    frameHex: hex(bad), result: 0x03,
    note: 'CRC 高字节被篡改，回 BadChecksum',
  });
}

/* 设备 → 小程序：ACK（seq 回显对应请求）。 */
addDevice({
  name: 'ack_ok', command: 0x80, commandName: 'ACK', seq: 1,
  payload: [0x01, 0x00],
  note: '对 set_power_on（seq 1）的 ACK：原命令字 0x01 + 结果码 0x00 OK',
});
addDevice({
  name: 'ack_invalid_param', command: 0x80, commandName: 'ACK', seq: 3,
  payload: [0x01, 0x01],
  note: '对 set_power_bad_value（seq 3）的 ACK：原命令字 0x01 + 结果码 0x01 InvalidParam',
});

/* ---------------- 自检：保证向量与契约不会漂移 ---------------- */

for (const c of cases) {
  if (c.frame_valid && c.frame_len !== 8 + c.payload_len) {
    throw new Error(`${c.name}: frame_len ${c.frame_len} != 8 + payload_len ${c.payload_len}`);
  }
  if (c.payload_len > MAX_PAYLOAD) {
    throw new Error(`${c.name}: payload ${c.payload_len}B exceeds MAX_PAYLOAD ${MAX_PAYLOAD}`);
  }
  if (c.frame_len > MAX_FRAME) {
    throw new Error(`${c.name}: frame ${c.frame_len}B exceeds MAX_FRAME ${MAX_FRAME}`);
  }
  const reconstructed = c.chunks_hex.map((h) => h.slice(2)).join('');
  if (reconstructed !== c.frame_hex) {
    throw new Error(`${c.name}: chunks do not reconstruct to the logical frame`);
  }
}

const doc = {
  protocol_version: 5,
  firmware_version: FIRMWARE_VERSION,
  magic: '0xA6',
  crc16: 'CCITT-FALSE poly 0x1021 init 0xFFFF, no reflect, no xorout',
  frame_layout: 'magic(1) version(1) command(1) seq(1) length(2 LE) payload(length) crc16(2 LE)',
  chunk_layout: 'ctrl(1) data(<=179); ctrl bit7=FIRST bit6=LAST bits5..0=chunk index',
  cases,
};

const json = `${JSON.stringify(doc, null, 2)}\n`;

if (process.argv.includes('--check')) {
  if (!fs.existsSync(OUT)) {
    console.error(`--check: ${REL} 不存在（先跑 npm run gen:vectors）`);
    process.exit(1);
  }
  const existing = fs.readFileSync(OUT, 'utf8');
  if (existing === json) {
    console.log(`OK: ${cases.length} cases 与 ${REL} 逐字节一致（幂等）`);
    process.exit(0);
  }
  let i = 0;
  while (i < existing.length && existing[i] === json[i]) i++;
  const line = existing.slice(0, i).split('\n').length;
  console.error(`--check: ${REL} 与生成器输出不一致（首个差异在第 ${line} 行附近）`);
  console.error(`  磁盘: ${JSON.stringify(existing.slice(Math.max(0, i - 40), i + 40))}`);
  console.error(`  生成: ${JSON.stringify(json.slice(Math.max(0, i - 40), i + 40))}`);
  process.exit(1);
}

fs.writeFileSync(OUT, json);
console.log(`${cases.length} cases -> ${REL}`);