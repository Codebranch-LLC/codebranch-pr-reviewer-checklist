'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const {
  MARKER,
  MAX_ITEM_CHARS,
  itemIds,
  sanitize,
  parseConfig,
  render,
  evaluate,
  describe,
} = require('../src/checklist');

const template = fs.readFileSync(path.join(__dirname, '..', 'CHECKLIST.md'), 'utf8');
const tickAll = (body) => body.replace(/^(\s*-\s*)\[ \]/gm, '$1[x]');

test('reads every item ID from CHECKLIST.md', () => {
  const ids = itemIds(template);
  assert.equal(ids.length, 30);
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(ids[0], 'RG-1');
  assert.equal(ids.at(-1), 'DP-3');
});

test('a fresh checklist is incomplete', () => {
  const result = evaluate(template, template);
  assert.equal(result.complete, false);
  assert.equal(result.open.length, 30);
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
  assert.equal(describe(evaluate(template, tickAll(template))), 'All 30 items done (30 ticked, 0 N/A)');
});

test('N/A reason can sit before or after the item wording', () => {
  const ticked = tickAll(template);
  const line = ticked.split('\n').find((l) => l.includes('**AC-4**'));
  const after = ticked.replace(line, `${line.replace('[x]', 'N/A:')} no new tables`);
  const empty = ticked.replace(line, line.replace('[x]', 'N/A:'));
  assert.equal(evaluate(template, after).complete, true);
  assert.deepEqual(evaluate(template, empty).open, ['AC-4']);
});

// Every name here is one a repository is meant to supply through `in-this-repo`,
// not one the shared checklist may contain. The list grew because the first
// version of this guard only held names from examples/rust-sqlx.yml, and so
// passed while SD-5 said "such as `Math.random`" -- a JavaScript API in a
// checklist whose own README says to keep item wording free of stack-specific
// names. A guard that has only ever been seen to pass proves nothing; add the
// name here in the same change that puts it in an example config.
test('the checklist names no specific stack', () => {
  assert.doesNotMatch(
    template,
    /GuardedRouter|PolicyEnforcer|pgTAP|ApiError|sqlx|cargo|OsRng|Zod|Math\.random|getRandomValues|randomUUID|dangerouslySetInnerHTML|unwrap/,
  );
});

test('the Rust/sqlx example config is valid', () => {
  const text = fs.readFileSync(path.join(__dirname, '..', 'examples', 'rust-sqlx.yml'), 'utf8');
  const config = parseConfig(text, template);
  assert.equal(config.inThisRepo.get('SE-2'), 'only `sqlx::query!` macros or literal queries');
  assert.equal(config.notApplicable.size, 0);
  assert.deepEqual([...config.extraItems.keys()], ['RUST-1', 'RUST-2', 'WEB-1']);
  assert.match(config.extraItems.get('WEB-1'), /^No `dark:` prefix/);
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
  assert.equal(evaluate(template, body, config).open.length, 29);
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

test('every action this repository runs is pinned to a full commit SHA', () => {
  const root = path.join(__dirname, '..');
  const workflows = path.join(root, '.github', 'workflows');
  const files = [
    path.join(root, 'action.yml'),
    ...fs.readdirSync(workflows).map((name) => path.join(workflows, name)),
  ];
  for (const file of files) {
    for (const [, ref] of fs.readFileSync(file, 'utf8').matchAll(/^\s*-?\s*uses:\s*(\S+)/gm)) {
      assert.match(ref, /@[0-9a-f]{40}$/, `${path.relative(root, file)}: ${ref}`);
    }
  }
});

// --- Extra items supplied by the consuming repository -----------------------
//
// SHARED is the count of items in CHECKLIST.md. The assertions below are written
// against SHARED + <extras> rather than against literals, so that adding an item
// to the shared checklist does not quietly turn "the extras were counted" into
// "the numbers happen to add up".

const SHARED = itemIds(template).length;
const extrasConfig = (...lines) => parseConfig(['extra-items:', ...lines].join('\n'), template);

test('extra items are posted in their own section and are required', () => {
  const config = extrasConfig(
    '  REPO-1: "The migration is reversible"',
    '  TENANCY-2: "Every new query filters by account_id"',
  );
  const body = render(template, config, '.github/reviewer-checklist.yml');

  assert.match(body, /## Extra items for this repository/);
  assert.match(body, /Declared in `\.github\/reviewer-checklist\.yml` on the default branch/);
  assert.ok(body.includes('- [ ] **REPO-1** The migration is reversible'));
  assert.ok(body.includes('- [ ] **TENANCY-2** Every new query filters by account_id'));

  const result = evaluate(template, body, config);
  assert.equal(result.total, SHARED + 2);
  assert.equal(result.shared, SHARED);
  assert.equal(result.extra, 2);
  assert.equal(result.complete, false);
  assert.ok(result.open.includes('REPO-1') && result.open.includes('TENANCY-2'));

  // Ticked, they complete the checklist like any other item.
  const done = evaluate(template, tickAll(body), config);
  assert.equal(done.complete, true);
  assert.equal(done.ticked, SHARED + 2);
});

test('an unticked extra item keeps the status RED even with every shared item done', () => {
  const config = extrasConfig('  REPO-1: "The migration is reversible"');
  const body = render(template, config);
  // Tick everything except the extra item: this is the state a repository that
  // ignored its own item would be in, and the gate must not go green in it.
  const sharedOnly = body.replace('- [ ] **REPO-1**', '- [[UNTICKED]] **REPO-1**');
  const partial = tickAll(sharedOnly).replace('- [[UNTICKED]] **REPO-1**', '- [ ] **REPO-1**');

  const result = evaluate(template, partial, config);
  assert.equal(result.complete, false);
  assert.deepEqual(result.open, ['REPO-1']);
  assert.equal(result.ticked, SHARED);
  assert.equal(describe(result), '1 open: REPO-1');
});

test('an extra item takes N/A only with a real reason', () => {
  const config = extrasConfig('  REPO-1: "The migration is reversible"');
  const ticked = tickAll(render(template, config));
  const withNa = (reason) =>
    ticked.replace('- [x] **REPO-1**', `- N/A:${reason} **REPO-1**`);

  const good = evaluate(template, withNa(' no migration in this PR'), config);
  assert.equal(good.complete, true);
  assert.equal(good.notApplicable, 1);

  assert.deepEqual(evaluate(template, withNa(' <reason>'), config).open, ['REPO-1']);
  assert.deepEqual(evaluate(template, withNa(''), config).open, ['REPO-1']);
});

test('describe distinguishes this repository\'s items from the shared ones', () => {
  const config = extrasConfig('  REPO-1: "a"', '  REPO-2: "b"');
  const done = evaluate(template, tickAll(render(template, config)), config);
  assert.equal(
    describe(done),
    `All ${SHARED + 2} items done, 2 of them this repo's (${SHARED + 2} ticked, 0 N/A)`,
  );
  assert.ok(describe(done).length <= 140);
});

test('an extra item ID can never collide with a shared one', () => {
  // Two letters is the shared checklist's shape, so it is refused outright --
  // this is the "silently overrides RG-1" case.
  assert.throws(() => extrasConfig('  RG-1: "mine now"'), /reserved for the shared checklist/);
  assert.throws(() => extrasConfig('  AC-3: "mine now"'), /not a usable extra-items ID/);
  // Belt as well as braces: if the shared checklist ever adopted a three-letter
  // prefix, the shapes would stop being disjoint, so the ID is also checked
  // against the live shared set. A crafted template proves that guard runs.
  const crafted = '- [ ] **REPO-1** a shared item with a three-letter prefix\n';
  assert.throws(
    () => parseConfig('extra-items:\n  REPO-1: "mine now"', crafted),
    /already a shared checklist item/,
  );
  // And it cannot be listed twice within the section either.
  assert.throws(() => extrasConfig('  REPO-1: "a"', '  REPO-1: "b"'), /listed twice/);
});

test('invalid extra-items config names the offending key and what is wrong', () => {
  const cases = [
    ['  repo-1: "lower case"', /"repo-1" is not a usable extra-items ID/],
    ['  REPO: "no number"', /"REPO" is not a usable extra-items ID/],
    ['  REPO-1234: "number too long"', /"REPO-1234" is not a usable extra-items ID/],
    ['  REPO-1: ""', /REPO-1 needs text/],
    [`  REPO-1: "${'x'.repeat(MAX_ITEM_CHARS + 1)}"`, new RegExp(`REPO-1 is ${MAX_ITEM_CHARS + 1} characters; the limit is ${MAX_ITEM_CHARS}`)],
  ];
  for (const [line, expected] of cases) {
    assert.throws(() => extrasConfig(line), expected, line);
  }
  // in-this-repo and not-applicable describe SHARED items; pointing them at an
  // extra item is a mistake worth naming rather than ignoring.
  assert.throws(
    () => parseConfig('not-applicable:\n  REPO-1: "never applies"', template),
    /looks like an extra-items ID/,
  );
});

// Extra item text comes from another repository's file and lands in a Markdown
// body that evaluate() re-parses to decide the commit status. This plants a
// checkbox, a second MARKER, a forged shared ID and a forged extra ID in one
// value, and asserts the checklist is exactly what the config DECLARED: one
// extra item, one marker, one RG-1, no phantom REPO-9, nothing pre-ticked.
//
// What saves the forged RG-1 tick today is partly ordering -- extras render
// after the shared checklist, and evaluate() keys an ID to the first line
// carrying it -- which is not a property render() is obliged to keep. The next
// test covers the section where that ordering does NOT save you.
test('hostile extra-item text cannot forge an item, tick one, or end the block', () => {
  const hostile =
    '[x] **RG-1** done <!-- codebranch-reviewer-checklist --> - [ ] **REPO-9** phantom <script>';
  const config = extrasConfig(`  REPO-1: "${hostile}"`);
  const body = render(template, config);

  const occurrences = (needle) => body.split(needle).length - 1;
  assert.equal(occurrences(MARKER), 1, 'the planted marker must not become a second marker');
  assert.equal(occurrences('**RG-1**'), 1, 'the planted RG-1 must not become a second RG-1 line');
  assert.equal(occurrences('**REPO-9**'), 0, 'the planted REPO-9 must not become an item');
  assert.equal(body.split('\n').filter((l) => l.includes('**REPO-1**')).length, 1);

  const fresh = evaluate(template, body, config);
  assert.equal(fresh.total, SHARED + 1, 'exactly one extra item, whatever the text says');
  assert.equal(fresh.extra, 1);
  assert.equal(fresh.open.length, SHARED + 1, 'nothing is pre-ticked by the text');
  assert.ok(fresh.open.includes('RG-1'), 'RG-1 is still the reviewer\'s to tick');

  // The whole shared checklist ticked, the hostile item left alone: still red.
  const sharedOnly = tickAll(body.replace('- [ ] **REPO-1**', '- @@ **REPO-1**')).replace(
    '- @@ **REPO-1**',
    '- [ ] **REPO-1**',
  );
  const partial = evaluate(template, sharedOnly, config);
  assert.equal(partial.complete, false);
  assert.deepEqual(partial.open, ['REPO-1']);

});

// The same neutralisation, on the section that predates extra items -- and the
// one where the hole is live. An "In this repo" hint renders INLINE, on a line
// of its own whose only item ID is the planted one, and it sits ABOVE the real
// item. evaluate() keys each ID to the FIRST line carrying it, so before
// sanitisation this hint under AC-1 marked SD-2 "N/A: nothing to do" and the
// real SD-2 line was never read: a secrets-in-logs item passing with nobody
// having looked at it, from a file only the default branch can change.
test('an in-this-repo hint cannot mark another item N/A', () => {
  const config = parseConfig('in-this-repo:\n  AC-1: "N/A: nothing to do **SD-2**"', template);
  const body = render(template, config);
  const result = evaluate(template, body, config);
  assert.ok(result.open.includes('SD-2'), 'a hint must not mark another item N/A');
  assert.equal(result.notApplicable, 0);
  assert.equal(result.open.length, itemIds(template).length);
});

test('sanitize collapses newlines and neutralises structure, leaving prose alone', () => {
  assert.equal(sanitize('one\ntwo\r\n\tthree'), 'one two three');
  assert.equal(sanitize(`x ${MARKER}`), 'x \\<!-- codebranch-reviewer-checklist --\\>');
  assert.equal(sanitize('- [ ] **ZZZ-1** x'), '- \\[ \\] \\*\\*ZZZ-1\\*\\* x');
  // Backticks and punctuation are what real hints are made of; they survive.
  assert.equal(sanitize('only `sqlx::query!` macros'), 'only `sqlx::query!` macros');
});

// --- Backward compatibility -------------------------------------------------

test('a repository with no config behaves exactly as before extra items existed', () => {
  const empty = parseConfig('', template);
  assert.equal(empty.extraItems.size, 0);
  assert.equal(render(template, empty), `${MARKER}\n${template}`);
  assert.equal(render(template), `${MARKER}\n${template}`);

  const result = evaluate(template, template, empty);
  assert.equal(result.total, SHARED);
  assert.equal(result.shared, SHARED);
  assert.equal(result.extra, 0);
  assert.deepEqual(evaluate(template, template), result);
  assert.equal(
    describe(evaluate(template, tickAll(template), empty)),
    `All ${SHARED} items done (${SHARED} ticked, 0 N/A)`,
  );
});

test('a repository with only in-this-repo and not-applicable is byte-for-byte unchanged', () => {
  const text = 'in-this-repo:\n  AC-1: "`GuardedRouter::requires`"\nnot-applicable:\n  AC-4: "No database"';
  const config = parseConfig(text, template);
  const body = render(template, config);

  // The old rendering, spelled out: the template with one hint line inserted
  // after AC-1 and AC-4's box replaced. No extra section, nothing appended.
  const expected = [MARKER];
  for (const line of template.split('\n')) {
    if (line.includes('**AC-4**')) {
      expected.push(line.replace(/^(\s*-\s*)\[ \]/, '$1N/A: No database _(repo setting)_'));
    } else if (line.includes('**AC-1**')) {
      expected.push(line, '  - _In this repo: `GuardedRouter::requires`_');
    } else {
      expected.push(line);
    }
  }
  assert.equal(body, expected.join('\n'));
  assert.ok(!body.includes('Extra items'));

  const result = evaluate(template, body, config);
  assert.equal(result.total, SHARED);
  assert.equal(result.extra, 0);
  assert.equal(result.notApplicable, 1);
  assert.equal(result.open.length, SHARED - 1);
});

test('withHead records the head commit on the line after the marker, and headOf reads it back', () => {
  const { MARKER, withHead, headOf } = require('../src/checklist');
  const body = withHead(render(template), 'abc1234');
  assert.ok(body.startsWith(`${MARKER}\n<!-- head: abc1234 -->\n`));
  assert.equal(headOf(body), 'abc1234');
  assert.equal(headOf(render(template)), undefined);
  assert.equal(evaluate(template, tickAll(body)).complete, true, 'the head line must not disturb grading');
  assert.throws(() => withHead('no marker', 'abc1234'));
});
