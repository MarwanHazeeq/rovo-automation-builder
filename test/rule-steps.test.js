import assert from 'node:assert/strict';
import test from 'node:test';
import { ALLOWED_ACTION_TYPES, ALLOWED_CONDITION_TYPES, ALLOWED_TRIGGER_TYPES, buildRulePayload } from '../src/index.js';
import { STRUCTURAL_LIBRARY } from '../src/component-library.js';
import { DESCRIBED_TYPES, describeSteps, describeTrigger } from '../src/rule-steps.js';

// Issue #26: the approver reads the rule as numbered steps, never as Jira's
// internal type names.

const node = (component, type, value, extra = {}) => ({ component, type, value, conditions: [], children: [], ...extra });
const action = (type, value) => node('ACTION', type, value);
const compare = (first, operator, second) => node('CONDITION', 'jira.comparator.condition', { first, operator, second });
const ifBlock = (conditions, children, conditionMatchType = 'ALL') =>
  node('CONDITION_BLOCK', 'jira.condition.if.block', { conditionMatchType }, { conditions, children });
const group = (...branches) => node('CONDITION', 'jira.condition.container.block', {}, { children: branches });
const log = (text) => action('codebarrel.action.log', text);

const lines = (rule) => describeSteps(rule).map(({ number, text }) => `${number} ${text}`);

test('every allowed trigger, condition and action type has a plain-English phrase', () => {
  assert.deepEqual([...DESCRIBED_TYPES.triggers].sort(), [...ALLOWED_TRIGGER_TYPES].sort());
  assert.deepEqual([...DESCRIBED_TYPES.conditions].sort(), [...ALLOWED_CONDITION_TYPES].sort());
  assert.deepEqual([...DESCRIBED_TYPES.actions].sort(), [...ALLOWED_ACTION_TYPES].sort());
});

test('a branch reads as If / Otherwise, with each action under the right side', () => {
  const rule = { components: [log('setup'), group(ifBlock([compare('{{issue.priority.name}}', 'EQUALS', 'High')], [log('escalate')]), ifBlock([], [log('flag')]))] };
  assert.deepEqual(lines(rule), [
    '1 Write to the audit log: "setup"',
    "2 If the work item's priority equals High:",
    '2.1 Write to the audit log: "escalate"',
    '3 Otherwise:',
    '3.1 Write to the audit log: "flag"',
  ]);
});

test('a later branch with conditions is an "Otherwise, if", because only the first match runs', () => {
  const rule = { components: [group(
    ifBlock([compare('a', 'EQUALS', 'b'), compare('c', 'NOT_EQUALS', '')], [log('one')], 'ANY'),
    ifBlock([compare('a', 'GREATER_THAN', '3')], [log('two')]),
  )] };
  assert.deepEqual(lines(rule), [
    '1 If a equals b or c is not empty:',
    '1.1 Write to the audit log: "one"',
    '2 Otherwise, if a is greater than 3:',
    '2.1 Write to the audit log: "two"',
  ]);
});

test('a branch inside a branch (the worked example) shows both levels', () => {
  const { ruleSpec } = STRUCTURAL_LIBRARY['jira.condition.container.block'].workedExample;
  const { rule } = buildRulePayload({ ...ruleSpec, projectId: '10086' }, 'test-cloud', 'test-actor', []);
  assert.equal(describeTrigger(rule, 'SOCDemo (ID 10086)'),
    "When a work item is created in SOCDemo (ID 10086), if the work item's priority is not empty:");
  assert.deepEqual(lines(rule), [
    '1 Write to the audit log: "always runs first"',
    "2 Create variable Priority = the work item's priority",
    "3 If the work item's priority equals High:",
    '3.1 Write to the audit log: "high priority"',
    "3.2 If the work item's reporter equals Pat:",
    '3.2.1 Write to the audit log: "high priority from Pat"',
    '3.3 Otherwise:',
    '3.3.1 Write to the audit log: "high priority from anyone else"',
    '4 Otherwise:',
    '4.1 Add an internal comment: "Not high priority"',
  ]);
});

test('a web request shows its method and redacted URL, never a header value', () => {
  const rule = { components: [action('jira.issue.outgoing.webhook', {
    url: 'https://sync.invalid/hook?sig=SECRETSIG', method: 'post',
    headers: [{ name: 'X-Key', value: 'real-header-value' }], customBody: '{"k":"body-value"}',
  })] };
  const [step] = lines(rule);
  assert.equal(step, '1 Send a POST web request to https://sync.invalid/hook?sig=[redacted]');
  assert.ok(!step.includes('real-header-value') && !step.includes('body-value'));
});

test('a literal value in a credential-named variable is hidden; smart values and stand-ins are shown', () => {
  const variable = (name, value) => action('jira.create.variable', { name: { type: 'FREE', value: name }, query: { type: 'SMART', value } });
  assert.deepEqual(lines({ components: [
    variable('ClientSecret', 'hunter2'),
    variable('AuthToken', 'Bearer {{webResponse.body.access_token}}'),
    variable('ApiKey', '<SDP_API_KEY>'),
  ] }), [
    '1 Create variable ClientSecret = [redacted]',
    '2 Create variable AuthToken = "Bearer [a web request response, but no web request runs before this step]"',
    '3 Create variable ApiKey = "<SDP_API_KEY>"',
  ]);
});

test('field edits name the field and the value, IDs included', () => {
  const edit = action('jira.issue.edit', { operations: [
    { field: { type: 'NAME', value: 'Escalated to Customer' }, type: 'SET', value: { type: 'NAME', value: 'Yes' } },
    { field: { type: 'ID', value: 'priority' }, type: 'SET', value: { type: 'ID', value: '2' } },
  ], advancedFields: '{\n  "fields": {\n    "customfield_11594": {{#=}}1{{/}}\n  }\n}' });
  assert.deepEqual(lines({ components: [edit] }),
    ['1 Set Escalated to Customer to Yes, and set priority to ID 2, and set customfield_11594 to a calculated value']);
});
