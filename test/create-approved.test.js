import assert from 'node:assert/strict';
import test from 'node:test';
import { createApprovedRuleActions, latestApproval } from '../src/create-approved.js';
import { createDraftStore, DRAFT_STATES } from '../src/draft-store.js';
import { digestRule } from '../src/draft-render.js';
import { adfText, APPROVAL_ENV, APPROVAL_IDS, fakeJira, fakeStorage, sampleRule } from './fakes.js';

const APPROVED = APPROVAL_IDS.approvedStatus;
const PENDING_APPROVAL = '10200';

// The draft is stored at DRAFT_AT; approvals in these tests happen after it
// unless a test says otherwise.
const DRAFT_AT = '2026-10-08T01:00:00.000Z';
const AFTER_DRAFT = '2026-10-08T09:30:00.000+0800'; // 01:30Z
const BEFORE_DRAFT = '2026-10-08T08:00:00.000+0800'; // 00:00Z

function liveIssue({ statusId = APPROVED, projectKey = 'AUTOAPR' } = {}) {
  return {
    id: '20001',
    key: 'AUTOAPR-7',
    fields: {
      project: { key: projectKey },
      status: { id: statusId, name: statusId === APPROVED ? 'Approved' : 'Pending' },
      reporter: { accountId: 'me-1' },
    },
  };
}

/** One changelog entry moving the ticket from `from` to `to`. */
function statusChange(to, { author = 'manager-1', created = AFTER_DRAFT, from = PENDING_APPROVAL } = {}) {
  return {
    id: String(Math.random()),
    author: author === null ? undefined : { accountId: author },
    created,
    items: [{ field: 'status', fieldId: 'status', from, to }],
  };
}

async function setup({
  draftState = DRAFT_STATES.PENDING,
  seed = true,
  create,
  storage = fakeStorage(),
  issue = liveIssue(),
  changelog = [statusChange(APPROVED)],
  jiraOverrides = {},
} = {}) {
  const store = createDraftStore(storage);
  const jira = fakeJira({ getIssue: () => issue, getChangelog: () => changelog, ...jiraOverrides });
  const createCalls = [];
  const createFn = async (record) => {
    createCalls.push(record);
    return create
      ? create(record)
      : { ok: true, ruleUuid: 'uuid-1', message: `Created and verified disabled Jira automation rule "${record.rule.name}".` };
  };
  if (seed) {
    const rule = { ...sampleRule(), name: '[AUTOAPR-7] Notify on P1' };
    const digest = digestRule(rule);
    await store.saveDraft({
      issueId: '20001', issueKey: 'AUTOAPR-7', version: 1, state: draftState, rule,
      scope: rule.ruleScopeARIs[0], digest, requesterAccountId: 'me-1',
      history: [{ version: 1, digest, state: DRAFT_STATES.PENDING, at: DRAFT_AT }],
    });
  }
  const { createApprovedAutomationRule } = createApprovedRuleActions({
    jira, store, create: createFn, getEnv: () => APPROVAL_ENV,
  });
  const run = (issueKey = 'AUTOAPR-7') => createApprovedAutomationRule({ issueKey });
  return { store, jira, createCalls, run };
}

// --- the happy path and retries ---------------------------------------------

test('an approved ticket gets its frozen rule created exactly once, and the ticket is told', async () => {
  const ctx = await setup();
  const result = await ctx.run();

  assert.equal(result.ok, true);
  assert.equal(result.ruleCreated, true);
  assert.equal(result.ruleUuid, 'uuid-1');
  assert.match(result.message, /DISABLED/);
  assert.equal(ctx.createCalls.length, 1);
  // The frozen rule is what gets created, not anything from the input.
  assert.equal(ctx.createCalls[0].rule.name, '[AUTOAPR-7] Notify on P1');
  const stored = await ctx.store.getDraft('20001');
  assert.equal(stored.state, DRAFT_STATES.CREATED);
  assert.equal(stored.ruleUuid, 'uuid-1');
  assert.match(adfText(ctx.jira.calls.addComment[0].body), /Rule created \(DISABLED\)/);
});

test('a retry after success reports the same rule and never creates a second one', async () => {
  const ctx = await setup();
  await ctx.run();
  const again = await ctx.run();

  assert.equal(again.ok, true);
  assert.equal(again.alreadyCreated, true);
  assert.equal(again.ruleUuid, 'uuid-1');
  assert.match(again.message, /No new rule was created/);
  assert.equal(ctx.createCalls.length, 1);
  assert.equal(ctx.jira.calls.addComment.length, 1, 'a retry posts no second comment');
});

test('concurrent calls create exactly one rule', async () => {
  // Hold the first creation open so the other calls run while it is
  // mid-flight - the case a read-then-write check cannot handle.
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const ctx = await setup({
    create: async () => { await gate; return { ok: true, ruleUuid: 'uuid-1', message: 'ok' }; },
  });
  const calls = [ctx.run(), ctx.run(), ctx.run()];
  await new Promise((resolve) => setImmediate(resolve));
  release();
  const results = await Promise.all(calls);

  assert.equal(ctx.createCalls.length, 1);
  assert.equal(results.filter((r) => r.ok && r.ruleCreated && !r.alreadyCreated).length, 1);
});

test('a call that finds the draft CREATING does not create', async () => {
  const ctx = await setup({ draftState: DRAFT_STATES.CREATING });
  const result = await ctx.run();
  assert.equal(result.ok, false);
  assert.equal(result.ruleCreated, false);
  assert.match(result.error, /in progress or was interrupted/);
  assert.equal(ctx.createCalls.length, 0);
});

// --- refusals before anything is attempted ------------------------------------

test('a ticket that is not Approved is refused, with no state change and no comment', async () => {
  const ctx = await setup({ issue: liveIssue({ statusId: PENDING_APPROVAL }) });
  const result = await ctx.run();

  assert.equal(result.ok, false);
  assert.equal(result.ruleCreated, false);
  assert.match(result.error, /not Approved/);
  assert.equal(ctx.createCalls.length, 0);
  assert.equal((await ctx.store.getDraft('20001')).state, DRAFT_STATES.PENDING);
  assert.equal(ctx.jira.calls.addComment.length, 0);
});

test('a ticket outside the approval project is refused', async () => {
  const ctx = await setup({ issue: liveIssue({ projectKey: 'GSOC' }) });
  const result = await ctx.run('GSOC-1');
  assert.equal(result.ok, false);
  assert.match(result.error, /not an approval ticket/);
  assert.equal(ctx.createCalls.length, 0);
});

test('a missing issueKey is refused', async () => {
  const ctx = await setup();
  const result = await ctx.run('  ');
  assert.equal(result.ok, false);
  assert.match(result.error, /Provide issueKey/);
});

test('an approved ticket with no stored draft creates nothing', async () => {
  const ctx = await setup({ seed: false });
  const result = await ctx.run();
  assert.equal(result.ok, false);
  assert.match(result.error, /No stored draft/);
  assert.equal(ctx.createCalls.length, 0);
});

test('a storage error before the claim is refused as retryable and creates nothing', async () => {
  const broken = fakeStorage();
  const ctx = await setup({ storage: broken });
  broken.get = async () => { throw new Error('storage unavailable'); };
  const result = await ctx.run();
  assert.equal(result.ok, false);
  assert.match(result.error, /Try again/);
  assert.equal(ctx.createCalls.length, 0);
});

// --- approval checks from the changelog ---------------------------------------

test('an approver outside the approver group creates nothing and is recorded', async () => {
  const ctx = await setup({ changelog: [statusChange(APPROVED, { author: 'someone-else' })] });
  const result = await ctx.run();

  assert.equal(result.ok, false);
  assert.match(result.error, /not in the approver group \(someone-else\)/);
  assert.deepEqual(ctx.jira.calls.isUserInGroup, [{ accountId: 'someone-else', groupId: APPROVAL_ENV.APPROVER_GROUP_ID }]);
  assert.equal(ctx.createCalls.length, 0);
  assert.equal((await ctx.store.getDraft('20001')).state, DRAFT_STATES.NEEDS_ATTENTION);
  assert.match(adfText(ctx.jira.calls.addComment[0].body), /Rule NOT created/);
});

test('a failed group-membership read is retryable: nothing is created, recorded or commented', async () => {
  const ctx = await setup({ jiraOverrides: { isUserInGroup: () => { throw new Error('HTTP 403'); } } });
  const result = await ctx.run();

  assert.equal(result.ok, false);
  assert.match(result.error, /group membership could not be read \(HTTP 403\)\. Try again shortly/);
  assert.equal(ctx.createCalls.length, 0);
  assert.equal((await ctx.store.getDraft('20001')).state, DRAFT_STATES.PENDING);
  assert.equal(ctx.jira.calls.addComment.length, 0);
});

test('being the assignee grants nothing: a group member as assignee does not excuse a non-member approver', async () => {
  const issue = liveIssue();
  issue.fields.assignee = { accountId: 'manager-1' };
  const ctx = await setup({ issue, changelog: [statusChange(APPROVED, { author: 'someone-else' })] });
  const result = await ctx.run();

  assert.equal(result.ok, false);
  assert.equal(ctx.createCalls.length, 0);
});

test('an approval with no author fails closed', async () => {
  const ctx = await setup({ changelog: [statusChange(APPROVED, { author: null })] });
  const result = await ctx.run();
  assert.equal(result.ok, false);
  assert.equal(ctx.createCalls.length, 0);
});

test('a changelog with no move to Approved fails closed', async () => {
  const ctx = await setup({ changelog: [] });
  const result = await ctx.run();
  assert.equal(result.ok, false);
  assert.match(result.error, /shows no move to Approved/);
  assert.equal(ctx.createCalls.length, 0);
});

test('an approval older than the stored draft version creates nothing', async () => {
  const ctx = await setup({ changelog: [statusChange(APPROVED, { created: BEFORE_DRAFT })] });
  const result = await ctx.run();

  assert.equal(result.ok, false);
  assert.match(result.error, /not after draft v1 was stored/);
  assert.equal(ctx.createCalls.length, 0);
  assert.equal((await ctx.store.getDraft('20001')).state, DRAFT_STATES.NEEDS_ATTENTION);
});

test('the latest approval is the one that counts', async () => {
  // Approved by an outsider long ago, then sent back, then approved properly.
  const changelog = [
    statusChange(APPROVED, { author: 'someone-else', created: BEFORE_DRAFT }),
    statusChange('10203', { author: 'manager-1', created: BEFORE_DRAFT, from: APPROVED }),
    statusChange(APPROVED, { author: 'manager-1', created: AFTER_DRAFT }),
  ];
  const ctx = await setup({ changelog });
  const result = await ctx.run();
  assert.equal(result.ok, true);
  assert.equal(ctx.createCalls.length, 1);
});

test('latestApproval ignores other fields and picks the newest move to Approved', () => {
  const entries = [
    statusChange(APPROVED, { author: 'a', created: '2026-10-08T01:00:00.000Z' }),
    { author: { accountId: 'b' }, created: '2026-10-08T05:00:00.000Z', items: [{ field: 'summary', to: APPROVED }] },
    statusChange(APPROVED, { author: 'c', created: '2026-10-08T03:00:00.000Z' }),
  ];
  assert.equal(latestApproval(entries, APPROVED).author.accountId, 'c');
  assert.equal(latestApproval([], APPROVED), null);
});

// --- outcome reporting --------------------------------------------------------

test('self-approval is allowed and labelled on the ticket', async () => {
  const ctx = await setup({ changelog: [statusChange(APPROVED, { author: 'me-1' })] });
  const result = await ctx.run();
  assert.equal(result.ok, true);
  assert.match(adfText(ctx.jira.calls.addComment[0].body), /self-approved/);
});

test('approval by a different approver is not labelled self-approved', async () => {
  const ctx = await setup();
  await ctx.run();
  assert.doesNotMatch(adfText(ctx.jira.calls.addComment[0].body), /self-approved/);
});

test('a creation failure is recorded and reported as not created', async () => {
  const ctx = await setup({
    create: async () => ({ ok: false, error: 'The Automation API rejected the create request.', summary: 'The rule was NOT created. The Automation API rejected the create request.' }),
  });
  const result = await ctx.run();
  assert.equal(result.ok, false);
  assert.equal(result.ruleCreated, false);
  assert.equal((await ctx.store.getDraft('20001')).state, DRAFT_STATES.NEEDS_ATTENTION);
  assert.match(adfText(ctx.jira.calls.addComment[0].body), /Rule NOT created/);

  // A retry is answered from storage, never re-attempted (invariant 7).
  const again = await ctx.run();
  assert.equal(again.ok, false);
  assert.equal(ctx.createCalls.length, 1);
});

test('created-but-unverified says the rule exists and needs attention', async () => {
  const ctx = await setup({
    create: async () => ({ ok: false, ruleUuid: 'uuid-9', error: 'verify failed', summary: 'The rule WAS created (ruleUuid: uuid-9) but could not be verified.' }),
  });
  const result = await ctx.run();
  assert.equal(result.ruleCreated, true);
  assert.equal(result.verified, false);
  const text = adfText(ctx.jira.calls.addComment[0].body);
  assert.match(text, /Needs attention/);
  assert.match(text, /WAS created/);
});
