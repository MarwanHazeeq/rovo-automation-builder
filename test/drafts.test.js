import assert from 'node:assert/strict';
import test from 'node:test';
import { createDraftActions } from '../src/drafts.js';
import { createDraftStore, DRAFT_STATES } from '../src/draft-store.js';
import { digestRule } from '../src/draft-render.js';
import { adfText, APPROVAL_ENV, fakeJira, fakeStorage, preparedOk } from './fakes.js';

function setup({ jiraOverrides, prepare = preparedOk(), env = APPROVAL_ENV } = {}) {
  const storage = fakeStorage();
  const store = createDraftStore(storage);
  const jira = fakeJira(jiraOverrides);
  const actions = createDraftActions({ jira, store, prepare, getEnv: () => env });
  return { storage, store, jira, actions };
}

test('draft raises a ticket, freezes the rule and says plainly that nothing was created', async () => {
  const { store, jira, actions } = setup();
  const result = await actions.draftAutomationRule({
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

test('a draft that fails validation raises no ticket', async () => {
  const { jira, actions } = setup({
    prepare: async () => ({ ok: false, error: 'trigger.fields must contain at least one Jira field name.' }),
  });
  const result = await actions.draftAutomationRule({ ruleSpec: '{}' });
  assert.equal(result.ok, false);
  assert.equal(result.ruleCreated, false);
  assert.equal(result.draftSubmitted, false);
  assert.equal(jira.calls.createIssue.length, 0);
});

test('missing approval configuration is reported by name', async () => {
  const { actions } = setup({ env: { ...APPROVAL_ENV, APPROVED_STATUS_ID: '', RESUBMIT_TRANSITION_ID: undefined } });
  const result = await actions.draftAutomationRule({ ruleSpec: '{}' });
  assert.equal(result.ok, false);
  assert.match(result.error, /APPROVED_STATUS_ID, RESUBMIT_TRANSITION_ID/);
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
  await actions.draftAutomationRule({ ruleSpec: '{}' });
  assert.ok(!JSON.stringify(jira.calls.addComment).includes('SUPERSECRET'));
  assert.ok(!jira.calls.addAttachment[0].content.includes('SUPERSECRET'));
  assert.match(jira.calls.addAttachment[0].content, /\[redacted\]/);
});

test('the full payload is attached as a versioned file and kept out of the comment', async () => {
  const { store, jira, actions } = setup();
  await actions.draftAutomationRule({ ruleSpec: '{}' });
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
  const result = await actions.draftAutomationRule({ ruleSpec: '{}' });

  assert.equal(result.ok, true);
  assert.equal(result.draftSubmitted, true);
  assert.match(result.warning, /could not be attached/);
  assert.equal((await store.getDraft('20001')).state, DRAFT_STATES.PENDING);
  assert.match(adfText(jira.calls.addComment[0].body), /could not be attached/);
});

// --- revise -----------------------------------------------------------------

function liveIssue(statusId, projectKey = 'AUTOAPR') {
  return () => ({ id: '20001', key: 'AUTOAPR-7', fields: { project: { key: projectKey }, status: { id: statusId, name: 'x' } } });
}

async function seededRevise(statusId, opts = {}) {
  const ctx = setup({ jiraOverrides: { getIssue: liveIssue(statusId, opts.projectKey), ...opts.jiraOverrides } });
  await ctx.actions.draftAutomationRule({ ruleSpec: '{}' });
  ctx.jira.calls.addComment.length = 0;
  return ctx;
}

test('revise replaces the draft, comments v2 and resubmits, when the manager requested changes', async () => {
  const ctx = await seededRevise(APPROVAL_ENV.CHANGES_REQUESTED_STATUS_ID);
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

test('revise is refused unless the live ticket is in Changes Requested', async () => {
  const ctx = await seededRevise('10200'); // Pending Approval
  const result = await ctx.actions.reviseAutomationRuleDraft({ issueKey: 'AUTOAPR-7', ruleSpec: '{}' });
  assert.equal(result.ok, false);
  assert.match(result.error, /only be revised after the manager chooses Request Changes/);
  assert.equal((await ctx.store.getDraft('20001')).version, 1);
  assert.equal(ctx.jira.calls.transitionIssue.length, 0);
});

test('revise refuses an issue outside the approval project', async () => {
  const ctx = await seededRevise(APPROVAL_ENV.CHANGES_REQUESTED_STATUS_ID, { projectKey: 'GSOC' });
  const result = await ctx.actions.reviseAutomationRuleDraft({ issueKey: 'GSOC-1', ruleSpec: '{}' });
  assert.equal(result.ok, false);
  assert.match(result.error, /not an approval ticket/);
});

test('revise refuses a draft that is no longer open', async () => {
  const ctx = await seededRevise(APPROVAL_ENV.CHANGES_REQUESTED_STATUS_ID);
  const draft = await ctx.store.getDraft('20001');
  await ctx.store.saveDraft({ ...draft, state: DRAFT_STATES.CREATED });
  const result = await ctx.actions.reviseAutomationRuleDraft({ issueKey: 'AUTOAPR-7', ruleSpec: '{}' });
  assert.equal(result.ok, false);
  assert.match(result.error, /CREATED and can no longer be revised/);
});

test('a failed resubmit transition still reports the stored draft and the manual step', async () => {
  const ctx = await seededRevise(APPROVAL_ENV.CHANGES_REQUESTED_STATUS_ID, {
    jiraOverrides: { transitionIssue: () => { throw new Error('HTTP 400'); } },
  });
  const result = await ctx.actions.reviseAutomationRuleDraft({ issueKey: 'AUTOAPR-7', ruleSpec: '{}' });
  assert.equal(result.ok, false);
  assert.equal(result.draftStored, true);
  assert.match(result.error, /Resubmit transition on the ticket manually/);
  assert.equal((await ctx.store.getDraft('20001')).version, 2);
});
