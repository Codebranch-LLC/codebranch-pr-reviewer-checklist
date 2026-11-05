'use strict';

// The live-checklist path, and the stale fallback. The fallback is the dangerous
// one: a reviewer answering a frozen checklist while the shared one has moved on
// is the quiet failure this gate exists to remove, so the test asserts the
// warning AND the marker on the commit status, not just that nothing threw.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const run = require('../src/main.js');
const template = fs.readFileSync(path.join(__dirname, '..', 'CHECKLIST.md'), 'utf8');
const LIVE = template.replace('**RG-1**', '**RG-1** (live copy)');

function harness({ getContent }) {
  const calls = { statuses: [], warnings: [], comments: [], updates: [] };
  const github = {
    paginate: async () => calls.comments,
    rest: {
      issues: {
        listComments: 'listComments',
        createComment: async ({ body }) => {
          const c = { id: 1, body, html_url: 'http://c', user: { login: 'github-actions[bot]' } };
          calls.comments.push(c);
          return { data: c };
        },
        updateComment: async ({ body }) => {
          calls.updates.push(body);
          return { data: { id: 1, body, html_url: 'http://c' } };
        },
      },
      pulls: {
        get: async () => ({
          data: { head: { sha: 'deadbeef' }, user: { login: 'author' }, base: { repo: { default_branch: 'main' } } },
        }),
      },
      repos: {
        get: async () => ({ data: { default_branch: 'main' } }),
        getContent,
        createCommitStatus: async (s) => {
          calls.statuses.push(s);
          return { data: s };
        },
      },
    },
  };
  const core = { warning: (m) => calls.warnings.push(m), info: () => {}, setFailed: (m) => calls.warnings.push(m) };
  const context = { repo: { owner: 'o', repo: 'r' }, eventName: 'pull_request_target', payload: { action: 'opened', pull_request: { number: 7 } } };
  return { github, core, context, calls };
}

const b64 = (s) => ({ data: { content: Buffer.from(s, 'utf8').toString('base64') } });

test('the checklist text is read live from the shared repository', async () => {
  const h = harness({
    getContent: async ({ path: p }) => {
      if (p === 'CHECKLIST.md') return b64(LIVE);
      const e = new Error('no config');
      e.status = 404;
      throw e;
    },
  });
  await run(h);
  assert.ok(h.calls.comments[0].body.includes('(live copy)'), 'posted comment should use the LIVE checklist');
  assert.equal(h.calls.warnings.length, 0);
  assert.ok(!h.calls.statuses[0].description.startsWith('[stale'));
});

test('an unreachable shared checklist falls back LOUDLY, never silently', async () => {
  const h = harness({
    getContent: async ({ path: p }) => {
      if (p === 'CHECKLIST.md') {
        const e = new Error('boom');
        e.status = 500;
        throw e;
      }
      const e = new Error('no config');
      e.status = 404;
      throw e;
    },
  });
  await run(h);
  assert.ok(!h.calls.comments[0].body.includes('(live copy)'), 'should fall back to the pinned copy');
  assert.equal(h.calls.warnings.length, 1);
  assert.match(h.calls.warnings[0], /may be out of date/);
  assert.ok(h.calls.statuses[0].description.startsWith('[stale checklist]'));
});

test('checklist-ref: pinned makes no API call for the checklist', async () => {
  process.env.CHECKLIST_REF = 'pinned';
  try {
    const h = harness({
      getContent: async ({ path: p }) => {
        if (p === 'CHECKLIST.md') throw new Error('must not be fetched when pinned');
        const e = new Error('no config');
        e.status = 404;
        throw e;
      },
    });
    await run(h);
    assert.equal(h.calls.warnings.length, 0);
    assert.ok(!h.calls.statuses[0].description.startsWith('[stale'));
  } finally {
    delete process.env.CHECKLIST_REF;
  }
});

// Extra items end to end: read from the CONSUMING repository's default branch
// (never the PR head), posted, counted, and reset on push like any other item.

const { itemIds, parseConfig, render } = require('../src/checklist');
const SHARED = itemIds(template).length;

const EXTRAS = [
  'extra-items:',
  '  REPO-1: "The migration is reversible"',
  '  TENANCY-2: "Every new query filters by account_id"',
].join('\n');

const configFor = (p) => (p === 'CHECKLIST.md' ? b64(LIVE) : b64(EXTRAS));
const tickAll = (body) => body.replace(/^(\s*-\s*)\[ \]/gm, '$1[x]');

test("a repository's extra items are posted, counted, and read from the default branch", async () => {
  const reads = [];
  const h = harness({
    getContent: async ({ path: p, ref }) => {
      reads.push({ path: p, ref });
      return configFor(p);
    },
  });
  await run(h);

  const body = h.calls.comments[0].body;
  assert.ok(body.includes('- [ ] **REPO-1** The migration is reversible'));
  assert.ok(body.includes('- [ ] **TENANCY-2** Every new query filters by account_id'));
  assert.match(body, /## Extra items for this repository/);
  // The section names the file it came from, so a reviewer who disagrees with an
  // item knows where it is written down.
  assert.ok(body.includes('.github/reviewer-checklist.yml'));

  assert.equal(h.calls.statuses[0].state, 'failure');
  assert.ok(
    h.calls.statuses[0].description.startsWith(`${SHARED + 2} open:`),
    `extras must be counted; got "${h.calls.statuses[0].description}"`,
  );
  assert.equal(h.calls.warnings.length, 0);

  // The config is read from the base repository's DEFAULT BRANCH. Reading it from
  // the PR head would let a pull request delete the very item written to catch
  // it, and the gate would go green having asked nothing.
  assert.equal(reads.find((r) => r.path === '.github/reviewer-checklist.yml').ref, 'main');
});

test('an extra item nobody ticked keeps the status red with every shared item done', async () => {
  const h = harness({ getContent: async ({ path: p }) => configFor(p) });
  const fresh = render(LIVE, parseConfig(EXTRAS, LIVE), '.github/reviewer-checklist.yml');
  // Tick the shared checklist, leave this repository's own items alone.
  const sharedTicked = tickAll(fresh.replace(/^- \[ \] \*\*(REPO-1|TENANCY-2)\*\*/gm, '- @@ **$1**'))
    .replace(/^- @@ \*\*/gm, '- [ ] **');
  h.calls.comments.push({
    id: 1,
    body: sharedTicked,
    html_url: 'http://c',
    user: { login: 'github-actions[bot]' },
  });
  await run(h);

  assert.equal(h.calls.statuses[0].state, 'failure');
  assert.equal(h.calls.statuses[0].description, '2 open: REPO-1, TENANCY-2');
});

test('an invalid extra item blocks the PR with an error status that names the key', async () => {
  const h = harness({
    getContent: async ({ path: p }) =>
      p === 'CHECKLIST.md' ? b64(LIVE) : b64('extra-items:\n  RG-1: "mine now"'),
  });
  await run(h);

  assert.equal(h.calls.statuses.length, 1);
  assert.equal(h.calls.statuses[0].state, 'error');
  assert.match(h.calls.statuses[0].description, /Invalid \.github\/reviewer-checklist\.yml: line 2/);
  assert.match(h.calls.warnings[0], /"RG-1"/);
  assert.equal(h.calls.comments.length, 0, 'no checklist is posted from a broken config');
});

test('reset-on-push resets the extra items too', async () => {
  process.env.RESET_ON_PUSH = 'true';
  try {
    const h = harness({ getContent: async ({ path: p }) => configFor(p) });
    h.context.payload.action = 'synchronize';
    // A checklist completed for the previous head, extras included.
    h.calls.comments.push({
      id: 1,
      body: tickAll(render(LIVE, parseConfig(EXTRAS, LIVE))),
      html_url: 'http://c',
      user: { login: 'github-actions[bot]' },
    });
    await run(h);

    assert.equal(h.calls.updates.length, 1);
    assert.ok(h.calls.updates[0].includes('- [ ] **REPO-1** The migration is reversible'));
    assert.ok(h.calls.updates[0].includes('- [ ] **TENANCY-2**'));
    assert.equal(h.calls.statuses[0].state, 'failure');
    assert.ok(h.calls.statuses[0].description.startsWith(`${SHARED + 2} open:`));
  } finally {
    delete process.env.RESET_ON_PUSH;
  }
});
