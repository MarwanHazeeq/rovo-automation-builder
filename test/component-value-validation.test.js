import assert from 'node:assert/strict';
import test from 'node:test';
import { createJiraAutomationRule } from '../src/index.js';

function mockResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

// Builds a rule with the given actions/conditions and returns the result plus
// the payload that would have been sent. A rejected value must never reach the
// POST at all.
async function build({ actions = [], conditions = [] }) {
  const previousEnv = { ...process.env };
  const previousFetch = globalThis.fetch;
  let posted = false;
  let createdRule;

  Object.assign(process.env, {
    AUTOMATION_API_EMAIL: 'a@b.test',
    AUTOMATION_API_TOKEN: 't',
    JIRA_CLOUD_ID: 'test-cloud',
    AUTOMATION_RULE_ACTOR_ACCOUNT_ID: 'actor',
  });
  globalThis.fetch = async (url, options = {}) => {
    if (url.endsWith('/rest/api/3/field')) return mockResponse(200, []);
    if (options.method === 'POST') {
      posted = true;
      createdRule = JSON.parse(options.body).rule;
      return mockResponse(201, { ruleUuid: 'x' });
    }
    return mockResponse(200, { rule: createdRule });
  };
  try {
    const result = await createJiraAutomationRule({
      ruleSpec: JSON.stringify({
        name: 'Value validation',
        projectId: '10449',
        trigger: { type: 'jira.issue.event.trigger:created' },
        conditions,
        actions,
      }),
    });
    return { result, posted };
  } finally {
    process.env = previousEnv;
    globalThis.fetch = previousFetch;
  }
}

test('rejects the wait shape that produced the opaque 500', async () => {
  const { result, posted } = await build({
    actions: [{ type: 'action.wait.for.time.duration', value: { delay: 10 } }],
  });

  assert.equal(result.ok, false);
  assert.match(result.error, /missing waitTimeInSeconds, randomWaitInterval/);
  assert.match(result.error, /unexpected delay/);
  assert.equal(posted, false, 'a malformed value must not reach Atlassian');
});

test('rejects an object value for the audit-log action', async () => {
  const { result, posted } = await build({
    actions: [{ type: 'codebarrel.action.log', value: { logMessage: 'hello' } }],
  });

  assert.equal(result.ok, false);
  assert.match(result.error, /takes a bare string value/);
  assert.equal(posted, false);
});

test('accepts a bare string for the audit-log action', async () => {
  const { result } = await build({
    actions: [{ type: 'codebarrel.action.log', value: 'hello {{issue.key}}' }],
  });
  assert.equal(result.ok, true);
});

test('rejects a create-variable value missing the verified type and lazy keys', async () => {
  const { result } = await build({
    actions: [{
      type: 'jira.create.variable',
      value: {
        id: '_v1',
        name: { type: 'FREE', value: 'myVar' },
        query: { type: 'SMART', value: '{{issue.key}}' },
      },
    }],
  });

  assert.equal(result.ok, false);
  assert.match(result.error, /missing type, lazy/);
});

test('accepts a fully-shaped create-variable value', async () => {
  const { result } = await build({
    actions: [{
      type: 'jira.create.variable',
      value: {
        id: '_v1',
        name: { type: 'FREE', value: 'myVar' },
        type: 'SMART',
        query: { type: 'SMART', value: '{{issue.key}}' },
        lazy: false,
      },
    }],
  });
  assert.equal(result.ok, true);
});

test('rejects an unverified comparator operator', async () => {
  const { result } = await build({
    conditions: [{
      type: 'jira.comparator.condition',
      value: { first: '{{issue.key}}', second: 'X', operator: 'CONTAINS' },
    }],
  });

  assert.equal(result.ok, false);
  assert.match(result.error, /is not verified on this tenant/);
  assert.match(result.error, /EQUALS, NOT_EQUALS, GREATER_THAN, LESS_THAN/);
});

test('accepts a verified comparator operator', async () => {
  const { result } = await build({
    conditions: [{
      type: 'jira.comparator.condition',
      value: {
        first: '{{changelog.status.fromString}}',
        second: '{{changelog.status.toString}}',
        operator: 'NOT_EQUALS',
      },
    }],
  });
  assert.equal(result.ok, true);
});

test('the error names the full verified shape so the caller can self-correct', async () => {
  const { result } = await build({
    actions: [{ type: 'jira.issue.refresh.issue', value: {} }],
  });

  assert.equal(result.ok, false);
  assert.match(result.error, /The verified shape has exactly: delayMs/);
});

test('an unverified action type is named in the error, not just the allowlist', async () => {
  const { result, posted } = await build({
    actions: [{ type: 'jira.issue.log.invented', value: 'x' }],
  });

  assert.equal(result.ok, false);
  assert.equal(result.ruleCreated, false);
  // Naming the rejected type is the whole point: without it neither the caller
  // nor the logs can tell which of a dozen actions was wrong.
  assert.match(result.error, /received "jira\.issue\.log\.invented"/);
  assert.match(result.error, /Allowed: /);
  assert.equal(posted, false);
});

test('an action with no type is described rather than reported as blank', async () => {
  const { result } = await build({ actions: [{ value: 'x' }] });

  assert.equal(result.ok, false);
  assert.match(result.error, /an action with no "type"/);
});

test('an unverified condition type is named too', async () => {
  const { result } = await build({
    conditions: [{ type: 'jira.invented.condition', value: {} }],
  });

  assert.equal(result.ok, false);
  assert.match(result.error, /received "jira\.invented\.condition"/);
});

test('every failure carries ruleCreated false, the claim that gets misreported', async () => {
  const { result } = await build({
    actions: [{ type: 'action.wait.for.time.duration', value: { delay: 10 } }],
  });

  assert.equal(result.ruleCreated, false);
  assert.equal(result.ruleUuid, undefined);
});