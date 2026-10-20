import assert from 'node:assert/strict';
import test from 'node:test';
import { createDraftActions } from '../src/drafts.js';
import { createDraftStore, DRAFT_STATES } from '../src/draft-store.js';
import { digestRule } from '../src/draft-render.js';
import { adfText, APPROVAL_ENV, APPROVAL_IDS, fakeJira, fakeStorage, PROJECT_STATUSES, preparedOk } from './fakes.js';

// What the requester wrote, as the agent sends it. No branch word in it.
const REQUEST = 'Log a message whenever an issue is created in SOCDemo.';

function setup({
  jiraOverrides,
  prepare = preparedOk(),
  env = APPROVAL_ENV,
  readyResult = { ok: true, marked: true, mode: 'rule' },
} = {}) {
  const storage = fakeStorage();
  const store = createDraftStore(storage);
  const jira = fakeJira(jiraOverrides);
  const markReadyCalls = [];
  const markReady = async (issueKey, projectKey) => {
    markReadyCalls.push({ issueKey, projectKey });
    return { issueKey, ...readyResult };
  };
  const actions = createDraftActions({ jira, store, prepare, getEnv: () => env, markReady });
  return { storage, store, jira, actions, markReadyCalls };
}

test('draft raises a ticket, freezes the rule and says plainly that nothing was created', async () => {
  const { store, jira, actions } = setup();
  const result = await actions.draftAutomationRule({
    requestText: REQUEST,
    ruleSpec: '{}',
    requestSummary: 'Log a message when an issue is created',
    context: { accountId: 'me-1' },
  });

  assert.equal(result.ok, true);
  assert.equal(result.ruleCreated, false);
  assert.equal(result.draftSubmitted, true);
  assert.equal(result.issueKey, 'AUTOAPR-7');
  assert.match(result.message, /No automation rule has been created/);

  const [fields] = jira.calls.createIssue;
  assert.deepEqual(fields.project, { key: 'AUTOAPR' });
  assert.deepEqual(fields.issuetype, { id: '10100' });
  assert.match(adfText(fields.description), /as described by the agent/);

  const stored = await store.getDraft('20001');
  assert.equal(stored.state, DRAFT_STATES.PENDING);
  assert.equal(stored.version, 1);
  assert.equal(stored.rule.name, '[AUTOAPR-7] Notify on P1');
  assert.equal(stored.rule.state, 'DISABLED');
  assert.equal(stored.digest, digestRule(stored.rule));
  assert.equal(stored.requesterAccountId, 'me-1');

  const [draftComment] = jira.calls.addComment;
  assert.equal(draftComment.key, 'AUTOAPR-7');
  assert.match(adfText(draftComment.body), /Draft v1/);
  assert.ok(adfText(draftComment.body).includes(stored.digest));
});

test('a draft without requestText is refused and raises no ticket', async () => {
  const { jira, actions } = setup();
  for (const requestText of [undefined, '', '   ', 42]) {
    const result = await actions.draftAutomationRule({ requestText, ruleSpec: '{}' });
    assert.equal(result.ok, false);
    assert.equal(result.draftSubmitted, false);
    assert.match(result.error, /requester's message was not provided/);
  }
  assert.equal(jira.calls.createIssue.length, 0);
});

test('requestText is stored on the ticket and with the draft, and prepare receives it', async () => {
  const seen = [];
  const prepare = async (payload) => { seen.push(payload.requestText); return preparedOk()(); };
  const { store, jira, actions } = setup({ prepare });
  const text = 'Escalate P1 tickets unless they are already assigned.';
  await actions.draftAutomationRule({ requestText: `  ${text}  `, ruleSpec: '{}' });

  assert.deepEqual(seen, [text]);
  const description = adfText(jira.calls.createIssue[0].description);
  assert.ok(description.includes(text));
  assert.match(description, /Requester's message, as sent by the agent/);
  assert.equal((await store.getDraft('20001')).requestText, text);
});

test('the project name and ID are the first thing on the ticket, above the request, and on the draft comment', async () => {
  const { jira, actions } = setup();
  await actions.draftAutomationRule({ requestText: REQUEST, ruleSpec: '{}', requestSummary: 'summary' });

  const description = adfText(jira.calls.createIssue[0].description);
  assert.match(description, /^Target project:\s+SOCDemo \(ID 10449\)/);
  assert.ok(description.indexOf('SOCDemo (ID 10449)') < description.indexOf(REQUEST));
  assert.match(adfText(jira.calls.addComment[0].body), /Project:\s+SOCDemo \(ID 10449\)/);
});

test('a project given by id alone is shown as an id, not as a made-up name', async () => {
  const rule = (await preparedOk()()).rule;
  const prepare = async () => ({ ok: true, rule, scope: rule.ruleScopeARIs[0], cloudId: 'test-cloud' });
  const { jira, actions } = setup({ prepare });
  await actions.draftAutomationRule({ requestText: REQUEST, ruleSpec: '{}' });
  assert.match(adfText(jira.calls.createIssue[0].description), /Target project:\s+ID 10449 \(the draft gave no project name\)/);
});

test('a revision is checked against the stored requestText, and a refusal changes nothing', async () => {
  const ctx = await seededRevise(APPROVAL_IDS.changesRequestedStatus);
  const seen = [];
  const revise = createDraftActions({
    jira: ctx.jira, store: ctx.store, getEnv: () => APPROVAL_ENV,
    prepare: async (payload) => { seen.push(payload.requestText); return { ok: false, error: 'refused' }; },
  });
  const result = await revise.reviseAutomationRuleDraft({ issueKey: 'AUTOAPR-7', ruleSpec: '{}', requestText: 'ignored' });
  assert.equal(result.ok, false);
  assert.deepEqual(seen, [REQUEST]);
  assert.equal((await ctx.store.getDraft('20001')).version, 1);
});

test('a draft that fails validation raises no ticket', async () => {
  const { jira, actions } = setup({
    prepare: async () => ({ ok: false, error: 'trigger.fields must contain at least one Jira field name.' }),
  });
  const result = await actions.draftAutomationRule({ requestText: REQUEST, ruleSpec: '{}' });
  assert.equal(result.ok, false);
  assert.equal(result.ruleCreated, false);
  assert.equal(result.draftSubmitted, false);
  assert.equal(jira.calls.createIssue.length, 0);
});

test('missing approval configuration is reported by name', async () => {
  const { actions } = setup({ env: { ...APPROVAL_ENV, APPROVED_STATUS_NAME: '', RESUBMIT_TRANSITION_NAME: undefined } });
  const result = await actions.draftAutomationRule({ requestText: REQUEST, ruleSpec: '{}' });
  assert.equal(result.ok, false);
  assert.match(result.error, /APPROVED_STATUS_NAME, RESUBMIT_TRANSITION_NAME/);
});

test('draft secrets are redacted in the ticket comment and the attachment', async () => {
  const prepare = async () => {
    const rule = (await preparedOk()()).rule;
    rule.components = [{
      component: 'ACTION',
      type: 'jira.issue.outgoing.webhook',
      value: { headers: [{ name: 'Authorization', value: 'Bearer SUPERSECRET' }] },
    }];
    return { ok: true, rule, scope: rule.ruleScopeARIs[0], cloudId: 'test-cloud' };
  };
  const { jira, actions } = setup({ prepare });
  await actions.draftAutomationRule({ requestText: REQUEST, ruleSpec: '{}' });
  assert.ok(!JSON.stringify(jira.calls.addComment).includes('SUPERSECRET'));
  assert.ok(!jira.calls.addAttachment[0].content.includes('SUPERSECRET'));
  assert.match(jira.calls.addAttachment[0].content, /\[redacted\]/);
});

test('the full payload is attached as a versioned file and kept out of the comment', async () => {
  const { store, jira, actions } = setup();
  await actions.draftAutomationRule({ requestText: REQUEST, ruleSpec: '{}' });
  const stored = await store.getDraft('20001');

  const [attachment] = jira.calls.addAttachment;
  assert.equal(attachment.key, 'AUTOAPR-7');
  assert.equal(attachment.filename, `draft-v1-${stored.digest.slice(0, 8)}.json`);
  assert.equal(JSON.parse(attachment.content).name, '[AUTOAPR-7] Notify on P1');

  const comment = jira.calls.addComment[0].body;
  assert.ok(!JSON.stringify(comment).includes('codeBlock'), 'no JSON block in the comment');
  assert.ok(adfText(comment).includes(attachment.filename));
});

test('a failed upload still submits the draft, with a warning and an honest comment', async () => {
  const { store, jira, actions } = setup({
    jiraOverrides: { addAttachment: () => { throw new Error('HTTP 403 attachments disabled'); } },
  });
  const result = await actions.draftAutomationRule({ requestText: REQUEST, ruleSpec: '{}' });

  assert.equal(result.ok, true);
  assert.equal(result.draftSubmitted, true);
  assert.match(result.warning, /could not be attached/);
  assert.equal((await store.getDraft('20001')).state, DRAFT_STATES.PENDING);
  assert.match(adfText(jira.calls.addComment[0].body), /could not be attached/);
});

// --- ticket routing and name resolution ---------------------------------

test('the ticket is created unassigned, with the issue type resolved from its name', async () => {
  const { store, jira, actions } = setup();
  const result = await actions.draftAutomationRule({ requestText: REQUEST, ruleSpec: '{}', approverAccountId: 'manager-1' });

  assert.equal(result.ok, true);
  assert.equal('assignedTo' in result, false);
  assert.equal('assignee' in jira.calls.createIssue[0], false);
  assert.deepEqual(jira.calls.createIssue[0].issuetype, { id: APPROVAL_IDS.issueType });
  assert.deepEqual(jira.calls.getProjectStatuses, ['AUTOAPR']);
  assert.equal('approverAccountId' in (await store.getDraft('20001')), false);
  assert.match(adfText(jira.calls.addComment[0].body), /Any member of the approver group/);
});

test('names match ignoring case and outer spaces, only within the approval issue type', async () => {
  // "Done" exists only on the decoy Task type, with the same ID as Approved;
  // it must not be found for the approval issue type.
  const { jira, actions } = setup({
    env: { ...APPROVAL_ENV, APPROVAL_ISSUE_TYPE_NAME: ' automation REQUEST ', APPROVED_STATUS_NAME: 'Done' },
  });
  const result = await actions.draftAutomationRule({ requestText: REQUEST, ruleSpec: '{}' });
  assert.equal(result.ok, false);
  assert.match(result.error, /APPROVED_STATUS_NAME is "Done", but nothing with that name exists in the Automation Request workflow/);
  assert.equal(jira.calls.createIssue.length, 0);
});

test('an unknown issue type name raises no ticket and names the variable', async () => {
  const { jira, actions } = setup({ env: { ...APPROVAL_ENV, APPROVAL_ISSUE_TYPE_NAME: 'Approval' } });
  const result = await actions.draftAutomationRule({ requestText: REQUEST, ruleSpec: '{}' });
  assert.equal(result.ok, false);
  assert.match(result.error, /APPROVAL_ISSUE_TYPE_NAME is "Approval", but nothing with that name exists in project AUTOAPR/);
  assert.equal(jira.calls.createIssue.length, 0);
});

test('a status name shared by two statuses is refused rather than guessed', async () => {
  const [decoy, approvalType] = PROJECT_STATUSES;
  const duplicated = { ...approvalType, statuses: [...approvalType.statuses, { id: '10299', name: 'approved' }] };
  const { jira, actions } = setup({ jiraOverrides: { getProjectStatuses: () => [decoy, duplicated] } });
  const result = await actions.draftAutomationRule({ requestText: REQUEST, ruleSpec: '{}' });
  assert.equal(result.ok, false);
  assert.match(result.error, /APPROVED_STATUS_NAME is "Approved", but 2 items share that name/);
  assert.equal(jira.calls.createIssue.length, 0);
});

test('a failed workflow read raises no ticket', async () => {
  const { jira, actions } = setup({ jiraOverrides: { getProjectStatuses: () => { throw new Error('HTTP 404'); } } });
  const result = await actions.draftAutomationRule({ requestText: REQUEST, ruleSpec: '{}' });
  assert.equal(result.ok, false);
  assert.match(result.error, /workflow of project AUTOAPR could not be read: HTTP 404/);
  assert.equal(jira.calls.createIssue.length, 0);
});

// --- revise -----------------------------------------------------------------

function liveIssue(statusId, projectKey = 'AUTOAPR') {
  return () => ({ id: '20001', key: 'AUTOAPR-7', fields: { project: { key: projectKey }, status: { id: statusId, name: 'x' } } });
}

async function seededRevise(statusId, opts = {}) {
  const ctx = setup({ jiraOverrides: { getIssue: liveIssue(statusId, opts.projectKey), ...opts.jiraOverrides } });
  await ctx.actions.draftAutomationRule({ requestText: REQUEST, ruleSpec: '{}' });
  ctx.jira.calls.addComment.length = 0;
  return ctx;
}

test('revise replaces the draft, comments v2 and resubmits, when the manager requested changes', async () => {
  const ctx = await seededRevise(APPROVAL_IDS.changesRequestedStatus);
  const revise = createDraftActions({
    jira: ctx.jira, store: ctx.store, prepare: preparedOk('[AUTOAPR-7] Notify on P1 and P2'), getEnv: () => APPROVAL_ENV,
  });
  const result = await revise.reviseAutomationRuleDraft({ issueKey: 'AUTOAPR-7', ruleSpec: '{}' });

  assert.equal(result.ok, true);
  assert.equal(result.ruleCreated, false);
  assert.equal(result.version, 2);
  const stored = await ctx.store.getDraft('20001');
  assert.equal(stored.version, 2);
  assert.equal(stored.state, DRAFT_STATES.PENDING);
  // An existing [KEY] prefix is not doubled.
  assert.equal(stored.rule.name, '[AUTOAPR-7] Notify on P1 and P2');
  assert.match(adfText(ctx.jira.calls.addComment[0].body), /Draft v2/);
  // Each version keeps its own file; v1's attachment is not replaced.
  assert.deepEqual(ctx.jira.calls.addAttachment.map((a) => a.filename.slice(0, 9)), ['draft-v1-', 'draft-v2-']);
  assert.deepEqual(ctx.jira.calls.transitionIssue, [{ key: 'AUTOAPR-7', transitionId: '31' }]);
});

test('revise is refused unless the live ticket is in Change Request', async () => {
  const ctx = await seededRevise('10200'); // Pending
  const result = await ctx.actions.reviseAutomationRuleDraft({ issueKey: 'AUTOAPR-7', ruleSpec: '{}' });
  assert.equal(result.ok, false);
  assert.match(result.error, /only be revised after the manager chooses Request Changes/);
  assert.equal((await ctx.store.getDraft('20001')).version, 1);
  assert.equal(ctx.jira.calls.transitionIssue.length, 0);
});

test('revise refuses an issue outside the approval project', async () => {
  const ctx = await seededRevise(APPROVAL_IDS.changesRequestedStatus, { projectKey: 'GSOC' });
  const result = await ctx.actions.reviseAutomationRuleDraft({ issueKey: 'GSOC-1', ruleSpec: '{}' });
  assert.equal(result.ok, false);
  assert.match(result.error, /not an approval ticket/);
});

test('revise refuses a draft that is no longer open', async () => {
  const ctx = await seededRevise(APPROVAL_IDS.changesRequestedStatus);
  const draft = await ctx.store.getDraft('20001');
  await ctx.store.saveDraft({ ...draft, state: DRAFT_STATES.CREATED });
  const result = await ctx.actions.reviseAutomationRuleDraft({ issueKey: 'AUTOAPR-7', ruleSpec: '{}' });
  assert.equal(result.ok, false);
  assert.match(result.error, /CREATED and can no longer be revised/);
});

test('the resubmit transition is found by name on the ticket; a missing one is a manual step', async () => {
  const ctx = await seededRevise(APPROVAL_IDS.changesRequestedStatus, {
    jiraOverrides: { getTransitions: () => [{ id: '41', name: 'Reject' }] },
  });
  const result = await ctx.actions.reviseAutomationRuleDraft({ issueKey: 'AUTOAPR-7', ruleSpec: '{}' });
  assert.equal(result.ok, false);
  assert.equal(result.draftStored, true);
  assert.match(result.error, /RESUBMIT_TRANSITION_NAME is "resubmit pending", but nothing with that name exists/);
  assert.match(result.error, /Resubmit transition on the ticket manually/);
  assert.equal(ctx.jira.calls.transitionIssue.length, 0);
});

test('a failed resubmit transition still reports the stored draft and the manual step', async () => {
  const ctx = await seededRevise(APPROVAL_IDS.changesRequestedStatus, {
    jiraOverrides: { transitionIssue: () => { throw new Error('HTTP 400'); } },
  });
  const result = await ctx.actions.reviseAutomationRuleDraft({ issueKey: 'AUTOAPR-7', ruleSpec: '{}' });
  assert.equal(result.ok, false);
  assert.equal(result.draftStored, true);
  assert.match(result.error, /Resubmit transition on the ticket manually/);
  assert.equal((await ctx.store.getDraft('20001')).version, 2);
});

// ---------------------------------------------------------------------------
// The ready-for-review step (src/mark-request-ready.js, stubbed here)
// ---------------------------------------------------------------------------

test('a draft marks its new ticket ready, after the attachment, and says delivery is unconfirmed', async () => {
  const { jira, actions, markReadyCalls } = setup();
  const result = await actions.draftAutomationRule({ requestText: REQUEST, ruleSpec: '{}' });

  assert.deepEqual(markReadyCalls, [{ issueKey: 'AUTOAPR-7', projectKey: 'AUTOAPR' }]);
  assert.equal(jira.calls.addAttachment.length, 1);
  assert.equal(result.readyForReview.marked, true);
  assert.match(result.message, /marked ready for review/);
  assert.match(result.message, /can't be confirmed/);
});

test('a ticket that could not be marked still submits the draft and tells the user to inform the approver', async () => {
  const { actions } = setup({
    readyResult: { ok: false, marked: false, error: 'no draft attached; not marking ready', notificationSent: false },
  });
  const result = await actions.draftAutomationRule({ requestText: REQUEST, ruleSpec: '{}' });

  assert.equal(result.ok, true);
  assert.equal(result.draftSubmitted, true);
  assert.equal(result.readyForReview.marked, false);
  assert.match(result.message, /could NOT be marked ready for review \(no draft attached; not marking ready\)/);
  assert.match(result.message, /No heads-up was triggered: tell the approver about AUTOAPR-7/);
});

test('when the heads-up was accepted but labelling failed, the message says it may already have been sent', async () => {
  const { actions } = setup({
    readyResult: { ok: false, marked: false, error: 'labels failed', notificationSent: true },
  });
  const result = await actions.draftAutomationRule({ requestText: REQUEST, ruleSpec: '{}' });

  assert.match(result.message, /may already have been sent/);
  assert.doesNotMatch(result.message, /No heads-up was triggered/);
});

test('a revision does not mark the ticket again', async () => {
  const ctx = setup({ jiraOverrides: { getIssue: liveIssue(APPROVAL_IDS.changesRequestedStatus) } });
  await ctx.actions.draftAutomationRule({ requestText: REQUEST, ruleSpec: '{}' });
  const result = await ctx.actions.reviseAutomationRuleDraft({ issueKey: 'AUTOAPR-7', ruleSpec: '{}' });

  assert.equal(result.ok, true);
  assert.equal(ctx.markReadyCalls.length, 1);
});
