// Unit tests for the tmux control-mode output unescaping in pty-driver.
//
// Verified against tmux 3.7c control mode: %output escapes CONTROL bytes
// (< 0x20, 0x7f) as 3-digit octal, but passes HIGH bytes (≥ 0x80 — i.e.
// every multi-byte UTF-8 character) through RAW, right next to \ooo escapes
// on the same line. Real-world example from a live capture:
//
//   %output %12 \033[32m<E7BBBF…绿色>\033[0m <E4BDA0…你好>\015\012
//
// The original bug decoded literal runs byte-by-byte (charCodeAt), truncating
// 你 (U+4F60) to 0x60 '`' — garbling every coloured CJK line. The fix
// re-encodes literal runs as UTF-8 and splices in the escaped bytes.

import { test } from 'node:test';
import assert from 'node:assert/strict';

// Mirror of the (unexported) implementation in pty-driver.ts
function unescapeTmux(s) {
  if (!s.includes('\\')) return s;
  const parts = [];
  const re = /\\([0-7]{3})/g;
  let last = 0;
  let m;
  while ((m = re.exec(s)) !== null) {
    if (m.index > last) parts.push(Buffer.from(s.slice(last, m.index), 'utf8'));
    parts.push(Buffer.from([parseInt(m[1], 8)]));
    last = m.index + m[0].length;
  }
  if (last < s.length) parts.push(Buffer.from(s.slice(last), 'utf8'));
  return Buffer.concat(parts).toString('utf8');
}

function extractLines(buf, chunk) {
  const all = buf.length === 0 ? chunk : Buffer.concat([buf, chunk]);
  const lines = [];
  let start = 0;
  let nl;
  while ((nl = all.indexOf(0x0a, start)) !== -1) {
    lines.push(all.subarray(start, nl).toString('utf8'));
    start = nl + 1;
  }
  return { lines, rest: all.subarray(start) };
}

test('ascii passes through', () => {
  assert.equal(unescapeTmux('hello world\r\n'), 'hello world\r\n');
});

test('control characters unescape', () => {
  // \r = \015, \x1b = \033
  assert.equal(unescapeTmux('a\\015\\033[32mgreen'), 'a\r\x1b[32mgreen');
});

test('CJK next to ANSI escape on SAME line (the live mojibake bug)', () => {
  // Exact shape observed from tmux 3.7c: escape + raw UTF-8 CJK + reset escape
  const raw = '\\033[32m' + Buffer.from('绿色测试', 'utf8') + '\\033[0m ascii ' +
    Buffer.from('你好世界', 'utf8');
  assert.equal(unescapeTmux(raw), '\x1b[32m绿色测试\x1b[0m ascii 你好世界');
});

test('CJK + CRLF escapes trailing (regression: 你 → 0x60 truncation)', () => {
  // 你 U+4F60 → charCodeAt low byte 0x60 = '`'; 好 U+597D → 0x7D = '}'
  const raw = Buffer.from('你好', 'utf8') + '\\015\\012';
  assert.equal(unescapeTmux(raw), '你好\r\n');
  assert.ok(!unescapeTmux(raw).includes('`'), 'no truncation to low byte');
});

test('emoji next to escape survives (4-byte UTF-8)', () => {
  const raw = '\\033[32mOK\\033[0m ' + Buffer.from('done 🎉', 'utf8');
  assert.equal(unescapeTmux(raw), '\x1b[32mOK\x1b[0m done 🎉');
});

test('fast path: strings without backslashes return unchanged', () => {
  assert.equal(unescapeTmux('plain text 你好'), 'plain text 你好');
});

test('high byte that LOOKS like an escape digit run is not mangled', () => {
  // ０３３-ish full-width digits must survive; only \ooo after backslash is escaped
  const raw = Buffer.from('数字１２３', 'utf8') + '\\033[0m';
  assert.equal(unescapeTmux(raw), '数字１２３\x1b[0m');
});

test('escaped backslash within text', () => {
  // A literal backslash in output arrives as \\134 (0o134 = 0x5c)
  const raw = '\\134\\015';
  assert.equal(unescapeTmux(raw), '\\\r');
});

// ── Chunk-boundary regression (live-output pipe splits) ──────────────────────
// Pipe chunks split at arbitrary BYTE offsets. The old reader called
// chunk.toString() per chunk, so a boundary landing mid-UTF-8-character
// produced permanent U+FFFD corruption whenever output volume was high.

test('chunk boundary mid-UTF-8-char does not corrupt (regression)', () => {
  const payload = Buffer.from('你好世界\nplain line\n', 'utf8');
  const a = payload.subarray(0, 1); // first byte of 你
  const b = payload.subarray(1);
  const first = extractLines(Buffer.alloc(0), a);
  assert.deepEqual(first.lines, [], 'incomplete line stays buffered');
  const second = extractLines(first.rest, b);
  assert.deepEqual(second.lines, ['你好世界', 'plain line']);
});

test('many tiny chunks with multibyte content', () => {
  const payload = Buffer.from('中文 emoji 🎉 mixed\n', 'utf8');
  let buf = Buffer.alloc(0);
  const lines = [];
  for (const b of payload) {
    const r = extractLines(buf, Buffer.from([b]));
    buf = r.rest;
    lines.push(...r.lines);
  }
  assert.deepEqual(lines, ['中文 emoji 🎉 mixed']);
});

test('full control-mode line: %output prefix + mixed escape/CJK + newline', () => {
  // End-to-end shape of one real %output event after line splitting.
  // Built as raw BYTES: escapes are ASCII, CJK passes through as UTF-8.
  const payload = Buffer.from('\x1b[32m绿色OK\x1b[0m 你好\r\n', 'utf8');
  const body = Buffer.concat([...payload].map((b) =>
    (b < 32 || b === 127)
      ? Buffer.from('\\' + b.toString(8).padStart(3, '0'))
      : Buffer.from([b])));
  const lineBytes = Buffer.concat([Buffer.from('%output %12 '), body, Buffer.from('\n')]);
  const { lines } = extractLines(Buffer.alloc(0), lineBytes);
  assert.equal(lines.length, 1);
  const raw = lines[0].slice('%output %12 '.length);
  assert.equal(unescapeTmux(raw), '\x1b[32m绿色OK\x1b[0m 你好\r\n');
});
