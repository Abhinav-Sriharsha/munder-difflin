'use strict';

// The terminal half of PR #213. It landed on ONE condition: that it is inert
// for everybody who has not switched it on. These tests are that condition.
// Arabic rendering CORRECTNESS is not tested here and is not claimed — it needs
// a reviewer who reads Arabic, which this one is not.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const { arabicJoinRanges, isArabicCp } = loadTs('src/renderer/src/terminal/arabicJoiner.ts');
const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

const HELLO_AR = 'مرحبا'; // 5 Arabic letters, U+0645 U+0631 U+062D U+0628 U+0627

// --- inertness: the whole basis for landing this half ----------------------

test('a row with no Arabic produces no join ranges at all', () => {
  for (const row of [
    '', 'hello world', '$ npm run build', 'const x = 42;',
    '┌───┐│ box │└───┘', // TUI box drawing
    '\x1b[31mred\x1b[0m',                 // an escape sequence that reached the row
    '你好世界',                            // CJK is not RTL and must not join
    'café — naïve « quotes »'             // latin-1 plus the punctuation used as glue
  ]) {
    assert.deepEqual(arabicJoinRanges(row), [], `joined something in: ${JSON.stringify(row)}`);
  }
});

test('glue characters alone never create a range', () => {
  // PHRASE_GLUE only extends a run that already started on an Arabic letter.
  // Its ASCII/Latin half is tested here; the rest of the list (، ؛ ؟ and the
  // tatweel ـ) sits INSIDE the Arabic block, so those are Arabic first and glue
  // second, and they are covered by the phrase tests below.
  assert.deepEqual(arabicJoinRanges(' ,.:;()«»!-—'), []);
});

test('a lone Arabic character is left alone', () => {
  // Nothing to shape across, so there is no reason to make it a span.
  assert.deepEqual(arabicJoinRanges(`a ${HELLO_AR[0]} b`), []);
});

// --- it does do its job ----------------------------------------------------

test('an Arabic word becomes one range', () => {
  assert.deepEqual(arabicJoinRanges(HELLO_AR), [[0, 5]]);
});

test('a range stops at the last Arabic character, not the trailing space', () => {
  const row = `hi ${HELLO_AR} bye`;
  assert.deepEqual(arabicJoinRanges(row), [[3, 8]]);
  assert.equal(row.slice(3, 8), HELLO_AR);
});

test('a phrase flows across the punctuation between its words', () => {
  const two = `${HELLO_AR} ${HELLO_AR}`;
  assert.deepEqual(arabicJoinRanges(two), [[0, two.length]]);
});

test('isArabicCp covers the script blocks and nothing else', () => {
  for (const cp of [0x0600, 0x06ff, 0x0750, 0x077f, 0xfb50, 0xfdff, 0xfe70, 0xfeff]) {
    assert.equal(isArabicCp(cp), true, `0x${cp.toString(16)} should be Arabic`);
  }
  for (const cp of [0x0041, 0x05ff, 0x0700, 0x4e00, 0xfb4f, 0xfe6f]) {
    assert.equal(isArabicCp(cp), false, `0x${cp.toString(16)} should not be Arabic`);
  }
});

// --- the gates -------------------------------------------------------------

test('the feature is off by default and does not sniff the OS locale', () => {
  const src = read('src/renderer/src/terminal/arabicSetting.ts');
  assert.doesNotMatch(src, /navigator/,
    'arabicSetting reads the OS locale again — the founder ruled that out');
  assert.match(src, /return false;\s*\n\}/, 'read() must fall back to false');
});

test('nothing Arabic is wired into a terminal unless the toggle is on', () => {
  const src = read('src/renderer/src/components/terminalPool.ts');
  // Match the CALL, not the import line at the top of the file.
  for (const call of ['registerCharacterJoiner(', 'attachArabicSpacingFix(entry.host)', "classList.add('cth-bidi')"]) {
    const i = src.indexOf(call);
    assert.ok(i > 0, `${call} is missing`);
    const guard = src.lastIndexOf('if (isArabicTerminalEnabled())', i);
    assert.ok(guard > 0 && i - guard < 1200, `${call} is not behind the enabled check`);
  }
});

test('the bidi CSS is scoped, so it cannot reach a terminal that never opted in', () => {
  const css = read('src/renderer/src/design/global.css');
  // Only the terminal-row bidi rules. global.css also has a pre-existing
  // .xterm-rows rule for ligature suppression, and a deliberately global
  // `unicode-bidi: isolate` on markdown code spans; neither is this feature.
  const rules = css.split('\n').filter((l) => l.includes('.xterm-rows > div'));
  assert.ok(rules.length > 0, 'the bidi rules vanished');
  for (const r of rules) {
    assert.ok(r.includes('.cth-bidi'),
      `an unscoped .xterm-rows rule reshapes every DOM-renderer terminal: ${r.trim()}`);
  }
});

test('the markdown direction rules use logical properties, a no-op in LTR', () => {
  // Only the .cth-md-preview rules. The separate .cth-md-card surface still
  // uses physical properties; it belongs to the RTL UI half, which is held.
  const md = read('src/renderer/src/design/global.css')
    .split('\n').filter((l) => l.trim().startsWith('.cth-md-preview') || l.includes('inline-start'))
    .join('\n');
  assert.doesNotMatch(md, /padding-left:|border-left:|margin-right:/,
    'a physical property here renders differently once dir=rtl');
  assert.match(md, /padding-inline-start|border-inline-start|margin-inline-end/);
});
