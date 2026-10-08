import { prepareRule, redactSecrets } from './index.js';
import { readApprovalConfig } from './approval-config.js';
import { createDraftStore, DRAFT_STATES } from './draft-store.js';
import { createJiraClient } from './jira-client.js';
import { digestRule, renderDraftAttachment, renderDraftComment, withTicketPrefix } from './draft-render.js';

/**
 * The two Rovo actions the agent is allowed to call. NEITHER creates a rule.
 *
 *   draft-automation-rule         build + validate a rule, raise an approval
 *                                 ticket, freeze the payload in Forge storage
 *   revise-automation-rule-draft  replace the frozen draft after the manager
 *                                 chose "Request Changes", then resubmit
 *
 * Rules are created only by src/create-approved.js, which the agent calls
 * after a human approves, and which creates the draft frozen here.
 *
 * The real handlers at the bottom are built from createDraftActions() with
 * the real Forge clients. Tests call createDraftActions() with fakes, so no
 * Forge runtime is needed to test the logic.
 */
export function createDraftActions({
  jira = createJiraClient(),
  store = createDraftStore(),
  prepare = prepareRule,
  getEnv = () => process.env,
} = {}) {
  return {
    /**
     * Rovo action `draft-automation-rule`.
     * Inputs: `ruleSpec` (JSON string, same contract as before), an
     * optional `requestSummary` (the agent's plain-language description,
     * shown on the ticket and clearly labelled as the agent's words) and an
     * optional `approverAccountId` (who the ticket is assigned to).
     */
    async draftAutomationRule(payload, invocationContext) {
      const configResult = readApprovalConfig(getEnv());
      if (!configResult.ok) return draftFailure(configResult.error);
      const { config } = configResult;

      // 0. Decide who the ticket is assigned to, BEFORE anything is created,
      //    so a bad approver never leaves a half-made ticket behind.
      const routing = chooseApprover(payload?.approverAccountId, config.approverAccountIds);
      if (!routing.ok) return draftFailure(routing.error);
      const approverAccountId = routing.accountId;

      // 1. Build and validate. Nothing is created; the only network call is
      //    the read-only field-metadata lookup.
      const prepared = await prepare(payload);
      if (!prepared.ok) return draftFailure(prepared.error, { details: prepared });

      // 2. Raise the approval ticket AS THE USER, so they are the reporter.
      let issue;
      try {
        issue = await jira.createIssue({
          project: { key: config.projectKey },
          issuetype: { id: config.issueTypeId },
          summary: truncate(`Automation rule request: ${prepared.rule.name}`, 250),
          description: describeRequest(payload?.requestSummary),
          // Set in the same request (not a separate assign call afterwards)
          // so the Teams "Issue created" rule already sees the assignee.
          ...(approverAccountId ? { assignee: { accountId: approverAccountId } } : {}),
        });
      } catch (error) {
        return draftFailure(`The approval ticket could not be created: ${error.message}`);
      }

      // 3. Freeze the exact payload. The name carries the ticket key so a
      //    created rule can always be traced back to its approval.
      const rule = withTicketPrefix(prepared.rule, issue.key);
      const record = {
        issueId: String(issue.id),
        issueKey: issue.key,
        version: 1,
        state: DRAFT_STATES.PENDING,
        rule,
        scope: prepared.scope,
        digest: digestRule(rule),
        // Where Rovo puts the invoking user's accountId is still open (spike
        // S1): the docs say the handler's second argument carries
        // `principal.accountId`. Both places are checked. null is fine: the
        // create action falls back to the ticket's reporter.
        requesterAccountId:
          invocationContext?.principal?.accountId ?? payload?.context?.accountId ?? null,
        // Audit only: who the ticket was sent to. Nothing reads this to decide
        // anything; the create action checks Jira's changelog instead.
        approverAccountId,
        history: [],
      };
      record.history.push({ version: 1, digest: record.digest, state: record.state, at: new Date().toISOString() });

      try {
        await store.saveDraft(record);
      } catch (error) {
        // The ticket exists but has no draft behind it. The create action
        // refuses to create anything for a ticket with no stored draft, so
        // this is safe; the user is told which ticket to discard.
        return draftFailure(
          `Approval ticket ${issue.key} was created, but the draft could not be stored: ${error.message}. ` +
            `Reject ${issue.key} and ask again.`,
          { issueKey: issue.key }
        );
      }

      // 4. Show the manager the code-rendered draft: the JSON as an attached
      //    file, then a comment summarising it. If either fails the draft is
      //    still stored correctly, so say so rather than failing.
      const warning = await postDraftArtifacts(jira, issue.key, record);

      return {
        ok: true,
        ruleCreated: false,
        draftSubmitted: true,
        issueKey: issue.key,
        version: 1,
        digest: record.digest,
        assignedTo: approverAccountId,
        ...(warning ? { warning } : {}),
        // Rendered by code. The agent should relay this, not paraphrase it.
        message:
          `Draft v1 of "${rule.name}" was submitted for approval as ${issue.key}` +
          (approverAccountId
            ? ` and assigned to approver ${approverAccountId}. `
            : ', unassigned: assign it to an approver so they are notified. ') +
          'No automation rule has been created. It can be created, DISABLED, only after ' +
          `${issue.key} is approved.`,
      };
    },

    /**
     * Rovo action `revise-automation-rule-draft`.
     * Inputs: `issueKey` (the approval ticket) and `ruleSpec` (the revised
     * spec). Usually called by the agent when a Jira automation rule runs it
     * after the manager picked "Request Changes", so there may be no user
     * present; every Jira call here is made as the app.
     */
    async reviseAutomationRuleDraft(payload) {
      const configResult = readApprovalConfig(getEnv());
      if (!configResult.ok) return draftFailure(configResult.error);
      const { config } = configResult;

      const issueKey = typeof payload?.issueKey === 'string' ? payload.issueKey.trim() : '';
      if (issueKey === '') return draftFailure('Provide issueKey, the approval ticket to revise.');

      // The live ticket is the authority on whether the manager asked for
      // changes (see the note in draft-store.js on why this is not stored).
      let issue;
      try {
        issue = await jira.getIssue(issueKey);
      } catch (error) {
        return draftFailure(`Approval ticket ${issueKey} could not be read: ${error.message}`);
      }
      // Only approval tickets: refuse an arbitrary issue key from the agent.
      if (issue?.fields?.project?.key !== config.projectKey) {
        return draftFailure(`${issueKey} is not an approval ticket in project ${config.projectKey}.`);
      }
      if (String(issue?.fields?.status?.id) !== config.changesRequestedStatusId) {
        return draftFailure(
          `${issueKey} is in status "${issue?.fields?.status?.name ?? 'unknown'}". ` +
            'A draft can only be revised after the manager chooses Request Changes.'
        );
      }

      const existing = await store.getDraft(String(issue.id));
      if (!existing) return draftFailure(`No stored draft exists for ${issueKey}.`);
      if (existing.state !== DRAFT_STATES.PENDING) {
        return draftFailure(`The draft for ${issueKey} is ${existing.state} and can no longer be revised.`);
      }

      const prepared = await prepare(payload);
      if (!prepared.ok) return draftFailure(prepared.error, { details: prepared, issueKey });

      const rule = withTicketPrefix(prepared.rule, issue.key);
      const version = existing.version + 1;
      // Save BEFORE moving the ticket back to Pending Approval, so by the time
      // the manager can approve, the stored draft is already the new version.
      const updated = await store.applyEvent(existing, 'revise', {
        rule,
        scope: prepared.scope,
        digest: digestRule(rule),
        version,
      });
      if (!updated) return draftFailure(`The draft for ${issueKey} could not be revised.`);

      const warning = await postDraftArtifacts(jira, issue.key, updated);

      try {
        await jira.transitionIssue(issue.key, config.resubmitTransitionId);
      } catch (error) {
        return draftFailure(
          `Draft v${version} was stored, but ${issue.key} could not be moved back to Pending Approval: ` +
            `${error.message}. Use the Resubmit transition on the ticket manually.`,
          { issueKey: issue.key, version, draftStored: true }
        );
      }

      return {
        ok: true,
        ruleCreated: false,
        draftSubmitted: true,
        issueKey: issue.key,
        version,
        digest: updated.digest,
        ...(warning ? { warning } : {}),
        message:
          `Draft v${version} of "${rule.name}" replaced the previous draft on ${issue.key} and was ` +
          'resubmitted for approval. No automation rule has been created.',
      };
    },
  };
}

// --- helpers ----------------------------------------------------------------

/**
 * Failure shape for the draft actions. `ruleCreated: false` and
 * `draftSubmitted: false` are stated explicitly so the agent has nothing to
 * infer, and `summary` is the sentence it should relay.
 */
function draftFailure(message, extra = {}) {
  const safeExtra = redactSecrets(extra);
  console.error(`[drafts] ${message}`);
  return {
    ok: false,
    ruleCreated: false,
    draftSubmitted: false,
    error: message,
    summary: `No automation rule was created. ${message}`,
    ...safeExtra,
  };
}

/**
 * Attach the redacted draft JSON to the ticket, then post the "Draft vN"
 * comment that names the file. The attachment goes first so the comment can
 * say truthfully whether it is there.
 *
 * Neither step is allowed to fail the action: the draft is already stored,
 * and the comment's summary is enough for the manager to decide on. Problems
 * come back as one warning string (or null when both worked).
 */
async function postDraftArtifacts(jira, issueKey, record) {
  const warnings = [];
  const attachment = renderDraftAttachment(record);
  let attachmentName = null;
  let attachmentError = null;
  try {
    await jira.addAttachment(issueKey, attachment.filename, attachment.text);
    attachmentName = attachment.filename;
  } catch (error) {
    attachmentError = error.message;
    console.error(`[drafts] attachment on ${issueKey} failed: ${error.message}`);
    warnings.push(`the draft JSON could not be attached (${error.message})`);
  }
  try {
    await jira.addComment(issueKey, renderDraftComment(record, { attachmentName, attachmentError }));
  } catch (error) {
    console.error(`[drafts] comment on ${issueKey} failed: ${error.message}`);
    warnings.push(`the draft comment could not be posted (${error.message})`);
  }
  return warnings.length
    ? `The draft was stored, but on ${issueKey} ${warnings.join(' and ')}.`
    : null;
}

/**
 * Who to assign the approval ticket to.
 *
 * The agent finds the manager's account ID with Rovo's Jira user search, so
 * the value is the agent's word: it is accepted only if it is on
 * APPROVER_ACCOUNT_IDS. With no value and exactly one approver configured,
 * that approver is used; with several, the ticket is left unassigned rather
 * than guessing. Being the assignee grants nothing: the create action
 * authorises from the changelog, not from this.
 */
function chooseApprover(requested, approverAccountIds) {
  const accountId = typeof requested === 'string' ? requested.trim() : '';
  if (accountId === '') {
    return { ok: true, accountId: approverAccountIds.length === 1 ? approverAccountIds[0] : null };
  }
  if (!approverAccountIds.includes(accountId)) {
    // Deliberately does not list the allowed IDs back to the agent.
    return {
      ok: false,
      error:
        `Account ${accountId} is not an allowed approver, so no approval ticket was raised. ` +
        'Ask the user to confirm their approver, or ask a Jira admin to add them to APPROVER_ACCOUNT_IDS.',
    };
  }
  return { ok: true, accountId };
}

/** Ticket description: the agent's summary, labelled as such. */
function describeRequest(requestSummary) {
  const summary = typeof requestSummary === 'string' && requestSummary.trim() !== ''
    ? truncate(requestSummary.trim(), 5000)
    : '(no summary supplied)';
  return {
    type: 'doc',
    version: 1,
    content: [
      { type: 'paragraph', content: [{ type: 'text', text: 'Request as described by the agent (not authoritative):', marks: [{ type: 'strong' }] }] },
      { type: 'paragraph', content: [{ type: 'text', text: summary }] },
      { type: 'paragraph', content: [{ type: 'text', text: 'The authoritative draft is the latest "Draft vN" comment, written by the app.' }] },
    ],
  };
}

function truncate(value, max) {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

// --- Forge handlers (referenced from manifest.yml) --------------------------
// Built lazily on first call so importing this module (e.g. in tests) never
// touches the Forge runtime.
let defaultActions;
const actions = () => (defaultActions ??= createDraftActions());

export const draftAutomationRule = (payload, context) => actions().draftAutomationRule(payload, context);
export const reviseAutomationRuleDraft = (payload) => actions().reviseAutomationRuleDraft(payload);
