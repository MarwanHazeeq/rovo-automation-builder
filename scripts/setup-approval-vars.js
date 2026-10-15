/**
 * One-command setup of the approval variables for a site:
 *
 *   npm run setup -- --group <approver-group-id> [--env development] [--project SOC]
 *     [--issue-type "Automation Request"] [--approved Approved]
 *     [--changes-requested "Change Request"] [--resubmit "resubmit pending"]
 *
 * It runs on your machine, not in Forge. It first CHECKS the values against
 * the live Jira site, then runs `forge variables set` for all six. Nothing is
 * set unless every check passes, so a typo never reaches the app.
 *
 * - The names are checked with the app's own resolver (resolveApprovalConfig
 *   in src/approval-config.js), so "found here" means "found by the app".
 * - The group is checked by reading its members.
 * - The resubmit transition is NOT checked: Jira only lists transitions on a
 *   ticket, and the app already looks it up by name on each ticket.
 *
 * Jira login comes from .env (JIRA_SITE_URL, JIRA_EMAIL, JIRA_API_TOKEN),
 * loaded by Node's --env-file-if-exists flag in package.json. The token is
 * only sent to the site in the Authorization header and is never printed.
 *
 * It does not deploy: it prints the deploy command, so you choose when.
 */

import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { resolveApprovalConfig } from '../src/approval-config.js';

const OPTIONS = {
  group: { type: 'string' },
  env: { type: 'string', default: 'development' },
  project: { type: 'string', default: 'SOC' },
  'issue-type': { type: 'string', default: 'Automation Request' },
  approved: { type: 'string', default: 'Approved' },
  'changes-requested': { type: 'string', default: 'Change Request' },
  resubmit: { type: 'string', default: 'resubmit pending' },
};

// On Windows `forge` is a .cmd file, which Node can only run through a shell.
// Allowing only these characters means a value can never break out of its
// quotes in that shell command.
const SAFE_VALUE = /^[A-Za-z0-9 _.:-]+$/;

const OLD_VARIABLES = [
  'APPROVAL_ISSUE_TYPE_ID',
  'APPROVED_STATUS_ID',
  'CHANGES_REQUESTED_STATUS_ID',
  'RESUBMIT_TRANSITION_ID',
  'APPROVER_ACCOUNT_IDS',
];

/**
 * Does the whole setup. Returns true on success, false if it stopped (the
 * reason is already logged). Everything outside this process is injected so
 * tests can run it without Jira or the Forge CLI.
 */
export async function runSetup({ argv, env, fetchFn, runForge, log = console.log }) {
  let args;
  try {
    ({ values: args } = parseArgs({ args: argv, options: OPTIONS, strict: true }));
  } catch (error) {
    log(`Stopped: ${error.message}`);
    return false;
  }
  if (!args.group) {
    log('Stopped: give the approver group ID with --group <id> (Jira admin > User management > Groups).');
    return false;
  }

  // The six variables the app reads, in the form it reads them.
  const variables = {
    APPROVAL_PROJECT_KEY: args.project,
    APPROVAL_ISSUE_TYPE_NAME: args['issue-type'],
    APPROVED_STATUS_NAME: args.approved,
    CHANGES_REQUESTED_STATUS_NAME: args['changes-requested'],
    RESUBMIT_TRANSITION_NAME: args.resubmit,
    APPROVER_GROUP_ID: args.group,
  };
  const unsafe = Object.entries(variables).filter(([, value]) => !SAFE_VALUE.test(value.trim()));
  if (unsafe.length > 0 || !SAFE_VALUE.test(args.env)) {
    log(
      `Stopped: these values may only contain letters, digits, spaces and _ . : - ` +
        `(${[...unsafe.map(([name]) => name), ...(SAFE_VALUE.test(args.env) ? [] : ['--env'])].join(', ')}).`
    );
    return false;
  }

  const missingLogin = ['JIRA_SITE_URL', 'JIRA_EMAIL', 'JIRA_API_TOKEN'].filter((name) => !env[name]?.trim());
  if (missingLogin.length > 0) {
    log(`Stopped: .env is missing ${missingLogin.join(', ')}. See README "Set up the approval workflow".`);
    return false;
  }
  const site = env.JIRA_SITE_URL.trim().replace(/\/+$/, '');
  const auth = `Basic ${Buffer.from(`${env.JIRA_EMAIL.trim()}:${env.JIRA_API_TOKEN.trim()}`).toString('base64')}`;

  // GET a site REST path as the .env user; returns { status, body }.
  async function jiraGet(path) {
    const response = await fetchFn(`${site}${path}`, { headers: { Accept: 'application/json', Authorization: auth } });
    const text = await response.text();
    let body = text;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      // Not JSON (an HTML error page, for example): keep the text.
    }
    return { status: response.status, body };
  }

  // 1. Names -> IDs, with the app's own resolver and matching rules.
  const jira = {
    async getProjectStatuses(projectKey) {
      const { status, body } = await jiraGet(`/rest/api/3/project/${encodeURIComponent(projectKey)}/statuses`);
      if (status !== 200) throw new Error(`HTTP ${status}`);
      return body;
    },
  };
  let resolved;
  try {
    resolved = await resolveApprovalConfig(jira, variables);
  } catch (error) {
    log(`Stopped: Jira could not be reached at ${site} (${error.message}).`);
    return false;
  }
  if (!resolved.ok) {
    log(`Stopped, nothing was set: ${resolved.error}`);
    return false;
  }
  const { config } = resolved;
  log(`Checked on ${site}:`);
  log(`  issue type        "${variables.APPROVAL_ISSUE_TYPE_NAME}" -> ${config.issueTypeId}`);
  log(`  approved          "${variables.APPROVED_STATUS_NAME}" -> ${config.approvedStatusId}`);
  log(`  changes requested "${variables.CHANGES_REQUESTED_STATUS_NAME}" -> ${config.changesRequestedStatusId}`);
  log(`  resubmit          "${variables.RESUBMIT_TRANSITION_NAME}" (checked by the app on each ticket)`);

  // 2. The approver group must exist.
  let group;
  try {
    group = await jiraGet(`/rest/api/3/group/member?groupId=${encodeURIComponent(args.group)}&maxResults=1`);
  } catch (error) {
    log(`Stopped: Jira could not be reached at ${site} (${error.message}).`);
    return false;
  }
  if (group.status === 404) {
    log(`Stopped, nothing was set: no group with ID ${args.group} exists on ${site}.`);
    return false;
  }
  if (group.status !== 200) {
    log(`Stopped, nothing was set: the group could not be read (HTTP ${group.status}).`);
    return false;
  }
  const members = Number(group.body?.total ?? 0);
  log(`  approver group    ${args.group} -> ${members} member(s)`);
  if (members === 0) log('  WARNING: the group has no members, so nobody can approve yet.');

  // 3. Every check passed: set the variables.
  for (const [name, value] of Object.entries(variables)) {
    const result = runForge(['variables', 'set', name, value.trim(), '-e', args.env]);
    if (result.status !== 0) {
      log(`Stopped: forge variables set ${name} failed. Variables before it were set; run the command again.`);
      return false;
    }
    log(`Set ${name} in ${args.env}.`);
  }

  log('');
  log('Done. The app sees the new values after a deploy:');
  log(`  forge deploy --non-interactive -e ${args.env}`);
  log('Optional tidy-up, the old ID variables are no longer read:');
  for (const name of OLD_VARIABLES) log(`  forge variables unset ${name} -e ${args.env}`);
  return true;
}

/** Runs the Forge CLI, showing its output. Values are pre-checked by SAFE_VALUE. */
function runForge(args) {
  const command = ['forge', ...args.map((arg) => `"${arg}"`)].join(' ');
  return spawnSync(command, { shell: true, stdio: 'inherit' });
}

// Run only when started as a script, not when a test imports this file.
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const ok = await runSetup({ argv: process.argv.slice(2), env: process.env, fetchFn: fetch, runForge });
  process.exitCode = ok ? 0 : 1;
}
