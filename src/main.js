'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const {
  MARKER,
  parseConfig,
  render,
  withHead,
  headOf,
  signatureOf,
  sameItems,
  evaluate,
  describe,
  truncate,
} = require('./checklist');

// Each of these describes the CONSUMING repository, not the checklist, so each
// is an action input (see action.yml) with the value every repository had before
// the inputs existed as its default. BOT_LOGIN in particular was a hidden
// coupling: the action accepts a `github-token`, but only the default
// GITHUB_TOKEN comments as `github-actions[bot]`, so a repository that passed an
// App or PAT token got an action that could never find its own comment.
const STATUS_CONTEXT = process.env.STATUS_CONTEXT || 'reviewer-checklist';
const BOT_LOGIN = process.env.BOT_LOGIN || 'github-actions[bot]';
const CONFIG_PATH = process.env.CONFIG_PATH || '.github/reviewer-checklist.yml';

// Who may fill in the checklist. Empty means anyone but the PR author, which is
// what every repository had before the input existed. Set, it names the
// reviewer accounts -- typically the account a CI-run review agent edits with --
// and an edit by any other account resets the checklist exactly like an author
// edit. It is what makes "an independent reviewer" something the action checks
// rather than something the author asserts: an author who can start the review
// agent can also choose the account it edits with, unless that account is fixed
// here, on the default branch.
const reviewerLogins = () =>
  new Set((process.env.REVIEWER_LOGINS || '').split(/[\s,]+/).filter(Boolean).map((l) => actor(l)));

// WHERE THE CHECKLIST TEXT COMES FROM, and why it is not simply the copy next to
// this file.
//
// A consumer pins this action to a commit SHA, because the step runs with write
// access to pull requests and commit statuses and a tag can be moved to other
// code. Pinning the code also froze the TEXT, so changing one checklist item
// meant re-pinning every repository that uses it -- and in practice that means
// the item never lands everywhere.
//
// So the two are separated. The CODE is immutable at the pinned SHA. The TEXT is
// read at run time from this repository's default branch, so editing CHECKLIST.md
// here changes what every consumer asks on their next pull request event, with
// nothing to re-pin. Unpinning the action would have achieved the same thing by
// also making the executable code mutable, which is the actual supply-chain risk.
// Read INSIDE the functions, not captured at module load: a value captured at
// require() time cannot be varied per run, which made the pinned-mode path
// untestable and would have hidden a wiring mistake in the composite action.
const CHECKLIST_PATH = 'CHECKLIST.md';
const checklistRepo = () =>
  process.env.CHECKLIST_REPO || 'Codebranch-LLC/codebranch-pr-reviewer-checklist';
const checklistRef = () => process.env.CHECKLIST_REF || '';

// The fallback is the copy baked in at the pinned SHA. It must NEVER be used
// silently: a reviewer answering a stale checklist while the shared one has moved
// on is exactly the quiet failure this gate exists to remove, so the warning is
// loud and the status description says so.
function pinnedTemplate() {
  return fs.readFileSync(path.join(__dirname, '..', CHECKLIST_PATH), 'utf8');
}

async function loadTemplate(github, core) {
  const ref0 = checklistRef();
  if (ref0 === 'pinned') return { text: pinnedTemplate(), live: true };
  const slug = checklistRepo();
  const [owner, repo] = slug.split('/');
  try {
    const ref = ref0 || (await github.rest.repos.get({ owner, repo })).data.default_branch;
    const { data } = await github.rest.repos.getContent({ owner, repo, path: CHECKLIST_PATH, ref });
    return { text: Buffer.from(data.content, 'base64').toString('utf8'), live: true };
  } catch (error) {
    core.warning(
      `Could not read ${CHECKLIST_PATH} from ${slug} (${error.status || error.message}). ` +
        'Falling back to the copy pinned with this action, which may be out of date.',
    );
    return { text: pinnedTemplate(), live: false };
  }
}

async function findChecklistComment(github, owner, repo, issueNumber) {
  const comments = await github.paginate(github.rest.issues.listComments, {
    owner,
    repo,
    issue_number: issueNumber,
    per_page: 100,
  });
  return comments.find((c) => c.user?.login === BOT_LOGIN && c.body?.startsWith(MARKER));
}

// GraphQL reports bot actors without the "[bot]" suffix REST uses
// (`github-actions[bot]` is `github-actions` in an edit's `editor`), so both
// sides are compared without it.
const actor = (login) => (login || '').replace(/\[bot\]$/, '');

// Has anyone who may not fill in the checklist edited it since the bot last
// wrote it? Returns 'author-edit', 'unlisted-edit' (an account outside
// `reviewer-logins`, when that is set) or null.
//
// Read from the comment's edit history, newest first, rather than from the
// event: a run must catch an author edit even when the run that edit started
// was cancelled, or when a reviewer's edit landed on top of it. The history
// lists the creation as an edit once the comment has been edited at all; a
// comment that was never edited has an empty history and nothing to catch.
async function disallowedEditSinceBot(github, comment, prAuthor, allowed) {
  const author = actor(prAuthor);
  const bot = actor(BOT_LOGIN);
  let after = null;
  for (;;) {
    const data = await github.graphql(
      `query($id: ID!, $after: String) {
        node(id: $id) {
          ... on IssueComment {
            userContentEdits(first: 100, after: $after) {
              nodes { editedAt editor { login } }
              pageInfo { hasNextPage endCursor }
            }
          }
        }
      }`,
      { id: comment.node_id, after },
    );
    const edits = data.node.userContentEdits;
    const nodes = [...edits.nodes].sort((a, b) => Date.parse(b.editedAt) - Date.parse(a.editedAt));
    for (const edit of nodes) {
      const editor = actor(edit.editor?.login);
      if (editor === bot) return null;
      if (editor === author) return { reason: 'author-edit', editor };
      if (allowed.size && !allowed.has(editor)) return { reason: 'unlisted-edit', editor };
    }
    if (!edits.pageInfo.hasNextPage) return null;
    after = edits.pageInfo.endCursor;
  }
}

// Read from the default branch so a pull request can't change its own settings.
//
// This is load-bearing for `extra-items` in particular, and it is why extra
// items are NOT read from the pull request's head. An item declared in the head
// could be deleted by the very pull request it was written to catch: the gate
// would go green having asked a question the author removed, which is worse than
// not having the item at all. On the default branch an extra item can only be
// changed by a pull request that was itself reviewed under the checklist.
async function loadConfigText(github, owner, repo, ref) {
  try {
    const { data } = await github.rest.repos.getContent({ owner, repo, path: CONFIG_PATH, ref });
    return Buffer.from(data.content, 'base64').toString('utf8');
  } catch (error) {
    if (error.status === 404) return '';
    throw error;
  }
}

module.exports = async ({ github, context, core }) => {
  const { text: template, live: templateIsLive } = await loadTemplate(github, core);
  // On unless explicitly turned off: without it, a checklist completed for one
  // commit is re-stamped green on every commit pushed after it.
  const resetOnPush = process.env.RESET_ON_PUSH !== 'false';

  const { owner, repo } = context.repo;
  const number = context.payload.pull_request?.number ?? context.payload.issue?.number;
  const { data: pr } = await github.rest.pulls.get({ owner, repo, pull_number: number });

  let config;
  try {
    config = parseConfig(
      await loadConfigText(github, owner, repo, pr.base.repo.default_branch),
      template,
    );
  } catch (error) {
    const message = `Invalid ${CONFIG_PATH}: ${error.message}`;
    await github.rest.repos.createCommitStatus({
      owner,
      repo,
      sha: pr.head.sha,
      state: 'error',
      context: STATUS_CONTEXT,
      description: truncate(message),
    });
    core.setFailed(message);
    return;
  }
  // Signs the head line when the repository supplies a key, binding the SHA to
  // this pull request so a signature cannot be copied from another one.
  const signingKey = process.env.SIGNING_KEY || '';
  const sign = (sha) =>
    signingKey &&
    crypto.createHmac('sha256', signingKey).update(`${owner}/${repo}#${number}@${sha}`).digest('hex');
  const signatureValid = (body) => {
    if (!signingKey) return true;
    const expected = Buffer.from(sign(headOf(body) || ''), 'hex');
    const actual = Buffer.from(signatureOf(body) || '', 'hex');
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
  };
  const freshBody = withHead(render(template, config, CONFIG_PATH), pr.head.sha, sign(pr.head.sha));

  let comment = await findChecklistComment(github, owner, repo, number);

  // Every decision below is made from the comment as it is NOW, never from the
  // event that started this run. Runs are not guaranteed to happen: the
  // concurrency group keeps one pending run and drops it when a newer one
  // queues, so an author's edit or a push can go unseen by any run of its own.
  // A rule that only acts on "the event I was started for" therefore has a hole
  // the size of every cancelled run; a rule that inspects the state does not.
  let resetReason;
  if (comment) {
    const disallowed = await disallowedEditSinceBot(github, comment, pr.user.login, reviewerLogins());
    if (disallowed?.reason === 'author-edit') {
      // Never "revert" to the body before the edit. That body is not known to
      // be the bot's: the author can stage it with an earlier edit (one that
      // removed the marker, so no run saw it, or one whose run was cancelled)
      // and have the revert restore a fully ticked checklist. The only body
      // known to be clean is a fresh one, so the author's edit costs the
      // reviewer's progress too -- which is the right incentive not to touch it.
      resetReason = 'author-edit';
      core.warning(
        `@${pr.user.login} authored this PR and cannot fill in the reviewer checklist. ` +
          'Their edit reset the checklist; the reviewer must complete it again.',
      );
    } else if (disallowed) {
      resetReason = 'unlisted-edit';
      core.warning(
        `@${disallowed.editor} is not one of this repository's reviewer-logins and cannot fill in ` +
          'the reviewer checklist. Their edit reset the checklist; the reviewer must complete it again.',
      );
    } else if (resetOnPush && (headOf(comment.body) !== pr.head.sha || !signatureValid(comment.body))) {
      // Covers the push whose `synchronize` run was cancelled, a comment written
      // before the head line existed (reset once, rather than guess), and a head
      // line someone other than this action wrote.
      resetReason = 'new-head';
    } else if (!sameItems(template, comment.body, config)) {
      // The shared checklist or this repository's extra items changed since the
      // comment was posted. Its reviewer has no line for a new item and may not
      // add one, so the comment is re-posted rather than left red for good.
      resetReason = 'items-changed';
    }
  }

  if (!comment) {
    ({ data: comment } = await github.rest.issues.createComment({
      owner,
      repo,
      issue_number: number,
      body: freshBody,
    }));
  } else if (resetReason) {
    ({ data: comment } = await github.rest.issues.updateComment({
      owner,
      repo,
      comment_id: comment.id,
      body: freshBody,
    }));
  }

  // Only the bot's own, marked comment can certify anything. After the logic
  // above this always holds; the check is here so that a mistake in that logic
  // fails closed instead of grading whatever body it was handed.
  if (comment.user?.login !== BOT_LOGIN || !comment.body?.startsWith(MARKER)) {
    const message = `The checklist comment is not one ${BOT_LOGIN} wrote; refusing to grade it.`;
    await github.rest.repos.createCommitStatus({
      owner,
      repo,
      sha: pr.head.sha,
      state: 'failure',
      context: STATUS_CONTEXT,
      description: truncate(message),
      target_url: comment.html_url,
    });
    core.setFailed(message);
    return;
  }

  const result = evaluate(template, comment.body, config);
  const description = templateIsLive ? describe(result) : truncate(`[stale checklist] ${describe(result)}`);
  await github.rest.repos.createCommitStatus({
    owner,
    repo,
    sha: pr.head.sha,
    state: result.complete ? 'success' : 'failure',
    context: STATUS_CONTEXT,
    description,
    target_url: comment.html_url,
  });
  core.info(`${STATUS_CONTEXT} on ${pr.head.sha}: ${description}`);
};
