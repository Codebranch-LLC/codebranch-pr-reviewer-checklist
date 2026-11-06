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

// `edits` is the comment's edit history as GraphQL returns it, newest first,
// with bot actors spelled the GraphQL way (no "[bot]" suffix).
function harness({ getContent, edits = [] }) {
  const calls = { statuses: [], warnings: [], failed: [], comments: [], updates: [], graphql: [] };
  const github = {
    paginate: async () => calls.comments,
    graphql: async (query, vars) => {
      calls.graphql.push(vars);
      return {
        node: {
          userContentEdits: {
            nodes: edits.map(([editor, editedAt]) => ({ editedAt, editor: editor && { login: editor } })),
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      };
    },
    rest: {
      issues: {
        listComments: 'listComments',
        createComment: async ({ body }) => {
          const c = { id: 1, node_id: 'IC_1', body, html_url: 'http://c', user: { login: 'github-actions[bot]' } };
          calls.comments.push(c);
          return { data: c };
        },
        updateComment: async ({ body }) => {
          calls.updates.push(body);
          return { data: { id: 1, node_id: 'IC_1', body, html_url: 'http://c', user: { login: 'github-actions[bot]' } } };
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
  const core = {
    warning: (m) => calls.warnings.push(m),
    info: () => {},
    setFailed: (m) => {
      calls.warnings.push(m);
      calls.failed.push(m);
    },
  };
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

// The author must never be able to turn the gate green, whatever order their
// edits arrive in and whichever runs GitHub cancels. Every case below is a
// sequence that worked against v2.0.0.

const { MARKER, withHead, headOf } = require('../src/checklist');
const HEAD = 'deadbeef';
const noConfig = async ({ path: p }) => {
  if (p === 'CHECKLIST.md') return b64(LIVE);
  const e = new Error('no config');
  e.status = 404;
  throw e;
};
const fresh = () => withHead(render(LIVE), HEAD);
const seed = (h, body, login = 'github-actions[bot]') =>
  h.calls.comments.push({ id: 1, node_id: 'IC_1', body, html_url: 'http://c', user: { login } });
const asEdit = (h, sender, from) => {
  h.context.eventName = 'issue_comment';
  h.context.payload = {
    action: 'edited',
    issue: { number: 7, pull_request: {} },
    comment: { id: 1 },
    sender: { login: sender },
    changes: { body: { from } },
  };
};

test('an author edit resets to a fresh checklist and never restores the body before it', async () => {
  // The two-edit trick: edit 1 ticked everything and stripped the marker, so the
  // workflow's `if:` skipped it; edit 2 put the marker back. v2.0.0 "reverted"
  // edit 2 by restoring edit 1 -- the fully ticked body -- and posted success.
  const ticked = tickAll(render(LIVE)).slice(MARKER.length + 1);
  const h = harness({
    getContent: noConfig,
    edits: [
      ['author', '2026-11-06T10:02:00Z'],
      ['author', '2026-11-06T10:01:00Z'],
      ['github-actions', '2026-11-06T10:00:00Z'],
    ],
  });
  seed(h, `${MARKER}\n${ticked}`);
  asEdit(h, 'author', ticked);
  await run(h);

  assert.equal(h.calls.updates.length, 1);
  assert.equal(h.calls.updates[0], fresh(), 'must reset to a fresh body, not restore changes.body.from');
  assert.equal(h.calls.statuses[0].state, 'failure');
  assert.match(h.calls.warnings[0], /@author authored this PR/);
});

test("an author edit whose own run was cancelled is still caught by the next run", async () => {
  // Author ticks everything; that run is cancelled while pending. A reviewer then
  // edits on top. The run that does execute was started by the REVIEWER's edit,
  // so nothing in its payload points at the author -- only the history does.
  const h = harness({
    getContent: noConfig,
    edits: [
      ['reviewer', '2026-11-06T10:02:00Z'],
      ['author', '2026-11-06T10:01:00Z'],
      ['github-actions', '2026-11-06T10:00:00Z'],
    ],
  });
  seed(h, tickAll(fresh()));
  asEdit(h, 'reviewer', tickAll(fresh()));
  await run(h);

  assert.equal(h.calls.updates.length, 1);
  assert.equal(h.calls.statuses[0].state, 'failure');
  assert.deepEqual(h.calls.graphql[0], { id: 'IC_1', after: null });
});

test('an author edit is caught on a run that was not started by an edit at all', async () => {
  const h = harness({ getContent: noConfig, edits: [['author', '2026-11-06T10:01:00Z'], ['github-actions', '2026-11-06T10:00:00Z']] });
  seed(h, tickAll(fresh()));
  h.context.payload.action = 'reopened';
  await run(h);

  assert.equal(h.calls.updates.length, 1);
  assert.equal(h.calls.statuses[0].state, 'failure');
});

test('an author edit the bot has already reset is not held against the reviewer', async () => {
  const h = harness({
    getContent: noConfig,
    edits: [
      ['reviewer', '2026-11-06T10:03:00Z'],
      ['github-actions', '2026-11-06T10:02:00Z'],
      ['author', '2026-11-06T10:01:00Z'],
      ['github-actions', '2026-11-06T10:00:00Z'],
    ],
  });
  seed(h, tickAll(fresh()));
  asEdit(h, 'reviewer', fresh());
  await run(h);

  assert.equal(h.calls.updates.length, 0);
  assert.equal(h.calls.statuses[0].state, 'success');
  assert.equal(h.calls.warnings.length, 0);
});

test('a reviewer completing the checklist turns it green', async () => {
  const h = harness({ getContent: noConfig, edits: [['reviewer', '2026-11-06T10:01:00Z'], ['github-actions', '2026-11-06T10:00:00Z']] });
  seed(h, tickAll(fresh()));
  asEdit(h, 'reviewer', fresh());
  await run(h);

  assert.equal(h.calls.updates.length, 0);
  assert.equal(h.calls.statuses[0].state, 'success');
});

test('a bot PR author is matched across the REST and GraphQL spellings of its login', async () => {
  const h = harness({ getContent: noConfig, edits: [['dependabot', '2026-11-06T10:01:00Z'], ['github-actions', '2026-11-06T10:00:00Z']] });
  const pulls = h.github.rest.pulls.get;
  h.github.rest.pulls.get = async (a) => {
    const r = await pulls(a);
    r.data.user.login = 'dependabot[bot]';
    return r;
  };
  seed(h, tickAll(fresh()));
  await run(h);

  assert.equal(h.calls.updates.length, 1);
  assert.equal(h.calls.statuses[0].state, 'failure');
});

test('reset-on-push resets on ANY run once the head moved, so a cancelled synchronize run is not a bypass', async () => {
  // Push, then an edit queues behind it and cancels the pending synchronize run.
  // The edit's run must still notice the checklist was rendered for another head.
  process.env.RESET_ON_PUSH = 'true';
  try {
    const h = harness({ getContent: noConfig, edits: [['reviewer', '2026-11-06T10:01:00Z'], ['github-actions', '2026-11-06T10:00:00Z']] });
    const stale = tickAll(withHead(render(LIVE), 'cafe1234'));
    seed(h, stale);
    asEdit(h, 'reviewer', stale);
    await run(h);

    assert.equal(h.calls.updates.length, 1);
    assert.equal(headOf(h.calls.updates[0]), HEAD);
    assert.equal(h.calls.statuses[0].state, 'failure');
  } finally {
    delete process.env.RESET_ON_PUSH;
  }
});

test('reset-on-push keeps a checklist completed for the current head', async () => {
  process.env.RESET_ON_PUSH = 'true';
  try {
    const h = harness({ getContent: noConfig, edits: [['reviewer', '2026-11-06T10:01:00Z'], ['github-actions', '2026-11-06T10:00:00Z']] });
    seed(h, tickAll(fresh()));
    asEdit(h, 'reviewer', fresh());
    await run(h);

    assert.equal(h.calls.updates.length, 0);
    assert.equal(h.calls.statuses[0].state, 'success');
  } finally {
    delete process.env.RESET_ON_PUSH;
  }
});

test('without reset-on-push, a checklist from another head is left alone', async () => {
  const h = harness({ getContent: noConfig });
  seed(h, tickAll(withHead(render(LIVE), 'cafe1234')));
  h.context.payload.action = 'synchronize';
  await run(h);

  assert.equal(h.calls.updates.length, 0);
  assert.equal(h.calls.statuses[0].state, 'success');
});

test('a comment the bot did not write is never graded', async () => {
  // Defence in depth: findChecklistComment only returns the bot's comments, so
  // this is what a mistake in the selection logic would look like.
  const h = harness({ getContent: noConfig });
  h.github.paginate = async () => [
    { id: 1, node_id: 'IC_1', body: tickAll(fresh()), html_url: 'http://c', user: { login: 'author' } },
  ];
  h.github.rest.issues.createComment = async ({ body }) => ({
    data: { id: 2, node_id: 'IC_2', body: tickAll(body), html_url: 'http://c', user: { login: 'author' } },
  });
  await run(h);

  assert.equal(h.calls.statuses[0].state, 'failure');
  assert.match(h.calls.failed[0], /refusing to grade/);
});
