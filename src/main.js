'use strict';

const fs = require('fs');
const path = require('path');
const { MARKER, parseConfig, render, evaluate, describe, truncate } = require('./checklist');

const STATUS_CONTEXT = 'reviewer-checklist';
const BOT_LOGIN = 'github-actions[bot]';
const CONFIG_PATH = '.github/reviewer-checklist.yml';

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
  const template = fs.readFileSync(path.join(__dirname, '..', 'CHECKLIST.md'), 'utf8');
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
  const description = describe(result);
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
