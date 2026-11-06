# Codebranch PR reviewer checklist

[`CHECKLIST.md`](CHECKLIST.md) is the review that a team member other than the author completes before approving a pull request. It covers what automated reviewers and static-analysis gates — CodeRabbit, Minmax/kudos and SonarCloud, in the repositories that run them — can't judge: intent, authorization, tenancy and design. The checklist itself names no tool and no stack, so it reads the same in every repository.

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
    # Only PR events, and only edits or deletions of the checklist comment
    # itself, identified by the marker the action puts at the top of it. Testing
    # the marker rather than the commenter's login keeps this condition correct
    # whatever identity `github-token` resolves to, and stops every other bot
    # comment on the PR (preview URLs, coverage reports) from starting this job.
    # It is a noise filter, not a security boundary: an edit it skips (say, one
    # that removed the marker) is still caught by the next run that does start,
    # because every run inspects the comment's edit history.
    if: >-
      github.event_name == 'pull_request_target' ||
      (github.event_name == 'issue_comment' &&
       github.event.issue.pull_request &&
       startsWith(github.event.comment.body, '<!-- codebranch-reviewer-checklist -->'))
    # Pin the runner image your repository standardises on. `ubuntu-latest` is a
    # floating label: the image under it changes on a day nobody chose.
    runs-on: ubuntu-24.04
    timeout-minutes: 5
    concurrency:
      group: reviewer-checklist-${{ github.event.pull_request.number || github.event.issue.number }}
      cancel-in-progress: false
    steps:
      - uses: Codebranch-LLC/codebranch-pr-reviewer-checklist@<commit-sha> # vX.Y.Z
        # Every input is optional; these are the defaults.
        # with:
        #   reset-on-push: 'false'
        #   status-context: reviewer-checklist
        #   bot-login: github-actions[bot]
        #   config-path: .github/reviewer-checklist.yml
```

`status-context` is the name of the commit status, and so the context to make required. Override it to match how the repository names its other contexts, to avoid a collision, or to run two checklists in one repository.

`bot-login` must match the identity `github-token` resolves to. The default `GITHUB_TOKEN` comments as `github-actions[bot]`; a GitHub App installation token comments as `<app-slug>[bot]`, and a personal access token as its owner. If it doesn't match, the action can't find the comment it posted, so it posts a new unticked checklist on every event and the status never goes green.

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

The checklist states rules without naming a stack. Each repository can say how it meets them, and mark items that never apply to it, in `.github/reviewer-checklist.yml` (or wherever `config-path` points):

```yaml
in-this-repo:
  AC-1: "`GuardedRouter::requires`, or `public` with a stated reason"
  SE-2: "only `sqlx::query!` macros or literal queries"

not-applicable:
  AC-4: "No database in this repository"

extra-items:
  RUST-1: "Every SQL string reaching the database is a `sqlx::query!` macro"
  TENANCY-2: "Every new query filters by account_id"
```

- `in-this-repo` adds an *In this repo* line under the item in the checklist comment.
- `not-applicable` fills the item in as N/A with that reason, so reviewers don't repeat it on every PR. Use it only for items that can never apply to the repository. An item that doesn't apply to one PR is still marked N/A by the reviewer, with a reason.
- `extra-items` adds items of the repository's own, **on top of** the shared ones. They are posted in an *Extra items for this repository* section at the end of the comment, and they are required in exactly the same way: tick each one, or replace its box with `N/A: <reason>`. They are counted in the status description, and `reset-on-push` resets them with everything else.

[`examples/rust-sqlx.yml`](examples/rust-sqlx.yml) is a complete example for a Rust (sqlx) and TypeScript repository.

### Extra item IDs

An extra item's ID is **three to twelve capital letters, a dash and a number** — `REPO-1`, `RUST-2`, `TENANCY-11`. The shared checklist uses exactly **two** letters (`RG`, `AC`, `SE`, `DP`…), so the two shapes cannot overlap: a repository can never override, shadow or duplicate a shared item, and a reviewer can tell which items are local by looking at them. `RG-1` or `AC-3` under `extra-items` is a config error, not a silent override.

Don't renumber an extra item for the same reason you don't renumber a shared one: the ID is what review comments cite. Retire it and add a new one.

`in-this-repo` and `not-applicable` describe shared items only. An extra item already carries its own text, and a repository that wants to stop asking one of its own items deletes it.

### What the file may contain

The file is optional. It is read from the default branch, never from the pull request. For `in-this-repo` and `not-applicable` that stops a PR marking its own items N/A; for `extra-items` it is what stops a pull request **deleting the item that would have caught it** — an item read from the PR head could be removed by the same PR, and the gate would go green having asked nothing. An extra item can therefore only be added or removed by a pull request that was itself reviewed under the checklist.

Only the three sections above are accepted, with one `ID: text` per line. An unknown section, an unknown or unusable item ID, an ID that collides with a shared one, a duplicate, an empty value, or a value over 300 characters sets the status to `error`, names the offending key and says what is wrong with it. That path blocks every pull request in the repository until the file is fixed, which is the point: a checklist gate that fails open is not a gate.

Item text and hints are treated as untrusted input. They land in a Markdown comment that this action re-parses to decide the commit status, so a value is collapsed to one line and `[`, `]`, `<`, `>` and `*` in it are escaped before it is rendered. Without that, text like `[x] **RG-1** done` could forge a checklist line and tick an item nobody read. Backticks and ordinary punctuation are untouched, so `` `sqlx::query!` `` still renders as code.

A change to the file applies to a PR's status on its next event, and to comments posted after that.

## How it is enforced

- **The author can't fill it in.** If the PR author has edited the checklist comment since the action last wrote it, the next run resets it to a fresh, unticked checklist and logs a warning. That wipes the reviewer's progress too, on purpose: the only body known to be clean is a fresh one. (Before v2.0.1 the edit was "reverted" to the body before it, which the author could stage with an earlier edit — see below.)
- **Decisions come from the comment's state, not from the event.** The concurrency group keeps one pending run and drops it when a newer one queues, so any single event can go unseen. Each run therefore reads the comment's edit history (who edited it, and whether the PR author did so after the action's last write) and the head commit the checklist was rendered for, instead of trusting the event that started it. A cancelled run never leaves a hole for the next one.
- **Only the action's own comment is graded.** A comment not written by `bot-login`, or that doesn't start with the marker, is never graded as success.
- **The PR can't change the rules.** `pull_request_target` runs the workflow from the default branch, so a PR can't edit the workflow to skip the check. The workflow never checks out PR code.
- **Items can't be deleted.** An item missing from the comment counts as open. Deleting the whole comment makes the workflow post a fresh, unticked one.
- **Repository-wide N/A comes from the default branch.** Editing a pre-filled N/A line in the comment has no effect.
- **N/A needs a reason.** `N/A:` with nothing after it, or the literal `N/A: <reason>`, counts as open. That applies to a repository's extra items too.
- **A repository's extra items can't be dodged.** They are read from the default branch, counted in the status, and an untouched one keeps the status red with every shared item ticked. Their text can't forge a checklist line, and their IDs can't collide with the shared ones.
- **Optional reset on push.** With `reset-on-push: true`, a checklist rendered for an older head commit is reset to unticked on the next run, whatever event starts it (the comment records its head commit in a hidden line), so the reviewer reviews the latest commits again. A comment posted before v2.0.1 has no such line and is reset once. so the reviewer reviews the latest commits again. Know what the default costs: the status is written per head commit but read from the EXISTING comment, so a checklist completed for commit A is re-stamped green on commit B with nobody having looked at B. That is the same hole "dismiss stale approvals" closes for the approval, so turn the two on together, or leave both off and accept that the gate certifies the review happened, not that it covered the final commit.

## Limits

- The PR author is the GitHub user who opened the PR. Someone else who pushed commits to the branch can still tick items.
- The status is an ordinary commit status, so anyone with write access can post a `reviewer-checklist` status through the API. In branch protection (or the ruleset), require the check **from the GitHub Actions app** as its expected source, so a status posted by anyone else doesn't satisfy it.
- Repository admins can bypass required checks. When that happens, RG-2 asks for the reason and for the checklist to be completed after the merge. Editing the comment after the merge still updates the status.
- RG-2 therefore assumes a bypass is *possible*. Where branch protection has "Do not allow bypassing the above settings" (`enforce_admins`) on, nobody can bypass, a pull request without a second reviewer is simply unmergeable, and RG-2 can never apply — mark it `not-applicable` for that repository rather than leaving reviewers an item they must N/A on every PR.

## Changing the checklist

Edit `CHECKLIST.md`. Item lines must keep the form `- [ ] **XX-n** text` — two capital letters, a dash, a number. The ID is what the parser checks and what repository settings refer to, so don't renumber an item: retire its ID and add a new one. Run the tests with `npm test`.

**An item that only applies to one stack does not belong here.** Keep the wording of shared items free of stack-specific names, and put the stack-specific question in that repository's [`extra-items`](#per-repository-settings) instead — that is what the section is for, and what makes this rule followable rather than a counsel of perfection. Two tests hold the line: `the checklist names no specific stack` fails on a name that belongs in a repository's settings, and the example config exercises the other side of it. Before this existed, the only places to put such an item were the shared checklist (where it reads as noise in every other repository) or nowhere; "nowhere" is what usually happened.

To release, tag the merge commit on `main` with a new version and push the tag:

```sh
git tag -a v1.1.0 -m v1.1.0 && git push origin v1.1.0
```

Never move or reuse a tag. Repositories pin the SHA and choose when to update. Bump the major version when a change can fail PRs that passed before, such as a new required item.

## Versioning: pin the action, follow the checklist

Pin the `uses:` to a **commit SHA**, not a tag or a branch. The step runs with
write access to pull requests and commit statuses, and a tag can be moved to
different code.

That used to freeze the checklist too, so changing one item meant re-pinning
every repository — which in practice meant the item never landed everywhere. It
no longer does: the action reads `CHECKLIST.md` from THIS repository's default
branch at run time. Edit the checklist here and every consumer asks the new
question on its next pull-request event, with nothing to re-pin.

So the split is deliberate:

| | How it updates | Why |
|---|---|---|
| Action code | re-pin the SHA (Dependabot proposes it) | executable, runs with write scopes — immutability is the point |
| Checklist text | automatically, from this repo's default branch | it is data, and it is meant to change in one place |

If the fetch fails, the action falls back to the copy baked in at the pinned SHA
and says so **loudly**: a `core.warning` in the log and a `[stale checklist]`
prefix on the commit status. A reviewer answering a frozen checklist while the
shared one has moved on is the quiet failure this gate exists to remove.

`checklist-ref: pinned` opts out and uses the baked-in copy with no API call.
