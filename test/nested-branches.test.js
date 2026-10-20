import assert from 'node:assert/strict';
import test from 'node:test';
import { buildRulePayload, createJiraAutomationRule } from '../src/index.js';
import { ACTION_LIBRARY } from '../src/component-library.js';

// A branch may carry its own `branches`: its actions run first, then one
// nested container hangs under the branch's block (the SDP export layout).

const TRIGGER = { type: 'jira.issue.event.trigger:created' };
const COND = { type: 'jira.comparator.condition', value: { first: 'a', second: 'b', operator: 'EQUALS' } };
const LOG = (text) => ({ type: 'codebarrel.action.log', value: text });
const SELECT = 'com.atlassian.jira.plugin.system.customfieldtypes:select';
const FLOAT = 'com.atlassian.jira.plugin.system.customfieldtypes:float';

function build(spec, fieldMetadata = null) {
  return buildRulePayload({ name: 'Nested', projectId: '10086', trigger: TRIGGER, ...spec }, 'test-cloud', 'test-actor', fieldMetadata);
}

const NESTED = {
  branches: [
    {
      conditions: [COND],
      actions: [LOG('outer-action')],
      branches: [
        { conditions: [COND], actions: [LOG('inner-then')] },
        { conditions: [], actions: [LOG('inner-else')] },
      ],
    },
    { conditions: [], actions: [LOG('outer-else')] },
  ],
};

test('a branch carrying branches produces a container nested inside that branch block', () => {
  const [container] = build(NESTED).rule.components;
  const block = container.children[0];
  const nested = block.children.filter((c) => c.type === 'jira.condition.container.block');
  assert.equal(nested.length, 1);
  assert.equal(nested[0].parentId, block.id);
  assert.equal(nested[0].children.length, 2);
});

test('the nested branch own actions come before its nested container', () => {
  const block = build(NESTED).rule.components[0].children[0];
  assert.equal(block.children[0].value, 'outer-action');
  assert.equal(block.children[1].type, 'jira.condition.container.block');
  assert.equal(block.children.length, 2);
});

test('every nested block conditions and actions carry that block id, not an ancestor id', () => {
  const outerBlock = build(NESTED).rule.components[0].children[0];
  const innerContainer = outerBlock.children[1];
  assert.equal(outerBlock.children[0].parentId, outerBlock.id);
  for (const innerBlock of innerContainer.children) {
    assert.equal(innerBlock.parentId, innerContainer.id);
    assert.notEqual(innerBlock.id, outerBlock.id);
    for (const c of innerBlock.conditions) assert.equal(c.conditionParentId, innerBlock.id);
    for (const a of innerBlock.children) assert.equal(a.parentId, innerBlock.id);
  }
});

test('nothing caps the depth: five levels build with correct wiring', () => {
  let spec = { conditions: [COND], actions: [LOG('leaf')] };
  for (let level = 0; level < 4; level++) {
    spec = { conditions: [COND], actions: [LOG(`level${level}`)], branches: [spec] };
  }
  let container = build({ branches: [spec] }).rule.components[0];
  let depth = 0;
  while (container) {
    depth++;
    const block = container.children[0];
    assert.equal(block.parentId, container.id);
    assert.equal(block.children[0].parentId, block.id);
    const next = block.children.find((c) => c.type === 'jira.condition.container.block');
    if (next) assert.equal(next.parentId, block.id);
    container = next;
  }
  assert.equal(depth, 5);
});

test('a branch with only nested branches and no actions of its own is valid', () => {
  const { rule } = build({ branches: [{ conditions: [COND], branches: [{ conditions: [], actions: [LOG('x')] }] }] });
  const block = rule.components[0].children[0];
  assert.equal(block.children.length, 1);
  assert.equal(block.children[0].type, 'jira.condition.container.block');
});

test('a branch with neither actions nor branches still throws, with its path', () => {
  assert.throws(
    () => build({ branches: [{ conditions: [COND], actions: [LOG('a')], branches: [{ conditions: [COND], actions: [] }] }] }),
    /branches\[0\]\.branches\[0\] has no actions or branches/
  );
});

test('a nested empty-conditions branch is valid only as the last at its own level', () => {
  const inner = (branches) => build({ branches: [{ conditions: [COND], actions: [LOG('a')], branches }] });
  assert.doesNotThrow(() => inner([{ conditions: [COND], actions: [LOG('x')] }, { conditions: [], actions: [LOG('y')] }]));
  assert.throws(
    () => inner([{ conditions: [], actions: [LOG('x')] }, { conditions: [COND], actions: [LOG('y')] }]),
    /branches\[0\]\.branches\[0\] has no conditions, so it is the else/
  );
});

test('an empty nested branches array is rejected with its path', () => {
  assert.throws(
    () => build({ branches: [{ conditions: [COND], actions: [LOG('a')], branches: [] }] }),
    /branches\[0\]\.branches must be a non-empty array/
  );
});

test('an unverified action type in a nested branch is rejected by the allowlist', () => {
  assert.throws(() => build({
    branches: [{
      conditions: [COND],
      actions: [LOG('a')],
      branches: [{ conditions: [], actions: [{ type: 'jira.not.a.real.action', value: {} }] }],
    }],
  }), /not a verified action type|Allowed/);
});

test('a nested rule is DISABLED', () => {
  assert.equal(build(NESTED).rule.state, 'DISABLED');
});

// Atlassian reassigns every id on create; simulate it.
function reassignIds(node) {
  if (Array.isArray(node)) return node.map(reassignIds);
  if (node && typeof node === 'object') {
    const out = {};
    for (const [key, value] of Object.entries(node)) {
      out[key] = ['id', 'parentId', 'conditionParentId'].includes(key) && value !== null
        ? `fresh-${key}-${Math.random()}`
        : reassignIds(value);
    }
    return out;
  }
  return node;
}

// Runs createJiraAutomationRule with fetch mocked: the field list, the POST
// (captured) and the verification GET (transformed from the captured rule).
async function createWithGet(spec, transformGet, fields = []) {
  const previous = { fetch: globalThis.fetch, env: { ...process.env } };
  Object.assign(process.env, {
    AUTOMATION_API_EMAIL: 'automation@example.test',
    AUTOMATION_API_TOKEN: 'test-token',
    JIRA_CLOUD_ID: 'test-cloud',
    AUTOMATION_RULE_ACTOR_ACCOUNT_ID: 'test-actor',
  });
  let created;
  globalThis.fetch = async (url, options = {}) => {
    if (String(url).endsWith('/rest/api/3/field')) {
      return { status: 200, text: async () => JSON.stringify(fields) };
    }
    if (options.method === 'POST') {
      created = JSON.parse(options.body).rule;
      return { status: 201, text: async () => JSON.stringify({ ruleUuid: 'r1' }) };
    }
    return { status: 200, text: async () => JSON.stringify({ rule: transformGet(created) }) };
  };
  try {
    return await createJiraAutomationRule({
      ruleSpec: JSON.stringify({ name: 'Nested', projectId: '10086', trigger: TRIGGER, ...spec }),
    });
  } finally {
    globalThis.fetch = previous.fetch;
    process.env = previous.env;
  }
}

test('a nested rule verifies against its own GET with fresh ids', async () => {
  const result = await createWithGet(NESTED, (rule) => ({ ...reassignIds(rule), extra: 'meta' }));
  assert.equal(result.ok, true, JSON.stringify(result));
});

test('a GET where a nested action changed does not verify', async () => {
  const result = await createWithGet(NESTED, (rule) => {
    const got = reassignIds(rule);
    got.components[0].children[0].children[1].children[0].children[0].value = 'tampered';
    return got;
  });
  assert.equal(result.ok, false);
});

test('a jira.issue.edit in a nested branch loads field metadata and builds', async () => {
  const fields = [
    { id: 'customfield_20001', key: 'customfield_20001', name: 'Escalated to Customer', schema: { type: 'option', custom: SELECT } },
    { id: 'customfield_11594', key: 'customfield_11594', name: 'Time Taken at Open Phase', schema: { type: 'number', custom: FLOAT } },
  ];
  const spec = {
    branches: [{
      conditions: [COND],
      actions: [LOG('a')],
      branches: [{ conditions: [], actions: [{ type: 'jira.issue.edit', value: ACTION_LIBRARY['jira.issue.edit'].example }] }],
    }],
  };
  const result = await createWithGet(spec, (rule) => reassignIds(rule), fields);
  assert.doesNotMatch(JSON.stringify(result), /Field metadata was not loaded/);
  assert.equal(result.ok, true, JSON.stringify(result));
});
