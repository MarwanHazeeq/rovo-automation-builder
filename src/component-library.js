/**
 * COMPONENT PAYLOAD LIBRARY
 *
 * Verified `value` shapes for every trigger, action, condition and structural
 * component type on this app's allowlist (see index.js: TRIGGER_BUILDERS /
 * ALLOWED_ACTION_TYPES / ALLOWED_CONDITION_TYPES / ALLOWED_STRUCTURAL_TYPES).
 *
 * Served to the Rovo agent by the get-component-reference tool. This file is
 * the single source of truth for component value shapes; the copy in the
 * project docs is a mirror for humans, not an input to the app.
 *
 * `example` IS THE INPUT CONTRACT. It is what the agent copies, so it must be
 * the shape buildRulePayload (index.js) ACCEPTS, not the shape Jira exports.
 * For a type the builder assembles itself (triggers, jira.issue.edit,
 * jira.issue.condition, the web request action) the exported shape differs
 * from the accepted one: record the export shape under `builtInternally`,
 * which is served to the agent as "what the builder produces, do not send".
 * test/component-contract.test.js feeds every `example` through
 * buildRulePayload, so an entry that documents an export shape fails CI.
 *
 * WHY THIS FILE EXISTS
 * Atlassian does not publish a schema for automation component `value`
 * objects. Per Atlassian support: "the component identifier must be
 * obtained by exporting an existing rule." That is a one-time cost per
 * type, not a recurring one -- once a type's shape is captured here, every
 * future rule that uses it is built from this file instead of a fresh
 * throwaway prototype in the Jira Automation UI.
 *
 * SOURCES
 * Each entry's `source` field names the real rule export it was taken
 * from, so a shape can be re-verified against the tenant if the
 * Automation API ever changes it. Two entries had literal secrets in the
 * original export (an OAuth client secret and a webhook signing key) --
 * those are replaced with <PLACEHOLDER> below. Rotate anything that was
 * ever pasted in plaintext outside a secrets manager.
 *
 * HOW TO ADD A NEW TYPE
 * 1. Build ONE rule of the new type in the Jira Automation UI (throwaway
 *    is fine -- this is the only time you need one for this type).
 *    2. Export it, or GET it via the Automation Rule Management API
 *    (get_automation_rule_details-equivalent: GET .../rule/{uuid}).
 * 3. Copy the component's `value` object and `schemaVersion` into the
 *    matching library below, add it to ALLOWED_*_TYPES in index.js, and
 *    delete the throwaway rule.
 * 4. Never repeat step 1 for that type again.
 */

// ─── Trigger Library ────────────────────────────────────────────────────
// index.js builds trigger values in TRIGGER_BUILDERS rather than taking
// them verbatim, so these are the target shapes those builders must emit.

// Observation from Auto-Triage.txt: the API accepts MANY project ARIs in an
// event trigger's eventFilters (that rule scopes to 7). index.js deliberately
// allows exactly one, as a blast-radius limit on agent-generated rules -- that
// is a policy choice, not an API constraint, so widening it is a decision to
// make explicitly rather than a bug to fix.

const TRIGGER_LIBRARY = {

  'jira.issue.event.trigger:created': {
    schemaVersion: 1,
    description: 'Run when a work item is created in the scoped project.',
    source: 'Accepted rule schema/structure, Auto-Triage.txt',
    example: {},
    builtInternally: {
      description:
        'NOT something to send. The builder produces this value; it is recorded as evidence of the exported shape.',
      value: {
        eventKey: 'jira:issue_created',
        issueEvent: 'issue_created',
        eventFilters: ['ari:cloud:jira:<cloudId>:project/<numericProjectId>'],
      },
    },
    notes:
      'The trigger takes no settings: send just { "type": "jira.issue.event.trigger:created" }. ' +
      'index.js builds eventFilters from the rule scope. The API accepts many ' +
      'project ARIs here (Auto-Triage.txt uses seven); index.js deliberately permits exactly one.',
  },

  'jira.issue.event.trigger:transitioned': {
    schemaVersion: 1,
    description: 'Run when a work item moves between statuses. Filterable by source and destination.',
    source: 'index.js TRIGGER_BUILDERS',
    example: {
      fromStatus: ['Open'],
      toStatus: [],
    },
    builtInternally: {
      description:
        'NOT something to send. The builder produces this value; eventFilters, eventKey and issueEvent are never supplied.',
      value: {
        eventFilters: ['ari:cloud:jira:<cloudId>:project/<numericProjectId>'],
        fromStatus: ['Open'],
        toStatus: [],
        eventKey: 'jira:issue_updated',
        issueEvent: 'issue_generic',
      },
    },
    notes:
      'Supply fromStatus / toStatus as arrays of status NAMES on the trigger; an empty array means ' +
      '"any". A fromStatus filter is the cheapest way to restrict a rule to one source status -- it ' +
      'replaces a guard condition entirely. Inside the rule, the transition is readable as ' +
      '{{changelog.status.fromString}} and {{changelog.status.toString}}.',
  },

  'jira.issue.field.changed': {
    schemaVersion: 2,
    description: 'Run when one of the named fields changes.',
    source: 'index.js TRIGGER_BUILDERS',
    example: {
      changeType: 'ANY_CHANGE',
      fields: ['Response Time'],
    },
    builtInternally: {
      description:
        'NOT something to send. The builder produces this value; eventFilters, actions and the { value, type } field wrappers are never supplied.',
      value: {
        eventFilters: ['ari:cloud:jira:<cloudId>:project/<numericProjectId>'],
        changeType: 'ANY_CHANGE',
        fields: [{ value: 'Response Time', type: 'fieldName' }],
        actions: ['edit'],
      },
    },
    notes: 'Supply trigger.fields as an array of field-name strings; index.js wraps each one.',
  },
  'jira.jql.scheduled': {
    schemaVersion: 1,
    description:
      'Run on a schedule against every work item matching a JQL query. The rule body ' +
      'executes ONCE PER MATCHING ISSUE with {{issue}} scoped to that issue -- this is the ' +
      'closest thing to iteration available on this tenant, and it needs no iterative ' +
      'container component (there is none on the allowlist).',
    source: 'BulkUpdate.txt (Historical_Time to First Response)',
    example: {
      jql: '"Response Time" is EMPTY',
      schedule: {
        frequency: 'WEEKLY',
        days: ['MO'],
        hour: 9,
        minute: 0,
        timezone: 'Asia/Singapore',
        interval: 1,
      },
      onlyUpdatedIssues: false,
    },
    builtInternally: {
      description:
        'NOT something to send. The builder produces this value from the schedule above, including the iCal rRule and the vestigial cron/rate fields.',
      value: {
        schedule: {
          cronExpression: '',
          method: 'BASIC',
          rate: 0,
          rateInterval: 86400,
          rRule:
            'BEGIN:VEVENT\nDTSTART;TZID=Asia/Singapore:20260925T153700\n' +
            'RRULE:FREQ=WEEKLY;BYHOUR=9;BYMINUTE=0;BYSECOND=0;BYDAY=MO;INTERVAL=1\n' +
            'END:VEVENT\n',
        },
        jql: '"Response Time" is EMPTY',
        executionMode: 'jql',
        onlyUpdatedIssues: false,
      },
    },
    notes:
      'IMPLEMENTED in index.js TRIGGER_BUILDERS. Takes { jql, schedule: { frequency, days, hour, minute, ' +
      'timezone, startDate?, interval? } }. frequency, hour, minute and timezone are REQUIRED (days too for ' +
      'WEEKLY): a missing one is refused, never defaulted, so ask the requester. It owns the iCal encoding, because an RRULE is ' +
      'the kind of transport detail an LLM gets wrong silently -- BulkUpdate.txt was described as a ' +
      'Monday rule but carries BYDAY=MO,TU,WE,TH,FR. A complete VEVENT string is accepted as an ' +
      'escape hatch. Adding the trigger also required gating TWO eventFilters checks (pre-send ' +
      'validation and post-create verification) on RULE_SCOPED_TRIGGER_TYPES, since a scheduled ' +
      'trigger has no eventFilters; verification asserts the JQL and executionMode round-tripped ' +
      'instead, and ruleScopeARIs remains the containment boundary. ' +
      'method "BASIC" pairs with rRule; cronExpression/rate/rateInterval are vestigial and stay at ' +
      '""/0/86400 in the verified export -- send them anyway, do not omit them. ' +
      'The rRule is an iCal VEVENT string, and its RRULE BYHOUR/BYMINUTE override the DTSTART ' +
      'time of day -- DTSTART effectively only sets the timezone and the start date. ' +
      'BYDAY is the day filter: BYDAY=MO is Mondays, BYDAY=MO,TU,WE,TH,FR is every weekday. ' +
      'onlyUpdatedIssues false re-scans the whole JQL result set on every run. ' +
      'Scheduled JQL rules have a per-execution issue cap -- a large historical backlog can be ' +
      'silently truncated, so check the audit log for a truncation warning on the first runs.',
  },
};

// ─── Action Library ─────────────────────────────────────────────────────

const ACTION_LIBRARY = {
  'jira.create.variable': {
    schemaVersion: 1,
    description: 'Create a named smart-value variable for later steps to reference.',
    source: 'Sample Integration Automation (SPLC-SDP_Request Creation)',
    example: {
      id: '_customsmartvalue_id_1758073090007',
      name: { type: 'FREE', value: 'ClientID' },
      type: 'SMART',
      query: { type: 'SMART', value: '<SMART_VALUE_EXPRESSION_OR_LITERAL>' },
      lazy: false,
    },
    notes:
      'id is a free-form unique string per variable -- generate one, do not reuse another variable\'s id. ' +
      'query.value is either a literal (a client ID, a static string) or a smart-value expression ' +
      'such as "{{issue.customfield_10257}}" or "{{now.diff(issue.created).minutes.abs|0}}".',
  },

  'jira.create.mapping-variable': {
    schemaVersion: 1,
    description: 'Create a lookup-table variable (key -> value) queried later as {{VarName.get(key)}}.',
    source: 'Sample Integration Automation (SiteMap / PriorityMap)',
    example: {
      name: { type: 'FREE', value: 'PriorityMap' },
      mappings: [
        { key: 'Informational', value: 'P3' },
        { key: 'Low', value: 'P3' },
        { key: 'Medium', value: 'P2' },
        { key: 'High', value: 'P1' },
        { key: 'Critical', value: 'Urgent' },
      ],
    },
    notes: 'No top-level "type"/"id" fields on this one (unlike jira.create.variable) -- do not add them.',
  },

  'codebarrel.action.log': {
    schemaVersion: 1,
    description: 'Write a value to the automation audit log. Useful for debugging a rule during development.',
    source: 'Sample Calculation Automation (Status Phase Calculator)',
    example: '{{triageSLAminutes}}',
    notes:
      'IMPORTANT: value is a bare STRING here, not an object -- {"value": {...}} is wrong and will 400. ' +
      'Pass whatever smart-value or literal text you want logged directly as the value.',
  },

  'jira.issue.outgoing.webhook': {
    schemaVersion: 1,
    description: 'Send an HTTP request (webhook) to an external system.',
    source: 'Sample Integration Automation (SPLC-SDP_Request Creation)',
    example: {
      url: 'https://example.com/api/endpoint',
      urlSecure: false,
      headers: [
        { id: '_header_1758073141366', name: 'Content-Type', value: 'application/json', headerSecure: false },
      ],
      sendIssue: false,
      contentType: 'custom',
      customBody: '{{someVariable}}',
      method: 'POST',
      responseEnabled: true,
      continueOnErrorEnabled: true,
      authenticate: true,
    },
    notes:
      'NEVER send an Authorization header: the builder rejects it. Set "authenticate": true instead and it ' +
      'adds an Authorization header holding a placeholder (REPLACE_ME_BEFORE_ENABLING) for a human to ' +
      'replace in the Automation UI before enabling the rule; omit it if the endpoint needs no auth. ' +
      'authenticate is this app\'s own flag and is removed from the stored value. url and method are required ' +
      '(a missing method is refused, never guessed as GET: ask the requester): ' +
      'urlSecure, sendIssue, responseEnabled and continueOnErrorEnabled default as in the example, ' +
      'contentType defaults to "empty". ' +
      'contentType "custom" pairs with customBody (a string, JSON or form-encoded, built from smart values). ' +
      'contentType "empty" (see the TRIGGER_BUILDERS defaults elsewhere) sends no body. ' +
      'Each header needs its own generated id, same free-form style as jira.create.variable\'s id. ' +
      'The response is read back as {{webhookResponse.*}} -- NOT {{webResponse.*}}, which resolves ' +
      'empty and fails silently. A second request in the same rule OVERWRITES webhookResponse, so ' +
      'copy anything still needed into a jira.create.variable step first. ' +
      'Never inline a real secret in headers/customBody in a spec sent to the Rovo agent -- resolve it from a ' +
      'Forge environment variable or a jira.create.variable step instead, the way ClientSecret is handled in the source rule.',
  },

  'action.wait.for.time.duration': {
    schemaVersion: 1,
    description: 'Pause the rule for a fixed number of seconds before continuing.',
    source: 'Sample Calculation Automation',
    example: { waitTimeInSeconds: 10, randomWaitInterval: null },
  },

  'jira.issue.refresh.issue': {
    schemaVersion: 1,
    description: 'Re-fetch the issue\'s current state mid-rule, so later steps see fields changed earlier in the same run.',
    source: 'Sample Calculation Automation',
    example: { delayMs: null },
  },

  'jira.set.entity.property': {
    schemaVersion: 3,
    description: 'Write a JSON blob to an issue (or other entity) property -- used for rule-private state that has no UI field.',
    source: 'Sample Calculation Automation (slaPhaseTimer)',
    example: {
      entityType: 'ISSUE',
      entity: null,
      key: 'slaPhaseTimer',
      value: '{\n  "enteredAt": "{{now.jiraDateTime}}"\n}',
    },
    notes: 'value is a JSON string (note the escaped newlines in the source), not a nested object.',
  },

  'jira.issue.comment': {
    schemaVersion: 2,
    description: 'Add a comment to the issue.',
    source: 'Sample Integration Automation',
    example: {
      comment: 'Some text or {{smart.value}}',
      publicComment: false,
      commentVisibility: null,
      sendNotifications: true,
      addCommentOnce: true,
    },
  },

  'jira.issue.edit': {
    schemaVersion: 12,
    description:
      'Edit one or more fields on the issue. Send value.fields; the builder looks each field up on the ' +
      'tenant and writes the Jira payload itself.',
    source: 'Sample Integration Automation + Sample Calculation Automation + BulkUpdate.txt',
    example: {
      fields: {
        'Escalated to Customer': 'Yes',
        customfield_11594: '{{#=}}ROUND({{issue.customfield_11594|0}} + 1, 2){{/}}',
      },
    },
    notes:
      'INPUT CONTRACT: value.fields is an object mapping a field NAME or field ID to the value, or an ' +
      'array of { name or fieldId, value } entries. Do NOT send "operations" or "advancedFields": the ' +
      'builder rejects them and builds them itself from the tenant\'s field metadata. Supported field ' +
      'types: single-select and text (written as operations), and float/number (written as ' +
      'advancedFields; the value may be a number, a smart value or a {{#=}} math expression, and the ' +
      'builder adds the {{#=}} wrapper when needed). System fields (labels, issuetype, priority, ...) ' +
      'are NOT supported and throw. A field name that matches several fields throws; send the ' +
      'customfield_NNNNN ID instead. sendNotifications defaults to true; send false to opt out. ' +
      'To change fields together with a status change, use jira.issue.transition, whose operations ' +
      'array IS sent as shown there.',
    builtInternally: {
      description:
        'NOT AN INPUT. These are the payloads the builder PRODUCES from value.fields, kept as evidence of ' +
        'what Jira exports and of which field types are supported. Sending any of them directly is rejected.',
      shapes: {
        operations: {
          description:
            'Produced for a plain SET on a text or single-select field: referenced by NAME with an ' +
            'explicit fieldType.',
          example: {
            operations: [
              {
                field: { type: 'NAME', value: 'Customer ITSM Incident' },
                fieldType: 'com.atlassian.jira.plugin.system.customfieldtypes:textfield',
                type: 'SET',
                value: '{{webhookResponse.body.request.id}}',
              },
            ],
            advancedFields: null,
            sendNotifications: true,
          },
        },
        operationsFloat: {
          description:
            'Exported form of a FLOAT (numeric) field set through operations, with the value carrying a ' +
            '{{#=}} math expression as a plain string. A rule running on this tenant does it this way, ' +
            'but the builder PRODUCES the advancedFields form below for float fields.',
          source: 'BulkUpdate.txt (Historical_Time to First Response)',
          example: {
            operations: [
              {
                field: { type: 'NAME', value: 'Response Time' },
                fieldType: 'com.atlassian.jira.plugin.system.customfieldtypes:float',
                type: 'SET',
                value: '{{#=}}ROUND({{issue.customfield_10049.ongoingCycle.elapsedTime.millis}} / 60000, 1){{/}}',
              },
            ],
            advancedFields: null,
            sendNotifications: true,
          },
          notes:
            'buildRulePayload routes float fields to the advancedFields shape below (and ' +
            'isSafeJiraNumericExpression permits ROUND(x, n)). This operations form is evidence the ' +
            'tenant accepts it, not an input: sending it is rejected.',
        },
        operationsSystemField: {
          description:
            'A SYSTEM field (labels, issuetype, priority, ...) rather than a custom field. These are ' +
            'referenced by ID, their fieldType is the bare field id rather than a ' +
            'customfieldtypes:* class, and a multi-value field takes an ARRAY of { type, value }.',
          source: 'Auto-Triage.txt (labels set during a transition)',
          example: {
            operations: [
              {
                field: { type: 'ID', value: 'labels' },
                fieldType: 'labels',
                type: 'SET',
                value: [{ type: 'NAME', value: 'suspicious-activity' }],
              },
            ],
            advancedFields: null,
            sendNotifications: true,
          },
          notes:
            'The builder CANNOT produce this yet: findJiraField + EDIT_OPERATION_VALUE_BUILDERS key on ' +
            'jiraField.schema.custom, which system fields do not have (they carry schema.system), so ' +
            'any attempt to edit labels or issuetype throws "not on the verified list". Adding it means ' +
            'a schema.system branch and a per-field builder, since the value shape differs by field ' +
            '(array for labels, likely scalar for priority) -- export one per field before adding it.',
        },
        advancedFields: {
          description:
            'Produced for float/number fields, which covers arithmetic such as incrementing by a computed ' +
            'amount. advancedFields is a JSON-shaped STRING (not a nested object) using smart-value ' +
            'template syntax, keyed by field ID.',
          example: {
            operations: [],
            advancedFields:
              '{\n  "fields": {\n    "customfield_11594": {{#=}}{{issue.customfield_11594|0}} + {{minutesToAdd|0}}{{/}}\n  }\n}',
            sendNotifications: false,
          },
          notes: 'Keys inside advancedFields use the field ID (customfield_NNNNN), not the display name.',
        },
      },
    },
  },

  'jira.issue.transition': {
    schemaVersion: 11,
    description:
      'Transition the issue to a new status, optionally setting fields in the same action.',
    source: 'Auto-Triage.txt',
    example: {
      operations: [
        {
          field: { type: 'ID', value: 'labels' },
          fieldType: 'labels',
          type: 'SET',
          value: [{ type: 'NAME', value: 'suspicious-activity' }],
        },
      ],
      advancedFields: null,
      sendNotifications: true,
      destinationStatus: { type: 'NAME', value: 'Triage Phase' },
      transitionMatch: '',
    },
    notes:
      'schemaVersion 11 confirmed. NOTE the previously recorded guess included an ' +
      '"ignoreConditions" key -- the real export has NO such key, so do not send it. ' +
      'transitionMatch is an empty string when the destination is given by name. ' +
      'The operations array is the same shape as jira.issue.edit\'s, so a transition can set ' +
      'fields atomically with the status change instead of needing a separate edit action. ' +
      'index.js passes this value through verbatim (only jira.issue.edit is built from field ' +
      'metadata), so an agent-supplied transition value is currently unvalidated -- the operations ' +
      'array here is exactly the shape the code comments say an LLM cannot reliably invent.',
  },
};

// ─── Condition Library ──────────────────────────────────────────────────

const CONDITION_LIBRARY = {
  'jira.comparator.condition': {
    schemaVersion: 1,
    description: 'Compare two smart-value expressions or literals.',
    source: 'Sample Calculation Automation + Sample Integration Automation + BulkUpdate.txt',
    example: {
      first: '{{issue.priority.name}}',
      second: 'High',
      operator: 'EQUALS',
    },
    verifiedOperators: ['EQUALS', 'NOT_EQUALS', 'GREATER_THAN', 'LESS_THAN'],
    notes:
      'Both sides are strings even when comparing numbers (e.g. second: "199"). Coerce, don\'t pass a JSON number. ' +
      'The verified idiom for "this smart value resolved to something" is second: "" with ' +
      'operator NOT_EQUALS -- see BulkUpdate.txt, which tests an SLA duration this way. Use it to guard ' +
      'any {{#=}} expression whose operand could render empty, since empty operands break the math block.',
  },

  'jira.issue.condition': {
    schemaVersion: 3,
    description: 'Check a specific issue field\'s value against a comparison. More structured than the comparator condition.',
    source: 'Sample Integration Automation',
    example: {
      name: 'Send to Customer ITSM',
      value: 'Yes',
      comparison: 'EQUALS',
    },
    notes:
      'INPUT CONTRACT: { name, value, comparison? } -- the field\'s display name and the value to compare ' +
      'it with. The builder looks the field up on the tenant and writes selectedField, selectedFieldType ' +
      'and compareValue itself; do not send those. Only single-select custom fields and the EQUALS ' +
      'comparison are supported. System fields (issuetype, priority, ...) and other custom field types ' +
      'throw; for those, use a jira.comparator.condition on a smart value instead.',
    builtInternally: {
      description:
        'NOT AN INPUT. These are the payloads the builder PRODUCES (or, for system fields, cannot yet ' +
        'produce), kept as evidence of the exported shape.',
      shapes: {
        customSelectField: {
          source: 'Sample Integration Automation',
          value: {
            selectedField: { type: 'NAME', value: 'Send to Customer ITSM' },
            selectedFieldType: 'com.atlassian.jira.plugin.system.customfieldtypes:select',
            comparison: 'EQUALS',
            compareValue: { type: 'NAME', modifier: null, value: 'Yes', multiValue: false, source: null },
          },
        },
        systemField: {
          source: 'Auto-Triage.txt (issue type equals Incident)',
          value: {
            selectedField: { type: 'ID', value: 'issuetype' },
            selectedFieldType: 'issuetype',
            comparison: 'EQUALS',
            compareValue: { type: 'ID', modifier: null, value: '10001', multiValue: false, source: null },
          },
          notes:
            'System fields use type "ID" on BOTH selectedField and compareValue, a bare selectedFieldType, ' +
            'and the numeric entity id as compareValue.value -- not the display name. The builder cannot ' +
            'produce this yet (it keys on schema.custom).',
        },
      },
    },
  },
};

// ─── Structural (branching) Library ─────────────────────────────────────
// These wrap conditions/actions to build if/else logic. They have no
// business-logic value of their own -- the interesting content lives in
// their `conditions` and `children` arrays.

const STRUCTURAL_LIBRARY = {
  'jira.condition.container.block': {
    schemaVersion: 1,
    description:
      'A pass-through wrapper that holds one or more CONDITION_BLOCK children. The builder emits exactly one ' +
      'per branching rule; its own value is always empty. You never send this type: send ruleSpec.branches.',
    source: 'Sample Calculation Automation, Sample Integration Automation, BulkUpdate.txt',
    // INPUT: the ruleSpec fields that make the builder emit this container.
    example: {
      branches: [
        {
          conditionMatchType: 'ALL',
          conditions: [
            { type: 'jira.comparator.condition', value: { first: '{{issue.priority.name}}', second: 'High', operator: 'EQUALS' } },
          ],
          actions: [{ type: 'codebarrel.action.log', value: 'escalate' }],
        },
        {
          conditions: [],
          actions: [{ type: 'codebarrel.action.log', value: 'flag' }],
        },
      ],
    },
    builtInternally: {
      description:
        'What the builder EMITS for the example above. This is NOT AN INPUT -- do not send it. ' +
        'One container holds one if.block per branch, in order; each block has its own id, and its ' +
        'conditions (conditionParentId) and actions (parentId) point at that id.',
      shapes: {
        container: { component: 'CONDITION', type: 'jira.condition.container.block', value: {}, children: ['<one CONDITION_BLOCK per branch>'] },
      },
    },
  },
  'jira.condition.if.block': {
    schemaVersion: 1,
    description:
      'One if / else-if / else branch. Send it as one entry of ruleSpec.branches: its `conditions` hold the ' +
      'test(s), its `actions` run when the branch matches. You never send this type directly.',
    source: 'Sample Calculation Automation, Sample Integration Automation, BulkUpdate.txt',
    // INPUT: one entry of ruleSpec.branches.
    example: {
      conditionMatchType: 'ALL',
      conditions: [
        { type: 'jira.comparator.condition', value: { first: '{{issue.priority.name}}', second: 'High', operator: 'EQUALS' } },
      ],
      actions: [{ type: 'codebarrel.action.log', value: 'matched' }],
    },
    verifiedMatchTypes: ['ALL', 'ANY'],
    builtInternally: {
      description:
        'What the builder EMITS per branch. This is NOT AN INPUT -- do not send it.',
      shapes: {
        ifBlock: { component: 'CONDITION_BLOCK', type: 'jira.condition.if.block', value: { conditionMatchType: 'ALL' }, conditions: ['<branch conditions>'], children: ['<branch actions>'] },
      },
    },
    notes:
      'ELSE is the LAST branch with an EMPTY `conditions` array -- verified in BulkUpdate.txt. It always ' +
      'matches, so its actions run when no earlier branch matched; guard the body itself if the fall-through ' +
      'case includes data that may be absent. Only the last branch may be empty, there can be one else, and ' +
      'every branch needs at least one action. Do not send branches together with top-level ' +
      'conditions/actions.',
  },
};

// ─── Verified smart-value expressions ───────────────────────────────────
// Not component shapes, but the same problem: an LLM will guess these, and a
// wrong guess renders empty rather than erroring. Only add what an export proves.

const VERIFIED_SMART_VALUES = {
  'math block': {
    source: 'BulkUpdate.txt',
    verified: [
      '{{#=}}ROUND(<numeric expression>, <decimal places>){{/}}  // ROUND(x, n) confirmed working',
      '{{#=}}{{issue.customfield_11594|0}} + {{minutesToAdd|0}}{{/}}  // plain arithmetic, Status-Phase-Calc',
    ],
    notes:
      'ROUND with an explicit decimal-places argument is confirmed on this tenant. ' +
      'The |0 default filter is the guard against a null field turning the whole block empty.',
  },

  'string timestamps and date diffs': {
    source: 'Gate test, GSOC-Demo, 2026-09-30',
    verified: [
      '{{earlier.toDate.diff(later.toDate).millis}}  // POSITIVE duration -- see operand order below',
      '{{earlier.toDate("yyyy-MM-dd\'T\'HH:mm:ss.SSSZ").diff(later.toDate("...")).millis}}  // same result',
    ],
    doesNotWork: [
      '{{exitVar.diff(entryVar).millis}}  // EMPTY -- Jira does not coerce an ISO-8601 string to a date',
      '{{issue.created.diff(exitVar).millis}}  // EMPTY -- a native date on the left does not help either',
    ],
    notes:
      'TWO findings, both load-bearing. (1) .toDate is mandatory: a timestamp taken from a parsed ' +
      'JSON body is a string, and no date function touches it until .toDate converts it. The bare ' +
      '.toDate works, so the quoted format argument is unnecessary -- prefer the bare form, since ' +
      'quotes are rejected inside a math expression by index.js isSafeJiraNumericExpression. ' +
      '(2) .diff() returns ARGUMENT MINUS RECEIVER, not the reverse: exit.diff(entry) evaluates to ' +
      'entry - exit and comes back NEGATIVE. Put the EARLIER timestamp as the receiver. This matches ' +
      "Jira's own documented idiom {{issue.created.diff(now).days}}, which is positive because it " +
      'means now - created. Getting this backwards produces a rule that runs cleanly and never ' +
      'writes, because the negative value trips the duration sanity guard.',
  },
  'changelog REST response': {
    source: 'Gate 2 test, GSOC-Demo, 2026-09-30',
    verified: [
      '{{webhookResponse.status}}  // 200 on an authenticated GET',
      '{{webhookResponse.body.total}}  // offset pagination IS still returned by /issue/{key}/changelog',
      '{{webhookResponse.body.values.last.items.field}}  // -> "status"',
      '{{webhookResponse.body.values.last.items.toString}}  // -> "Investigation Phase"',
    ],
    notes:
      'Both items.* accessors resolve at the PARENT record level, where {{created}} is still in ' +
      'scope -- so a nested {{#items}} loop, which cannot reach the parent timestamp, is not needed. ' +
      'The join separator between multiple items is NOT yet confirmed: every record observed so far ' +
      'held a single item. Treat ", " as likely but unproven, and prefer a test that matches a ' +
      'single exact value as well as delimiter-bounded ones, so an unexpected separator produces a ' +
      'miss (logged, no edit) rather than a wrong match.',
  },

  'JSM SLA fields': {
    source: 'BulkUpdate.txt (customfield_10049)',
    verified: [
      '{{issue.customfield_10049.ongoingCycle.elapsedTime.millis}}  // running cycle, not yet final',
      '{{issue.customfield_10049.completedCycles.elapsedTime.millis.sum}}  // all finished cycles, summed',
    ],
    notes:
      'An SLA field exposes durations directly in millis, with no REST call and no date arithmetic. ' +
      '.sum aggregates a list of durations. NOTE these are SLA-calendar durations (they honour ' +
      'working hours and pauses), so they are NOT a substitute for exact elapsed calendar time.',
  },
};

export {
  TRIGGER_LIBRARY,
  ACTION_LIBRARY,
  CONDITION_LIBRARY,
  STRUCTURAL_LIBRARY,
  VERIFIED_SMART_VALUES,
};
