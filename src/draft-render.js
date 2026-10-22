import {
  AUTH_PLACEHOLDER, canonicalJson, describeComponentPositions, parseHttpUrl, redactSecrets, redactUrl, sha256, walkComponents,
} from './index.js';

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

const ISSUE_CREATING_ACTIONS = new Set(['jira.issue.create', 'jira.issue.clone']);

/**
 * Plain-language outline of a built rule: trigger, conditions, actions, and
 * where any create/clone action puts the new issue. That last one is listed
 * on its own because it is the one action that can reach OUTSIDE the rule's
 * project scope, so the approver must see it, not dig for it in the JSON.
 */
export function summarizeRule(rule) {
  const conditions = [];
  const actions = [];
  const issueTargets = [];
  walkComponents(rule.components ?? [], (node) => {
    if (node.component === 'CONDITION') conditions.push(node.type);
    if (node.component === 'ACTION') actions.push(node.type);
    if (node.component === 'ACTION' && ISSUE_CREATING_ACTIONS.has(node.type)) {
      const projectOperation = (node.value?.operations ?? []).find((op) => op?.field?.value === 'project');
      const target = projectOperation?.value;
      issueTargets.push(
        target?.type === 'ID' ? { action: node.type, projectId: String(target.value) }
          : target?.type === 'COPY' ? { action: node.type, projectId: null, sameAsTrigger: true }
            : { action: node.type, projectId: null }
      );
    }
  });
  return { trigger: rule.trigger?.type ?? 'none', conditions, actions, issueTargets };
}

// "project 10284 (OUTSIDE this rule's project)" etc., for the draft comment.
function describeIssueTarget(target, scope) {
  const scopeProjectId = /project\/(\d+)$/.exec(String(scope))?.[1];
  if (target.sameAsTrigger) return `${target.action}: same project as the trigger issue`;
  if (!target.projectId) return `${target.action}: project NOT SET (Jira decides; check the attached payload)`;
  return target.projectId === scopeProjectId
    ? `${target.action}: project ${target.projectId} (this rule's project)`
    : `${target.action}: project ${target.projectId}, OUTSIDE this rule's project ${scopeProjectId}`;
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
 */
export function findStandIns(rule) {
  const positions = describeComponentPositions(rule);
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

// A smart value that reads a web request's response, e.g.
// "{{webResponse.body.access_token}}" or "{{webhookResponse.status}}".
const WEB_RESPONSE_READ = /\{\{\s*(?:webResponse|webhookResponse)\b[^}]*\}\}/g;

/**
 * Every web-response read in a rule, grouped under the web request whose
 * response it actually gets: the most recent request before it that has run
 * (a later request overwrites the response).
 *
 * "Has run" is why this is not a plain rule-order walk. The branches of an
 * if/else group are exclusive, so a request in the accepted branch never
 * precedes a read in the rejected branch even though it is above it on the
 * page. Each branch therefore starts from the response the group was entered
 * with. After a group (or a lone if-block) in which a request was sent, which
 * response is live depends on the branch taken, and the group heading says so.
 *
 * The app cannot tell whether an accessor is right; the spec it would be
 * checked against never reaches the app. This makes the actual strings
 * visible so an approver who knows the rule can catch a wrong one.
 *
 * Returns { hasWebRequest, groups: [{ request, reads: [{ accessor, where: [] }] }] }.
 * `request` is null for reads before any request. Identical accessors in one
 * group are merged into one entry listing all their positions, so a long rule
 * stays short. A request's OWN value (e.g. its body) is read before it is sent,
 * so those reads count toward the previous request.
 */
export function findWebResponseReads(rule) {
  const positions = describeComponentPositions(rule);
  // `sent` marks a real request group, which is shown even with no reads (an
  // unread response is worth seeing too). The other groups show only if read.
  const startGroup = (request, sent) => {
    const group = { request, sent, reads: new Map() };
    groups.push(group);
    return group;
  };
  const groups = [];
  let current = startGroup(null, false);

  // Returns whether any request was sent within `nodes`.
  const visit = (nodes) => {
    let sentAny = false;
    for (const node of Array.isArray(nodes) ? nodes : []) {
      if (!node || typeof node !== 'object') continue;
      const where = positions.get(node) ?? 'the rule';
      for (const leaf of stringLeaves(node.value)) {
        for (const accessor of leaf.match(WEB_RESPONSE_READ) ?? []) {
          const places = current.reads.get(accessor) ?? [];
          if (!places.includes(where)) places.push(where);
          current.reads.set(accessor, places);
        }
      }
      if (node.component === 'ACTION' && node.type === 'jira.issue.outgoing.webhook') {
        current = startGroup(where, true);
        sentAny = true;
      }

      const entry = current;
      let sentInside = false;
      if (node.type === 'jira.condition.container.block') {
        for (const branch of Array.isArray(node.children) ? node.children : []) {
          current = entry;
          if (visit([branch])) sentInside = true;
        }
      } else {
        // Both walks must run, so no short-circuiting `||` here.
        const inConditions = visit(node.conditions);
        const inChildren = visit(node.children);
        sentInside = inConditions || inChildren;
      }
      if (node.type === 'jira.condition.container.block' || node.type === 'jira.condition.if.block') {
        current = sentInside
          ? startGroup(`whichever request ran last in ${where} (it depends on the branch taken)`, false)
          : entry;
      }
      sentAny = sentAny || sentInside;
    }
    return sentAny;
  };
  if (rule.trigger && typeof rule.trigger === 'object') visit([rule.trigger]);
  visit(rule.components);

  return {
    hasWebRequest: groups.some((group) => group.sent),
    groups: groups
      .filter((group) => group.sent || group.reads.size > 0)
      .map(({ request, reads }) => ({ request, reads: [...reads].map(([accessor, where]) => ({ accessor, where })) })),
  };
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

const listOrNone = (items) => (items.length ? items.join(', ') : 'none');

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
  const { rule, version, digest, scope, projectName } = record;
  const outline = summarizeRule(rule);

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
      [strong('Trigger: '), code(outline.trigger)],
      [strong('Conditions: '), text(listOrNone(outline.conditions))],
      [strong('Actions: '), text(listOrNone(outline.actions))],
      ...(outline.issueTargets.length
        ? [[strong('Creates issues in: '), text(outline.issueTargets.map((t) => describeIssueTarget(t, scope)).join('; '))]]
        : []),
      [strong('State on creation: '), text('DISABLED (a human enables it)')],
      [strong('Digest: '), code(digest)],
    ]),
    ...renderWebResponseReads(findWebResponseReads(rule)),
    ...renderStandIns(findStandIns(rule)),
    attachmentLine,
    paragraph(text('Any member of the approver group can review this. Approve to have the agent create exactly this rule. Request Changes to have it revised. Reject to cancel.'))
  );
}

// Shown on EVERY draft with a web request, not only when something looks wrong:
// the app cannot know what is wrong, and a section that appears only sometimes
// trains people to skim it. Accessors are code-marked text: data, not markup.
function renderWebResponseReads({ hasWebRequest, groups }) {
  if (!hasWebRequest) return [];
  return [
    heading(4, 'Web response reads'),
    paragraph(text('Each read gets the response of the web request it is listed under; a later request ' +
      'overwrites it. Check every accessor is exactly the one this rule needs (webResponse and ' +
      'webhookResponse are not interchangeable).')),
    ...groups.flatMap(({ request, reads }) => [
      paragraph(strong(request ? `After ${request}:` : 'Before any web request:')),
      reads.length
        ? bulletList(reads.map(({ accessor, where }) => [code(accessor), text(` in ${where.join('; ')}`)]))
        : paragraph(text('No reads of this response.')),
    ]),
  ];
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

/** A comment explaining that nothing was created, and why. */
export function renderNotCreatedComment(reason) {
  return doc(
    heading(3, 'Rule NOT created'),
    paragraph(text(reason))
  );
}

/** A comment for an outcome a human has to check (e.g. creation outcome unknown). */
export function renderAttentionComment(reason) {
  return doc(
    heading(3, 'Needs attention'),
    paragraph(text(reason))
  );
}
