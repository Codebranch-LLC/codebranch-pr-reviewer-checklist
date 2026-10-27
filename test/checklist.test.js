'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { MARKER, itemIds, parseConfig, render, evaluate, describe } = require('../src/checklist');

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

test('the checklist names no specific stack', () => {
  assert.doesNotMatch(template, /GuardedRouter|PolicyEnforcer|pgTAP|ApiError|sqlx|cargo|OsRng|Zod/);
});

test('the Rust/sqlx example config is valid', () => {
  const text = fs.readFileSync(path.join(__dirname, '..', 'examples', 'rust-sqlx.yml'), 'utf8');
  const config = parseConfig(text, template);
  assert.equal(config.inThisRepo.get('SE-2'), 'only `sqlx::query!` macros or literal queries');
  assert.equal(config.notApplicable.size, 0);
});

test('parseConfig accepts quoted, unquoted and commented values', () => {
  const config = parseConfig(
    [
      '# comment',
      'in-this-repo:',
      '  AC-1: "say \\"hi\\""',
      "  AC-2: 'it''s fine'",
      '  AC-3: plain text # trailing comment',
      '',
      'not-applicable:',
      '  AC-4: No database',
    ].join('\n'),
    template,
  );
  assert.equal(config.inThisRepo.get('AC-1'), 'say "hi"');
  assert.equal(config.inThisRepo.get('AC-2'), "it's fine");
  assert.equal(config.inThisRepo.get('AC-3'), 'plain text');
  assert.equal(config.notApplicable.get('AC-4'), 'No database');
});

test('parseConfig rejects anything it does not understand', () => {
  const bad = {
    'unknown section': 'skip:\n  AC-1: x',
    'unknown ID': 'in-this-repo:\n  ZZ-9: x',
    'empty text': 'not-applicable:\n  AC-4: ""',
    'duplicate ID': 'in-this-repo:\n  AC-1: x\n  AC-1: y',
    'entry outside a section': '  AC-1: x',
    'malformed line': 'in-this-repo:\n  - AC-1',
  };
  for (const [name, text] of Object.entries(bad)) {
    assert.throws(() => parseConfig(text, template), Error, name);
  }
  assert.equal(parseConfig('', template).inThisRepo.size, 0);
});

test('render adds hints and fills in repo-wide N/A', () => {
  const config = parseConfig('in-this-repo:\n  AC-1: "`GuardedRouter::requires`"\nnot-applicable:\n  AC-4: "No database"', template);
  const body = render(template, config);
  const lines = body.split('\n');
  const ac1 = lines.findIndex((l) => l.includes('**AC-1**'));

  assert.ok(body.startsWith(MARKER));
  assert.equal(lines[ac1 + 1], '  - _In this repo: `GuardedRouter::requires`_');
  assert.match(lines.find((l) => l.includes('**AC-4**')), /^- N\/A: No database _\(repo setting\)_ \*\*AC-4\*\*/);
  assert.equal(evaluate(template, body, config).open.length, 28);
  assert.equal(render(template), `${MARKER}\n${template}`);
});

test('repo-wide N/A holds even if the comment line is edited or removed', () => {
  const config = parseConfig('not-applicable:\n  AC-4: "No database"', template);
  const body = tickAll(template)
    .split('\n')
    .filter((line) => !line.includes('**AC-4**'))
    .join('\n');
  const result = evaluate(template, body, config);
  assert.equal(result.complete, true);
  assert.equal(result.notApplicable, 1);
});
