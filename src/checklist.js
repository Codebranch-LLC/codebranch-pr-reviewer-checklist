'use strict';

const MARKER = '<!-- codebranch-reviewer-checklist -->';
const ITEM_ID = /\*\*([A-Z]{2}-\d+)\*\*/;
const UNTICKED = /^(\s*-\s*)\[ \]/;
const TICKED = /^\s*[-*]\s*\[[xX]\]/;
// "N/A:" followed by a real reason, not the "<reason>" placeholder.
const NOT_APPLICABLE = /N\/A:\s*(?!<reason>)\S/;
const STATUS_DESCRIPTION_LIMIT = 140;
const CONFIG_SECTIONS = { 'in-this-repo': 'inThisRepo', 'not-applicable': 'notApplicable' };
const EMPTY_CONFIG = { inThisRepo: new Map(), notApplicable: new Map() };

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

// Parses .github/reviewer-checklist.yml. Only this subset of YAML is accepted:
//
//   in-this-repo:
//     AC-1: "GuardedRouter::requires"
//   not-applicable:
//     AC-4: "No database in this repo"
//
// Anything else is an error, so a typo can't silently drop a setting.
function parseConfig(text, template) {
  const known = new Set(itemIds(template));
  const config = { inThisRepo: new Map(), notApplicable: new Map() };
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

    const entry = line.match(/^\s+([A-Z]{2}-\d+):(.*)$/);
    if (!entry) throw new Error(`${where}: expected "  ID: text"`);
    if (!section) throw new Error(`${where}: ${entry[1]} is outside a section`);
    const [, id, raw] = entry;
    if (!known.has(id)) throw new Error(`${where}: ${id} is not a checklist item`);
    if (config[section].has(id)) throw new Error(`${where}: ${id} is listed twice`);
    const value = unquote(raw);
    if (!value) throw new Error(`${where}: ${id} needs text`);
    config[section].set(id, value);
  });

  return config;
}

// The checklist comment body: repo-wide N/A items are filled in and
// "In this repo" hints sit under their items.
function render(template, config = EMPTY_CONFIG) {
  const output = [];
  for (const line of template.split('\n')) {
    const match = UNTICKED.test(line) && line.match(ITEM_ID);
    const id = match && match[1];
    const reason = id && config.notApplicable.get(id);
    output.push(reason ? line.replace(UNTICKED, `$1N/A: ${reason} _(repo setting)_`) : line);
    if (id && config.inThisRepo.has(id)) {
      output.push(`  - _In this repo: ${config.inThisRepo.get(id)}_`);
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

  const result = { total: 0, ticked: 0, notApplicable: 0, open: [], missing: [] };
  for (const [id, wording] of items(template)) {
    result.total++;
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
    return `All ${result.total} items done (${result.ticked} ticked, ${result.notApplicable} N/A)`;
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

module.exports = { MARKER, itemIds, parseConfig, render, evaluate, describe, truncate };
