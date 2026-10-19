import assert from 'node:assert/strict';
import test from 'node:test';
import { findMatches, isSupported, surveyRule } from '../scripts/find-component-examples.js';

const priorityCondition = {
  type: 'jira.issue.condition',
  schemaVersion: 3,
  value: { selectedField: { type: 'ID', value: 'priority' }, selectedFieldType: 'priority' },
};
const issueTypeCondition = {
  type: 'jira.issue.condition',
  schemaVersion: 3,
  value: { selectedField: { type: 'ID', value: 'issuetype' }, selectedFieldType: 'issuetype' },
};

test('finds a component nested inside an if/else branch, filtered by field', () => {
  const rule = {
    trigger: { type: 'jira.issue.event.trigger:created', conditions: [issueTypeCondition] },
    components: [
      { type: 'jira.condition.container.block', children: [
        { type: 'jira.condition.if.block', conditions: [priorityCondition], children: [] },
      ] },
    ],
  };

  const matches = findMatches(rule, 'jira.issue.condition', 'Priority');

  assert.deepEqual(matches, [priorityCondition]);
});

test('without a field filter, also returns trigger-level conditions', () => {
  const rule = {
    trigger: { type: 'jira.issue.event.trigger:created', conditions: [issueTypeCondition] },
    components: [priorityCondition],
  };

  assert.equal(findMatches(rule, 'jira.issue.condition').length, 2);
  assert.equal(findMatches(rule, 'jira.issue.event.trigger:created').length, 1);
});

test('a rule with no components yields no matches instead of throwing', () => {
  assert.deepEqual(findMatches({}, 'jira.issue.condition', 'priority'), []);
  assert.deepEqual(findMatches(undefined, 'jira.issue.condition'), []);
});

test('survey groups conditions by field type, edits per operation, and counts each rule once', () => {
  const statusCondition = {
    type: 'jira.issue.condition',
    value: { selectedField: { type: 'ID', value: 'status' }, selectedFieldType: 'status' },
  };
  const edit = {
    type: 'jira.issue.edit',
    value: { operations: [
      { field: { type: 'ID', value: 'labels' }, fieldType: 'labels', type: 'ADD', value: 'x' },
      { field: { type: 'NAME', value: 'Team' }, fieldType: 'com.example:team', type: 'SET', value: 'y' },
    ] },
  };
  const ruleA = {
    trigger: { type: 'jira.issue.event.trigger:created', conditions: [priorityCondition] },
    components: [{ type: 'jira.condition.if.block', conditions: [statusCondition, statusCondition], children: [edit] }],
  };
  const ruleB = { trigger: { type: 'jira.issue.event.trigger:created' }, components: [statusCondition] };
  const tally = new Map();

  surveyRule(ruleA, { name: 'A', uuid: 'a' }, tally);
  surveyRule(ruleB, { name: 'B', uuid: 'b' }, tally);

  const status = tally.get('jira.issue.condition / status');
  assert.equal(status.count, 3);
  assert.equal(status.rules.size, 2);
  assert.equal(status.source.name, 'A', 'keeps the first example only');
  assert.equal(tally.get('jira.issue.condition / priority').count, 1);
  assert.ok(tally.has('jira.issue.edit / labels'));
  assert.ok(tally.has('jira.issue.edit / com.example:team'));
  assert.equal(tally.get('jira.issue.event.trigger:created').rules.size, 2);
});

test('survey redacts secrets in the stored example', () => {
  const tally = new Map();
  surveyRule({ components: [{
    type: 'jira.issue.outgoing.webhook',
    value: { url: 'https://x.test', headers: [{ name: 'Authorization', value: 'Bearer s3cret' }] },
  }] }, { name: 'W', uuid: 'w' }, tally);

  const example = JSON.stringify(tally.get('jira.issue.outgoing.webhook').example);
  assert.ok(!example.includes('s3cret'));
});

test('isSupported reflects the library and the field-type builders', () => {
  assert.equal(isSupported('jira.issue.condition'), true);
  assert.equal(isSupported('jira.issue.condition / priority'), true);
  assert.equal(isSupported('jira.issue.condition / com.atlassian.jira.plugin.system.customfieldtypes:select'), true);
  assert.equal(isSupported('jira.issue.condition / status'), true);
  assert.equal(isSupported('jira.issue.condition / labels'), false);
  assert.equal(isSupported('jira.issue.edit / assignee'), true);
  assert.equal(isSupported('jira.issue.edit / com.atlassian.jira.plugin.system.customfieldtypes:float'), true);
  assert.equal(isSupported('jira.issue.edit / com.atlassian.jira.plugin.system.customfieldtypes:textfield'), true);
  assert.equal(isSupported('jira.issue.edit / com.example:team'), false);
  assert.equal(isSupported('made.up.type'), false);
});
