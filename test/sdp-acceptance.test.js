import assert from 'node:assert/strict';
import test from 'node:test';
import { buildRulePayload, createJiraAutomationRule } from '../src/index.js';

// Acceptance test for issue #7: the ruleSpec the agent should produce from
// docs/specs/sdp-request-creation.md. Every secret is a placeholder string
// that must survive into the payload untouched.

const TRIGGER = { type: 'jira.issue.field.changed', fields: ['Send to Customer ITSM'] };
const TEXTFIELD = 'com.atlassian.jira.plugin.system.customfieldtypes:textfield';
const FIELDS = [
  { id: 'customfield_10300', key: 'customfield_10300', name: 'Customer ITSM Incident', schema: { type: 'string', custom: TEXTFIELD } },
];

const variable = (id, name, query) => ({
  type: 'jira.create.variable',
  value: { id: `_customsmartvalue_id_${id}`, name: { type: 'FREE', value: name }, type: 'SMART', query: { type: 'SMART', value: query }, lazy: false },
});
const mapping = (name, mappings) => ({
  type: 'jira.create.mapping-variable',
  value: { name: { type: 'FREE', value: name }, mappings },
});
const log = (text) => ({ type: 'codebarrel.action.log', value: text });
const wait = () => ({ type: 'action.wait.for.time.duration', value: { waitTimeInSeconds: 5, randomWaitInterval: null } });
const compare = (first, operator, second) => ({ type: 'jira.comparator.condition', value: { first, second, operator } });
const comment = (text) => ({
  type: 'jira.issue.comment',
  value: { comment: text, publicComment: false, commentVisibility: null, sendNotifications: true, addCommentOnce: true },
});

const SPEC = {
  name: 'SDP request creation',
  projectId: '10086',
  trigger: TRIGGER,
  actions: [
    variable(1, 'ClientID', '<SDP_CLIENT_ID>'),
    variable(2, 'ClientSecret', '<SDP_CLIENT_SECRET>'),
    {
      type: 'jira.issue.outgoing.webhook',
      value: {
        url: 'https://<TOKEN_HOST>/oauth/v2/token',
        method: 'POST',
        headers: [{ id: '_header_1', name: 'Content-Type', value: 'application/x-www-form-urlencoded', headerSecure: false }],
        contentType: 'custom',
        customBody: 'client_id={{ClientID}}&client_secret={{ClientSecret}}&grant_type=client_credentials&scope=SDPOnDemand.requests.ALL',
      },
    },
    variable(3, 'AuthToken', 'Bearer {{webResponse.body.access_token}}'),
    mapping('SiteMap', [{ key: '<SITE_KEY_1>', value: '<SDP_SITE_1>' }, { key: '<SITE_KEY_2>', value: '<SDP_SITE_2>' }]),
    variable(4, 'SDPSite', '{{SiteMap.get(issue.customfield_10257)}}'),
    mapping('PriorityMap', [
      { key: 'Informational', value: 'P3' },
      { key: 'Low', value: 'P3' },
      { key: 'Medium', value: 'P2' },
      { key: 'High', value: 'P1' },
      { key: 'Critical', value: 'Urgent' },
    ]),
    variable(5, 'SDPPriority', '{{PriorityMap.get(issue.priority.name)}}'),
    log('{{SDPPriority}}'),
    variable(6, 'sdppayload', '{"request":{"subject":"{{issue.summary.jsonEncode}}","description":"{{issue.description.jsonEncode}}","udf_fields":{"udf_char31":"{{issue.key}}"}}}'),
    log('{{sdppayload}}'),
    {
      type: 'jira.issue.outgoing.webhook',
      value: {
        url: 'https://<SDP_HOST>/api/v3/requests',
        method: 'POST',
        headers: [
          { id: '_header_2', name: 'Content-Type', value: 'application/x-www-form-urlencoded', headerSecure: false },
          { id: '_header_3', name: 'Accept', value: 'application/vnd.manageengine.sdp.v3+json', headerSecure: false },
        ],
        contentType: 'custom',
        customBody: 'input_data={{sdppayload.urlEncode}}',
        authenticate: true,
      },
    },
    wait(),
  ],
  branches: [
    {
      conditions: [compare('{{webhookResponse.status}}', 'GREATER_THAN', '199'), compare('{{webhookResponse.status}}', 'LESS_THAN', '300')],
      conditionMatchType: 'ALL',
      actions: [
        wait(),
        { type: 'jira.issue.edit', value: { fields: { 'Customer ITSM Incident': '{{webhookResponse.body.request.id}}' } } },
      ],
      branches: [
        {
          conditions: [
            compare('{{issue.attachments.size}}', 'GREATER_THAN', '0'),
            compare('{{issue.comments.size}}', 'GREATER_THAN', '0'),
            compare('{{comment.attachments.size}}', 'GREATER_THAN', '0'),
          ],
          conditionMatchType: 'ANY',
          actions: [
            {
              type: 'jira.issue.outgoing.webhook',
              value: {
                url: 'https://<SYNC_SERVICE_URL>',
                method: 'POST',
                headers: [
                  { id: '_header_4', name: 'Content-Type', value: 'application/json', headerSecure: false },
                  { id: '_header_5', name: 'Auth-Key', value: '<SYNC_AUTH_KEY>', headerSecure: true },
                ],
                contentType: 'custom',
                customBody: '{"jiraTicketKey":"{{issue.key}}","SDPToken":"{{AuthToken}}","SDPRequestID":"{{webhookResponse.body.request.id}}"}',
              },
            },
            wait(),
            comment('{{webResponse.body}}'),
          ],
        },
      ],
    },
    {
      conditions: [compare('{{webhookResponse.status}}', 'GREATER_THAN', '399')],
      actions: [comment('Failed to create SDP ticket. Response: {{webResponse.body}}')],
    },
  ],
};

const build = () => buildRulePayload(SPEC, 'test-cloud', 'test-actor', FIELDS);

test('the SDP spec builds through buildRulePayload and is DISABLED', () => {
  assert.equal(build().rule.state, 'DISABLED');
});

test('thirteen setup actions sit at the top level before the one container, which is last', () => {
  const { components } = build().rule;
  assert.equal(components.length, 14);
  for (const c of components) assert.equal(c.parentId, null);
  assert.ok(components.slice(0, 13).every((c) => c.component === 'ACTION'));
  assert.equal(components[13].type, 'jira.condition.container.block');
});

test('the top container holds exactly two sibling if-blocks: accepted, then rejected', () => {
  const container = build().rule.components[13];
  assert.equal(container.children.length, 2);
  const [accepted, rejected] = container.children;
  for (const block of container.children) {
    assert.equal(block.type, 'jira.condition.if.block');
    assert.equal(block.parentId, container.id);
  }
  assert.equal(accepted.conditions.length, 2);
  assert.equal(rejected.conditions.length, 1);
  assert.equal(rejected.children[0].type, 'jira.issue.comment');
});

test('the comments/attachments check is nested inside the accepted block, after its own actions', () => {
  const [accepted] = build().rule.components[13].children;
  assert.deepEqual(accepted.children.map((c) => c.type), [
    'action.wait.for.time.duration',
    'jira.issue.edit',
    'jira.condition.container.block',
  ]);
  const nested = accepted.children[2];
  assert.equal(nested.parentId, accepted.id);
  assert.equal(nested.children.length, 1);
  const inner = nested.children[0];
  assert.equal(inner.parentId, nested.id);
  assert.equal(inner.conditions.length, 3);
  for (const c of inner.conditions) assert.equal(c.conditionParentId, inner.id);
  for (const a of inner.children) assert.equal(a.parentId, inner.id);
});

test('placeholder credentials survive verbatim in the built payload', () => {
  const text = JSON.stringify(build().rule);
  for (const placeholder of ['<SDP_CLIENT_ID>', '<SDP_CLIENT_SECRET>', '<SYNC_AUTH_KEY>', '<TOKEN_HOST>', '<SDP_HOST>', '<SYNC_SERVICE_URL>']) {
    assert.ok(text.includes(placeholder), `${placeholder} missing`);
  }
});

test('webResponse and webhookResponse each stay where the spec put them', () => {
  const { components } = build().rule;
  assert.match(components[3].value.query.value, /\{\{webResponse\.body\.access_token\}\}/);
  assert.doesNotMatch(components[3].value.query.value, /webhookResponse/);
  const [accepted, rejected] = components[13].children;
  assert.match(accepted.conditions[0].value.first, /webhookResponse\.status/);
  assert.match(JSON.stringify(accepted.children[1].value), /webhookResponse\.body\.request\.id/);
  const syncComment = accepted.children[2].children[0].children[2];
  assert.equal(syncComment.value.comment, '{{webResponse.body}}');
  assert.match(rejected.children[0].value.comment, /\{\{webResponse\.body\}\}/);
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

test('the SDP rule verifies against its own GET with fresh ids', async () => {
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
      return { status: 200, text: async () => JSON.stringify(FIELDS) };
    }
    if (options.method === 'POST') {
      created = JSON.parse(options.body).rule;
      return { status: 201, text: async () => JSON.stringify({ ruleUuid: 'r1' }) };
    }
    return { status: 200, text: async () => JSON.stringify({ rule: { ...reassignIds(created), extra: 'meta' } }) };
  };
  try {
    const result = await createJiraAutomationRule({ ruleSpec: JSON.stringify(SPEC) });
    assert.equal(result.ok, true, JSON.stringify(result));
  } finally {
    globalThis.fetch = previous.fetch;
    process.env = previous.env;
  }
});
