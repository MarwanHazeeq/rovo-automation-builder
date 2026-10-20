import assert from 'node:assert/strict';
import test from 'node:test';
import { BRANCH_WORDS, buildRulePayload, countBranches, findBranchWords, prepareRule } from '../src/index.js';
import { buildCard } from '../src/mark-request-ready.js';

// Checks that run on what the agent sends, whatever the requester said: the
// branch-word check on requestText, the refusal of values nobody supplied, and
// the project name carried back for the approval ticket.

// Same fetch-mocking approach as index.test.js: swap globalThis.fetch and the
// Forge environment variables for the duration of one callback.
async function withForgeEnvironment(fetchImplementation, callback) {
  const previousValues = {
    AUTOMATION_API_EMAIL: process.env.AUTOMATION_API_EMAIL,
    AUTOMATION_API_TOKEN: process.env.AUTOMATION_API_TOKEN,
    JIRA_CLOUD_ID: process.env.JIRA_CLOUD_ID,
    AUTOMATION_RULE_ACTOR_ACCOUNT_ID: process.env.AUTOMATION_RULE_ACTOR_ACCOUNT_ID,
  };
  const previousFetch = globalThis.fetch;
  Object.assign(process.env, {
    AUTOMATION_API_EMAIL: 'automation@example.test',
    AUTOMATION_API_TOKEN: 'test-token',
    JIRA_CLOUD_ID: 'test-cloud',
    AUTOMATION_RULE_ACTOR_ACCOUNT_ID: 'test-actor',
  });
  globalThis.fetch = fetchImplementation;
  try {
    return await callback();
  } finally {
    for (const [key, value] of Object.entries(previousValues)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    globalThis.fetch = previousFetch;
  }
}

const mockResponse = (status, body) => ({ status, text: async () => JSON.stringify(body) });

// Only the project search is ever asked for: these specs need no field metadata.
const projectSearch = async () => mockResponse(200, {
  isLast: true,
  values: [{ id: '10100', key: 'SOCD', name: 'SOCDemo' }],
});

const LOG = (text) => ({ type: 'codebarrel.action.log', value: text });
const PRIORITY_CONDITION = {
  type: 'jira.comparator.condition',
  value: { first: '{{issue.priority.name}}', second: 'High', operator: 'EQUALS' },
};

const ONE_BRANCH = { actions: [LOG('escalate'), LOG('flag')] };
const TWO_BRANCHES = {
  branches: [
    { conditions: [PRIORITY_CONDITION], actions: [LOG('escalate')] },
    { conditions: [], actions: [LOG('flag')] },
  ],
};

function prepare(specBody, requestText) {
  const payload = {
    ruleSpec: JSON.stringify({
      name: 'High priority',
      projectName: 'SOCDemo',
      trigger: { type: 'jira.issue.event.trigger:created' },
      ...specBody,
    }),
    ...(requestText === undefined ? {} : { requestText }),
  };
  return withForgeEnvironment(projectSearch, () => prepareRule(payload));
}

const OTHERWISE = 'If nobody picks them up quickly it should escalate, otherwise just flag it.';

test('a branch word with only one branch is refused, naming the problem and the way out', async () => {
  const result = await prepare(ONE_BRANCH, OTHERWISE);
  assert.equal(result.ok, false);
  assert.match(result.error, /more than one case/);
  assert.match(result.error, /"otherwise"/);
  assert.match(result.error, /only one branch/);
  assert.match(result.error, /Confirm with the requester what should happen in each case/);
  assert.match(result.error, /send a branch for each/);
});

test('the same request with two branches proceeds', async () => {
  const result = await prepare(TWO_BRANCHES, OTHERWISE);
  assert.equal(result.ok, true);
  assert.equal(result.rule.state, 'DISABLED');
});

test('a request with no branch word and one branch proceeds', async () => {
  const result = await prepare(ONE_BRANCH, 'Log a message when an issue is created.');
  assert.equal(result.ok, true);
});

test('a rule with two cases anywhere inside it counts as having several cases', async () => {
  const nested = {
    branches: [{
      conditions: [PRIORITY_CONDITION],
      branches: [
        { conditions: [PRIORITY_CONDITION], actions: [LOG('a')] },
        { conditions: [], actions: [LOG('b')] },
      ],
    }],
  };
  const result = await prepare(nested, OTHERWISE);
  assert.equal(result.ok, true);
  assert.equal(countBranches(result.rule), 3);
  assert.equal(countBranches((await prepare(ONE_BRANCH)).rule), 1);
});

test('the check applies to a full pasted payload too', async () => {
  const full = (await prepare(ONE_BRANCH)).rule;
  const payload = { ruleSpec: JSON.stringify({ rule: full }), requestText: 'Escalate unless it is assigned.' };
  const result = await withForgeEnvironment(projectSearch, () => prepareRule(payload));
  assert.equal(result.ok, false);
  assert.match(result.error, /more than one case/);
});

test('branch words match whole words only, in any case, and a pair needs both words', () => {
  assert.deepEqual(findBranchWords('Escalate UNLESS it is assigned'), ['unless']);
  assert.deepEqual(findBranchWords('Do X.\nOr   Else do Y'), ['or else']);
  assert.deepEqual(findBranchWords('In that case, page the lead'), ['in that case']);
  assert.deepEqual(findBranchWords('Notify depending on the severity'), ['depending on']);
  assert.deepEqual(findBranchWords('If it is P1 escalate, else flag it'), ['if ... else']);
  // Not whole words.
  assert.deepEqual(findBranchWords('unlessX, otherwiseness, elsewhere, notify someone else'), []);
  // "if" alone, or "else" alone, is not a branch.
  assert.deepEqual(findBranchWords('If it is P1, escalate'), []);
  assert.deepEqual(findBranchWords('Tell someone else'), []);
  assert.ok(BRANCH_WORDS.includes('otherwise'));
});

// --- values nobody supplied --------------------------------------------------

const SCHEDULED = (schedule) => prepare({
  trigger: { type: 'jira.jql.scheduled', jql: 'status = Open', ...(schedule ? { schedule } : {}) },
  actions: [LOG('x')],
});

test('a schedule without a time zone is refused in the requester\'s words', async () => {
  const result = await SCHEDULED({ days: ['MO'], hour: 9, minute: 0 });
  assert.equal(result.ok, false);
  assert.match(result.error, /requester did not say which time zone/);
  assert.match(result.error, /do not assume one/);
});

test('a schedule without a time of day or days is refused, and a complete one builds', async () => {
  const noTime = await SCHEDULED({ days: ['MO'], timezone: 'Asia/Kuala_Lumpur' });
  assert.match(noTime.error, /requester did not say what time of day/);
  const noDays = await SCHEDULED({ hour: 9, minute: 30, timezone: 'Asia/Kuala_Lumpur' });
  assert.match(noDays.error, /requester did not say which days of the week/);
  const done = await SCHEDULED({ days: ['MO'], hour: 9, minute: 30, timezone: 'Asia/Kuala_Lumpur' });
  assert.equal(done.ok, true);
  assert.match(done.rule.trigger.value.schedule.rRule, /TZID=Asia\/Kuala_Lumpur/);
  assert.match(done.rule.trigger.value.schedule.rRule, /BYHOUR=9;BYMINUTE=30/);
});

test('a branch with no conditions key is refused rather than becoming the else', async () => {
  const result = await prepare({ branches: [{ actions: [LOG('a')] }] });
  assert.equal(result.ok, false);
  assert.match(result.error, /has no "conditions"/);
  assert.match(result.error, /"conditions": \[\] if it is the else/);
});

test('two conditions with no ALL or ANY choice are refused, but one condition needs none', async () => {
  const two = await prepare({ conditions: [PRIORITY_CONDITION, PRIORITY_CONDITION], actions: [LOG('a')] });
  assert.equal(two.ok, false);
  assert.match(two.error, /did not say whether ALL of them must be true or just ANY one/);
  const withChoice = await prepare({
    conditions: [PRIORITY_CONDITION, PRIORITY_CONDITION], conditionMatchType: 'ANY', actions: [LOG('a')],
  });
  assert.equal(withChoice.ok, true);
  assert.equal((await prepare({ conditions: [PRIORITY_CONDITION], actions: [LOG('a')] })).ok, true);
});

test('every rule is still created DISABLED', async () => {
  for (const spec of [ONE_BRANCH, TWO_BRANCHES]) {
    assert.equal((await prepare(spec)).rule.state, 'DISABLED');
  }
  const built = buildRulePayload(
    { name: 'x', projectId: '10449', trigger: { type: 'jira.issue.event.trigger:created' }, ...ONE_BRANCH },
    'test-cloud', 'test-actor', null
  );
  assert.equal(built.rule.state, 'DISABLED');
});

// --- the project is carried back for the ticket and the card -------------------

test('prepareRule returns the project name when the spec named it, and null for an id alone', async () => {
  assert.equal((await prepare(ONE_BRANCH)).projectName, 'SOCDemo');
  const byId = await withForgeEnvironment(projectSearch, () => prepareRule({
    ruleSpec: JSON.stringify({
      name: 'x', projectId: '10449', trigger: { type: 'jira.issue.event.trigger:created' }, ...ONE_BRANCH,
    }),
  }));
  assert.equal(byId.ok, true);
  assert.equal(byId.projectName, null);
});

test('the Teams card shows the target project, and omits the line when none is given', () => {
  const facts = (targetProject) =>
    buildCard({ issueKey: 'SOC-1', summary: 's', requestedBy: 'r', targetProject, siteUrl: 'https://x.test' })
      .attachments[0].content.body[1].facts;
  assert.deepEqual(facts('SOCDemo (ID 10100)')[2], { title: 'Target project', value: 'SOCDemo (ID 10100)' });
  assert.equal(facts(null).length, 3);
});
