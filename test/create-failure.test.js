import assert from 'node:assert/strict';
import test from 'node:test';
import { explainCreateFailure, summarizeCreateFailure } from '../src/draft-render.js';

// Issue #10: a failed create explains what failed, where, what to do next and
// whether a rule exists, using names a person can find in the rule.

const webhook = (id, url) => ({
  component: 'ACTION', type: 'jira.issue.outgoing.webhook', id, value: { url, headers: [] }, conditions: [], children: [],
});
const log = { component: 'ACTION', type: 'codebarrel.action.log', id: 'l1', value: 'hi', conditions: [], children: [] };
const ifBlock = {
  component: 'CONDITION_BLOCK', type: 'jira.condition.if.block', id: 'b1', value: {}, conditions: [],
  children: [webhook('w3', 'https://sync.example.com/hook?sig=SECRETSIG')],
};
const RULE = {
  name: 'SDP request creation',
  trigger: { type: 'jira.issue.field.changed', value: {}, conditions: [] },
  components: [log, webhook('w1', 'https://a.example.com'), webhook('w2', 'https://b.example.com'),
    { component: 'CONDITION', type: 'jira.condition.container.block', id: 'c1', value: {}, conditions: [], children: [ifBlock] }],
};

// Copied from the Forge log of the live SDP run (2026-10-20). Atlassian's
// uuids are its own, not the ids that were sent.
const LIVE_API_ERROR = {
  errors: [
    { id: '82682231', status: 400, code: 'api.error.unknown', title: 'Please enter a valid web request URL', field: 'component:__NEW__ACTION__36d72f7a-2b2e-4168-a54c-5669a207bb6e.url' },
    { id: '77dd0796', status: 400, code: 'api.error.unknown', title: 'Please enter a valid web request URL', field: 'component:__NEW__ACTION__4a946b83-a082-4120-a8aa-667ef340f2d7.url' },
    { id: 'ddfee548', status: 400, code: 'api.error.unknown', title: 'Please enter a valid web request URL', field: 'component:__NEW__ACTION__6aa5434e-23da-4df7-bcf6-8d04b30d1b31.url' },
  ],
};

test('a multi-error apiError renders every entry, naming candidate components, never a uuid', () => {
  const explanation = explainCreateFailure(
    { error: 'The Automation API rejected the create request.', status: 400, apiError: LIVE_API_ERROR }, RULE);
  assert.equal(explanation.where.length, 3);
  for (const line of explanation.where) {
    assert.equal(line,
      'Please enter a valid web request URL: field "url" on one of: the 1st web request action; ' +
      'the 2nd web request action; the 3rd web request action (inside the 1st if-block)');
  }
  assert.match(explanation.what, /HTTP 400: Please enter a valid web request URL$/);
  assert.match(explanation.nextStep, /^Fix the field\(s\) named under Where/);
  assert.equal(explanation.ruleExists, false);
  assert.match(explanation.ruleInJira, /^No/);
  assert.doesNotMatch(JSON.stringify(explanation), /36d72f7a|4a946b83|6aa5434e|__NEW__/);
});

test('a field error whose id matches a sent component names exactly that one', () => {
  const explanation = explainCreateFailure(
    { status: 400, apiError: { errors: [{ title: 'Bad URL', field: 'component:__NEW__ACTION__w2.url' }] } }, RULE);
  assert.deepEqual(explanation.where, ['Bad URL: field "url" on the 2nd web request action']);
});

test('401 and 403 point at the app Automation API credentials, not the requester', () => {
  for (const status of [401, 403]) {
    const { nextStep, ruleExists } = explainCreateFailure({ status, apiError: 'Unauthorized' }, RULE);
    assert.match(nextStep, /AUTOMATION_API_EMAIL \/ AUTOMATION_API_TOKEN/);
    assert.match(nextStep, /not the requester's permissions/);
    assert.equal(ruleExists, false);
  }
});

test('a 5xx or a network failure is called transient', () => {
  assert.match(explainCreateFailure({ status: 503 }, RULE).nextStep, /looks temporary/);
  assert.match(
    explainCreateFailure({ error: 'The create request could not be sent: ECONNRESET', networkError: true }, RULE).nextStep,
    /looks temporary/
  );
});

test('created but unverified says the rule exists and must not be resubmitted', () => {
  const explanation = explainCreateFailure(
    { error: 'The rule was created, but verification found a mismatch.', ruleUuid: 'uuid-9', mismatch: 'x' }, RULE);
  assert.equal(explanation.ruleExists, true);
  assert.match(explanation.nextStep, /EXISTS in Jira and is DISABLED \(ruleUuid uuid-9\)/);
  assert.match(explanation.nextStep, /Do NOT raise a new request/);
  assert.match(summarizeCreateFailure(explanation), /^The rule WAS created but could not be verified\./);
});

test('an outcome-unknown failure asks for the rule to be looked for by name', () => {
  const explanation = explainCreateFailure({ outcomeUnknown: true, error: 'The create call threw: boom' }, RULE);
  assert.match(explanation.nextStep, /"SDP request creation"/);
  assert.match(explanation.ruleInJira, /^Unknown/);
});

test('a signed URL quoted by Jira or an error message is redacted in the explanation and the summary', () => {
  const explanation = explainCreateFailure({
    error: 'The create request could not be sent: fetch https://sync.example.com/hook?sig=SECRETSIG failed',
    status: 400,
    apiError: { errors: [{ title: 'Unreachable https://sync.example.com/hook?sig=SECRETSIG', field: 'component:__NEW__ACTION__zz.url' }] },
  }, RULE);
  const all = `${JSON.stringify(explanation)} ${summarizeCreateFailure(explanation)}`;
  assert.ok(!all.includes('SECRETSIG'));
  assert.match(all, /https:\/\/sync\.example\.com\/hook\?sig=\[redacted\]/);
});
