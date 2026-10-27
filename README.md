# Codebranch PR reviewer checklist

[`CHECKLIST.md`](CHECKLIST.md) is the review that a team member other than the author completes before approving a pull request. It covers what CodeRabbit, Minmax/kudos and SonarCloud can't judge.

This repository ships the checklist as a GitHub Action. On every pull request in a repository that uses it:

1. A bot comment with the checklist is posted on the PR.
2. The reviewer edits that comment, ticking each item or replacing its box with `N/A: <reason>`.
3. A `reviewer-checklist` commit status on the PR's head commit stays red until every item is ticked or marked N/A with a real reason. Make that status required, and the PR can't merge until the checklist is done.

## Use it in a repository

Add `.github/workflows/reviewer-checklist.yml`:

```yaml
name: Reviewer checklist

on:
  pull_request_target:
    types: [opened, reopened, synchronize, ready_for_review]
  issue_comment:
    types: [edited, deleted]

permissions:
  contents: read
  issues: write
  pull-requests: write
  statuses: write

jobs:
  checklist:
    # Only PR events, and only edits or deletions of the checklist comment itself.
    if: >-
      github.event_name == 'pull_request_target' ||
      (github.event_name == 'issue_comment' &&
       github.event.issue.pull_request &&
       github.event.comment.user.login == 'github-actions[bot]')
    runs-on: ubuntu-latest
    timeout-minutes: 5
    concurrency:
      group: reviewer-checklist-${{ github.event.pull_request.number || github.event.issue.number }}
      cancel-in-progress: false
    steps:
      - uses: Codebranch-LLC/codebranch-pr-reviewer-checklist@<commit-sha> # vX.Y.Z
        # with:
        #   reset-on-push: true
```

Replace `<commit-sha>` with the full commit SHA of a release, and keep the tag in the comment:

```sh
git ls-remote https://github.com/Codebranch-LLC/codebranch-pr-reviewer-checklist 'refs/tags/v*'
```

Always pin the full SHA, never a tag. This action runs with write access to your pull requests, and a tag can be moved to different code. At a pinned SHA everything the action runs is fixed: it reads its own files from that commit, and its one dependency, `actions/github-script`, is itself pinned by SHA. Dependabot's `github-actions` ecosystem updates SHA pins and their version comments.

Then, in the repository's branch ruleset (or branch protection) for `main`:

- Require the status check **`reviewer-checklist`**.
- Require at least one approval, and dismiss stale approvals when new commits are pushed.

Merge the workflow file to the default branch first. `pull_request_target` and `issue_comment` workflows always run from the default branch.

## Per-repository settings

The checklist states rules without naming a stack. Each repository can say how it meets them, and mark items that never apply to it, in `.github/reviewer-checklist.yml`:

```yaml
in-this-repo:
  AC-1: "`GuardedRouter::requires`, or `public` with a stated reason"
  SE-2: "only `sqlx::query!` macros or literal queries"

not-applicable:
  AC-4: "No database in this repository"
```

- `in-this-repo` adds an *In this repo* line under the item in the checklist comment.
- `not-applicable` fills the item in as N/A with that reason, so reviewers don't repeat it on every PR. Use it only for items that can never apply to the repository. An item that doesn't apply to one PR is still marked N/A by the reviewer, with a reason.

[`examples/rust-sqlx.yml`](examples/rust-sqlx.yml) is a complete example for a Rust (sqlx) and TypeScript repository.

The file is optional. It is read from the default branch, never from the pull request, so a PR can't mark its own items N/A. Only the two sections above are accepted, with one `ID: text` per line. An unknown section, an unknown item ID, a duplicate or an empty value sets the status to `error` and names the line. A change to the file applies to a PR's status on its next event, and to the hints in comments posted after that.

## How it is enforced

- **The author can't fill it in.** If the PR author edits the checklist comment, the edit is reverted and the run logs a warning.
- **The PR can't change the rules.** `pull_request_target` runs the workflow from the default branch, so a PR can't edit the workflow to skip the check. The workflow never checks out PR code.
- **Items can't be deleted.** An item missing from the comment counts as open. Deleting the whole comment makes the workflow post a fresh, unticked one.
- **Repository-wide N/A comes from the default branch.** Editing a pre-filled N/A line in the comment has no effect.
- **N/A needs a reason.** `N/A:` with nothing after it, or the literal `N/A: <reason>`, counts as open.
- **Optional reset on push.** With `reset-on-push: true`, every new push resets the checklist to unticked, so the reviewer reviews the latest commits again.

## Limits

- The PR author is the GitHub user who opened the PR. Someone else who pushed commits to the branch can still tick items.
- Repository admins can bypass required checks. When that happens, RG-2 asks for the reason and for the checklist to be completed after the merge. Editing the comment after the merge still updates the status.

## Changing the checklist

Edit `CHECKLIST.md`. Item lines must keep the form `- [ ] **XX-n** text`. The ID is what the parser checks and what repository settings refer to, so don't renumber an item: retire its ID and add a new one. Keep item wording free of stack-specific names; those go in each repository's settings. Run the tests with `npm test`.

To release, tag the merge commit on `main` with a new version and push the tag:

```sh
git tag -a v1.1.0 -m v1.1.0 && git push origin v1.1.0
```

Never move or reuse a tag. Repositories pin the SHA and choose when to update. Bump the major version when a change can fail PRs that passed before, such as a new required item.
