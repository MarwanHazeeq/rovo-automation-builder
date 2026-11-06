import {
  AUTH_PLACEHOLDER, canonicalJson, describeComponentPositions, parseHttpUrl, redactSecrets, redactUrl, sha256, walkComponents,
} from './index.js';
import { describeIssueTarget, describeSteps, describeTrigger, issueTarget } from './rule-steps.js';

/**
 * Everything a human reads about a draft is rendered HERE, by code, from the
 * frozen rule object. Never from text the agent wrote. That is the point of
 * the approval ticket: the manager approves what this function shows, which
 * is derived from exactly what will be POSTed.
 *
 * Jira Cloud REST v3 takes comment bodies in Atlassian Document Format (ADF),
 * a JSON tree of nodes (doc > paragraph > text, etc.) rather than markup, so
 * the small helpers below build those nodes.
 */

/** The digest that identifies one exact rule payload. Key order does not matter. */
export function digestRule(rule) {
  return sha256(canonicalJson(rule));
}

/**
 * Prefix the rule name with the approval ticket key, e.g.
 * "[SOC-12] Notify on P1", so a created rule can always be traced back to
 * its approval. Any existing "[KEY] " prefix is removed first, because a
 * revised spec often copies the name from the previous draft.
 */
export function withTicketPrefix(rule, issueKey) {
  const baseName = String(rule.name ?? '').replace(/^\[[A-Z][A-Z0-9_]*-\d+\]\s*/, '');
  return { ...rule, name: `[${issueKey}] ${baseName}` };
}

/**
 * "SOCDemo (ID 10086)": the project a rule will be created in, worded so the
 * manager sees it before approving. `name` is null when the draft named the
 * project by id only. Shared by the ticket, the draft comment and the Teams card.
 */
export function projectLine(name, id) {
  return name ? `${name} (ID ${id})` : `ID ${id} (the draft gave no project name)`;
}

/** The numeric project id inside a rule scope ARI, or null if it has none. */
export function projectIdFromScope(scope) {
  return /project\/(\d+)$/.exec(String(scope))?.[1] ?? null;
}

const ISSUE_CREATING_ACTIONS = { 'jira.issue.create': 'Create', 'jira.issue.clone': 'Clone' };

/**
 * A rule as the approver reads it: the "When ..." sentence, the numbered
 * steps (see rule-steps.js), and where any create/clone step puts the new
 * work item. That last one is listed on its own as well because it is the one
 * action that can reach OUTSIDE the rule's project scope, so the approver
 * must see it, not dig for it in the steps or the JSON.
 */
export function outlineRule(rule, { scope, projectName, fieldNames = {} }) {
  const scopeProjectId = projectIdFromScope(scope);
  const steps = describeSteps(rule, { scopeProjectId, fieldNames });
  const issueTargets = steps
    .filter(({ node }) => node.component === 'ACTION' && ISSUE_CREATING_ACTIONS[node.type])
    .map(({ node, number }) =>
      `${ISSUE_CREATING_ACTIONS[node.type]} (step ${number}) ${describeIssueTarget(issueTarget(node), scopeProjectId)}`);
  return {
    opening: describeTrigger(rule, projectLine(projectName, scopeProjectId), { fieldNames }),
    steps,
    issueTargets,
  };
}

// Domains reserved by RFC 2606 / RFC 6761: guaranteed never to resolve, so a
// web request pointed at one can never hand its token or payload to a stranger.
const RESERVED_HOST = /(^|\.)(invalid|example|test|localhost)$|(^|\.)example\.(com|net|org)$/i;

// Angle-bracket placeholder text such as "<SDP_CLIENT_SECRET>". At least one
// capital letter is required so ordinary markup like "<br>" is not listed.
const PLACEHOLDER = /<(?=[^<>]*[A-Z])[A-Za-z][\w -]{1,60}>/g;

/** Every string anywhere inside a component value, in order. */
function stringLeaves(value, out = []) {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) value.forEach((entry) => stringLeaves(entry, out));
  else if (value && typeof value === 'object') Object.values(value).forEach((entry) => stringLeaves(entry, out));
  return out;
}

/** Visit the trigger, its conditions, then every component, in rule order. */
function walkRule(rule, visit) {
  if (rule.trigger && typeof rule.trigger === 'object') visit(rule.trigger);
  walkComponents(rule.trigger?.conditions, visit);
  walkComponents(rule.components, visit);
}

/**
 * Stand-ins the app can detect in a built rule: values a human must replace in
 * the Jira UI before the rule is enabled. Built from the payload, never from a
 * fixed sentence, so the list names THIS rule's unfinished fields and is empty
 * when there are none.
 *
 *   - a web request URL on a reserved domain (it passes Jira's create-time
 *     check but is obviously not the real endpoint)
 *   - angle-bracket placeholder text anywhere (credentials, headers, bodies)
 *   - the Authorization header placeholder the app itself adds
 *
 * Only the stand-in itself is shown (the placeholder token, or the redacted
 * URL), never the whole value it sits in, which may hold a real secret.
 *
 * `positions` maps each component to where a reader finds it. The draft
 * comment passes step numbers (see stepPositions) so the list points at the
 * steps printed above it.
 */
export function findStandIns(rule, positions = describeComponentPositions(rule)) {
  const found = [];
  walkRule(rule, (node) => {
    const where = positions.get(node) ?? 'the rule';
    if (node.type === 'jira.issue.outgoing.webhook') {
      const host = parseHttpUrl(node.value?.url)?.hostname;
      if (host && RESERVED_HOST.test(host)) {
        found.push({ value: redactUrl(node.value.url), kind: 'URL on a reserved domain', where });
      }
    }
    const tokens = new Set();
    for (const leaf of stringLeaves(node.value)) {
      for (const match of leaf.match(PLACEHOLDER) ?? []) tokens.add(match);
      if (leaf === AUTH_PLACEHOLDER) tokens.add(AUTH_PLACEHOLDER);
    }
    for (const token of tokens) found.push({ value: token, kind: 'placeholder', where });
  });
  return found;
}

// --- ADF node helpers -------------------------------------------------------

const text = (value, marks) => ({ type: 'text', text: String(value), ...(marks ? { marks } : {}) });
const strong = (value) => text(value, [{ type: 'strong' }]);
const code = (value) => text(value, [{ type: 'code' }]);
const paragraph = (...content) => ({ type: 'paragraph', content });
const heading = (level, value) => ({ type: 'heading', attrs: { level }, content: [text(value)] });
const bulletList = (items) => ({
  type: 'bulletList',
  content: items.map((content) => ({ type: 'listItem', content: [paragraph(...content)] })),
});
const doc = (...content) => ({ type: 'doc', version: 1, content });


/**
 * Numbered steps as nested bullet lists. The step number is written into the
 * text ("2.1 ...") rather than left to an ordered list, because Jira picks
 * its own numbering style for nested ordered lists and the stand-in list
 * refers to steps by these exact numbers.
 */
function stepList(steps, depth = 0, start = 0) {
  const items = [];
  let i = start;
  while (i < steps.length && steps[i].depth >= depth) {
    const step = steps[i];
    i += 1;
    const content = [paragraph(strong(`${step.number} `), text(step.text))];
    if (i < steps.length && steps[i].depth > depth) {
      const nested = stepList(steps, depth + 1, i);
      content.push(nested.list);
      i = nested.next;
    }
    items.push({ type: 'listItem', content });
  }
  return { list: { type: 'bulletList', content: items }, next: i };
}

/** The "When ..." sentence and the steps, shared by the comment and the description. */
function ruleBody(outline) {
  return [
    paragraph(text(outline.opening)),
    ...(outline.steps.length ? [stepList(outline.steps).list] : [paragraph(text('(The rule has no steps.)'))]),
  ];
}

/**
 * Where each component sits, by step number: "step 2.1". A branch's own
 * conditions belong to its "If ..." step; trigger conditions to the trigger.
 */
function stepPositions(rule, steps) {
  const positions = new Map();
  if (rule?.trigger && typeof rule.trigger === 'object') positions.set(rule.trigger, 'the trigger');
  walkComponents(rule?.trigger?.conditions, (node) => positions.set(node, 'the trigger'));
  for (const { number, node } of steps) {
    positions.set(node, `step ${number}`);
    walkComponents(node.conditions, (inner) => positions.set(inner, `step ${number}`));
  }
  return positions;
}

/**
 * The approval ticket description: what the draft rule does, in the same
 * words and numbered steps as the "Draft vN" comment (issue #25).
 *
 * The target project comes first: it is the one thing the app cannot check
 * against the conversation, so the manager is the last point where a wrong
 * project is free to fix. Nothing here is text the agent or the requester
 * wrote; it is all rendered from the draft. It is written when the ticket is
 * raised and rewritten on every revision, so it always shows the latest draft.
 */
export function renderDraftDescription({ rule, scope, projectName, fieldNames }) {
  return doc(
    paragraph(strong('Target project: '), text(projectLine(projectName, projectIdFromScope(scope)))),
    ...ruleBody(outlineRule(rule, { scope, projectName, fieldNames })),
    paragraph(text('Written by the Automation Rule Builder app from the stored draft. The authoritative draft is the latest ' +
      '"Draft vN" comment and its attached JSON.'))
  );
}

/**
 * The redacted copy of a draft that is attached to the approval ticket, so the
 * manager can read the full payload without it crowding the comment.
 *
 * The file is a VIEW, not the source of truth: the app creates the draft
 * stored in Forge KVS, never this file. Anyone who can edit the ticket can
 * upload a look-alike file, which changes nothing. The digest in the app's
 * comment (computed over the unredacted stored rule) is how to tell the real
 * draft apart.
 *
 * Secrets such as webhook headers are replaced with "[redacted]" (by
 * redactSecrets in index.js, the redaction used everywhere else), because
 * an attachment can be downloaded by anyone who can view the ticket and is
 * copied into exports and backups.
 *
 * The filename carries the version and the first 8 characters of the digest,
 * e.g. draft-v2-3fa91c0b.json, so every revision keeps its own file.
 */
export function renderDraftAttachment(record) {
  return {
    filename: `draft-v${record.version}-${String(record.digest).slice(0, 8)}.json`,
    text: `${JSON.stringify(redactSecrets(record.rule), null, 2)}\n`,
  };
}

/**
 * The "Draft vN" comment posted when a draft is submitted or revised.
 *
 * It summarises the rule and names the attached JSON file. `attachmentName`
 * is set when the upload worked; `attachmentError` when it did not, in which
 * case the comment says so (the summary alone is enough to decide on).
 */
export function renderDraftComment(record, { attachmentName, attachmentError } = {}) {
  const { rule, version, digest, scope, projectName, fieldNames } = record;
  const outline = outlineRule(rule, { scope, projectName, fieldNames });

  const attachmentLine = attachmentName
    ? paragraph(strong('Full payload: '), code(attachmentName),
      text(' is attached (a redacted view: secrets are shown as [redacted]; the digest above is of the unredacted stored draft).'))
    : paragraph(strong('Full payload: '),
      text(`could not be attached (${attachmentError ?? 'unknown error'}). The summary above is generated from the stored draft.`));

  return doc(
    heading(3, `Draft v${version}: proposed automation rule`),
    paragraph(text('Written by the Automation Rule Builder app from the stored draft. '),
      strong('No rule exists yet.')),
    bulletList([
      [strong('Name: '), text(rule.name)],
      [strong('Project: '), text(projectLine(projectName, projectIdFromScope(scope)))],
      [strong('Project scope: '), code(scope)],
      ...(outline.issueTargets.length
        ? [[strong('Creates work items: '), text(outline.issueTargets.join('; '))]]
        : []),
      [strong('State on creation: '), text('DISABLED (a human enables it)')],
      [strong('Digest: '), code(digest)],
    ]),
    heading(4, 'What the rule does'),
    ...ruleBody(outline),
    ...renderStandIns(findStandIns(rule, stepPositions(rule, outline.steps))),
    attachmentLine,
    paragraph(text('Any member of the approver group can review this. Approve to have the agent create exactly this rule. Request Changes to have it revised. Reject to cancel.'))
  );
}

// The section's presence is the signal, so it is left out entirely when there
// is nothing to replace rather than shown empty.
function renderStandIns(standIns) {
  if (standIns.length === 0) return [];
  return [
    heading(4, 'Stand-ins to replace'),
    paragraph(strong('This rule stays DISABLED. Do not enable it until every item below is replaced in the Jira UI.')),
    bulletList(standIns.map(({ value, kind, where }) => [code(value), text(` (${kind}) in ${where}`)])),
  ];
}

/** The comment posted after the create action created the rule. */
export function renderCreatedComment(record, { message, selfApproved, manualStepRequired }) {
  return doc(
    heading(3, 'Rule created (DISABLED)'),
    paragraph(text(message)),
    bulletList([
      [strong('ruleUuid: '), code(record.ruleUuid)],
      [strong('Draft version: '), text(`v${record.version}`)],
      [strong('Digest: '), code(record.digest)],
      ...(selfApproved ? [[strong('Approval: '), text('self-approved (requester and approver are the same person)')]] : []),
    ]),
    ...(manualStepRequired ? [paragraph(strong('Before enabling: '), text(manualStepRequired))] : []),
    paragraph(text('Enable the rule manually in Project settings > Automation once it has been reviewed.'))
  );
}

// --- why a create failed ------------------------------------------------------

// Atlassian's text and error messages can quote a URL; keep only its safe parts.
const scrubUrls = (value) => String(value).replace(/https?:\/\/[^\s"'<>]+/gi, (url) => redactUrl(url));
const clip = (value, max = 300) => (value.length > max ? `${value.slice(0, max)}...` : value);

/**
 * Find the component an Atlassian field error is about, in words a person can
 * use. Errors name components like "component:__NEW__ACTION__<uuid>.url", and
 * on create that uuid is a fresh one Atlassian made up, NOT the id this app
 * sent (seen on the live SDP run). So an exact id match is used when there is
 * one, and otherwise every component of that kind that has that field is
 * listed as a candidate. The uuid itself is never shown: it appears nowhere a
 * human can look.
 */
function locateFieldError(field, rule, positions) {
  const match = /^component:(?:__NEW__([A-Z_]+?)__)?([^.]+)\.(.+)$/.exec(String(field ?? ''));
  if (!match) {
    return field ? `field "${String(field).replace(/__NEW__\w+?__[0-9a-f-]+/gi, 'a new component')}"` : 'no field named';
  }
  const [, kind, id, path] = match;
  const key = path.split(/[.[]/)[0];
  const nodes = [];
  walkRule(rule, (node) => nodes.push(node));

  const exact = nodes.find((node) => node.id === id);
  if (exact) return `field "${path}" on ${positions.get(exact)}`;
  const candidates = nodes.filter((node) =>
    (!kind || node.component === kind) && node.value && typeof node.value === 'object' && key in node.value);
  if (candidates.length === 1) return `field "${path}" on ${positions.get(candidates[0])}`;
  if (candidates.length > 1) {
    return `field "${path}" on one of: ${candidates.map((node) => positions.get(node)).join('; ')}`;
  }
  return `field "${path}" on ${kind ? `a component of kind ${kind}` : 'a component'} that could not be matched to the rule`;
}

/**
 * Turn a failed createAndVerifyRule result into what a human needs to act:
 *   what       - the HTTP status and Atlassian's own message
 *   where      - one line per field error, naming the component
 *   nextStep   - chosen from the failure, not a fixed sentence
 *   ruleExists - stated either way, because it decides whether a new request is safe
 * Pure: `rule` is the frozen draft that was sent, used only to name components.
 * Atlassian's text is quoted as data, URLs in it are redacted, and component
 * values are never echoed.
 */
export function explainCreateFailure(result, rule = {}) {
  const status = Number.isInteger(result?.status) ? result.status : null;
  const apiError = result?.apiError;
  const errors = Array.isArray(apiError?.errors) ? apiError.errors : [];
  const ruleUuid = typeof result?.ruleUuid === 'string' ? result.ruleUuid : null;
  const outcomeUnknown = result?.outcomeUnknown === true;

  const atlassianMessage = errors.length
    ? [...new Set(errors.map((entry) => entry?.title ?? entry?.message).filter(Boolean))].join('; ')
    : typeof apiError === 'string' ? apiError : apiError?.message ?? '';
  const what = scrubUrls(clip(status === null
    ? String(result?.error ?? 'unknown error')
    : `${result?.error ?? 'Jira refused the request.'} HTTP ${status}${atlassianMessage ? `: ${atlassianMessage}` : ''}`, 600));

  const positions = describeComponentPositions(rule);
  const where = errors.map((entry) =>
    scrubUrls(`${clip(String(entry?.title ?? entry?.message ?? 'Error'))}: ${locateFieldError(entry?.field, rule, positions)}`));

  let nextStep;
  if (ruleUuid) {
    nextStep =
      `The rule EXISTS in Jira and is DISABLED (ruleUuid ${ruleUuid}). Open it in Project settings > Automation ` +
      'and check it against the attached draft. Do NOT raise a new request for it: that would create a second copy.';
  } else if (outcomeUnknown) {
    nextStep =
      `It is not known whether the rule was created. Look in the project's automation rules for one named ` +
      `"${rule.name ?? 'this rule'}" before doing anything else, and raise a new request only if it is not there.`;
  } else if (status === 401 || status === 403) {
    nextStep =
      'Jira refused the app\'s own Automation API credentials (the AUTOMATION_API_EMAIL / AUTOMATION_API_TOKEN ' +
      'Forge variables), not the requester\'s permissions. Ask the app admin to fix them, then raise a new request.';
  } else if (status === 429 || (status !== null && status >= 500) || result?.networkError === true) {
    nextStep =
      'This looks temporary (Jira or the network failed, not the rule). Raise a new request with the same rule; ' +
      'if it fails the same way, ask the app admin to check the Forge logs.';
  } else if (status !== null && errors.length > 0) {
    nextStep =
      'Fix the field(s) named under Where in the request, then raise a new request. This ticket\'s draft cannot be ' +
      'created again.';
  } else if (status !== null) {
    nextStep =
      'Jira refused the rule without naming a field. Compare the attached draft with the component reference, ' +
      'fix the request and raise a new one.';
  } else {
    nextStep = 'The app refused the stored draft before sending it, for the reason above. Fix the request and raise a new one.';
  }

  const ruleInJira = ruleUuid
    ? `Yes: a DISABLED rule exists (ruleUuid ${ruleUuid}).`
    : outcomeUnknown
      ? 'Unknown: check before raising a new request.'
      : 'No: nothing was created, so a new request is safe.';

  return { what, where, nextStep, ruleExists: Boolean(ruleUuid), outcomeUnknown, ruleInJira };
}

/** The same explanation as one sentence block, for the agent to relay verbatim. */
export function summarizeCreateFailure(explanation) {
  const { what, where, nextStep, ruleExists, outcomeUnknown } = explanation;
  const opening = ruleExists
    ? 'The rule WAS created but could not be verified.'
    : outcomeUnknown ? 'It is not known whether the rule was created.' : 'No automation rule was created.';
  return [
    opening,
    `What failed: ${what}`,
    ...(where.length ? [`Where: ${where.join(' | ')}`] : []),
    `What to do: ${nextStep}`,
  ].join(' ');
}

// A plain string (an approval refusal) is shown as before; an explanation from
// explainCreateFailure gets What failed / Where / What to do / Rule in Jira.
function failureBody(reason) {
  if (typeof reason === 'string') return [paragraph(text(reason))];
  return [
    paragraph(strong('What failed: '), text(reason.what)),
    ...(reason.where.length ? [paragraph(strong('Where:')), bulletList(reason.where.map((line) => [text(line)]))] : []),
    paragraph(strong('What to do: '), text(reason.nextStep)),
    paragraph(strong('Rule in Jira: '), text(reason.ruleInJira)),
  ];
}

/** A comment explaining that nothing was created, and why. */
export function renderNotCreatedComment(reason) {
  return doc(heading(3, 'Rule NOT created'), ...failureBody(reason));
}

/** A comment for an outcome a human has to check (created but unverified, or unknown). */
export function renderAttentionComment(reason) {
  return doc(heading(3, 'Needs attention'), ...failureBody(reason));
}
