import assert from 'node:assert/strict';
import test from 'node:test';
import { buildRulePayload, createJiraAutomationRule } from '../src/index.js';

// ruleSpec.branches: one rule expressing if / else-if / else.

const TRIGGER = { type: 'jira.issue.event.trigger:created' };
const IS_HIGH = {
  type: 'jira.comparator.condition',
  value: { first: '{{issue.priority.name}}', second: 'High', operator: 'EQUALS' },
};
const IS_LOW = {
  type: 'jira.comparator.condition',
  value: { first: '{{issue.priority.name}}', second: 'Low', operator: 'EQUALS' },
};
const log = (text) => ({ type: 'codebarrel.action.log', value: text });

function build(spec) {
  return buildRulePayload(
    { name: 'Branch check', projectId: '10086', trigger: TRIGGER, ...spec },
    'test-cloud',
    'test-actor',
    null
  );
}

test('two branches, second with empty conditions: one container, two if.blocks in order', () => {
  const { rule } = build({
    branches: [
      { conditions: [IS_HIGH], actions: [log('escalate')] },
      { conditions: [], actions: [log('flag')] },
    ],
  });
  assert.equal(rule.components.length, 1);
  const container = rule.components[0];
  assert.equal(container.type, 'jira.condition.container.block');
  assert.equal(container.children.length, 2);
  const [ifBlock, elseBlock] = container.children;
  assert.equal(ifBlock.type, 'jira.condition.if.block');
  assert.equal(ifBlock.conditions.length, 1);
  assert.equal(ifBlock.children[0].value, 'escalate');
  assert.equal(elseBlock.conditions.length, 0);
  assert.equal(elseBlock.children[0].value, 'flag');
  assert.equal(rule.state, 'DISABLED');
});

test('three branches, no else: three if.blocks, none with empty conditions', () => {
  const { rule } = build({
    branches: [
      { conditions: [IS_HIGH], actions: [log('a')] },
      { conditions: [IS_LOW], conditionMatchType: 'ANY', actions: [log('b')] },
      { conditions: [IS_HIGH, IS_LOW], actions: [log('c')] },
    ],
  });
  const blocks = rule.components[0].children;
  assert.equal(blocks.length, 3);
  assert.ok(blocks.every((block) => block.conditions.length > 0));
  assert.deepEqual(blocks.map((block) => block.value.conditionMatchType), ['ALL', 'ANY', 'ALL']);
});

test('each branch wires its own block id into its conditions, actions and parent', () => {
  const { rule } = build({
    branches: [
      { conditions: [IS_HIGH], actions: [log('a')] },
      { conditions: [IS_LOW], actions: [log('b')] },
      { conditions: [], actions: [log('c')] },
    ],
  });
  const container = rule.components[0];
  const ids = container.children.map((block) => block.id);
  assert.equal(new Set(ids).size, 3);
  for (const block of container.children) {
    assert.equal(block.parentId, container.id);
    for (const condition of block.conditions) assert.equal(condition.conditionParentId, block.id);
    for (const action of block.children) assert.equal(action.parentId, block.id);
  }
});

test('an empty-conditions branch in the middle throws', () => {
  assert.throws(() => build({
    branches: [
      { conditions: [], actions: [log('a')] },
      { conditions: [IS_HIGH], actions: [log('b')] },
    ],
  }), /Only the LAST branch may have empty conditions/);
});

test('two empty-conditions branches throw', () => {
  assert.throws(() => build({
    branches: [
      { conditions: [IS_HIGH], actions: [log('a')] },
      { conditions: [], actions: [log('b')] },
      { conditions: [], actions: [log('c')] },
    ],
  }), /unreachable/);
});

test('a branch with no actions throws', () => {
  assert.throws(() => build({
    branches: [{ conditions: [IS_HIGH], actions: [] }, { conditions: [], actions: [log('b')] }],
  }), /branches\[0\] has no actions/);
});

test('both branches and top-level actions throws', () => {
  assert.throws(() => build({
    branches: [{ conditions: [IS_HIGH], actions: [log('a')] }],
    actions: [log('b')],
  }), /EITHER "branches" OR/);
});

test('flat conditions + actions still build one if.block, ids wired together', () => {
  const { rule } = build({ conditions: [IS_HIGH], actions: [log('a')] });
  const [container] = rule.components;
  assert.equal(container.children.length, 1);
  const block = container.children[0];
  assert.equal(block.conditions[0].conditionParentId, block.id);
  assert.equal(block.children[0].parentId, block.id);
  assert.equal(block.parentId, container.id);
});

test('flat actions with no conditions stay at the top level with a null parent', () => {
  const { rule } = build({ actions: [log('a')] });
  assert.equal(rule.components.length, 1);
  assert.equal(rule.components[0].type, 'codebarrel.action.log');
  assert.equal(rule.components[0].parentId, null);
});

test('a branched rule goes through createJiraAutomationRule and is created DISABLED', async () => {
  const saved = {
    AUTOMATION_API_EMAIL: process.env.AUTOMATION_API_EMAIL,
    AUTOMATION_API_TOKEN: process.env.AUTOMATION_API_TOKEN,
    JIRA_CLOUD_ID: process.env.JIRA_CLOUD_ID,
    AUTOMATION_RULE_ACTOR_ACCOUNT_ID: process.env.AUTOMATION_RULE_ACTOR_ACCOUNT_ID,
  };
  const savedFetch = globalThis.fetch;
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
    return { status: 200, text: async () => JSON.stringify({ rule: created }) };
  };
  try {
    const result = await createJiraAutomationRule({
      ruleSpec: JSON.stringify({
        name: 'Escalate or flag',
        projectId: '10086',
        trigger: TRIGGER,
        branches: [
          { conditions: [IS_HIGH], actions: [log('escalate')] },
          { conditions: [], actions: [log('flag')] },
        ],
      }),
    });
    assert.equal(result.ok, true);
    assert.equal(created.state, 'DISABLED');
    assert.equal(created.components[0].children.length, 2);
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    globalThis.fetch = savedFetch;
  }
});
