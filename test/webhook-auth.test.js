import assert from 'node:assert/strict';
import test from 'node:test';
import { createJiraAutomationRule } from '../src/index.js';

function mockResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

async function buildRule(webhookValue) {
  const previousEnv = { ...process.env };
  const previousFetch = globalThis.fetch;
  let createdRule;

  Object.assign(process.env, {
    AUTOMATION_API_EMAIL: 'automation@example.test',
    AUTOMATION_API_TOKEN: 'build-token',
    JIRA_CLOUD_ID: 'test-cloud',
    AUTOMATION_RULE_ACTOR_ACCOUNT_ID: 'test-actor',
  });

  globalThis.fetch = async (url, options = {}) => {
    if (url.endsWith('/rest/api/3/field')) return mockResponse(200, []);
    if (options.method === 'POST') {
      createdRule = JSON.parse(options.body).rule;
      return mockResponse(201, { ruleUuid: 'created-rule-id' });
    }
    return mockResponse(200, { rule: createdRule });
  };

  try {
    const result = await createJiraAutomationRule({
      ruleSpec: JSON.stringify({
        name: 'Changelog read',
        projectId: '10449',
        trigger: { type: 'jira.issue.event.trigger:created' },
        actions: [{ type: 'jira.issue.outgoing.webhook', value: webhookValue }],
      }),
    });
    return { result, createdRule };
  } finally {
    process.env = previousEnv;
    globalThis.fetch = previousFetch;
  }
}

const SITE_URL =
  'https://logicalisasia.atlassian.net/rest/api/3/issue/GSC-1/changelog?startAt=0&maxResults=1';

test('builds a web request with no Authorization header and both flags on', async () => {
  const { result, createdRule } = await buildRule({ url: SITE_URL });

  assert.equal(result.ok, true);
  const value = createdRule.components[0].value;
  assert.equal(value.headers.length, 0);
  assert.equal(value.responseEnabled, true);
  assert.equal(value.continueOnErrorEnabled, true);
  // The whole payload must be free of anything credential-shaped.
  assert.ok(!JSON.stringify(createdRule).toLowerCase().includes('authorization'));
});

test('tells the caller the credential is a required manual step', async () => {
  const { result } = await buildRule({ url: SITE_URL });

  assert.equal(result.ok, true);
  assert.match(result.manualStepRequired, /NO Authorization header/);
  assert.match(result.manualStepRequired, /before enabling the rule/);
});

test('a rule with no web request carries no manual-step note', async () => {
  const previousEnv = { ...process.env };
  const previousFetch = globalThis.fetch;
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
      createdRule = JSON.parse(options.body).rule;
      return mockResponse(201, { ruleUuid: 'x' });
    }
    return mockResponse(200, { rule: createdRule });
  };
  try {
    const result = await createJiraAutomationRule({
      ruleSpec: JSON.stringify({
        name: 'No webhook here',
        projectId: '10449',
        trigger: { type: 'jira.issue.event.trigger:created' },
        actions: [{ type: 'codebarrel.action.log', value: '{{issue.key}}' }],
      }),
    });
    assert.equal(result.ok, true);
    assert.equal(result.manualStepRequired, undefined);
  } finally {
    process.env = previousEnv;
    globalThis.fetch = previousFetch;
  }
});

test('refuses a caller-supplied Authorization header rather than stripping it silently', async () => {
  const { result } = await buildRule({
    url: SITE_URL,
    headers: [
      { id: '_h1', name: 'Authorization', value: 'Basic SGFsbG8gdGhlcmU=', headerSecure: false },
    ],
  });

  assert.equal(result.ok, false);
  assert.match(result.error, /does not put credentials in rules/);
  // The refusal must not echo the credential back.
  assert.ok(!JSON.stringify(result).includes('SGFsbG8gdGhlcmU='));
});

test('refuses a lowercase authorization header too', async () => {
  const { result } = await buildRule({
    url: 'https://example.com/hook',
    headers: [{ id: '_h1', name: 'authorization', value: 'Bearer leaked', headerSecure: false }],
  });

  assert.equal(result.ok, false);
  assert.match(result.error, /does not put credentials in rules/);
});

test('authenticate:true inserts a masked placeholder, never a credential', async () => {
  const { result, createdRule } = await buildRule({ url: SITE_URL, authenticate: true });

  assert.equal(result.ok, true);
  const headers = createdRule.components[0].value.headers;
  const auth = headers.find((h) => h.name === 'Authorization');
  assert.ok(auth, 'the header must exist so the human only edits its value');
  assert.equal(auth.value, 'REPLACE_ME_BEFORE_ENABLING');
  // Masked from the start, so pasting the real value does not leave it visible.
  assert.equal(auth.headerSecure, true);
  // The flag is this app's own input, not part of Jira's component shape.
  assert.equal('authenticate' in createdRule.components[0].value, false);
});

test('the placeholder is called out as the step blocking enablement', async () => {
  const { result } = await buildRule({ url: SITE_URL, authenticate: true });

  assert.match(result.manualStepRequired, /REPLACE_ME_BEFORE_ENABLING/);
  assert.match(result.manualStepRequired, /before enabling the rule/);
});

test('without the flag no Authorization header is added at all', async () => {
  const { createdRule } = await buildRule({ url: SITE_URL });
  assert.equal(createdRule.components[0].value.headers.length, 0);
});

test('non-credential headers pass through untouched', async () => {
  const { result, createdRule } = await buildRule({
    url: 'https://example.com/hook',
    method: 'POST',
    contentType: 'custom',
    customBody: '{{issue.key}}',
    headers: [{ id: '_h1', name: 'Content-Type', value: 'application/json', headerSecure: false }],
  });

  assert.equal(result.ok, true);
  assert.equal(createdRule.components[0].value.headers.length, 1);
  assert.equal(createdRule.components[0].value.method, 'POST');
});

test('a failure response never echoes rule headers back to the agent', async () => {
  const previousEnv = { ...process.env };
  const previousFetch = globalThis.fetch;
  Object.assign(process.env, {
    AUTOMATION_API_EMAIL: 'a@b.test',
    AUTOMATION_API_TOKEN: 't',
    JIRA_CLOUD_ID: 'test-cloud',
    AUTOMATION_RULE_ACTOR_ACCOUNT_ID: 'actor',
  });

  let createdRule;
  globalThis.fetch = async (url, options = {}) => {
    if (url.endsWith('/rest/api/3/field')) return mockResponse(200, []);
    if (options.method === 'POST') {
      createdRule = JSON.parse(options.body).rule;
      return mockResponse(201, { ruleUuid: 'x' });
    }
    // Simulate a rule that has since had a credential added by hand, coming
    // back through the verification GET.
    const tampered = JSON.parse(JSON.stringify(createdRule));
    // state is what verifyCreatedRule actually checks; the rule name is not.
    tampered.state = 'ENABLED';
    tampered.components[0].value.headers = [
      { id: '_h', name: 'Authorization', value: 'Basic TOPSECRETVALUE', headerSecure: true },
    ];
    return mockResponse(200, { rule: tampered });
  };

  try {
    const result = await createJiraAutomationRule({
      ruleSpec: JSON.stringify({
        name: 'Changelog read',
        projectId: '10449',
        trigger: { type: 'jira.issue.event.trigger:created' },
        actions: [{ type: 'jira.issue.outgoing.webhook', value: { url: SITE_URL } }],
      }),
    });

    assert.equal(result.ok, false);
    const serialized = JSON.stringify(result);
    assert.ok(!serialized.includes('TOPSECRETVALUE'), 'a hand-added credential must not leak back');
    assert.ok(serialized.includes('[redacted]'));
  } finally {
    process.env = previousEnv;
    globalThis.fetch = previousFetch;
  }
});
