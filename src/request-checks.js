/**
 * Checks `draft-automation-rule` runs on its OWN input, before any ticket
 * exists. The app cannot see the conversation, so it cannot verify what the
 * requester said; it can only refuse shapes that are wrong whatever they said.
 *
 * Every message here is read by the agent and then relayed to a SOC analyst,
 * so each says what is missing and what to do in the requester's words.
 */

// Words that show the requester described more than one case ("do X,
// otherwise do Y"). ONE place to change the list. Matching is whole-word and
// case-insensitive; a phrase matches across any run of spaces. This is a word
// search, not an understanding of the request: "escalate unless it is already
// assigned" is really one branch and still matches "unless". That costs one
// unnecessary question, whereas the opposite error ships a rule that quietly
// does the wrong thing, so the trade is deliberate.
//
// "if ... else" is handled separately in findBranchWords because it needs both
// words to be present, not one of them.
export const BRANCH_WORDS = [
  'otherwise',
  'unless',
  'or else',
  'in that case',
  'depending on',
];

/** Build a whole-word, case-insensitive matcher for a word or phrase. */
function wholeWord(phrase) {
  const body = phrase.split(/\s+/).join('\\s+');
  return new RegExp(`\\b${body}\\b`, 'i');
}

/** Return the branch words found in `requestText` (empty array if none). */
export function findBranchWords(requestText) {
  const found = BRANCH_WORDS.filter((phrase) => wholeWord(phrase).test(requestText));
  if (wholeWord('if').test(requestText) && wholeWord('else').test(requestText)) {
    found.push('if ... else');
  }
  return found;
}

/**
 * `requestText` is the requester's message as sent. It is an audit trail, not
 * a gate: the agent writes it, so it proves nothing by itself. Returns an
 * error message, or null when present.
 */
export function checkRequestText(requestText) {
  if (typeof requestText !== 'string' || requestText.trim() === '') {
    return 'requestText is missing. Send the requester\'s message exactly as they wrote it, ' +
      'so the approver can compare what was asked for with what was built.';
  }
  return null;
}

/**
 * A request that describes more than one case must use more than one branch,
 * so the agent cannot flatten "do X, otherwise Y" into one branch holding both
 * actions (which would run X and Y every time). Returns an error message, or
 * null when the draft is fine.
 */
export function checkBranchesMatchRequest(requestText, branchCount) {
  if (branchCount > 1) return null;
  const found = findBranchWords(requestText);
  if (found.length === 0) return null;
  return `The request describes more than one case (it contains ${found.map((w) => `"${w}"`).join(', ')}), ` +
    `but the draft has only ${branchCount === 1 ? 'one branch' : 'no branches'}. ` +
    'Confirm with the requester what should happen in each case, then send one entry in ' +
    'ruleSpec.branches for each case (the last one with empty conditions is the "otherwise").';
}

/**
 * How many branches a built rule has: the children of its condition
 * container, or 1 for a rule with no conditions (actions at the top level).
 */
export function countBranches(rule) {
  const container = (rule?.components ?? []).find(
    (node) => node.type === 'jira.condition.container.block'
  );
  return container ? container.children.length : 1;
}
