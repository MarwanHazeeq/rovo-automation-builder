import assert from 'node:assert/strict';
import test from 'node:test';
import { buildRulePayload, createJiraAutomationRule } from '../src/index.js';

// ruleSpec.actions next to ruleSpec.branches: setup actions that run
// unconditionally before the branching container.

const TRIGGER = { type: 'jira.issue.event.trigger:created' };
const COND = { type: 'jira.comparator.condition', value: { first: 'a', second: 'b', operator: 'EQUALS' } };
const LOG = (text) => ({ type: 'codebarrel.action.log', value: text });

function build(spec) {
  return buildRulePayload({ name: 'Setup', projectId: '10086', trigger: TRIGGER, ...spec }, 'test-cloud', 'test-actor', null);
}

const withSetup = () => build({
  actions: [LOG('setup1'), LOG('setup2')],
  branches: [
    { conditions: [COND], actions: [LOG('then')] },
    { conditions: [], actions: [LOG('else')] },
  ],
});

test('actions + branches: setup actions first in order, then one container last', () => {
  const { rule } = withSetup();
  assert.equal(rule.components.length, 3);
  assert.deepEqual(rule.components.slice(0, 2).map((c) => c.value), ['setup1', 'setup2']);
  assert.equal(rule.components[2].type, 'jira.condition.container.block');
  assert.equal(rule.components[2].children.length, 2);
});

test('top-level setup actions and the container carry a null parentId', () => {
  const { rule } = withSetup();
  for (const top of rule.components) assert.equal(top.parentId, null);
});

test('conditions + branches still throws, naming the conflict', () => {
  assert.throws(
    () => build({ conditions: [COND], branches: [{ conditions: [], actions: [LOG('a')] }] }),
    /both "branches" and top-level "conditions"/
  );
});

test('flat conditions + actions output is unchanged by the helper extraction', () => {
  const { rule } = build({ conditions: [COND], actions: [LOG('a')] });
  assert.equal(rule.components.length, 1);
  const container = rule.components[0];
  assert.equal(container.parentId, null);
  assert.equal(container.children.length, 1);
  assert.equal(container.children[0].children[0].parentId, container.children[0].id);
  const flat = build({ actions: [LOG('a')] });
  assert.equal(flat.rule.components.length, 1);
  assert.equal(flat.rule.components[0].parentId, null);
});

test('rule is DISABLED', () => {
  assert.equal(withSetup().rule.state, 'DISABLED');
});

// Atlassian reassigns every id on create and may add metadata; simulate both.
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

async function createWithGet(spec, transformGet) {
  const previous = {
    fetch: globalThis.fetch,
    env: { ...process.env },
  };
  Object.assign(process.env, {
    AUTOMATION_API_EMAIL: 'automation@example.test',
    AUTOMATION_API_TOKEN: 'test-token',
    JIRA_CLOUD_ID: 'test-cloud',
    AUTOMATION_RULE_ACTOR_ACCOUNT_ID: 'test-actor',
  });
  let created;
  globalThis.fetch = async (url, options = {}) => {
    if (options.method === 'POST') {
      created = JSON.parse(options.body).rule;
      return { status: 201, text: async () => JSON.stringify({ ruleUuid: 'r1' }) };
    }
    return { status: 200, text: async () => JSON.stringify({ rule: transformGet(created) }) };
  };
  try {
    return await createJiraAutomationRule({
      ruleSpec: JSON.stringify({ name: 'Setup', projectId: '10086', trigger: TRIGGER, ...spec }),
    });
  } finally {
    globalThis.fetch = previous.fetch;
    process.env = previous.env;
  }
}

const SPEC = {
  actions: [LOG('setup1')],
  branches: [
    { conditions: [COND], actions: [LOG('then')] },
    { conditions: [], actions: [LOG('else')] },
  ],
};

test('a setup-actions + branches rule verifies against its own GET with fresh ids', async () => {
  const result = await createWithGet(SPEC, (rule) => ({ ...reassignIds(rule), extra: 'meta' }));
  assert.equal(result.ok, true, JSON.stringify(result));
});

test('a GET where a branch action changed does not verify', async () => {
  const result = await createWithGet(SPEC, (rule) => {
    const got = reassignIds(rule);
    got.components[1].children[0].children[0].value = 'tampered';
    return got;
  });
  assert.equal(result.ok, false);
});
