'use strict';

const MARKER = '<!-- codebranch-reviewer-checklist -->';
const ITEM_ID = /\*\*([A-Z]{2}-\d+)\*\*/;
const TICKED = /^\s*[-*]\s*\[[xX]\]/;
// "N/A:" followed by a real reason, not the "<reason>" placeholder.
const NOT_APPLICABLE = /N\/A:\s*(?!<reason>)\S/;
const STATUS_DESCRIPTION_LIMIT = 140;

// Maps each item ID to its wording, e.g. "AC-1" -> "Every new or changed route ...".
function items(template) {
  const result = new Map();
  for (const line of template.split('\n')) {
    const match = /^\s*-\s*\[ \]/.test(line) && line.match(ITEM_ID);
    if (match) result.set(match[1], line.slice(match.index + match[0].length).trim());
  }
  return result;
}

function itemIds(template) {
  return [...items(template).keys()];
}

// What the reviewer wrote on the line, without the ID and the item's own wording.
function reviewerText(line, id, wording) {
  return line.replace(`**${id}**`, '').replace(wording, '');
}

function evaluate(template, body) {
  const lines = new Map();
  for (const line of body.split('\n')) {
    const match = line.match(ITEM_ID);
    if (match && !lines.has(match[1])) lines.set(match[1], line);
  }

  const result = { total: 0, ticked: 0, notApplicable: 0, open: [], missing: [] };
  for (const [id, wording] of items(template)) {
    result.total++;
    const line = lines.get(id);
    if (line === undefined) result.missing.push(id);
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
  const text = parts.join('; ');
  return text.length <= STATUS_DESCRIPTION_LIMIT
    ? text
    : `${text.slice(0, STATUS_DESCRIPTION_LIMIT - 1)}…`;
}

module.exports = { MARKER, itemIds, evaluate, describe };
