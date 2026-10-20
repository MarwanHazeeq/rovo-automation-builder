import assert from 'node:assert/strict';
import test from 'node:test';
import { buildRulePayload } from '../src/index.js';

// ruleSpec.branches: one if.block per branch inside ONE container, each with
// its own id wired to its own conditions and actions.

const TRIGGER = { type: 'jira.issue.event.trigger:created' };
const COND = { type: 'jira.comparator.condition', value: { first: 'a', second: 'b', operator: 'EQUALS' } };
const LOG = (text) => ({ type: 'codebarrel.action.log', value: text });

function build(spec) {
  return buildRulePayload({ name: 'Branches', projectId: '10086', trigger: TRIGGER, ...spec }, 'test-cloud', 'test-actor', null);
}


const twoBranches = () => build({
  branches: [
    { conditions: [COND], actions: [LOG('one'), LOG('two')] },
    { conditions: [], actions: [LOG('else')] },
  ],
});

test('two branches, second empty: one container, two if.blocks in order, else last', () => {
  const { rule } = twoBranches();
  assert.equal(rule.components.length, 1);
  const container = rule.components[0];
  assert.equal(container.type, 'jira.condition.container.block');
  assert.equal(container.children.length, 2);
  assert.ok(container.children.every((block) => block.type === 'jira.condition.if.block'));
  assert.equal(container.children[0].conditions.length, 1);
  assert.equal(container.children[1].conditions.length, 0);
  assert.equal(container.children[1].children[0].value, 'else');
});

test('three branches without an else: three if.blocks, none empty', () => {
  const { rule } = build({
    branches: [1, 2, 3].map((n) => ({ conditions: [COND], actions: [LOG(`b${n}`)] })),
  });
  const blocks = rule.components[0].children;
  assert.equal(blocks.length, 3);
  assert.ok(blocks.every((block) => block.conditions.length === 1));
});

test('each branch has its own block id wired to its conditions, actions and the container', () => {
  const { rule } = twoBranches();
  const container = rule.components[0];
  const [first, second] = container.children;
  assert.notEqual(first.id, second.id);
  for (const block of container.children) {
    assert.equal(block.parentId, container.id);
    for (const condition of block.conditions) assert.equal(condition.conditionParentId, block.id);
    for (const action of block.children) assert.equal(action.parentId, block.id);
  }
});

test('an empty-conditions branch that is not last throws', () => {
  assert.throws(
    () => build({ branches: [{ conditions: [], actions: [LOG('a')] }, { conditions: [COND], actions: [LOG('b')] }] }),
    /unreachable/
  );
});

test('two empty-conditions branches throw', () => {
  assert.throws(
    () => build({ branches: [{ conditions: [], actions: [LOG('a')] }, { conditions: [], actions: [LOG('b')] }] }),
    /unreachable/
  );
});

test('a branch with no actions throws', () => {
  assert.throws(() => build({ branches: [{ conditions: [COND], actions: [] }] }), /no actions/);
});

test('branches must be a non-empty array', () => {
  assert.throws(() => build({ branches: [] }), /non-empty array/);
  assert.throws(() => build({ branches: 'x' }), /non-empty array/);
});

test('conditionMatchType is validated per branch', () => {
  assert.throws(
    () => build({ branches: [{ conditionMatchType: 'SOME', conditions: [COND], actions: [LOG('a')] }] }),
    /conditionMatchType must be one of/
  );
  const { rule } = build({ branches: [{ conditionMatchType: 'ANY', conditions: [COND], actions: [LOG('a')] }] });
  assert.equal(rule.components[0].children[0].value.conditionMatchType, 'ANY');
});

test('branches together with top-level conditions throws', () => {
  assert.throws(
    () => build({ conditions: [COND], branches: [{ conditions: [COND], actions: [LOG('a')] }] }),
    /both "branches" and top-level "conditions"/
  );
});

test('branches together with top-level actions is not rejected', () => {
  assert.doesNotThrow(() =>
    build({ actions: [LOG('setup')], branches: [{ conditions: [COND], actions: [LOG('a')] }] }));
});

test('branched rules are still created DISABLED', () => {
  assert.equal(twoBranches().rule.state, 'DISABLED');
});

test('flat conditions + actions still build one block sharing one id', () => {
  const { rule } = build({ conditions: [COND, COND], actions: [LOG('x'), LOG('y')], conditionMatchType: 'ANY' });
  const [container] = rule.components;
  assert.equal(container.children.length, 1);
  const [block] = container.children;
  assert.equal(block.parentId, container.id);
  assert.equal(block.value.conditionMatchType, 'ANY');
  assert.deepEqual(block.conditions.map((c) => c.conditionParentId), [block.id, block.id]);
  assert.deepEqual(block.children.map((a) => a.parentId), [block.id, block.id]);
});

test('flat actions without conditions stay at the top level with a null parent', () => {
  const { rule } = build({ actions: [LOG('x'), LOG('y')] });
  assert.equal(rule.components.length, 2);
  assert.ok(rule.components.every((c) => c.component === 'ACTION' && c.parentId === null));
});

test('flat spec with neither conditions nor actions keeps its error', () => {
  assert.throws(() => build({}), /Provide at least one condition or action\./);
});
