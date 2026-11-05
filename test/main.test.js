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
  const calls = { statuses: [], warnings: [], comments: [] };
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
        updateComment: async ({ body }) => ({ data: { id: 1, body, html_url: 'http://c' } }),
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
