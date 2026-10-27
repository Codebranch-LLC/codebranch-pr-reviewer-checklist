'use strict';

const fs = require('fs');
const path = require('path');
const { MARKER, evaluate, describe } = require('./checklist');

const STATUS_CONTEXT = 'reviewer-checklist';
const BOT_LOGIN = 'github-actions[bot]';

async function findChecklistComment(github, owner, repo, issueNumber) {
  const comments = await github.paginate(github.rest.issues.listComments, {
    owner,
    repo,
    issue_number: issueNumber,
    per_page: 100,
  });
  return comments.find((c) => c.user?.login === BOT_LOGIN && c.body?.startsWith(MARKER));
}

module.exports = async ({ github, context, core }) => {
  const template = fs.readFileSync(path.join(__dirname, '..', 'CHECKLIST.md'), 'utf8');
  const freshBody = `${MARKER}\n${template}`;
  const resetOnPush = process.env.RESET_ON_PUSH === 'true';

  const { owner, repo } = context.repo;
  const { eventName } = context;
  const { action } = context.payload;
  const number = context.payload.pull_request?.number ?? context.payload.issue?.number;
  const { data: pr } = await github.rest.pulls.get({ owner, repo, pull_number: number });

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

  const result = evaluate(template, comment.body);
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
