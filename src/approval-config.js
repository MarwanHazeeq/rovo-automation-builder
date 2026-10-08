/**
 * Configuration for the approval flow, read from Forge environment variables
 * (`forge variables set -e development NAME value`).
 *
 * Statuses and transitions are identified by their numeric IDs, not their
 * names, so renaming "Approved" to "Approved by Manager" in the workflow
 * editor does not silently break the actions. Find the IDs in
 * Jira settings > Issues > Statuses (hover the edit link) or with
 * GET /rest/api/3/issue/{key}/transitions.
 *
 * There are deliberately NO defaults. A missing value is reported by name,
 * because guessing a status ID would make the create action refuse every approval.
 */

const REQUIRED = [
  'APPROVAL_PROJECT_KEY', //       e.g. SOC - the project approval tickets live in
  'APPROVAL_ISSUE_TYPE_ID', //     issue type used for approval tickets
  'APPROVED_STATUS_ID',
  'CHANGES_REQUESTED_STATUS_ID',
  'RESUBMIT_TRANSITION_ID', //     Changes Requested -> Pending Approval, used by the app
  'APPROVER_ACCOUNT_IDS', //       comma-separated Atlassian account IDs allowed to approve
];

/**
 * Returns `{ ok: true, config }` or `{ ok: false, error }` naming every
 * missing variable at once, so setup is not a one-error-at-a-time loop.
 */
export function readApprovalConfig(env = process.env) {
  const missing = REQUIRED.filter((name) => !env[name] || String(env[name]).trim() === '');
  if (missing.length > 0) {
    return { ok: false, error: `The Forge environment is missing: ${missing.join(', ')}.` };
  }
  const approverAccountIds = env.APPROVER_ACCOUNT_IDS.split(',').map((id) => id.trim()).filter(Boolean);
  if (approverAccountIds.length === 0) {
    return { ok: false, error: 'APPROVER_ACCOUNT_IDS must list at least one account ID.' };
  }
  return {
    ok: true,
    config: {
      projectKey: env.APPROVAL_PROJECT_KEY.trim(),
      issueTypeId: env.APPROVAL_ISSUE_TYPE_ID.trim(),
      approvedStatusId: env.APPROVED_STATUS_ID.trim(),
      changesRequestedStatusId: env.CHANGES_REQUESTED_STATUS_ID.trim(),
      resubmitTransitionId: env.RESUBMIT_TRANSITION_ID.trim(),
      approverAccountIds,
    },
  };
}
