'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { itemIds, evaluate, describe } = require('../src/checklist');

const template = fs.readFileSync(path.join(__dirname, '..', 'CHECKLIST.md'), 'utf8');
const tickAll = (body) => body.replace(/^(\s*-\s*)\[ \]/gm, '$1[x]');

test('reads every item ID from CHECKLIST.md', () => {
  const ids = itemIds(template);
  assert.equal(ids.length, 29);
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(ids[0], 'RG-1');
  assert.equal(ids.at(-1), 'DP-3');
});

test('a fresh checklist is incomplete', () => {
  const result = evaluate(template, template);
  assert.equal(result.complete, false);
  assert.equal(result.open.length, 29);
});

test('ticking every item completes it, with x or X', () => {
  assert.equal(evaluate(template, tickAll(template)).complete, true);
  assert.equal(evaluate(template, tickAll(template).replace('[x] **RG-1**', '[X] **RG-1**')).complete, true);
});

test('N/A counts only with a real reason', () => {
  const ticked = tickAll(template);
  const withNa = (reason) => ticked.replace('- [x] **AC-4**', `- N/A:${reason} **AC-4**`);

  const result = evaluate(template, withNa(' no new tables'));
  assert.equal(result.complete, true);
  assert.equal(result.notApplicable, 1);

  assert.deepEqual(evaluate(template, withNa(' <reason>')).open, ['AC-4']);
  assert.deepEqual(evaluate(template, withNa('')).open, ['AC-4']);
});

test('removing an item line leaves it unresolved', () => {
  const body = tickAll(template)
    .split('\n')
    .filter((line) => !line.includes('**SD-2**'))
    .join('\n');
  const result = evaluate(template, body);
  assert.equal(result.complete, false);
  assert.deepEqual(result.missing, ['SD-2']);
});

test('describe stays within the commit status limit', () => {
  assert.ok(describe(evaluate(template, template)).length <= 140);
  assert.equal(describe(evaluate(template, tickAll(template))), 'All 29 items done (29 ticked, 0 N/A)');
});

test('N/A reason can sit before or after the item wording', () => {
  const ticked = tickAll(template);
  const line = ticked.split('\n').find((l) => l.includes('**AC-4**'));
  const after = ticked.replace(line, `${line.replace('[x]', 'N/A:')} no new tables`);
  const empty = ticked.replace(line, line.replace('[x]', 'N/A:'));
  assert.equal(evaluate(template, after).complete, true);
  assert.deepEqual(evaluate(template, empty).open, ['AC-4']);
});
