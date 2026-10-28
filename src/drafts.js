import { prepareRule, redactSecrets } from './index.js';
import { findTransitionId, resolveApprovalConfig } from './approval-config.js';
import { createDraftStore, DRAFT_STATES } from './draft-store.js';
import { createJiraClient } from './jira-client.js';
import {
  digestRule, projectIdFromScope, projectLine, renderDraftAttachment, renderDraftComment, withTicketPrefix,
} from './draft-render.js';
import { createReadyMarker } from './mark-request-ready.js';

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
  // Marks the new ticket ready for the manager's Teams heads-up. Injected so
  // tests can stub it; see src/mark-request-ready.js.
  markReady = createReadyMarker({ jira, getEnv }).markRequestReady,
} = {}) {
  return {
    /**
     * Rovo action `draft-automation-rule`.
     * Inputs: `ruleSpec` (JSON string, same contract as before),
     * `requestText` (REQUIRED: the requester's message, as sent; it goes on
     * the ticket for the manager and is checked for words that describe more
     * than one case, see prepareRule), an optional `requestSummary` (the agent's plain-language description,
     * shown on the ticket and clearly labelled as the agent's words).
     * No assignee is sent, so Jira's project default assignee applies.
     * Approvers are the members of the approver group, and any of them may
     * pick the ticket up.
     */
    async draftAutomationRule(payload, invocationContext) {
      // The agent writes this field, so it proves nothing about what the
      // requester said. It is an audit trail for the manager, and the input to
      // the branch-word check. Never logged: it is free text from a person.
      const requestText = typeof payload?.requestText === 'string' ? payload.requestText.trim() : '';
      if (requestText === '') {
        return draftFailure(
          "The requester's message was not provided. Send it exactly as the requester wrote it in " +
            'requestText; if there is no message to send, ask the requester what they want first.'
        );
      }

      const configResult = await resolveApprovalConfig(jira, getEnv());
      if (!configResult.ok) return draftFailure(configResult.error);
      const { config } = configResult;

      // 1. Build and validate. Nothing is created; the only network calls are
      //    read-only lookups (fields, project, and the trigger's statuses).
      const prepared = await prepare({ ...payload, requestText });
      if (!prepared.ok) return draftFailure(prepared.error, { details: prepared });
      const projectId = projectIdFromScope(prepared.scope);
      const projectName = prepared.projectName ?? null;
      const statusCheck = await checkStatusNames(jira, prepared.rule, projectId);
      if (!statusCheck.ok) return draftFailure(statusCheck.error);

      // 2. Raise the approval ticket AS THE USER, so they are the reporter.
      let issue;
      try {
        issue = await jira.createIssue({
          project: { key: config.projectKey },
          issuetype: { id: config.issueTypeId },
          summary: truncate(`Automation rule request: ${prepared.rule.name}`, 250),
          description: describeRequest({ projectName, projectId, requestText, requestSummary: payload?.requestSummary }),
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
        projectName,
        // Kept so a revision is checked against the same words (the revise
        // call is headless and carries no request text of its own).
        requestText,
        // Where Rovo puts the invoking user's accountId is still open (spike
        // S1): the docs say the handler's second argument carries
        // `principal.accountId`. Both places are checked. null is fine: the
        // create action falls back to the ticket's reporter.
        requesterAccountId:
          invocationContext?.principal?.accountId ?? payload?.context?.accountId ?? null,
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

      // 5. Now the ticket exists and the draft is attached: mark it ready so
      //    the manager gets the Teams heads-up. Only first submissions are
      //    marked; a revision keeps the labels and sends nothing new.
      const readyForReview = await markReady(issue.key, config.projectKey, { projectName, projectId });

      return {
        ok: true,
        ruleCreated: false,
        draftSubmitted: true,
        issueKey: issue.key,
        version: 1,
        digest: record.digest,
        ...(warning ? { warning } : {}),
        readyForReview,
        // Rendered by code. The agent should relay this, not paraphrase it.
        message:
          `Draft v1 of "${rule.name}" was submitted for approval as ${issue.key}. ` +
          'No automation rule has been created. It can be created, DISABLED, only after ' +
          `${issue.key} is approved. ${describeReadiness(issue.key, readyForReview)}`,
      };
    },

    /**
     * Rovo action `revise-automation-rule-draft`.
     * Inputs: `issueKey` (the approval ticket) and `ruleSpec` (the revised
     * spec). It takes no requestText: the original is stored with the draft
     * and reused, so a headless revision cannot drop or rewrite it. Usually called by the agent when a Jira automation rule runs it
     * after the manager picked "Request Changes", so there may be no user
     * present; every Jira call here is made as the app.
     */
    async reviseAutomationRuleDraft(payload) {
      const configResult = await resolveApprovalConfig(jira, getEnv());
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

      const prepared = await prepare({ ...payload, requestText: existing.requestText });
      if (!prepared.ok) return draftFailure(prepared.error, { details: prepared, issueKey });
      const statusCheck = await checkStatusNames(jira, prepared.rule, projectIdFromScope(prepared.scope));
      if (!statusCheck.ok) return draftFailure(statusCheck.error, { issueKey });

      const rule = withTicketPrefix(prepared.rule, issue.key);
      const version = existing.version + 1;
      // Save BEFORE moving the ticket back to Pending, so by the time
      // the manager can approve, the stored draft is already the new version.
      const updated = await store.applyEvent(existing, 'revise', {
        rule,
        scope: prepared.scope,
        projectName: prepared.projectName ?? null,
        digest: digestRule(rule),
        version,
      });
      if (!updated) return draftFailure(`The draft for ${issueKey} could not be revised.`);

      const warning = await postDraftArtifacts(jira, issue.key, updated);

      try {
        // Transitions depend on the ticket's current status, so the resubmit
        // transition is looked up by name on the ticket itself.
        const transition = findTransitionId(
          await jira.getTransitions(issue.key),
          config.resubmitTransitionName,
          issue.key
        );
        if (!transition.ok) throw new Error(transition.error);
        await jira.transitionIssue(issue.key, transition.id);
      } catch (error) {
        return draftFailure(
          `Draft v${version} was stored, but ${issue.key} could not be moved back to Pending: ` +
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

// How many status names a refusal lists. The agent picks from them, so a
// short list of real options helps more than a whole workflow dump.
const STATUS_ERROR_CANDIDATE_LIMIT = 10;

/**
 * Check the status names on a transitioned trigger against the target
 * project's workflow. Jira accepts any name at create time, and a name that
 * matches no status makes a rule that never fires, with no error anywhere.
 * So an unknown name is refused here, before a ticket is raised, naming the
 * real statuses so the agent can resend the spec.
 *
 * Names must match exactly. A case-only difference is refused too, with the
 * real name suggested: correcting it silently would freeze a draft that
 * differs from the one the agent sent.
 */
async function checkStatusNames(jira, rule, projectId) {
  const value = rule?.trigger?.value ?? {};
  const wanted = ['fromStatus', 'toStatus'].flatMap((field) =>
    (Array.isArray(value[field]) ? value[field] : []).map((ref) => ({ field, name: ref?.value }))
  );
  // No filter (or any other trigger): nothing to check, so no extra call.
  if (wanted.length === 0) return { ok: true };

  let issueTypes;
  try {
    issueTypes = await jira.getProjectStatuses(projectId);
  } catch (error) {
    return { ok: false, error: `The statuses of project ${projectId} could not be read: ${error.message}` };
  }
  // The same status shows up under every issue type that uses it; list it once.
  const known = [...new Set(
    (Array.isArray(issueTypes) ? issueTypes : []).flatMap((type) =>
      (Array.isArray(type?.statuses) ? type.statuses : []).map((status) => status?.name)
    ).filter((name) => typeof name === 'string')
  )];

  const problems = wanted
    .filter(({ name }) => !known.includes(name))
    .map(({ field, name }) => {
      const nearMatch = known.find((candidate) => candidate.toLowerCase() === String(name).toLowerCase());
      return `trigger.${field} has "${name}"${nearMatch ? ` (did you mean "${nearMatch}"?)` : ''}`;
    });
  if (problems.length === 0) return { ok: true };

  const listed = known.slice(0, STATUS_ERROR_CANDIDATE_LIMIT).map((name) => `"${name}"`).join(', ');
  const more = known.length > STATUS_ERROR_CANDIDATE_LIMIT ? `, and ${known.length - STATUS_ERROR_CANDIDATE_LIMIT} more` : '';
  return {
    ok: false,
    error:
      `${problems.join('; ')}, but project ${projectId} has no status with that exact name. ` +
      `Its statuses are: ${listed}${more}. Send the names exactly as listed.`,
  };
}

/**
 * The sentence about the manager's heads-up, rendered by code so the agent
 * cannot overstate it. "Accepted by the flow" is the most this app can know;
 * whether Teams showed the card is only visible in Power Automate.
 */
function describeReadiness(issueKey, ready) {
  if (ready?.marked || ready?.alreadyMarked) {
    return 'It is marked ready for review; the manager heads-up was handed to the notification flow ' +
      "(delivery to Teams can't be confirmed here).";
  }
  const reason = `It could NOT be marked ready for review (${ready?.error ?? 'unknown error'}).`;
  return ready?.notificationSent
    ? `${reason} A heads-up may already have been sent; check with the approver about ${issueKey}.`
    : `${reason} No heads-up was triggered: tell the approver about ${issueKey}.`;
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
 * Ticket description. The target project comes first, above everything the
 * agent wrote, because it is the one thing the app cannot check against the
 * conversation: the manager is the last point where a wrong project is free to
 * fix. Then the requester's message as the agent sent it, then the agent's
 * summary, each labelled as such.
 */
function describeRequest({ projectName, projectId, requestText, requestSummary }) {
  const summary = typeof requestSummary === 'string' && requestSummary.trim() !== ''
    ? truncate(requestSummary.trim(), 5000)
    : '(no summary supplied)';
  return {
    type: 'doc',
    version: 1,
    content: [
      { type: 'paragraph', content: [
        { type: 'text', text: 'Target project: ', marks: [{ type: 'strong' }] },
        { type: 'text', text: projectLine(projectName, projectId) },
      ] },
      { type: 'paragraph', content: [{ type: 'text', text: "Requester's message, as sent by the agent (not verified):", marks: [{ type: 'strong' }] }] },
      { type: 'paragraph', content: [{ type: 'text', text: truncate(requestText, 10000) }] },
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
