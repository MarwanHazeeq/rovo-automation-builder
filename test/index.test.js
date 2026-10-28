import assert from 'node:assert/strict';
import test from 'node:test';
import { createAndVerifyRule, createJiraAutomationRule, onCreateOutcome, walkComponents } from '../src/index.js';

const FIELD_METADATA = [
  {
    id: 'customfield_11639',
    key: 'customfield_11639',
    name: 'Response Time',
    schema: {
      type: 'number',
      custom: 'com.atlassian.jira.plugin.system.customfieldtypes:float',
    },
  },
  {
    id: 'customfield_10101',
    key: 'customfield_10101',
    name: 'Customer ITSM Incident',
    schema: {
      type: 'string',
      custom: 'com.atlassian.jira.plugin.system.customfieldtypes:textfield',
    },
  },
  {
    id: 'customfield_11640',
    key: 'customfield_11640',
    name: 'Another Number',
    schema: {
      type: 'number',
      custom: 'com.atlassian.jira.plugin.system.customfieldtypes:float',
    },
  },
  {
    id: 'customfield_11594',
    key: 'customfield_11594',
    name: 'Time Taken at Open Phase',
    schema: {
      type: 'number',
      custom: 'com.atlassian.jira.plugin.system.customfieldtypes:float',
    },
  },
];

function mockResponse(status, body) {
  return {
    status,
    text: async () => JSON.stringify(body),
  };
}

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
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    globalThis.fetch = previousFetch;
  }
}

test('writes Jira float fields as advanced numeric expressions and keeps text operations', async () => {
  const elapsedMinutes =
    '{{#=}}{{issue.customfield_10049.completedCycles.last.elapsedTime.millis}} / 60000{{/}}';
  let createdRule;

  const result = await withForgeEnvironment(async (url, options = {}) => {
    if (url.endsWith('/rest/api/3/field')) {
      return mockResponse(200, FIELD_METADATA);
    }
    if (options.method === 'POST') {
      createdRule = JSON.parse(options.body).rule;
      return mockResponse(201, { ruleUuid: 'created-rule-id' });
    }
    return mockResponse(200, { rule: createdRule });
  }, () => createJiraAutomationRule({
    ruleSpec: JSON.stringify({
      name: 'Copy first response SLA to Response Time',
      projectId: '10449',
      trigger: {
        type: 'jira.issue.event.trigger:created',
      },
      actions: [{
        type: 'jira.issue.edit',
        value: {
          fields: [
            { name: 'Response Time', value: elapsedMinutes },
            { name: 'Customer ITSM Incident', value: 'INC-123' },
            { name: 'Another Number', value: 2.5 },
          ],
        },
      }],
    }),
  }));

  assert.equal(result.ok, true);
  const editValue = createdRule.components[0].value;
  assert.equal(editValue.operations.length, 1);
  assert.equal(editValue.operations[0].field.value, 'Customer ITSM Incident');
  assert.match(editValue.advancedFields, /"customfield_11639": \{\{#=\}\}/);
  assert.ok(editValue.advancedFields.includes(elapsedMinutes));
  assert.match(editValue.advancedFields, /"customfield_11640": 2\.5/);
});

test('normalizes field objects in changed-field triggers to Jira field-name strings', async () => {
  let createdRule;
  const result = await withForgeEnvironment(async (url, options = {}) => {
    if (url.endsWith('/rest/api/3/field')) {
      return mockResponse(200, FIELD_METADATA);
    }
    if (options.method === 'POST') {
      createdRule = JSON.parse(options.body).rule;
      return mockResponse(201, { ruleUuid: 'created-rule-id' });
    }
    return mockResponse(200, { rule: createdRule });
  }, () => createJiraAutomationRule({
    ruleSpec: JSON.stringify({
      name: 'Normalize assignee trigger field',
      projectId: '10449',
      trigger: {
        type: 'jira.issue.field.changed',
        fields: [{ name: 'Assignee' }],
      },
      actions: [{
        // A bare string: codebarrel.action.log takes no object wrapper.
        type: 'codebarrel.action.log',
        value: 'Assignee changed',
      }],
    }),
  }));

  assert.equal(result.ok, true);
  assert.deepEqual(createdRule.trigger.value.fields, [
    { value: 'Assignee', type: 'fieldName' },
  ]);
});

test('constructs numeric advanced fields from a field map and bare smart-value expressions', async () => {
  let createdRule;
  const result = await withForgeEnvironment(async (url, options = {}) => {
    if (url.endsWith('/rest/api/3/field')) {
      return mockResponse(200, FIELD_METADATA);
    }
    if (options.method === 'POST') {
      createdRule = JSON.parse(options.body).rule;
      return mockResponse(201, { ruleUuid: 'created-rule-id' });
    }
    return mockResponse(200, { rule: createdRule });
  }, () => createJiraAutomationRule({
    ruleSpec: JSON.stringify({
      name: 'Track time in the open phase',
      projectId: '10449',
      trigger: {
        type: 'jira.issue.event.trigger:transitioned',
      },
      actions: [{
        type: 'jira.issue.edit',
        value: {
          fields: {
            customfield_11594:
              'ROUND({{issue.customfield_11594|0}} + ({{durationMillis}} / 60000), 2)',
            'Another Number': '{{minutesToAdd}}',
          },
        },
      }],
    }),
  }));

  assert.equal(result.ok, true);
  const advancedFields = createdRule.components[0].value.advancedFields;
  assert.ok(advancedFields.includes(
    '"customfield_11594": {{#=}}ROUND({{issue.customfield_11594|0}} + ' +
      '({{durationMillis}} / 60000), 2){{/}}'
  ));
  assert.ok(advancedFields.includes(
    '"customfield_11640": {{#=}}{{minutesToAdd}}{{/}}'
  ));
});

test('rejects numeric expressions that could break the advancedFields JSON value', async () => {
  let createRequestSent = false;
  const result = await withForgeEnvironment(async (url) => {
    if (url.endsWith('/rest/api/3/field')) {
      return mockResponse(200, FIELD_METADATA);
    }
    createRequestSent = true;
    return mockResponse(500, {});
  }, () => createJiraAutomationRule({
    ruleSpec: JSON.stringify({
      name: 'Reject unsafe number expression',
      projectId: '10449',
      trigger: {
        type: 'jira.issue.event.trigger:created',
      },
      actions: [{
        type: 'jira.issue.edit',
        value: {
          fields: [{
            name: 'Response Time',
            value: '{{#=}}{{issue.customfield_10049}}}}, "unexpected": 1{{/}}',
          }],
        },
      }],
    }),
  }));

  assert.equal(result.ok, false);
  assert.match(result.error, /finite number, a Jira smart value/);
  assert.equal(createRequestSent, false);
});

test('builds a scheduled JQL trigger with no eventFilters and a generated rRule', async () => {
  let createdRule;
  const result = await withForgeEnvironment(async (url, options = {}) => {
    if (url.endsWith('/rest/api/3/field')) {
      return mockResponse(200, FIELD_METADATA);
    }
    if (options.method === 'POST') {
      createdRule = JSON.parse(options.body).rule;
      return mockResponse(201, { ruleUuid: 'created-rule-id' });
    }
    return mockResponse(200, { rule: createdRule });
  }, () => createJiraAutomationRule({
    ruleSpec: JSON.stringify({
      name: 'Historical Response Time backfill',
      projectId: '10878',
      trigger: {
        type: 'jira.jql.scheduled',
        jql: '"Response Time" is EMPTY',
        schedule: {
          days: ['MO'],
          hour: 9,
          minute: 0,
          timezone: 'Asia/Singapore',
          startDate: '2026-09-25',
        },
      },
      actions: [{
        type: 'codebarrel.action.log',
        value: 'backfill candidate {{issue.key}}',
      }],
    }),
  }));

  assert.equal(result.ok, true);
  const triggerValue = createdRule.trigger.value;
  assert.equal(createdRule.trigger.type, 'jira.jql.scheduled');
  assert.equal(triggerValue.executionMode, 'jql');
  assert.equal(triggerValue.jql, '"Response Time" is EMPTY');
  assert.equal(triggerValue.onlyUpdatedIssues, false);
  // A scheduled rule carries no eventFilters; ruleScopeARIs is its only scope.
  assert.equal(triggerValue.eventFilters, undefined);
  assert.deepEqual(createdRule.ruleScopeARIs, [
    'ari:cloud:jira:test-cloud:project/10878',
  ]);
  // Vestigial-but-required schedule fields match the verified export.
  assert.equal(triggerValue.schedule.method, 'BASIC');
  assert.equal(triggerValue.schedule.cronExpression, '');
  assert.equal(triggerValue.schedule.rate, 0);
  assert.equal(triggerValue.schedule.rateInterval, 86400);
  // Monday only, and DTSTART's time of day agrees with BYHOUR/BYMINUTE.
  assert.match(triggerValue.schedule.rRule, /BYDAY=MO;INTERVAL=1/);
  assert.ok(!triggerValue.schedule.rRule.includes('BYDAY=MO,'));
  assert.match(
    triggerValue.schedule.rRule,
    /DTSTART;TZID=Asia\/Singapore:20260925T090000/
  );
  assert.match(triggerValue.schedule.rRule, /BYHOUR=9;BYMINUTE=0;BYSECOND=0/);
});

test('accepts a complete VEVENT string as a schedule escape hatch', async () => {
  const rawSchedule =
    'BEGIN:VEVENT\nDTSTART;TZID=Asia/Singapore:20260925T060000\n' +
    'RRULE:FREQ=WEEKLY;BYHOUR=6;BYMINUTE=30;BYSECOND=0;BYDAY=SA;INTERVAL=2\nEND:VEVENT';
  let createdRule;
  const result = await withForgeEnvironment(async (url, options = {}) => {
    if (url.endsWith('/rest/api/3/field')) return mockResponse(200, FIELD_METADATA);
    if (options.method === 'POST') {
      createdRule = JSON.parse(options.body).rule;
      return mockResponse(201, { ruleUuid: 'created-rule-id' });
    }
    return mockResponse(200, { rule: createdRule });
  }, () => createJiraAutomationRule({
    ruleSpec: JSON.stringify({
      name: 'Fortnightly sweep',
      projectId: '10878',
      trigger: {
        type: 'jira.jql.scheduled',
        jql: 'status = Open',
        schedule: rawSchedule,
      },
      actions: [{ type: 'codebarrel.action.log', value: '{{issue.key}}' }],
    }),
  }));

  assert.equal(result.ok, true);
  assert.equal(createdRule.trigger.value.schedule.rRule, `${rawSchedule}\n`);
});

// The schedule values a requester must give; the builder supplies none of them.
const WHEN = { hour: 9, minute: 0, timezone: 'Asia/Singapore' };

test('rejects a scheduled trigger with a missing jql or an invalid schedule', async () => {
  const build = (trigger) => withForgeEnvironment(
    async (url) => {
      if (url.endsWith('/rest/api/3/field')) return mockResponse(200, FIELD_METADATA);
      return mockResponse(201, { ruleUuid: 'should-not-be-created' });
    },
    () => createJiraAutomationRule({
      ruleSpec: JSON.stringify({
        name: 'Invalid scheduled rule',
        projectId: '10878',
        trigger: { type: 'jira.jql.scheduled', ...trigger },
        actions: [{ type: 'codebarrel.action.log', value: 'x' }],
      }),
    })
  );

  const noJql = await build({ schedule: { ...WHEN, days: ['MO'] } });
  assert.equal(noJql.ok, false);
  assert.match(noJql.error, /trigger\.jql/);

  const badDay = await build({ jql: 'status = Open', schedule: { ...WHEN, days: ['FUNDAY'] } });
  assert.equal(badDay.ok, false);
  assert.match(badDay.error, /unrecognized day/);

  const badHour = await build({ jql: 'status = Open', schedule: { ...WHEN, days: ['MO'], hour: 25 } });
  assert.equal(badHour.ok, false);
  assert.match(badHour.error, /hour must be an integer between 0 and 23/);

  const badZone = await build({ jql: 'status = Open', schedule: { ...WHEN, days: ['MO'], timezone: 'Mars/Olympus' } });
  assert.equal(badZone.ok, false);
  assert.match(badZone.error, /not a recognized IANA time zone/);

  const badRaw = await build({ jql: 'status = Open', schedule: 'every monday at 9' });
  assert.equal(badRaw.ok, false);
  assert.match(badRaw.error, /complete iCal VEVENT/);

  // Values the requester must have chosen are refused when absent, in the
  // requester's words, rather than filled in.
  const noTime = await build({ jql: 'status = Open', schedule: { days: ['MO'], timezone: 'Asia/Singapore' } });
  assert.equal(noTime.ok, false);
  assert.match(noTime.error, /did not say what time of day/);

  const noZone = await build({ jql: 'status = Open', schedule: { days: ['MO'], hour: 9, minute: 0 } });
  assert.equal(noZone.ok, false);
  assert.match(noZone.error, /did not say which time zone/);

  const noDays = await build({ jql: 'status = Open', schedule: WHEN });
  assert.equal(noDays.ok, false);
  assert.match(noDays.error, /did not say which days of the week/);

  const noSchedule = await build({ jql: 'status = Open' });
  assert.equal(noSchedule.ok, false);
  assert.match(noSchedule.error, /did not say what time of day/);
});

test('still requires eventFilters to match scope for event-driven triggers', async () => {
  let createdRule;
  const result = await withForgeEnvironment(async (url, options = {}) => {
    if (url.endsWith('/rest/api/3/field')) return mockResponse(200, FIELD_METADATA);
    if (options.method === 'POST') {
      createdRule = JSON.parse(options.body).rule;
      return mockResponse(201, { ruleUuid: 'created-rule-id' });
    }
    return mockResponse(200, { rule: createdRule });
  }, () => createJiraAutomationRule({
    ruleSpec: JSON.stringify({
      name: 'Event rule keeps its event filter',
      projectId: '10449',
      trigger: { type: 'jira.issue.event.trigger:created' },
      actions: [{ type: 'codebarrel.action.log', value: '{{issue.key}}' }],
    }),
  }));

  assert.equal(result.ok, true);
  assert.deepEqual(createdRule.trigger.value.eventFilters, [
    'ari:cloud:jira:test-cloud:project/10449',
  ]);
});

test('verification rejects a scheduled rule whose JQL came back rewritten', async () => {
  let tamperedRule;
  const result = await withForgeEnvironment(async (url, options = {}) => {
    if (url.endsWith('/rest/api/3/field')) return mockResponse(200, FIELD_METADATA);
    if (options.method === 'POST') {
      tamperedRule = JSON.parse(options.body).rule;
      // Simulate the site returning a different query than the one requested.
      tamperedRule.trigger.value.jql = 'project is not EMPTY';
      return mockResponse(201, { ruleUuid: 'created-rule-id' });
    }
    return mockResponse(200, { rule: tamperedRule });
  }, () => createJiraAutomationRule({
    ruleSpec: JSON.stringify({
      name: 'Tampered scheduled rule',
      projectId: '10878',
      trigger: {
        type: 'jira.jql.scheduled',
        jql: '"Response Time" is EMPTY',
        schedule: { ...WHEN, days: ['MO'] },
      },
      actions: [{ type: 'codebarrel.action.log', value: 'x' }],
    }),
  }));

  assert.equal(result.ok, false);
  assert.match(result.mismatch, /scheduled trigger JQL did not match/);
});

test('a failure outcome passes through the exit seam unchanged', async () => {
  const seen = [];
  const remove = onCreateOutcome((outcome) => seen.push(outcome));
  try {
    // No Forge env set up, so the handler fails on its first check.
    const result = await createJiraAutomationRule({});
    assert.equal(result.ok, false);
    assert.equal(seen.length, 1);
    assert.equal(seen[0], result);
  } finally {
    remove();
  }
});

test('a success outcome passes through the exit seam unchanged', async () => {
  const seen = [];
  const remove = onCreateOutcome((outcome) => seen.push(outcome));
  try {
    let createdRule;
    const result = await withForgeEnvironment(async (url, options = {}) => {
      if (options.method === 'POST') {
        createdRule = JSON.parse(options.body).rule;
        return mockResponse(201, { ruleUuid: 'created-rule-id' });
      }
      return mockResponse(200, { rule: createdRule });
    }, () => createJiraAutomationRule({
      ruleSpec: JSON.stringify({
        name: 'Seam test',
        projectId: '10449',
        trigger: { type: 'jira.issue.event.trigger:created' },
        actions: [{ type: 'codebarrel.action.log', value: 'hello' }],
      }),
    }));
    assert.equal(result.ok, true);
    assert.equal(seen.length, 1);
    assert.equal(seen[0], result);
  } finally {
    remove();
  }
});

test('success response carries a code-rendered sentence with name, state, scope and ruleUuid', async () => {
  let createdRule;
  const result = await withForgeEnvironment(async (url, options = {}) => {
    if (options.method === 'POST') {
      createdRule = JSON.parse(options.body).rule;
      return mockResponse(201, { ruleUuid: 'uuid-123' });
    }
    return mockResponse(200, { rule: createdRule });
  }, () => createJiraAutomationRule({
    ruleSpec: JSON.stringify({
      name: 'Sentence test',
      projectId: '10449',
      trigger: { type: 'jira.issue.event.trigger:created' },
      actions: [{ type: 'codebarrel.action.log', value: 'hello' }],
    }),
  }));
  assert.equal(result.ok, true);
  assert.equal(result.ruleCreated, true);
  assert.match(result.message, /"Sentence test"/);
  assert.match(result.message, /DISABLED/);
  assert.ok(result.message.includes(result.projectScope));
  assert.ok(result.message.includes('uuid-123'));
});

test('failure response says plainly that the rule was NOT created', async () => {
  const result = await createJiraAutomationRule({});
  assert.equal(result.ok, false);
  assert.equal(result.ruleCreated, false);
  assert.match(result.summary, /^The rule was NOT created\./);
});

test('failure after creation does not claim the rule was not created', async () => {
  const result = await withForgeEnvironment(async (url, options = {}) => (
    options.method === 'POST'
      ? mockResponse(201, { ruleUuid: 'uuid-456' })
      : mockResponse(500, { error: 'boom' })
  ), () => createJiraAutomationRule({
    ruleSpec: JSON.stringify({
      name: 'Verify fail',
      projectId: '10449',
      trigger: { type: 'jira.issue.event.trigger:created' },
      actions: [{ type: 'codebarrel.action.log', value: 'hello' }],
    }),
  }));
  assert.equal(result.ok, false);
  assert.match(result.summary, /WAS created/);
  assert.ok(result.summary.includes('uuid-456'));
});

test('receipt digest is stable across key order and whitespace', async () => {
  const a = await createJiraAutomationRule({ ruleSpec: '{"name":"x","trigger":{"type":"t"}}' });
  const b = await createJiraAutomationRule({ ruleSpec: '{ "trigger": { "type": "t" },\n  "name": "x" }' });
  const c = await createJiraAutomationRule({ ruleSpec: '{"name":"y","trigger":{"type":"t"}}' });
  assert.match(a.receipt.digest, /^sha256:[0-9a-f]{64}$/);
  assert.equal(a.receipt.digest, b.receipt.digest);
  assert.notEqual(a.receipt.digest, c.receipt.digest);
});

test('receipt is present on pre-parse failures, with a digest and no summary', async () => {
  const result = await createJiraAutomationRule({ ruleSpec: '{not json' });
  assert.equal(result.ok, false);
  assert.match(result.receipt.digest, /^sha256:/);
  assert.equal(result.receipt.summary, null);
});

test('receipt summarizes trigger, conditions and actions', async () => {
  const result = await createJiraAutomationRule({
    ruleSpec: JSON.stringify({
      name: 'x',
      trigger: { type: 'jira.issue.event.trigger:created' },
      conditions: [{ type: 'jira.issue.condition' }],
      actions: [{ type: 'codebarrel.action.log' }],
    }),
  });
  assert.equal(
    result.receipt.summary.text,
    'Trigger: jira.issue.event.trigger:created. Conditions: jira.issue.condition. Actions: codebarrel.action.log.'
  );
});

test('receipt summarizes a full rule payload and never leaks credentials', async () => {
  const result = await createJiraAutomationRule({
    ruleSpec: JSON.stringify({
      rule: {
        name: 'x',
        trigger: { component: 'TRIGGER', type: 'jira.issue.event.trigger:created' },
        components: [{
          component: 'ACTION',
          type: 'jira.issue.outgoing.webhook',
          value: { headers: [{ name: 'Authorization', value: 'Bearer SUPERSECRET' }] },
        }],
      },
    }),
  });
  assert.match(result.receipt.summary.text, /Actions: jira\.issue\.outgoing\.webhook/);
  assert.ok(!JSON.stringify(result.receipt).includes('SUPERSECRET'));
});

test('createAndVerifyRule re-validates a stored rule and never POSTs one that is not DISABLED', async () => {
  let posted = false;
  const scope = 'ari:cloud:jira:test-cloud:project/10449';
  const tampered = {
    name: 'Tampered',
    state: 'ENABLED',
    actor: { type: 'ACCOUNT_ID', actor: 'test-actor' },
    ruleScopeARIs: [scope],
    trigger: { component: 'TRIGGER', type: 'jira.issue.event.trigger:created', value: { eventFilters: [scope] } },
    components: [],
  };
  const result = await withForgeEnvironment(async () => {
    posted = true;
    return mockResponse(201, { ruleUuid: 'should-not-exist' });
  }, () => createAndVerifyRule({ rule: tampered }));
  assert.equal(result.ok, false);
  assert.match(result.error, /DISABLED/);
  assert.equal(posted, false);
});

// Shapes as Jira's /rest/api/3/field returns them for system fields.
const SYSTEM_FIELD_METADATA = [
  { id: 'priority', key: 'priority', name: 'Priority', schema: { type: 'priority', system: 'priority' } },
  { id: 'issuetype', key: 'issuetype', name: 'Issue Type', schema: { type: 'issuetype', system: 'issuetype' } },
  { id: 'labels', key: 'labels', name: 'Labels', schema: { type: 'array', items: 'string', system: 'labels' } },
];

async function draftWithCondition(conditionValue) {
  let createdRule;
  const result = await withForgeEnvironment(async (url, options = {}) => {
    if (url.endsWith('/rest/api/3/field')) return mockResponse(200, SYSTEM_FIELD_METADATA);
    if (options.method === 'POST') {
      createdRule = JSON.parse(options.body).rule;
      return mockResponse(201, { ruleUuid: 'created-rule-id' });
    }
    return mockResponse(200, { rule: createdRule });
  }, () => createJiraAutomationRule({
    ruleSpec: JSON.stringify({
      name: 'System field condition',
      projectId: '10449',
      trigger: { type: 'jira.issue.event.trigger:created' },
      conditions: [{ type: 'jira.issue.condition', value: conditionValue }],
      actions: [{ type: 'codebarrel.action.log', value: 'matched' }],
    }),
  }));
  const conditions = [];
  walkComponents(createdRule?.components, (node) => {
    if (node.type === 'jira.issue.condition') conditions.push(node.value);
  });
  return { result, conditions };
}

test('builds a priority condition by numeric ID, matching the tenant rule shape', async () => {
  const { result, conditions } = await draftWithCondition({ name: 'Priority', value: '2' });

  assert.equal(result.ok, true);
  assert.deepEqual(conditions, [{
    selectedField: { type: 'ID', value: 'priority' },
    selectedFieldType: 'priority',
    comparison: 'EQUALS',
    compareValue: { type: 'ID', modifier: null, value: '2', multiValue: false, source: null },
  }]);
});

test('builds an issuetype condition when the field is given by its ID', async () => {
  const { result, conditions } = await draftWithCondition({ name: 'issuetype', value: 10001 });

  assert.equal(result.ok, true);
  assert.equal(conditions[0].selectedFieldType, 'issuetype');
  assert.equal(conditions[0].compareValue.value, '10001');
});

test('rejects a system-field condition given a display name instead of an ID', async () => {
  const { result } = await draftWithCondition({ name: 'Priority', value: 'High' });

  assert.equal(result.ok, false);
  assert.match(result.error, /numeric ID.*not "High"/);
});

test('still rejects a system field that has no verified condition shape', async () => {
  const { result } = await draftWithCondition({ name: 'Labels', value: 'soc' });

  assert.equal(result.ok, false);
  assert.match(result.error, /not on the verified list for jira\.issue\.condition/);
  // The agent is steered to the generic comparator rather than dead-ending.
  assert.match(result.error, /jira\.comparator\.condition/);
  assert.match(result.error, /\{\{issue\.labels\}\}/);
});

// Issue #17: a synthetic stand-in for the GSOC-Demo spec. The broken copy has
// sendNotifications inside fields with one brace missing, as the agent emitted it.
const EDIT_FORMULA = '{{#=}}ROUND({{issue.customfield_11594|0}} + 1, 2){{/}}';
const BROKEN_EDIT = `{"type":"jira.issue.edit","value":{"fields":{"Time Taken at Open Phase":"${EDIT_FORMULA}","sendNotifications":false}}`;
const FIXED_EDIT = `{"type":"jira.issue.edit","value":{"fields":{"Time Taken at Open Phase":"${EDIT_FORMULA}"},"sendNotifications":false}}`;
const specWith = (edit) =>
  `{"name":"Accumulate phase time","projectId":"10449","trigger":{"type":"jira.issue.event.trigger:created"},` +
  `"actions":[${edit},${edit}]}`;

test('a ruleSpec with a missing brace is rejected with an excerpt, not a bare offset', async () => {
  const result = await withForgeEnvironment(async () => {
    throw new Error('no network call expected');
  }, () => createJiraAutomationRule({ ruleSpec: specWith(BROKEN_EDIT) }));

  assert.equal(result.ok, false);
  assert.match(result.error, /^ruleSpec is not valid JSON \(Expected double-quoted property name\)/);
  assert.match(result.error, /"sendNotifications":false\}\},>>>HERE<<<\{"type"/);
  assert.doesNotMatch(result.error, /position \d+/);
});

test('the corrected ruleSpec builds, with sendNotifications beside fields', async () => {
  let createdRule;
  const result = await withForgeEnvironment(async (url, options = {}) => {
    if (url.endsWith('/rest/api/3/field')) return mockResponse(200, FIELD_METADATA);
    if (options.method === 'POST') {
      createdRule = JSON.parse(options.body).rule;
      return mockResponse(201, { ruleUuid: 'created-rule-id' });
    }
    return mockResponse(200, { rule: createdRule });
  }, () => createJiraAutomationRule({ ruleSpec: specWith(FIXED_EDIT) }));

  assert.equal(result.ok, true, result.error);
  const edits = createdRule.components.filter((component) => component.type === 'jira.issue.edit');
  assert.equal(edits.length, 2);
  for (const edit of edits) assert.equal(edit.value.sendNotifications, false);
});

test('sendNotifications inside fields is named per action, before any network call', async () => {
  let calls = 0;
  const misplaced = { type: 'jira.issue.edit', value: { fields: { 'Time Taken at Open Phase': '1', sendNotifications: false } } };
  const result = await withForgeEnvironment(async () => {
    calls += 1;
    throw new Error('no network call expected');
  }, () => createJiraAutomationRule({
    ruleSpec: JSON.stringify({
      name: 'x',
      projectId: '10449',
      trigger: { type: 'jira.issue.event.trigger:created' },
      actions: [misplaced],
      branches: [{ conditions: [], actions: [], branches: [{ conditions: [], actions: [{ type: 'jira.issue.comment', value: {} }, misplaced] }] }],
    }),
  }));

  assert.equal(result.ok, false);
  assert.equal(calls, 0);
  assert.match(result.error, /2 malformed jira\.issue\.edit action/);
  assert.match(result.error, /actions\[0\] has sendNotifications inside value\.fields/);
  assert.match(result.error, /branches\[0\]\.branches\[0\]\.actions\[1\] has sendNotifications inside value\.fields/);
});

test('an edit action without fields is named by its path', async () => {
  const result = await withForgeEnvironment(async () => {
    throw new Error('no network call expected');
  }, () => createJiraAutomationRule({
    ruleSpec: JSON.stringify({
      name: 'x',
      projectId: '10449',
      trigger: { type: 'jira.issue.event.trigger:created' },
      actions: [{ type: 'jira.issue.edit', value: { sendNotifications: false } }],
    }),
  }));

  assert.equal(result.ok, false);
  assert.match(result.error, /actions\[0\] has no value\.fields/);
});

// --- transitioned trigger: status filters -----------------------------------
// The agent sends plain status names; the builder wraps each as
// { type: 'NAME', value }, the form every status-filtered rule on the site
// uses. Plain strings sent to the Automation API get HTTP 500 with an EMPTY
// body, so anything that is not a list of names is refused at draft time.

async function buildTransitionRule(triggerExtras) {
  let createdRule;
  const result = await withForgeEnvironment(async (url, options = {}) => {
    if (url.endsWith('/rest/api/3/field')) return mockResponse(200, FIELD_METADATA);
    if (options.method === 'POST') {
      createdRule = JSON.parse(options.body).rule;
      return mockResponse(201, { ruleUuid: 'created-rule-id' });
    }
    return mockResponse(200, { rule: createdRule });
  }, () => createJiraAutomationRule({
    ruleSpec: JSON.stringify({
      name: 'Transition rule',
      projectId: '10449',
      trigger: { type: 'jira.issue.event.trigger:transitioned', ...triggerExtras },
      actions: [{ type: 'codebarrel.action.log', value: 'moved' }],
    }),
  }));
  return { result, createdRule };
}

test('fromStatus names are trimmed and wrapped as NAME status references', async () => {
  const { result, createdRule } = await buildTransitionRule({ fromStatus: ['Open', ' In Triage '] });

  assert.equal(result.ok, true);
  assert.deepEqual(createdRule.trigger.value.fromStatus, [
    { type: 'NAME', value: 'Open' },
    { type: 'NAME', value: 'In Triage' },
  ]);
  assert.deepEqual(createdRule.trigger.value.toStatus, []);
});

test('a toStatus nested in value is wrapped the same way', async () => {
  const { result, createdRule } = await buildTransitionRule({ value: { toStatus: ['Closed'] } });

  assert.equal(result.ok, true);
  assert.deepEqual(createdRule.trigger.value.toStatus, [{ type: 'NAME', value: 'Closed' }]);
});

// Regression: a single string used to be dropped silently, so the rule fired
// on EVERY transition while the draft the approver read named one status.
test('a single status string is refused, not dropped', async () => {
  const { result, createdRule } = await buildTransitionRule({ toStatus: 'Closed' });

  assert.equal(result.ok, false);
  assert.equal(createdRule, undefined);
  assert.match(result.error, /trigger\.toStatus must be a list of status names/);
  // The rejected value is echoed so the agent can see what it sent.
  assert.match(result.error, /"Closed"/);
});

test('pre-wrapped status objects are refused, so there is one input form', async () => {
  const { result } = await buildTransitionRule({ fromStatus: [{ type: 'NAME', value: 'Open' }] });

  assert.equal(result.ok, false);
  assert.match(result.error, /trigger\.fromStatus\[0\]/);
});

test('a transitioned trigger with no status filter builds with both arrays empty', async () => {
  const { result, createdRule } = await buildTransitionRule({});

  assert.equal(result.ok, true);
  assert.deepEqual(createdRule.trigger.value.fromStatus, []);
  assert.deepEqual(createdRule.trigger.value.toStatus, []);
});
