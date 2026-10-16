import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildRulePayload,
  ALLOWED_TRIGGER_TYPES,
  ALLOWED_ACTION_TYPES,
  ALLOWED_CONDITION_TYPES,
} from '../src/index.js';
import {
  TRIGGER_LIBRARY,
  ACTION_LIBRARY,
  CONDITION_LIBRARY,
  STRUCTURAL_LIBRARY,
} from '../src/component-library.js';

// The contract: the `example` the library hands the agent (through
// get-component-reference) is accepted by buildRulePayload. An entry that
// documents the shape Jira EXPORTS instead of the shape the builder TAKES
// fails here, not in front of a requester.

const SELECT = 'com.atlassian.jira.plugin.system.customfieldtypes:select';
const FLOAT = 'com.atlassian.jira.plugin.system.customfieldtypes:float';

// Just enough tenant metadata for every documented example to resolve.
const FIELD_METADATA = [
  { id: 'customfield_20001', key: 'customfield_20001', name: 'Escalated to Customer', schema: { type: 'option', custom: SELECT } },
  { id: 'customfield_20002', key: 'customfield_20002', name: 'Send to Customer ITSM', schema: { type: 'option', custom: SELECT } },
  { id: 'customfield_11594', key: 'customfield_11594', name: 'Time Taken at Open Phase', schema: { type: 'number', custom: FLOAT } },
];

const BASE_TRIGGER = { type: 'jira.issue.event.trigger:created' };
const BASE_ACTION = { type: 'codebarrel.action.log', value: 'hello' };

function build(spec) {
  return buildRulePayload(
    { name: 'Contract check', projectId: '10086', ...spec },
    'test-cloud',
    'test-actor',
    FIELD_METADATA
  );
}

test('the library and the builder allow exactly the same component types', () => {
  assert.deepEqual(Object.keys(TRIGGER_LIBRARY).sort(), [...ALLOWED_TRIGGER_TYPES].sort());
  assert.deepEqual(Object.keys(ACTION_LIBRARY).sort(), [...ALLOWED_ACTION_TYPES].sort());
  assert.deepEqual(Object.keys(CONDITION_LIBRARY).sort(), [...ALLOWED_CONDITION_TYPES].sort());
});

for (const [type, entry] of Object.entries(ACTION_LIBRARY)) {
  test(`action ${type}: the documented example is accepted`, () => {
    const { rule } = build({
      trigger: BASE_TRIGGER,
      actions: [{ type, value: entry.example }],
    });
    assert.equal(rule.state, 'DISABLED');
    assert.ok(rule.components.some((component) => component.type === type));
  });
}

for (const [type, entry] of Object.entries(CONDITION_LIBRARY)) {
  test(`condition ${type}: the documented example is accepted`, () => {
    const { rule } = build({
      trigger: BASE_TRIGGER,
      conditions: [{ type, value: entry.example }],
      actions: [BASE_ACTION],
    });
    assert.equal(rule.state, 'DISABLED');
  });
}

// Structural entries document the INPUT (ruleSpec.branches fields); the
// container/if.block shapes live under builtInternally as labelled output.
test('structural container: the documented branches example builds one container', () => {
  const { rule } = build({
    trigger: BASE_TRIGGER,
    ...STRUCTURAL_LIBRARY['jira.condition.container.block'].example,
  });
  assert.equal(rule.components.length, 1);
  assert.equal(rule.components[0].type, 'jira.condition.container.block');
  assert.equal(rule.components[0].children.length, 2);
});

test('structural if.block: the documented branch example is accepted', () => {
  const { rule } = build({
    trigger: BASE_TRIGGER,
    branches: [STRUCTURAL_LIBRARY['jira.condition.if.block'].example],
  });
  assert.equal(rule.state, 'DISABLED');
  assert.equal(rule.components[0].children[0].type, 'jira.condition.if.block');
});

// A trigger's example is the settings sent next to `type`, e.g.
// { type, fromStatus: [...] }.
for (const [type, entry] of Object.entries(TRIGGER_LIBRARY)) {
  test(`trigger ${type}: the documented example is accepted`, () => {
    const { rule } = build({
      trigger: { type, ...entry.example },
      actions: [BASE_ACTION],
    });
    assert.equal(rule.state, 'DISABLED');
    assert.equal(rule.trigger.type, type);
  });
}

test('every entry that records a builtInternally shape marks it as not an input', () => {
  for (const library of [TRIGGER_LIBRARY, ACTION_LIBRARY, CONDITION_LIBRARY, STRUCTURAL_LIBRARY]) {
    for (const [type, entry] of Object.entries(library)) {
      if (entry.builtInternally === undefined) continue;
      assert.match(
        entry.builtInternally.description,
        /NOT (AN INPUT|something to send)/,
        `${type}: builtInternally must say it is not an input`
      );
    }
  }
});

test('jira.issue.edit rejects the exported operations shape it used to document', () => {
  const exported = ACTION_LIBRARY['jira.issue.edit'].builtInternally.shapes.operations.example;
  assert.throws(
    () => build({ trigger: BASE_TRIGGER, actions: [{ type: 'jira.issue.edit', value: exported }] }),
    /takes "value\.fields"/
  );
});

test('the Escalated to Customer example builds a select operation and a numeric advancedFields', () => {
  const { rule } = build({
    trigger: BASE_TRIGGER,
    actions: [{ type: 'jira.issue.edit', value: ACTION_LIBRARY['jira.issue.edit'].example }],
  });
  const value = rule.components.find((component) => component.type === 'jira.issue.edit').value;
  assert.equal(value.operations[0].field.value, 'Escalated to Customer');
  assert.equal(value.operations[0].value.value, 'Yes');
  assert.match(value.advancedFields, /"customfield_11594": /);
});
