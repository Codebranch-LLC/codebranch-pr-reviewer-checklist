'use strict';

const fs = require('fs');
const path = require('path');
const { MARKER, parseConfig, render, evaluate, describe, truncate } = require('./checklist');

// Each of these describes the CONSUMING repository, not the checklist, so each
// is an action input (see action.yml) with the value every repository had before
// the inputs existed as its default. BOT_LOGIN in particular was a hidden
// coupling: the action accepts a `github-token`, but only the default
// GITHUB_TOKEN comments as `github-actions[bot]`, so a repository that passed an
// App or PAT token got an action that could never find its own comment.
const STATUS_CONTEXT = process.env.STATUS_CONTEXT || 'reviewer-checklist';
const BOT_LOGIN = process.env.BOT_LOGIN || 'github-actions[bot]';
const CONFIG_PATH = process.env.CONFIG_PATH || '.github/reviewer-checklist.yml';

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

// Read from the default branch so a pull request can't change its own settings.
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
  const resetOnPush = process.env.RESET_ON_PUSH === 'true';

  const { owner, repo } = context.repo;
  const { eventName } = context;
  const { action } = context.payload;
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
  const freshBody = render(template, config);

  let comment = await findChecklistComment(github, owner, repo, number);

  if (eventName === 'issue_comment' && action === 'edited' && comment?.id === context.payload.comment.id) {
    const editor = context.payload.sender.login;
    const previousBody = context.payload.changes?.body?.from;
    if (editor === pr.user.login && previousBody !== undefined) {
      ({ data: comment } = await github.rest.issues.updateComment({
        owner,
        repo,
        comment_id: comment.id,
        body: previousBody,
      }));
      core.warning(`@${editor} authored this PR and cannot fill in the reviewer checklist. The edit was reverted.`);
    }
  }

  if (!comment) {
    ({ data: comment } = await github.rest.issues.createComment({
      owner,
      repo,
      issue_number: number,
      body: freshBody,
    }));
  } else if (eventName === 'pull_request_target' && action === 'synchronize' && resetOnPush) {
    ({ data: comment } = await github.rest.issues.updateComment({
      owner,
      repo,
      comment_id: comment.id,
      body: freshBody,
    }));
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
