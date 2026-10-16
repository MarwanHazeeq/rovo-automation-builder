import assert from 'node:assert/strict';
import test from 'node:test';
import { prepareRule } from '../src/index.js';

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

function mockResponse(status, body) {
  return { status, text: async () => JSON.stringify(body) };
}

const SOC = { id: '10086', key: 'SOC', name: 'SOC' };
const SOC_DEMO = { id: '10100', key: 'SOCD', name: 'SOCDemo' };
const SOC_ARCHIVE = { id: '10101', key: 'SOCA', name: 'SOCArchive' };

// A fetch that answers project/search with the given pages (one body per
// call, in order) and records every URL it was asked for.
function projectSearchFetch(pages, calls = []) {
  return async (url) => {
    calls.push(url);
    assert.ok(url.includes('/rest/api/3/project/search'), `unexpected request ${url}`);
    const body = pages[calls.length - 1];
    assert.ok(body, `no mocked page for request ${calls.length}`);
    return mockResponse(200, body);
  };
}

function specWith(project) {
  return {
    ruleSpec: JSON.stringify({
      name: 'Log creation',
      ...project,
      trigger: { type: 'jira.issue.event.trigger:created' },
      actions: [{ type: 'codebarrel.action.log', value: 'hello' }],
    }),
  };
}

const onePage = (values) => ({ values, isLast: true, total: values.length });

test('an exact single match resolves and the scope ARI carries its id', async () => {
  const calls = [];
  const result = await withForgeEnvironment(
    projectSearchFetch([onePage([SOC_DEMO])], calls),
    () => prepareRule(specWith({ projectName: 'SOCDemo' }))
  );

  assert.equal(result.ok, true);
  assert.deepEqual(result.rule.ruleScopeARIs, ['ari:cloud:jira:test-cloud:project/10100']);
  assert.match(calls[0], /project\/search\?query=SOCDemo&/);
});

test('case and surrounding whitespace do not stop a name matching', async () => {
  const result = await withForgeEnvironment(
    projectSearchFetch([onePage([{ ...SOC_DEMO, name: ' SOCDemo ' }])]),
    () => prepareRule(specWith({ projectName: '  socdemo ' }))
  );

  assert.equal(result.ok, true);
  assert.deepEqual(result.rule.ruleScopeARIs, ['ari:cloud:jira:test-cloud:project/10100']);
});

test('the query is url-encoded', async () => {
  const calls = [];
  await withForgeEnvironment(
    projectSearchFetch([onePage([{ id: '1', key: 'AB', name: 'A&B Team' }])], calls),
    () => prepareRule(specWith({ projectName: 'A&B Team' }))
  );

  assert.match(calls[0], /query=A%26B%20Team&/);
});

test('substring-only candidates do not resolve to anything', async () => {
  const result = await withForgeEnvironment(
    projectSearchFetch([onePage([SOC, SOC_DEMO, SOC_ARCHIVE])]),
    () => prepareRule(specWith({ projectName: 'SOCDem' }))
  );

  assert.equal(result.ok, false);
  assert.equal(result.ruleCreated, false);
  assert.match(result.error, /projectName "SOCDem" matched no project/);
  assert.match(result.error, /SOC, SOCDemo, SOCArchive/);
});

test('a query that substring-matches several projects still picks the exact name', async () => {
  const result = await withForgeEnvironment(
    projectSearchFetch([onePage([SOC, SOC_DEMO, SOC_ARCHIVE])]),
    () => prepareRule(specWith({ projectName: 'SOC' }))
  );

  assert.equal(result.ok, true);
  assert.deepEqual(result.rule.ruleScopeARIs, ['ari:cloud:jira:test-cloud:project/10086']);
});

test('zero matches throws, naming the searched term and capping the candidate list', async () => {
  const many = Array.from({ length: 12 }, (_, i) => ({
    id: String(200 + i),
    key: `P${i}`,
    name: `Project ${i}`,
  }));
  const result = await withForgeEnvironment(
    projectSearchFetch([onePage(many)]),
    () => prepareRule(specWith({ projectName: 'Project' }))
  );

  assert.equal(result.ok, false);
  assert.match(result.error, /projectName "Project" matched no project/);
  assert.match(result.error, /first 10 of 12/);
  assert.match(result.error, /Project 9/);
  assert.doesNotMatch(result.error, /Project 10/);
});

test('an empty search result says so', async () => {
  const result = await withForgeEnvironment(
    projectSearchFetch([onePage([])]),
    () => prepareRule(specWith({ projectName: 'Nope' }))
  );

  assert.equal(result.ok, false);
  assert.match(result.error, /"Nope" matched no project\. The search returned no projects/);
});

test('two exact-name matches throw and list both keys instead of picking one', async () => {
  const result = await withForgeEnvironment(
    projectSearchFetch([onePage([SOC_DEMO, { id: '10200', key: 'SDEMO2', name: 'SOCDemo' }])]),
    () => prepareRule(specWith({ projectName: 'SOCDemo' }))
  );

  assert.equal(result.ok, false);
  assert.match(result.error, /matches more than one project/);
  assert.match(result.error, /key SOCD/);
  assert.match(result.error, /key SDEMO2/);
  assert.match(result.error, /do not pick one/);
});

test('a match on the second page is found', async () => {
  const calls = [];
  const result = await withForgeEnvironment(
    projectSearchFetch(
      [
        { values: [SOC, SOC_ARCHIVE], isLast: false, total: 3 },
        { values: [SOC_DEMO], isLast: true, total: 3 },
      ],
      calls
    ),
    () => prepareRule(specWith({ projectName: 'SOCDemo' }))
  );

  assert.equal(result.ok, true);
  assert.equal(calls.length, 2);
  assert.match(calls[1], /startAt=2&/);
  assert.deepEqual(result.rule.ruleScopeARIs, ['ari:cloud:jira:test-cloud:project/10100']);
});

test('a duplicate name split across pages is still caught', async () => {
  const result = await withForgeEnvironment(
    projectSearchFetch([
      { values: [SOC_DEMO], isLast: false, total: 2 },
      { values: [{ id: '10200', key: 'SDEMO2', name: 'SOCDemo' }], isLast: true, total: 2 },
    ]),
    () => prepareRule(specWith({ projectName: 'SOCDemo' }))
  );

  assert.equal(result.ok, false);
  assert.match(result.error, /matches more than one project/);
});

test('a response that never reports the last page is an error, not a guess', async () => {
  const never = { values: [SOC_DEMO], isLast: false };
  const result = await withForgeEnvironment(
    async () => mockResponse(200, never),
    () => prepareRule(specWith({ projectName: 'SOCDemo' }))
  );

  assert.equal(result.ok, false);
  assert.match(result.error, /matched too many projects to check/);
});

test('a failed project search is reported with its status', async () => {
  const result = await withForgeEnvironment(
    async () => mockResponse(403, { message: 'no' }),
    () => prepareRule(specWith({ projectName: 'SOCDemo' }))
  );

  assert.equal(result.ok, false);
  assert.match(result.error, /Project search returned status 403/);
});

test('projectId alone still works and makes no project search', async () => {
  const calls = [];
  const result = await withForgeEnvironment(
    async (url) => {
      calls.push(url);
      return mockResponse(500, {});
    },
    () => prepareRule(specWith({ projectId: '10086' }))
  );

  assert.equal(result.ok, true);
  assert.equal(calls.length, 0);
  assert.deepEqual(result.rule.ruleScopeARIs, ['ari:cloud:jira:test-cloud:project/10086']);
});

test('projectId and projectName that agree are accepted', async () => {
  const result = await withForgeEnvironment(
    projectSearchFetch([onePage([SOC_DEMO])]),
    () => prepareRule(specWith({ projectId: '10100', projectName: 'SOCDemo' }))
  );

  assert.equal(result.ok, true);
});

test('projectId and projectName that disagree throw', async () => {
  const result = await withForgeEnvironment(
    projectSearchFetch([onePage([SOC_DEMO])]),
    () => prepareRule(specWith({ projectId: '10086', projectName: 'SOCDemo' }))
  );

  assert.equal(result.ok, false);
  assert.match(result.error, /projectId "10086" and projectName "SOCDemo" are different projects/);
  assert.match(result.error, /10100/);
});

test('neither projectName nor projectId throws and asks for projectName', async () => {
  const result = await withForgeEnvironment(
    async () => mockResponse(500, {}),
    () => prepareRule(specWith({}))
  );

  assert.equal(result.ok, false);
  assert.match(result.error, /needs projectName/);
});

test('a project key sent as projectId is still rejected', async () => {
  const result = await withForgeEnvironment(
    async () => mockResponse(500, {}),
    () => prepareRule(specWith({ projectId: 'SOC' }))
  );

  assert.equal(result.ok, false);
  assert.match(result.error, /projectId must be the numeric Jira project ID/);
});
