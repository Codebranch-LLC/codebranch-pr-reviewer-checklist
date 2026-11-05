'use strict';

const MARKER = '<!-- codebranch-reviewer-checklist -->';
// Matches both a shared item ID (RG-1) and a repository-supplied one (REPO-1).
const ITEM_ID = /\*\*([A-Z]{2,12}-\d+)\*\*/;
const UNTICKED = /^(\s*-\s*)\[ \]/;
const TICKED = /^\s*[-*]\s*\[[xX]\]/;
// "N/A:" followed by a real reason, not the "<reason>" placeholder.
const NOT_APPLICABLE = /N\/A:\s*(?!<reason>)\S/;
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

// What the reviewer wrote on the line, without the ID and the item's own wording.
function reviewerText(line, id, wording) {
  return line.replace(`**${id}**`, '').replace(wording, '');
}

function evaluate(template, body, config = EMPTY_CONFIG) {
  const lines = new Map();
  for (const line of body.split('\n')) {
    const match = line.match(ITEM_ID);
    if (match && !lines.has(match[1])) lines.set(match[1], line);
  }

  const result = { total: 0, shared: 0, extra: 0, ticked: 0, notApplicable: 0, open: [], missing: [] };
  for (const [id, wording] of allItems(template, config)) {
    result.total++;
    if (config.extraItems.has(id)) result.extra++;
    else result.shared++;
    const line = lines.get(id);
    // Repo-wide N/A comes from the default branch, not from the comment.
    if (config.notApplicable.has(id)) result.notApplicable++;
    else if (line === undefined) result.missing.push(id);
    else if (TICKED.test(line)) result.ticked++;
    else if (NOT_APPLICABLE.test(reviewerText(line, id, wording))) result.notApplicable++;
    else result.open.push(id);
  }
  result.complete = result.open.length === 0 && result.missing.length === 0;
  return result;
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
  sanitize,
  parseConfig,
  render,
  evaluate,
  describe,
  truncate,
};
