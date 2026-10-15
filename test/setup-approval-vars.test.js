import assert from 'node:assert/strict';
import test from 'node:test';
import { runSetup } from '../scripts/setup-approval-vars.js';
import { PROJECT_STATUSES } from './fakes.js';

const LOGIN = Object.freeze({
  JIRA_SITE_URL: 'https://example.atlassian.net/',
  JIRA_EMAIL: 'me@example.com',
  JIRA_API_TOKEN: 'secret-token',
});
const GROUP = 'db9869d9-10a9-4e42-b4f5-c000c42ae126';

/** Fake Jira: the project statuses and one group, by URL. */
function fakeFetch({ statuses = PROJECT_STATUSES, groupStatus = 200, groupTotal = 2 } = {}) {
  const urls = [];
  const fetchFn = async (url, init) => {
    urls.push({ url, auth: init.headers.Authorization });
    const reply = (status, body) => ({ status, text: async () => JSON.stringify(body) });
    if (url.includes('/project/AUTOAPR/statuses')) return reply(200, statuses);
    if (url.includes('/group/member')) return reply(groupStatus, { total: groupTotal, values: [] });
    return reply(404, { errorMessages: ['not found'] });
  };
  return { fetchFn, urls };
}

async function setup({ argv = ['--group', GROUP, '--project', 'AUTOAPR', '--issue-type', 'Automation Request'], env = LOGIN, ...jira } = {}) {
  const { fetchFn, urls } = fakeFetch(jira);
  const forgeCalls = [];
  const lines = [];
  const ok = await runSetup({
    argv,
    env,
    fetchFn,
    runForge: (args) => {
      forgeCalls.push(args);
      return { status: 0 };
    },
    log: (line) => lines.push(line),
  });
  return { ok, urls, forgeCalls, output: lines.join('\n') };
}

test('checks the names and group on the site, then sets all six variables', async () => {
  const { ok, urls, forgeCalls, output } = await setup();

  assert.equal(ok, true);
  assert.equal(urls[0].url, 'https://example.atlassian.net/rest/api/3/project/AUTOAPR/statuses');
  assert.equal(urls[0].auth, `Basic ${Buffer.from('me@example.com:secret-token').toString('base64')}`);
  assert.deepEqual(forgeCalls.map((args) => args[2]), [
    'APPROVAL_PROJECT_KEY',
    'APPROVAL_ISSUE_TYPE_NAME',
    'APPROVED_STATUS_NAME',
    'CHANGES_REQUESTED_STATUS_NAME',
    'RESUBMIT_TRANSITION_NAME',
    'APPROVER_GROUP_ID',
  ]);
  assert.deepEqual(forgeCalls[5], ['variables', 'set', 'APPROVER_GROUP_ID', GROUP, '-e', 'development']);
  assert.match(output, /approved +"Approved" -> 10201/);
  assert.match(output, /2 member\(s\)/);
  assert.match(output, /forge deploy --non-interactive -e development/);
  assert.doesNotMatch(output, /secret-token/);
});

test('a status name that does not exist sets nothing and names the variable', async () => {
  const { ok, forgeCalls, output } = await setup({
    argv: ['--group', GROUP, '--project', 'AUTOAPR', '--approved', 'Done'],
  });
  assert.equal(ok, false);
  assert.equal(forgeCalls.length, 0);
  assert.match(output, /nothing was set: APPROVED_STATUS_NAME is "Done"/);
});

test('an unknown group sets nothing', async () => {
  const { ok, forgeCalls, output } = await setup({ groupStatus: 404 });
  assert.equal(ok, false);
  assert.equal(forgeCalls.length, 0);
  assert.match(output, new RegExp(`no group with ID ${GROUP}`));
});

test('an empty group is set, with a warning', async () => {
  const { ok, output } = await setup({ groupTotal: 0 });
  assert.equal(ok, true);
  assert.match(output, /WARNING: the group has no members/);
});

test('missing .env values are listed by name before Jira is called', async () => {
  const { ok, urls, output } = await setup({ env: { JIRA_SITE_URL: 'https://example.atlassian.net' } });
  assert.equal(ok, false);
  assert.equal(urls.length, 0);
  assert.match(output, /\.env is missing JIRA_EMAIL, JIRA_API_TOKEN/);
});

test('a value that could break the shell command is refused before anything runs', async () => {
  const { ok, urls, forgeCalls, output } = await setup({ argv: ['--group', 'abc" & del *'] });
  assert.equal(ok, false);
  assert.equal(urls.length, 0);
  assert.equal(forgeCalls.length, 0);
  assert.match(output, /APPROVER_GROUP_ID/);
});

test('no --group stops with how to find it', async () => {
  const { ok, output } = await setup({ argv: [] });
  assert.equal(ok, false);
  assert.match(output, /--group <id>/);
});
