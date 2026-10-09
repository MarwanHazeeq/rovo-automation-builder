// Component types added from the rule survey (scripts/find-component-examples.js
// --survey). Each test builds a rule through the real pipeline with fetch
// mocked, and checks the payload against the shape the tenant rule showed.
import assert from 'node:assert/strict';
import test from 'node:test';
import { createJiraAutomationRule, walkComponents } from '../src/index.js';
import { ACTION_LIBRARY, CONDITION_LIBRARY } from '../src/component-library.js';
import { renderDraftComment, summarizeRule } from '../src/draft-render.js';

const SCOPE = 'ari:cloud:jira:test-cloud:project/10086';

// Shapes as Jira's /rest/api/3/field returns them.
const FIELD_METADATA = [
  { id: 'status', key: 'status', name: 'Status', schema: { type: 'status', system: 'status' } },
  { id: 'project', key: 'project', name: 'Project', schema: { type: 'project', system: 'project' } },
  { id: 'summary', key: 'summary', name: 'Summary', schema: { type: 'string', system: 'summary' } },
  { id: 'labels', key: 'labels', name: 'Labels', schema: { type: 'array', items: 'string', system: 'labels' } },
  { id: 'assignee', key: 'assignee', name: 'Assignee', schema: { type: 'user', system: 'assignee' } },
  { id: 'priority', key: 'priority', name: 'Priority', schema: { type: 'priority', system: 'priority' } },
  { id: 'description', key: 'description', name: 'Description', schema: { type: 'string', system: 'description' } },
  { id: 'attachment', key: 'attachment', name: 'Attachment', schema: { type: 'array', items: 'attachment', system: 'attachment' } },
  { id: 'customfield_10002', key: 'customfield_10002', name: 'Organizations',
    schema: { type: 'array', custom: 'com.atlassian.servicedesk:sd-customer-organizations' } },
  { id: 'customfield_10003', key: 'customfield_10003', name: 'Request participants',
    schema: { type: 'array', custom: 'com.atlassian.servicedesk:sd-request-participants' } },
  { id: 'customfield_10010', key: 'customfield_10010', name: 'Request Type',
    schema: { type: 'sd-customerrequesttype', custom: 'com.atlassian.servicedesk:vp-origin' } },
  { id: 'customfield_10500', key: 'customfield_10500', name: 'Start date cf',
    schema: { type: 'datetime', custom: 'com.atlassian.jira.plugin.system.customfieldtypes:datetime' } },
];

function mockResponse(status, body) {
  return { status, text: async () => JSON.stringify(body) };
}

/** Run a ruleSpec through the pipeline; returns the result and the POSTed rule. */
async function build(specParts) {
  const saved = { ...process.env };
  const previousFetch = globalThis.fetch;
  Object.assign(process.env, {
    AUTOMATION_API_EMAIL: 'automation@example.test',
    AUTOMATION_API_TOKEN: 'test-token',
    JIRA_CLOUD_ID: 'test-cloud',
    AUTOMATION_RULE_ACTOR_ACCOUNT_ID: 'test-actor',
  });
  let rule;
  globalThis.fetch = async (url, options = {}) => {
    if (url.endsWith('/rest/api/3/field')) return mockResponse(200, FIELD_METADATA);
    if (options.method === 'POST') {
      rule = JSON.parse(options.body).rule;
      return mockResponse(201, { ruleUuid: 'created-rule-id' });
    }
    return mockResponse(200, { rule });
  };
  try {
    const result = await createJiraAutomationRule({
      ruleSpec: JSON.stringify({
        name: 'Surveyed component',
        projectId: '10086',
        trigger: { type: 'jira.issue.event.trigger:created' },
        actions: [{ type: 'codebarrel.action.log', value: 'ran' }],
        ...specParts,
      }),
    });
    return { result, rule };
  } finally {
    process.env = saved;
    globalThis.fetch = previousFetch;
  }
}

function componentsOfType(rule, type) {
  const found = [];
  walkComponents(rule?.components, (node) => { if (node.type === type) found.push(node); });
  return found;
}

// --- Triggers -----------------------------------------------------------------

test('issue-event triggers are built with the rule\'s own project as the only filter', async () => {
  const expected = {
    'jira.issue.event.trigger:commented': { eventTypes: ['PRIMARY_ACTION'], eventFilters: [SCOPE] },
    'jira.issue.event.trigger:updated': { eventKey: 'jira:issue_updated', issueEvent: 'issue_updated', eventFilters: [SCOPE] },
    'jira.issue.event.trigger:assigned': { eventKey: 'jira:issue_updated', issueEvent: 'issue_assigned', eventFilters: [SCOPE] },
    'jira.issue.event.trigger:deleted': { eventKey: 'jira:issue_deleted', issueEvent: 'issue_deleted', eventFilters: [SCOPE] },
  };
  for (const [type, value] of Object.entries(expected)) {
    const { result, rule } = await build({ trigger: { type } });
    assert.equal(result.ok, true, `${type}: ${result.error}`);
    assert.deepEqual(rule.trigger.value, value, type);
  }
});

test('moved trigger takes numeric source/target projects and defaults to any (-1999)', async () => {
  const { result, rule } = await build({ trigger: { type: 'jira.issue.event.trigger:moved', sourceProject: '10218' } });
  assert.equal(result.ok, true, result.error);
  assert.equal(rule.trigger.value.sourceProject, '10218');
  assert.equal(rule.trigger.value.targetProject, '-1999');
  assert.equal(rule.trigger.value.issueEvent, 'issue_moved');

  const bad = await build({ trigger: { type: 'jira.issue.event.trigger:moved', sourceProject: 'SOC' } });
  assert.equal(bad.result.ok, false);
  assert.match(bad.result.error, /numeric project ID/);
});

test('non-event triggers take exactly their verified keys and are scoped by the rule alone', async () => {
  const sla = { customFieldId: 'customfield_10049', thresholdType: 'WILL_BREACH', thresholdValue: 3600000, scheduleConfigIdSet: [1] };
  const { result, rule } = await build({ trigger: { type: 'jira.sla.threshold.trigger', value: sla } });
  assert.equal(result.ok, true, result.error);
  assert.deepEqual(rule.trigger.value, sla);
  assert.deepEqual(rule.ruleScopeARIs, [SCOPE]);

  const deploy = await build({ trigger: { type: 'devops.deploy.event.trigger:statechange', value: { environments: ['production'], states: ['failed'] } } });
  assert.equal(deploy.result.ok, true, deploy.result.error);
  assert.equal(deploy.rule.trigger.schemaVersion, -1);

  const missing = await build({ trigger: { type: 'jira.sla.threshold.trigger', value: { customFieldId: 'customfield_10049' } } });
  assert.equal(missing.result.ok, false);
  assert.match(missing.result.error, /missing thresholdType/);
});

test('incoming webhook is built without a token and rejects one supplied by the agent', async () => {
  const { result, rule } = await build({ trigger: { type: 'jira.incoming.webhook', value: { searchOrProvide: 'provided', jql: null } } });
  assert.equal(result.ok, true, result.error);
  assert.equal('webhookToken' in rule.trigger.value, false);

  const withToken = await build({ trigger: { type: 'jira.incoming.webhook', value: { searchOrProvide: 'provided', jql: null, webhookToken: 'abc' } } });
  assert.equal(withToken.result.ok, false);
  assert.match(withToken.result.error, /Do not supply webhookToken/);
});

// --- Plain actions and conditions -------------------------------------------

const SURVEYED_ACTIONS = [
  'jira.issue.assign', 'jira.issue.outgoing.email', 'jira.auto.approve.action', 'rovo.invoke-agent.action',
  'jira.issue.related', 'jira.lookup.issues', 'jira.edit.request.type', 'jira.proforma.form.add.action',
  'jira.issue.create', 'jira.issue.clone',
];
const SURVEYED_CONDITIONS = ['jira.jql.condition', 'jira.user.condition', 'jira.affected.services.condition'];

test('every surveyed action builds from its library example with the library schemaVersion', async () => {
  for (const type of SURVEYED_ACTIONS) {
    const entry = ACTION_LIBRARY[type];
    const { result, rule } = await build({ actions: [{ type, value: entry.example }] });
    assert.equal(result.ok, true, `${type}: ${result.error}`);
    assert.equal(componentsOfType(rule, type)[0].schemaVersion, entry.schemaVersion, type);
  }
});

test('every surveyed condition builds from its library example', async () => {
  for (const type of SURVEYED_CONDITIONS) {
    const entry = CONDITION_LIBRARY[type];
    const { result, rule } = await build({ conditions: [{ type, value: entry.example }] });
    assert.equal(result.ok, true, `${type}: ${result.error}`);
    const [node] = componentsOfType(rule, type);
    assert.deepEqual(node.value, entry.example, type);
    assert.equal(node.schemaVersion, entry.schemaVersion, type);
  }
});

test('a surveyed action with an invented key is rejected by name', async () => {
  const { result } = await build({ actions: [{ type: 'jira.auto.approve.action', value: { approve: true } }] });
  assert.equal(result.ok, false);
  assert.match(result.error, /unexpected approve/);
});

test('the ProForma form is always taken from the rule\'s own project', async () => {
  const value = { ...ACTION_LIBRARY['jira.proforma.form.add.action'].example };
  value.templateFormsConfig = { projectId: 99999, templateFormIds: [3] };
  const { result, rule } = await build({ actions: [{ type: 'jira.proforma.form.add.action', value }] });
  assert.equal(result.ok, true, result.error);
  assert.deepEqual(componentsOfType(rule, 'jira.proforma.form.add.action')[0].value.templateFormsConfig,
    { projectId: 10086, templateFormIds: [3] });
});

// --- Field types -------------------------------------------------------------

async function editOperations(fields) {
  const { result, rule } = await build({ actions: [{ type: 'jira.issue.edit', value: { fields } }] });
  return { result, operations: componentsOfType(rule, 'jira.issue.edit')[0]?.value.operations };
}

test('system-field edits are built by ID with the surveyed value shapes', async () => {
  const { result, operations } = await editOperations({
    Labels: ['soc', 'p1'],
    Assignee: '611ca5f3aee32f006f99cf9d',
    Priority: '5',
    Description: 'Updated by automation',
    Attachment: 'trigger',
  });
  assert.equal(result.ok, true, result.error);
  assert.deepEqual(operations, [
    { field: { type: 'ID', value: 'labels' }, fieldType: 'labels', type: 'SET',
      value: [{ type: 'NAME', value: 'soc' }, { type: 'NAME', value: 'p1' }] },
    { field: { type: 'ID', value: 'assignee' }, fieldType: 'assignee', type: 'SET',
      value: { type: 'ID', value: '611ca5f3aee32f006f99cf9d' } },
    { field: { type: 'ID', value: 'priority' }, fieldType: 'priority', type: 'SET', value: { type: 'ID', value: '5' } },
    { field: { type: 'ID', value: 'description' }, fieldType: 'description', type: 'SET', value: 'Updated by automation' },
    { field: { type: 'ID', value: 'attachment' }, fieldType: 'attachment', type: 'COPY',
      value: { copyOptions: [], sourceIssue: 'trigger', sourceField: { type: 'ID', value: 'attachment', fieldType: 'attachment' } } },
  ]);
});

test('JSM and date-time custom-field edits match the surveyed shapes', async () => {
  const { result, operations } = await editOperations({
    Organizations: [1, '7'],
    'Request participants': ['qm:abc:def', '611ca5f3aee32f006f99cf9d'],
    'Start date cf': '{{now}}',
  });
  assert.equal(result.ok, true, result.error);
  assert.deepEqual(operations.map((op) => op.value), [
    [{ type: 'ID', value: 1 }, { type: 'ID', value: 7 }],
    [{ type: 'ID', value: 'qm:abc:def' }, { type: 'ID', value: '611ca5f3aee32f006f99cf9d' }],
    '{{now}}',
  ]);
  assert.equal(operations[0].field.type, 'NAME');
});

test('ID-based edits reject display names, and attachment only copies from the trigger', async () => {
  const priority = await editOperations({ Priority: 'High' });
  assert.equal(priority.result.ok, false);
  assert.match(priority.result.error, /numeric ID/);

  const attachment = await editOperations({ Attachment: 'SOC-1' });
  assert.equal(attachment.result.ok, false);
  assert.match(attachment.result.error, /only be copied from the trigger issue/);
});

async function issueCondition(value) {
  const { result, rule } = await build({ conditions: [{ type: 'jira.issue.condition', value }] });
  return { result, condition: componentsOfType(rule, 'jira.issue.condition')[0]?.value };
}

test('system-field conditions use each field\'s own compareValue type', async () => {
  const status = await issueCondition({ name: 'Status', value: 'Level 1 Support' });
  assert.equal(status.result.ok, true, status.result.error);
  assert.equal(status.condition.compareValue.type, 'NAME');
  assert.equal(status.condition.compareValue.value, 'Level 1 Support');

  const project = await issueCondition({ name: 'project', value: 10053 });
  assert.equal(project.condition.compareValue.type, 'ID');
  assert.equal(project.condition.compareValue.value, '10053');

  const summary = await issueCondition({ name: 'Summary', value: 'Test', comparison: 'STARTS_WITH' });
  assert.equal(summary.result.ok, true, summary.result.error);
  assert.deepEqual(summary.condition.compareValue, { type: 'VALUE', modifier: null, value: 'Test', multiValue: false, source: null });
});

test('an unverified comparison is rejected per field and points at the comparator', async () => {
  const { result } = await issueCondition({ name: 'Summary', value: 'Test' });
  assert.equal(result.ok, false);
  assert.match(result.error, /not verified .* field "Summary" \(currently: STARTS_WITH\)/);
  assert.match(result.error, /jira\.comparator\.condition/);
});

test('request type conditions compare by name, like select fields', async () => {
  const { result, condition } = await issueCondition({ name: 'Request Type', value: 'Request a change' });
  assert.equal(result.ok, true, result.error);
  assert.deepEqual(condition.selectedField, { type: 'NAME', value: 'Request Type' });
  assert.equal(condition.selectedFieldType, 'com.atlassian.servicedesk:vp-origin');
  assert.equal(condition.compareValue.type, 'NAME');
});

// --- Approval ticket ---------------------------------------------------------

test('the draft comment names where create/clone actions put new issues', async () => {
  const { result, rule } = await build({ actions: [
    { type: 'jira.issue.create', value: ACTION_LIBRARY['jira.issue.create'].example },
    { type: 'jira.issue.clone', value: ACTION_LIBRARY['jira.issue.clone'].example },
  ] });
  assert.equal(result.ok, true, result.error);

  assert.deepEqual(summarizeRule(rule).issueTargets, [
    { action: 'jira.issue.create', projectId: '10284' },
    { action: 'jira.issue.clone', projectId: null, sameAsTrigger: true },
  ]);
  const comment = JSON.stringify(renderDraftComment({ rule, version: 1, digest: 'sha256:x', scope: SCOPE }));
  assert.match(comment, /Creates issues in: /);
  assert.match(comment, /project 10284, OUTSIDE this rule's project 10086/);
  assert.match(comment, /same project as the trigger issue/);
});

test('rules without create/clone actions get no target line', async () => {
  const { rule } = await build({});
  const comment = JSON.stringify(renderDraftComment({ rule, version: 1, digest: 'sha256:x', scope: SCOPE }));
  assert.doesNotMatch(comment, /Creates issues in/);
});

// --- Full-payload path (a pasted export skips the builder) -------------------


async function withRawSpec(ruleSpec) {
  const saved = { ...process.env };
  const previousFetch = globalThis.fetch;
  Object.assign(process.env, {
    AUTOMATION_API_EMAIL: 'automation@example.test',
    AUTOMATION_API_TOKEN: 'test-token',
    JIRA_CLOUD_ID: 'test-cloud',
    AUTOMATION_RULE_ACTOR_ACCOUNT_ID: 'test-actor',
  });
  let posted;
  globalThis.fetch = async (url, options = {}) => {
    if (options.method === 'POST') {
      posted = JSON.parse(options.body).rule;
      return mockResponse(201, { ruleUuid: 'created-rule-id' });
    }
    return mockResponse(200, { rule: posted });
  };
  try {
    return await createJiraAutomationRule({ ruleSpec });
  } finally {
    process.env = saved;
    globalThis.fetch = previousFetch;
  }
}

test('a pasted full payload cannot carry an incoming-webhook token', async () => {
  const { rule } = await build({ trigger: { type: 'jira.incoming.webhook', value: { searchOrProvide: 'provided', jql: null } } });
  rule.trigger.value.webhookToken = 'pasted-secret';

  const result = await withRawSpec(JSON.stringify({ rule }));
  assert.equal(result.ok, false);
  assert.match(result.error, /must not carry a webhookToken/);
});

test('a pasted full payload cannot attach a ProForma form from another project', async () => {
  const { rule } = await build({ actions: [{ type: 'jira.proforma.form.add.action', value: ACTION_LIBRARY['jira.proforma.form.add.action'].example }] });
  componentsOfType(rule, 'jira.proforma.form.add.action')[0].value.templateFormsConfig.projectId = 10030;

  const result = await withRawSpec(JSON.stringify({ rule }));
  assert.equal(result.ok, false);
  assert.match(result.error, /rule's own project 10086, not 10030/);
});

// --- Keys whose verified value is null ---------------------------------------

test('keys whose verified value is null are filled in when the agent drops them', async () => {
  // The 2026-10-09 Rovo test: the agent omitted commentVisibility (verified null).
  const { result, rule } = await build({ actions: [{ type: 'jira.issue.comment', value: {
    comment: 'P2 raised: {{issue.key}}', publicComment: false, sendNotifications: true, addCommentOnce: true,
  } }] });
  assert.equal(result.ok, true, result.error);
  const [comment] = componentsOfType(rule, 'jira.issue.comment');
  assert.equal(comment.value.commentVisibility, null);
  assert.ok('commentVisibility' in comment.value);
});

test('a dropped key with a real verified value still fails', async () => {
  const { result } = await build({ actions: [{ type: 'jira.issue.comment', value: {
    publicComment: false, commentVisibility: null, sendNotifications: true, addCommentOnce: true,
  } }] });
  assert.equal(result.ok, false);
  assert.match(result.error, /missing comment\b/);
});
