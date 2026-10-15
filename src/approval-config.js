/**
 * Configuration for the approval flow, read from Forge environment variables
 * (`forge variables set -e development NAME value`) and then RESOLVED against
 * the live Jira site.
 *
 * WHY NAMES, NOT IDS
 * The env vars hold the issue type, status and transition NAMES (for example
 * "Approved"). The app looks up their IDs on every call, so the same
 * configuration works on any customer site and keeps working if the workflow
 * is rebuilt with new IDs. The cost: renaming a status in the workflow editor
 * means updating the env var (and redeploying, which Forge needs for any env
 * var change). A name that matches nothing, or matches more than one thing,
 * is refused by name: guessing would either block every approval or, worse,
 * act on the wrong status.
 *
 * WHY A GROUP, NOT A LIST OF ACCOUNT IDS
 * Approvers are the members of the Jira group APPROVER_GROUP_ID, so adding or
 * removing an approver is a Jira admin task with no redeploy. The group is
 * named by its ID (Jira admin > User management > Groups, or
 * GET /rest/api/3/group/bulk), which survives a group rename. Trade-off,
 * accepted on purpose: whoever can edit that group decides who may approve
 * rule creation. See docs/adr/0002-approval-config-by-name-and-group.md.
 *
 * There are deliberately NO defaults. A missing value is reported by name.
 */

const REQUIRED = [
  'APPROVAL_PROJECT_KEY', //          e.g. SOC - the project approval tickets live in
  'APPROVAL_ISSUE_TYPE_NAME', //      issue type used for approval tickets
  'APPROVED_STATUS_NAME',
  'CHANGES_REQUESTED_STATUS_NAME',
  'RESUBMIT_TRANSITION_NAME', //      Change Request -> Pending, used by the app
  'APPROVER_GROUP_ID', //             Jira group whose members may approve
];

/**
 * Check the env vars are present, without calling Jira. Returns
 * `{ ok: true, names }` or `{ ok: false, error }` naming every missing
 * variable at once, so setup is not a one-error-at-a-time loop.
 */
export function readApprovalConfig(env = process.env) {
  const missing = REQUIRED.filter((name) => !env[name] || String(env[name]).trim() === '');
  if (missing.length > 0) {
    return { ok: false, error: `The Forge environment is missing: ${missing.join(', ')}.` };
  }
  return {
    ok: true,
    names: {
      projectKey: env.APPROVAL_PROJECT_KEY.trim(),
      issueTypeName: env.APPROVAL_ISSUE_TYPE_NAME.trim(),
      approvedStatusName: env.APPROVED_STATUS_NAME.trim(),
      changesRequestedStatusName: env.CHANGES_REQUESTED_STATUS_NAME.trim(),
      resubmitTransitionName: env.RESUBMIT_TRANSITION_NAME.trim(),
      approverGroupId: env.APPROVER_GROUP_ID.trim(),
    },
  };
}

/**
 * Read the env vars and turn the names into IDs with ONE Jira call
 * (GET /rest/api/3/project/{key}/statuses lists every issue type of the
 * project with the statuses its workflow uses).
 *
 * Returns `{ ok: true, config }` or `{ ok: false, error }`. `config` carries
 * `projectKey`, `issueTypeId`, `approvedStatusId`, `changesRequestedStatusId`
 * (all strings), plus `resubmitTransitionName` and `approverGroupId`, which
 * are used as-is: transitions depend on the ticket's current status, so the
 * revise action looks the transition up on the ticket itself
 * (see findTransitionId), and group membership is checked per account.
 */
export async function resolveApprovalConfig(jira, env = process.env) {
  const read = readApprovalConfig(env);
  if (!read.ok) return read;
  const { names } = read;

  let issueTypes;
  try {
    issueTypes = await jira.getProjectStatuses(names.projectKey);
  } catch (error) {
    return { ok: false, error: `The workflow of project ${names.projectKey} could not be read: ${error.message}` };
  }

  const issueType = findOneByName(issueTypes, names.issueTypeName, 'APPROVAL_ISSUE_TYPE_NAME', `project ${names.projectKey}`);
  if (!issueType.ok) return issueType;
  const where = `the ${issueType.match.name} workflow of project ${names.projectKey}`;
  const approved = findOneByName(issueType.match.statuses, names.approvedStatusName, 'APPROVED_STATUS_NAME', where);
  if (!approved.ok) return approved;
  const changesRequested = findOneByName(
    issueType.match.statuses,
    names.changesRequestedStatusName,
    'CHANGES_REQUESTED_STATUS_NAME',
    where
  );
  if (!changesRequested.ok) return changesRequested;

  return {
    ok: true,
    config: {
      projectKey: names.projectKey,
      issueTypeId: String(issueType.match.id),
      approvedStatusId: String(approved.match.id),
      changesRequestedStatusId: String(changesRequested.match.id),
      resubmitTransitionName: names.resubmitTransitionName,
      approverGroupId: names.approverGroupId,
    },
  };
}

/**
 * The ID of the transition called `name` among those Jira currently offers on
 * a ticket (GET /rest/api/3/issue/{key}/transitions). Same rules as above:
 * exactly one match, or a refusal that names RESUBMIT_TRANSITION_NAME.
 */
export function findTransitionId(transitions, name, issueKey) {
  const found = findOneByName(transitions, name, 'RESUBMIT_TRANSITION_NAME', `the transitions available on ${issueKey}`);
  return found.ok ? { ok: true, id: String(found.match.id) } : found;
}

/**
 * Exactly one item whose `name` equals `wanted`, ignoring case and outer
 * spaces. Zero or several matches is an error naming the env var, so an
 * admin knows which value to fix.
 */
function findOneByName(items, wanted, variable, where) {
  const key = wanted.trim().toLowerCase();
  const matches = (Array.isArray(items) ? items : []).filter(
    (item) => typeof item?.name === 'string' && item.name.trim().toLowerCase() === key
  );
  if (matches.length === 1) return { ok: true, match: matches[0] };
  return {
    ok: false,
    error:
      matches.length === 0
        ? `${variable} is "${wanted}", but nothing with that name exists in ${where}.`
        : `${variable} is "${wanted}", but ${matches.length} items share that name in ${where}; rename one so the match is unambiguous.`,
  };
}
