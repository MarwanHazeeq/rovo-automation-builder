import assert from 'node:assert/strict';
import test from 'node:test';
import { createAndVerifyRule, createJiraAutomationRule, onCreateOutcome } from '../src/index.js';

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

// Every schedule field the requester must state; none has a default.
const FULL_SCHEDULE = {
  frequency: 'WEEKLY',
  days: ['MO'],
  hour: 9,
  minute: 0,
  timezone: 'Asia/Singapore',
};

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
          frequency: 'WEEKLY',
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

  const noJql = await build({ schedule: FULL_SCHEDULE });
  assert.equal(noJql.ok, false);
  assert.match(noJql.error, /trigger\.jql/);

  const badDay = await build({ jql: 'status = Open', schedule: { ...FULL_SCHEDULE, days: ['FUNDAY'] } });
  assert.equal(badDay.ok, false);
  assert.match(badDay.error, /unrecognized day/);

  const badHour = await build({ jql: 'status = Open', schedule: { ...FULL_SCHEDULE, hour: 25 } });
  assert.equal(badHour.ok, false);
  assert.match(badHour.error, /hour must be an integer between 0 and 23/);

  const badZone = await build({ jql: 'status = Open', schedule: { ...FULL_SCHEDULE, timezone: 'Mars/Olympus' } });
  assert.equal(badZone.ok, false);
  assert.match(badZone.error, /not a recognized IANA time zone/);

  const badRaw = await build({ jql: 'status = Open', schedule: 'every monday at 9' });
  assert.equal(badRaw.ok, false);
  assert.match(badRaw.error, /complete iCal VEVENT/);
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
        schedule: FULL_SCHEDULE,
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

test('a scheduled trigger missing a schedule value throws, in the requester\'s words', async () => {
  const build = (schedule) => withForgeEnvironment(
    async () => mockResponse(201, { ruleUuid: 'should-not-be-created' }),
    () => createJiraAutomationRule({
      ruleSpec: JSON.stringify({
        name: 'Unscheduled rule',
        projectId: '10878',
        trigger: { type: 'jira.jql.scheduled', jql: 'status = Open', schedule },
        actions: [{ type: 'codebarrel.action.log', value: 'x' }],
      }),
    })
  );

  const { timezone, ...noZone } = FULL_SCHEDULE;
  const { hour, ...noHour } = FULL_SCHEDULE;
  const { days, ...noDays } = FULL_SCHEDULE;
  const { frequency, ...noFrequency } = FULL_SCHEDULE;
  const cases = [
    [undefined, /did not say when the rule should run/],
    [noZone, /did not say which time zone/],
    [noHour, /did not say what hour of the day/],
    [noDays, /did not say which day\(s\) of the week/],
    [noFrequency, /did not say how often/],
  ];
  for (const [schedule, message] of cases) {
    const result = await build(schedule);
    assert.equal(result.ok, false);
    assert.match(result.error, message);
  }
});

test('a web request without an HTTP method throws and a complete one is created DISABLED', async () => {
  let createdRule;
  const run = (value) => withForgeEnvironment(async (url, options = {}) => {
    if (options.method === 'POST') {
      createdRule = JSON.parse(options.body).rule;
      return mockResponse(201, { ruleUuid: 'created-rule-id' });
    }
    return mockResponse(200, { rule: createdRule });
  }, () => createJiraAutomationRule({
    ruleSpec: JSON.stringify({
      name: 'Web request',
      projectId: '10878',
      trigger: { type: 'jira.issue.event.trigger:created' },
      actions: [{ type: 'jira.issue.outgoing.webhook', value }],
    }),
  }));

  const missing = await run({ url: 'https://example.test/hook' });
  assert.equal(missing.ok, false);
  assert.match(missing.error, /did not say which HTTP method/);

  const complete = await run({ url: 'https://example.test/hook', method: 'post' });
  assert.equal(complete.ok, true);
  assert.equal(createdRule.state, 'DISABLED');
  assert.equal(createdRule.components[0].value.method, 'POST');
});
