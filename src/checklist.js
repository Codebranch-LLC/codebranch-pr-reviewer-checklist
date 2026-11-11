'use strict';

const MARKER = '<!-- codebranch-reviewer-checklist -->';
// Matches both a shared item ID (RG-1) and a repository-supplied one (REPO-1).
const ITEM_ID = /\*\*([A-Z]{2,12}-\d+)\*\*/;
const UNTICKED = /^(\s*-\s*)\[ \]/;
// A line is graded only if it has the exact shape of an item line: unindented,
// a box or an "N/A: <reason>", and THEN the item ID. Anything else -- a note, a
// sub-bullet, a reason that mentions another ID in bold -- is never read as an
// item, so it cannot tick, untick or N/A one. The reason may not contain "*"
// (unless escaped, as sanitize() writes it), so the first **ID** after "N/A:" is
// always the item's own.
const ITEM_LINE = /^[-*][ \t]+(?:\[([ xX])\]|N\/A:((?:[^*\\\n]|\\.)*?))[ \t]*\*\*([A-Z]{2,12}-\d+)\*\*/;
// HTML comments are invisible on GitHub. A tick line inside one would turn the
// status green while every box a human can see is open, so they are removed
// before grading. An unclosed "<!--" swallows the rest of the body: fail closed.
const HTML_COMMENT = /<!--[\s\S]*?(?:-->|$)/g;
// An item whose wording says this can never be N/A, by a reviewer or by a
// repository's `not-applicable` setting.
const ALWAYS_APPLIES = 'This item always applies.';
// An N/A reason must state a fact, not just exist: at least this many words.
const MIN_REASON_WORDS = 3;
const STATUS_DESCRIPTION_LIMIT = 140;
const CONFIG_SECTIONS = {
  'in-this-repo': 'inThisRepo',
  'not-applicable': 'notApplicable',
  'extra-items': 'extraItems',
};
const EMPTY_CONFIG = { inThisRepo: new Map(), notApplicable: new Map(), extraItems: new Map() };
const DEFAULT_CONFIG_PATH = '.github/reviewer-checklist.yml';

// A repository-supplied item ID: three to twelve capital letters, a dash, a
// number. The shared checklist uses exactly TWO letters (RG, AC, SE, DP...), so
// the two shapes are disjoint BY CONSTRUCTION and a repo item can never
// shadow -- or silently override -- a shared one. It also means a reviewer can
// tell at a glance which items are local: three or more letters is this
// repository's own. The disjointness is belt; parseConfig also checks the id
// against the live shared set (braces), in case the shared checklist ever
// adopts a longer prefix.
const EXTRA_ID = /^[A-Z]{3,12}-\d{1,3}$/;
// Every value in the config file is bounded. Item text is rendered into a
// comment body this action re-parses; hints sit in the same body. Unbounded
// text from another repository has no business in either. No value in any
// known config is within an order of magnitude of this.
const MAX_ITEM_CHARS = 300;

// Maps each item ID to its wording, e.g. "AC-1" -> "Every route, handler, ...".
function items(template) {
  const result = new Map();
  for (const line of template.split('\n')) {
    const match = UNTICKED.test(line) && line.match(ITEM_ID);
    if (match) result.set(match[1], line.slice(match.index + match[0].length).trim());
  }
  return result;
}

function itemIds(template) {
  return [...items(template).keys()];
}

// Shared items that can never be N/A.
function alwaysApplies(template) {
  return new Set([...items(template)].filter(([, text]) => text.includes(ALWAYS_APPLIES)).map(([id]) => id));
}

function realReason(reason) {
  const text = (reason || '').trim();
  return text !== '' && text !== '<reason>' && text.split(/\s+/).length >= MIN_REASON_WORDS;
}

// The graded item lines of a comment body, keyed by ID. An ID that appears on
// more than one item line is ambiguous and is recorded as such: it counts as
// open, so a second, ticked copy of a line can never win over the real one.
function itemLines(body) {
  const lines = new Map();
  for (const line of body.replace(HTML_COMMENT, '').split('\n')) {
    const match = line.match(ITEM_LINE);
    if (!match) continue;
    const [, box, reason, id] = match;
    lines.set(
      id,
      lines.has(id)
        ? { duplicate: true }
        : { ticked: box !== undefined && box !== ' ', reason: box === undefined ? reason : undefined },
    );
  }
  return lines;
}

function unquote(raw) {
  const value = raw.trim();
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1).replace(/\\(["\\])/g, '$1');
  }
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1).replace(/''/g, "'");
  }
  return value.replace(/\s+#.*$/, '');
}

// Text out of the consuming repository's config is UNTRUSTED. It lands in a
// Markdown comment body that `evaluate` later RE-PARSES to decide the commit
// status, and the parser works on the shape of a line: a box, an "**ID**", an
// "N/A:". Text that can produce those characters can produce a line.
//
// The hole this closes is live, and it predates extra items. An "In this repo"
// hint renders INLINE, on a line of its own whose only item ID is whatever the
// hint contains, and ABOVE the real item -- and evaluate() keys each ID to the
// FIRST line carrying it. So:
//
//   in-this-repo:
//     AC-1: "N/A: nothing to do **SD-2**"
//
// used to render a line under AC-1 that evaluate read as SD-2's, counting
// "no secrets in logs" as N/A with the real SD-2 line never looked at.
//
// For `extra-items` it is defence in depth rather than a live hole: an extra
// item renders as "- [ ] **ITS-ID** <text>", so its own ID is always the first
// on the line and the section is appended after the shared checklist. Planted
// text still gets neutralised, because what stops it is an ordering that no
// future change to render() is obliged to preserve -- and because "[x] **RG-1**
// done" or a second MARKER inside an item reads to a human exactly like the real
// thing.
//
// So the text is neutralised, not trusted:
//   - every run of whitespace (newline, CR, tab) collapses to one space, so one
//     entry can only ever produce one line;
//   - "[", "]", "<" and ">" are escaped, which kills the checkbox pattern and
//     any HTML comment, MARKER included;
//   - "*" is escaped individually, so "**" never survives and the text cannot
//     forge an "**ID**" item marker.
//
// Neutralising beats rejecting: an invalid config blocks every pull request in
// the repository, and a repository is allowed to write "[" in a hint. Only the
// length is a hard error (see parseConfig), because it is a fact about the
// value, not a guess about what the value meant.
function sanitize(raw) {
  return raw
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[[\]<>*]/g, (character) => `\\${character}`);
}

// Parses .github/reviewer-checklist.yml. Only this subset of YAML is accepted:
//
//   in-this-repo:
//     AC-1: "GuardedRouter::requires"
//   not-applicable:
//     AC-4: "No database in this repo"
//   extra-items:
//     REPO-1: "Every new sqlx query compiles against the checked-in schema"
//
// Anything else is an error, so a typo can't silently drop a setting.
function parseConfig(text, template) {
  const known = new Set(itemIds(template));
  const always = alwaysApplies(template);
  const config = { inThisRepo: new Map(), notApplicable: new Map(), extraItems: new Map() };
  let section = null;

  text.split('\n').forEach((line, index) => {
    const where = `line ${index + 1}`;
    if (line.trim() === '' || line.trim().startsWith('#')) return;

    const heading = line.match(/^([a-z-]+):\s*$/);
    if (heading) {
      section = CONFIG_SECTIONS[heading[1]];
      if (!section) throw new Error(`${where}: unknown section "${heading[1]}"`);
      return;
    }

    const entry = line.match(/^\s+([A-Za-z0-9_-]+):(.*)$/);
    if (!entry) throw new Error(`${where}: expected "  ID: text"`);
    if (!section) throw new Error(`${where}: ${entry[1]} is outside a section`);
    const [, id, raw] = entry;

    if (section === 'extraItems') {
      if (!EXTRA_ID.test(id)) {
        throw new Error(
          `${where}: "${id}" is not a usable extra-items ID. Use three to twelve ` +
            'capital letters, a dash and a number (for example REPO-1 or TENANCY-2). ' +
            'Two-letter prefixes are reserved for the shared checklist, so an extra ' +
            'item can never collide with one.',
        );
      }
      if (known.has(id)) {
        throw new Error(
          `${where}: "${id}" is already a shared checklist item. Choose another ID: an ` +
            'extra item never overrides, shadows or duplicates a shared one.',
        );
      }
    } else if (!known.has(id)) {
      const hint = EXTRA_ID.test(id)
        ? ` "${id}" looks like an extra-items ID; in-this-repo and not-applicable ` +
          'describe SHARED items only, and an extra item already carries its own text.'
        : '';
      throw new Error(`${where}: ${id} is not a checklist item.${hint}`);
    }

    if (section === 'notApplicable' && always.has(id)) {
      throw new Error(`${where}: ${id} always applies and cannot be marked not applicable`);
    }
    if (config[section].has(id)) throw new Error(`${where}: ${id} is listed twice`);
    const value = unquote(raw);
    if (!value) throw new Error(`${where}: ${id} needs text`);
    if (value.length > MAX_ITEM_CHARS) {
      throw new Error(
        `${where}: ${id} is ${value.length} characters; the limit is ${MAX_ITEM_CHARS}`,
      );
    }
    config[section].set(id, value);
  });

  return config;
}


// Shared items plus this repository's extra items, in that order: one map, so
// render, evaluate and describe cannot disagree about what the checklist is.
function allItems(template, config = EMPTY_CONFIG) {
  const result = items(template);
  for (const [id, text] of config.extraItems) result.set(id, sanitize(text));
  return result;
}

// The checklist comment body: repo-wide N/A items are filled in, "In this repo"
// hints sit under their items, and this repository's extra items are appended in
// their own section so a reviewer can see which items are local.
function render(template, config = EMPTY_CONFIG, configPath = DEFAULT_CONFIG_PATH) {
  const output = [];
  for (const line of template.split('\n')) {
    const match = UNTICKED.test(line) && line.match(ITEM_ID);
    const id = match && match[1];
    const reason = id && config.notApplicable.get(id);
    output.push(reason ? line.replace(UNTICKED, `$1N/A: ${sanitize(reason)} _(repo setting)_`) : line);
    if (id && config.inThisRepo.has(id)) {
      output.push(`  - _In this repo: ${sanitize(config.inThisRepo.get(id))}_`);
    }
  }
  if (config.extraItems.size) {
    output.push('', '---', '', '## Extra items for this repository', '');
    output.push(
      `Declared in \`${configPath}\` on the default branch, not in the shared checklist.`,
      'They are required exactly like the items above: tick each one, or replace its box',
      'with `N/A: <reason>`.',
      '',
    );
    for (const [id, text] of config.extraItems) {
      output.push(`- [ ] **${id}** ${sanitize(text)}`);
    }
  }
  return `${MARKER}\n${output.join('\n')}`;
}

// Does the comment carry exactly the items the checklist has now? When the
// shared checklist or the repository's extra items change, a comment posted
// before the change cannot be completed (its reviewer has no line for the new
// item), so the caller re-posts it.
function sameItems(template, body, config = EMPTY_CONFIG) {
  const expected = [...allItems(template, config).keys()].sort();
  const actual = [...itemLines(body).keys()].sort();
  return expected.length === actual.length && expected.every((id, i) => id === actual[i]);
}

function evaluate(template, body, config = EMPTY_CONFIG) {
  const lines = itemLines(body);
  const always = alwaysApplies(template);

  const result = { total: 0, shared: 0, extra: 0, ticked: 0, notApplicable: 0, open: [], missing: [] };
  for (const id of allItems(template, config).keys()) {
    result.total++;
    if (config.extraItems.has(id)) result.extra++;
    else result.shared++;
    const line = lines.get(id);
    // Repo-wide N/A comes from the default branch, not from the comment.
    if (config.notApplicable.has(id)) result.notApplicable++;
    else if (line === undefined) result.missing.push(id);
    else if (line.duplicate) result.open.push(id);
    else if (line.ticked) result.ticked++;
    else if (line.reason !== undefined && !always.has(id) && realReason(line.reason)) result.notApplicable++;
    else result.open.push(id);
  }
  result.complete = result.open.length === 0 && result.missing.length === 0;
  return result;
}

// The head commit a checklist body was rendered for, on the line after MARKER.
// It is what lets a run notice "the checklist predates this head" without
// relying on the `synchronize` run having happened: GitHub's concurrency group
// drops a PENDING run when a newer one queues, so an edit made just after a
// push can cancel the very run that was meant to reset the checklist. Anyone
// who can edit the comment can edit this line too; that is fine, because an
// edit by the PR author resets the checklist anyway (see main.js), and an edit
// by anyone else is an edit by someone already trusted to tick items.
//
// "Anyone else is already trusted" stops holding once the reviewer is an agent
// whoever opened the PR can start: that person also picks the account it edits
// with, and could set this line to the SHA of a commit they have not pushed yet,
// so the push that follows never resets the checklist. With a `signing-key`, the
// line also carries an HMAC of the SHA that only this action can compute, and a
// line whose signature does not verify counts as rendered for another head.
const HEAD_LINE = /^<!-- head: ([0-9a-f]{7,64})(?: sig: ([0-9a-f]{64}))? -->$/m;

function withHead(body, sha, sig) {
  if (!body.startsWith(`${MARKER}\n`)) throw new Error('withHead: body must start with the marker line');
  const signature = sig ? ` sig: ${sig}` : '';
  return `${MARKER}\n<!-- head: ${sha}${signature} -->\n${body.slice(MARKER.length + 1)}`;
}

function headOf(body) {
  return body.match(HEAD_LINE)?.[1];
}

function signatureOf(body) {
  return body.match(HEAD_LINE)?.[2];
}

function describe(result) {
  if (result.complete) {
    // The shared count is the one that means something across repositories, so
    // it stays visible instead of being absorbed into a bigger total.
    const local = result.extra ? `, ${result.extra} of them this repo's` : '';
    return `All ${result.total} items done${local} (${result.ticked} ticked, ${result.notApplicable} N/A)`;
  }
  const parts = [];
  if (result.open.length) parts.push(`${result.open.length} open: ${result.open.join(', ')}`);
  if (result.missing.length) parts.push(`${result.missing.length} removed: ${result.missing.join(', ')}`);
  return truncate(parts.join('; '));
}

function truncate(text) {
  return text.length <= STATUS_DESCRIPTION_LIMIT
    ? text
    : `${text.slice(0, STATUS_DESCRIPTION_LIMIT - 1)}…`;
}

module.exports = {
  MARKER,
  MAX_ITEM_CHARS,
  itemIds,
  alwaysApplies,
  sameItems,
  signatureOf,
  sanitize,
  parseConfig,
  render,
  withHead,
  headOf,
  evaluate,
  describe,
  truncate,
};
