import { canonicalJson, sha256, redactSecrets, walkComponents } from './index.js';

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

/** Plain-language outline of a built rule: trigger, conditions, actions. */
export function summarizeRule(rule) {
  const conditions = [];
  const actions = [];
  walkComponents(rule.components ?? [], (node) => {
    if (node.component === 'CONDITION') conditions.push(node.type);
    if (node.component === 'ACTION') actions.push(node.type);
  });
  return { trigger: rule.trigger?.type ?? 'none', conditions, actions };
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
  const { rule, version, digest, scope } = record;
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
      [strong('Project scope: '), code(scope)],
      [strong('Trigger: '), code(outline.trigger)],
      [strong('Conditions: '), text(listOrNone(outline.conditions))],
      [strong('Actions: '), text(listOrNone(outline.actions))],
      [strong('State on creation: '), text('DISABLED (a human enables it)')],
      [strong('Digest: '), code(digest)],
    ]),
    attachmentLine,
    paragraph(text('Any member of the approver group can review this. Approve to have the agent create exactly this rule. Request Changes to have it revised. Reject to cancel.'))
  );
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
