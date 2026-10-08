import { createAndVerifyRule } from './index.js';
import { readApprovalConfig } from './approval-config.js';
import { createDraftStore, DRAFT_STATES } from './draft-store.js';
import { createJiraClient } from './jira-client.js';
import { renderAttentionComment, renderCreatedComment, renderNotCreatedComment } from './draft-render.js';

/**
 * Rovo action `create-approved-automation-rule`. THE ONLY CODE PATH THAT
 * CREATES AN AUTOMATION RULE.
 *
 * The agent calls this, usually because a Jira automation rule woke it when
 * the approval ticket moved to Approved, or because a user asked in chat. The
 * agent "presses the button" but cannot choose WHAT is created:
 *
 *   - The only input is the approval ticket's key. There is no rule content
 *     in the input, so nothing the agent writes reaches the Automation API.
 *   - What gets created is the draft frozen in Forge storage when the
 *     manager reviewed it, exactly as stored.
 *
 * WHO IS ALLOWED TO PRESS THE BUTTON
 * Anyone, including a headless automation run with no user. The approval is
 * the authorisation, so the checks are about the ticket, not the caller:
 *
 *   1. The ticket is in the approval project and its LIVE status is Approved.
 *   2. Jira's own changelog says who made the latest move to Approved, and
 *      that person is in APPROVER_ACCOUNT_IDS. (The workflow should already
 *      limit the Approve button to approvers; this check still holds if that
 *      workflow condition is removed or the workflow is copied without it.)
 *   3. That approval happened AFTER the stored draft's latest version was
 *      saved, so the manager approved the version that will be created.
 *
 * WHY THE CLAIM STILL MATTERS
 * Agents retry tool calls readily, and the automation rule and a user in chat
 * may both ask at the same time. The atomic claim (draftStore.claimCreation)
 * lets exactly one call reach the POST; every later call is answered from the
 * stored outcome instead of creating a second rule.
 *
 * COMMENTS ON THE TICKET
 * Only outcomes are commented (created, not created, needs attention). A call
 * that is simply refused, e.g. "not approved yet", changes nothing and posts
 * nothing, so an agent that retries cannot flood the ticket.
 *
 * Tests build this with createApprovedRuleActions() and fakes; the real
 * handler at the bottom uses the real Forge clients.
 */
export function createApprovedRuleActions({
  jira = createJiraClient(),
  store = createDraftStore(),
  create = createAndVerifyRule,
  getEnv = () => process.env,
} = {}) {
  return {
    async createApprovedAutomationRule(payload) {
      const configResult = readApprovalConfig(getEnv());
      if (!configResult.ok) return refused(configResult.error);
      const { config } = configResult;

      const issueKey = typeof payload?.issueKey === 'string' ? payload.issueKey.trim() : '';
      if (issueKey === '') return refused('Provide issueKey, the approval ticket whose rule should be created.');

      // --- 1. The live ticket must be an approved approval ticket ----------
      let issue;
      try {
        issue = await jira.getIssue(issueKey);
      } catch (error) {
        return refused(`Approval ticket ${issueKey} could not be read: ${error.message}`);
      }
      if (issue?.fields?.project?.key !== config.projectKey) {
        return refused(`${issueKey} is not an approval ticket in project ${config.projectKey}.`);
      }
      if (String(issue?.fields?.status?.id) !== config.approvedStatusId) {
        return refused(
          `${issueKey} is in status "${issue?.fields?.status?.name ?? 'unknown'}", not Approved. ` +
            'A rule can only be created after an approver approves the ticket.'
        );
      }
      const issueId = String(issue.id);

      // --- 2. There must be an open draft to create -------------------------
      let draft;
      try {
        draft = await store.getDraft(issueId);
      } catch (error) {
        // Nothing has been claimed or created yet, so a retry is safe.
        return refused(`The stored draft for ${issueKey} could not be read (${error.message}). Try again shortly.`);
      }
      if (!draft) {
        return refused(`No stored draft exists for ${issueKey}, so there is nothing to create. Ask for a new draft.`);
      }
      if (draft.state !== DRAFT_STATES.PENDING) return answerFromStoredOutcome(issueKey, draft);

      // --- 3. Jira's changelog must show a valid, current approval ----------
      let approval;
      try {
        approval = latestApproval(await jira.getChangelog(issueKey), config.approvedStatusId);
      } catch (error) {
        return refused(`The history of ${issueKey} could not be read (${error.message}). Try again shortly.`);
      }

      const approvalProblem = checkApproval(approval, draft, config, issueKey);
      if (approvalProblem) {
        // A real finding, not a transient error: record it so later calls are
        // answered from storage, and tell the humans on the ticket.
        await saveQuietly(() => store.applyEvent(draft, 'fail', { lastError: approvalProblem }), issueKey);
        await comment(jira, issueKey, renderNotCreatedComment(approvalProblem));
        return notCreated(approvalProblem, { issueKey });
      }
      const approverAccountId = approval.author.accountId;
      console.log(`[create-approved] ${issueKey} approved by ${approverAccountId}; creating draft v${draft.version}`);

      // --- 4. THE CLAIM. Exactly one call ever gets past this line. ---------
      const claimed = await store.claimCreation(issueId);
      if (!claimed) {
        // Another call won (or an earlier one was interrupted). Do NOT create.
        return notCreated(
          `Another creation attempt for ${issueKey} is already running or was interrupted. ` +
            `Check ${issueKey} for a "Rule created" comment, and the project's automation rules for one ` +
            `named "${draft.rule.name}". This app will not create it again.`,
          { issueKey }
        );
      }

      let creating;
      try {
        creating = await store.applyEvent(draft, 'approve');
      } catch (error) {
        // The claim is held but nothing was POSTed. A retry is impossible (the
        // claim exists), so hand this to a human rather than risk anything.
        const reason =
          `${issueKey} is approved, but the draft could not be marked as being created ` +
          `(${error.message}). Nothing was created. Raise a new request.`;
        await comment(jira, issueKey, renderAttentionComment(reason));
        return notCreated(reason, { issueKey });
      }

      // --- 5. Create the frozen rule, DISABLED, and verify it ---------------
      let result;
      try {
        result = await create(creating);
      } catch (error) {
        // createAndVerifyRule reports failures as values; a throw here means
        // the outcome is genuinely unknown.
        result = { ok: false, error: error.message, summary: `Creation outcome unknown: ${error.message}` };
      }

      if (result.ok) {
        const created = await saveQuietly(
          () => store.applyEvent(creating, 'created', { ruleUuid: result.ruleUuid }),
          issueKey
        ) ?? { ...creating, ruleUuid: result.ruleUuid };
        const requester = draft.requesterAccountId ?? issue?.fields?.reporter?.accountId ?? null;
        await comment(jira, issueKey, renderCreatedComment(created, {
          message: result.message,
          selfApproved: requester !== null && requester === approverAccountId,
          manualStepRequired: result.manualStepRequired,
        }));
        return {
          ok: true,
          ruleCreated: true,
          issueKey,
          ruleUuid: result.ruleUuid,
          version: created.version,
          digest: created.digest,
          ...(result.manualStepRequired ? { manualStepRequired: result.manualStepRequired } : {}),
          // Rendered by code. The agent relays this, it does not paraphrase it.
          message: `${result.message} It was approved on ${issueKey} and stays DISABLED until someone enables it.`,
        };
      }

      // createAndVerifyRule includes ruleUuid only when the rule DOES exist
      // (created but not verified); say so plainly in that case.
      const summary = result.summary ?? result.error;
      await saveQuietly(
        () => store.applyEvent(creating, 'fail', { lastError: summary, ruleUuid: result.ruleUuid }),
        issueKey
      );
      const ruleExists = typeof result.ruleUuid === 'string';
      await comment(jira, issueKey, ruleExists ? renderAttentionComment(summary) : renderNotCreatedComment(summary));
      return {
        ok: false,
        // A rule that exists but failed verification IS created; say so, and
        // say it was not verified, rather than letting the agent guess.
        ruleCreated: ruleExists,
        issueKey,
        ...(ruleExists ? { ruleUuid: result.ruleUuid, verified: false } : {}),
        error: result.error,
        summary,
      };
    },
  };
}

// --- approval checks ----------------------------------------------------------

/**
 * The most recent changelog entry that moved the ticket INTO the Approved
 * status, or null. "Most recent" matters: a ticket can be approved, sent back
 * through Request Changes and approved again, and only the last approval
 * speaks for the current draft. Jira returns entries oldest first, but the
 * entries are compared by timestamp so their order never matters.
 */
export function latestApproval(entries, approvedStatusId) {
  let latest = null;
  for (const entry of entries ?? []) {
    const movedToApproved = (entry?.items ?? []).some(
      (item) => (item?.fieldId ?? item?.field) === 'status' && String(item?.to) === approvedStatusId
    );
    if (!movedToApproved) continue;
    if (latest === null || Date.parse(entry.created) >= Date.parse(latest.created)) latest = entry;
  }
  return latest;
}

/** Returns why the approval is not valid for this draft, or null if it is. */
function checkApproval(approval, draft, config, issueKey) {
  if (!approval) {
    return `The history of ${issueKey} shows no move to Approved, so the approval cannot be verified. Nothing was created.`;
  }
  const approver = approval.author?.accountId ?? null;
  if (!approver || !config.approverAccountIds.includes(approver)) {
    return (
      `${issueKey} was moved to Approved by an account that is not in APPROVER_ACCOUNT_IDS ` +
      `(${approver ?? 'unknown'}). Nothing was created. Ask an approver to raise a new request.`
    );
  }
  // The draft's last history entry is when its current version was stored.
  // An approval at or before that moment approved an earlier version.
  const storedAt = draft.history?.at(-1)?.at;
  const approvedAt = Date.parse(approval.created);
  const draftAt = Date.parse(storedAt ?? '');
  if (!Number.isFinite(approvedAt) || !Number.isFinite(draftAt) || approvedAt <= draftAt) {
    return (
      `${issueKey} was approved at ${approval.created ?? 'an unknown time'}, which is not after draft ` +
      `v${draft.version} was stored (${storedAt ?? 'unknown'}). The approval may be for an earlier ` +
      'version, so nothing was created. Raise a new request.'
    );
  }
  return null;
}

/**
 * Answer a call for a draft that is no longer open, from what is stored. This
 * is what makes agent retries safe AND truthful: a second call after success
 * reports the same rule instead of creating another or claiming failure.
 */
function answerFromStoredOutcome(issueKey, draft) {
  if (draft.state === DRAFT_STATES.CREATED) {
    return {
      ok: true,
      ruleCreated: true,
      alreadyCreated: true,
      issueKey,
      ruleUuid: draft.ruleUuid,
      version: draft.version,
      digest: draft.digest,
      message:
        `The rule for ${issueKey} was already created (ruleUuid ${draft.ruleUuid}) and is DISABLED. ` +
        'No new rule was created.',
    };
  }
  if (draft.state === DRAFT_STATES.CREATING) {
    return notCreated(
      `Creation of the rule for ${issueKey} is in progress or was interrupted. Check ${issueKey} ` +
        'for a "Rule created" comment before doing anything else. This app will not create it again.',
      { issueKey }
    );
  }
  return notCreated(
    `The draft for ${issueKey} is ${draft.state}${draft.lastError ? `: ${draft.lastError}` : '.'}`,
    { issueKey }
  );
}

// --- helpers ------------------------------------------------------------------

/** A refusal before anything was attempted. Nothing changes, nothing is posted. */
function refused(message) {
  console.warn(`[create-approved] refused: ${message}`);
  return { ok: false, ruleCreated: false, error: message, summary: `No automation rule was created. ${message}` };
}

/** A definite "not created" outcome after the checks ran. */
function notCreated(message, extra = {}) {
  console.error(`[create-approved] ${message}`);
  return { ok: false, ruleCreated: false, error: message, summary: `No automation rule was created. ${message}`, ...extra };
}

/** Post a comment; a failure is logged, never thrown (the outcome stands). */
async function comment(jira, issueKey, adfBody) {
  try {
    await jira.addComment(issueKey, adfBody);
  } catch (error) {
    console.error(`[create-approved] comment on ${issueKey} failed: ${error.message}`);
  }
}

/** Run a storage write; log and return null on failure instead of throwing. */
async function saveQuietly(write, issueKey) {
  try {
    return await write();
  } catch (error) {
    console.error(`[create-approved] storage write for ${issueKey} failed: ${error.message}`);
    return null;
  }
}

// --- Forge handler (referenced from manifest.yml) ---------------------------
// Built lazily on first call so importing this module (e.g. in tests) never
// touches the Forge runtime.
let defaultActions;
export const createApprovedAutomationRule = (payload) =>
  (defaultActions ??= createApprovedRuleActions()).createApprovedAutomationRule(payload);
