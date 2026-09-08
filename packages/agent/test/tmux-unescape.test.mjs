// Unit tests for the tmux control-mode output unescaping in pty-driver.
//
// The critical case: tmux escapes BYTES, so non-ASCII UTF-8 characters
// arrive as consecutive octal escapes (你 = \344\275\240). Byte-by-byte
// String.fromCharCode turns them into Latin-1 mojibake — the bug that
// garbled every CJK character in the phone's terminal. The fix decodes
// the byte stream as UTF-8; these tests pin that.

import { test } from 'node:test';
import assert from 'node:assert/strict';

// Mirror of the (unexported) implementation in pty-driver.ts
function unescapeTmux(s) {
  if (!s.includes('\\')) return s;
  const bytes = [];
  let i = 0;
  while (i < s.length) {
    const m = /^\\([0-7]{3})/.exec(s.slice(i, i + 4));
    if (m) {
      bytes.push(parseInt(m[1], 8));
      i += 4;
    } else {
      bytes.push(s.charCodeAt(i));
      i += 1;
    }
  }
  return Buffer.from(bytes).toString('utf8');
}

function tmuxEscape(s) {
  return [...Buffer.from(s, 'utf8')]
    .map((b) => (b < 32 || b > 126 ? '\\' + b.toString(8).padStart(3, '0') : String.fromCharCode(b)))
    .join('');
}

test('ascii passes through', () => {
  assert.equal(unescapeTmux('hello world\r\n'), 'hello world\r\n');
});

test('control characters unescape', () => {
  // \r = \015, \x1b = \033
  assert.equal(unescapeTmux('a\\015\\033[32mgreen'), 'a\r\x1b[32mgreen');
});

test('CJK: multi-byte UTF-8 survives (regression)', () => {
  const line = tmuxEscape('你好');
  assert.ok(line.includes('\\344'), 'tmux escaped 你 byte-wise');
  assert.equal(unescapeTmux(line), '你好', 'no Latin-1 mojibake');
});

test('emoji: 4-byte UTF-8 survives', () => {
  assert.equal(unescapeTmux(tmuxEscape('done 🎉')), 'done 🎉');
});

test('mixed content: ascii + CJK + emoji + control chars', () => {
  const original = 'ok 你好 🚀\r\n';
  assert.equal(unescapeTmux(tmuxEscape(original)), original);
});

test('ANSI color sequences embedded in output', () => {
  const original = '\x1b[32mok\x1b[0m all pass';
  assert.equal(unescapeTmux(tmuxEscape(original)), original);
});

test('fast path: strings without backslashes return unchanged', () => {
  assert.equal(unescapeTmux('plain text 你好'), 'plain text 你好');
});
