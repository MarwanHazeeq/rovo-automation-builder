import { createHash, randomUUID } from 'node:crypto';
import {
  ACTION_LIBRARY,
  CONDITION_LIBRARY,
  STRUCTURAL_LIBRARY,
} from './component-library.js';

const AUTOMATION_API_BASE = 'https://api.atlassian.com/automation/public/jira';

// The site-scoped Jira REST API, used only to resolve a field NAME (as an
// LLM or a prose spec would give it) into the internal field-type class that
// the Automation API's edit action requires. Same host as the Automation
// API, so it needs no additional manifest.yml egress entry.
const JIRA_SITE_API_BASE = 'https://api.atlassian.com/ex/jira';

// These component types are confirmed by rules currently running on the
// target tenant. Keep this list explicit because unsupported types return
// opaque 400 errors from the Automation API.
const TRIGGER_BUILDERS = {
  'jira.issue.field.changed': {
    schemaVersion: 2,
    buildValue(trigger, scope) {
      const triggerFields = trigger.fields || trigger.value?.fields || [];
      if (!Array.isArray(triggerFields) || triggerFields.length === 0) {
        throw new Error('trigger.fields must contain at least one Jira field name.');
      }
      return {
        eventFilters: [scope],
        // Optional: "the field changed" already means any change, which is the
        // only reading of a requester who names no particular kind of change.
        changeType: trigger.changeType || trigger.value?.changeType || 'ANY_CHANGE',
        fields: triggerFields.map((field) => ({
          value: normalizeTriggerFieldName(field),
          type: 'fieldName',
        })),
        actions: ['edit'],
      };
    },
  },
  'jira.issue.event.trigger:created': {
    schemaVersion: 1,
    buildValue(_trigger, scope) {
      return {
        eventKey: 'jira:issue_created',
        issueEvent: 'issue_created',
        eventFilters: [scope],
      };
    },
  },
  'jira.issue.event.trigger:transitioned': {
    schemaVersion: 1,
    buildValue(trigger, scope) {
      // The agent may put these at the top of the trigger or nested inside a
      // `value` object, because both look reasonable. Reading only one shape
      // meant a status filter could be silently dropped, producing a rule
      // that fired on EVERY transition instead of the requested one.
      const triggerValue = trigger.value || {};
      const fromStatus = trigger.fromStatus ?? triggerValue.fromStatus;
      const toStatus = trigger.toStatus ?? triggerValue.toStatus;

      // The agent sends plain status names; Jira stores each one as
      // { type: 'NAME', value }. That form is taken from the live site rules
      // "Jira-ITHUB Close" and "Approved_Automation". Plain strings make the
      // Automation API answer HTTP 500 with an EMPTY body, so they are never
      // sent. Anything that is not a list of names -- a single string above
      // all -- is refused rather than emptied: an emptied filter makes a rule
      // that fires on EVERY transition while the draft the approver reads
      // names one status.
      const statusFilter = (value, field) => {
        if (value === undefined || value === null) return [];
        if (!Array.isArray(value)) {
          throw new Error(
            `trigger.${field} must be a list of status names, e.g. ["Closed"] ` +
              `(received: ${JSON.stringify(value)}).`
          );
        }
        return value.map((name, index) => ({
          type: 'NAME',
          value: nonEmptyString(name, `trigger.${field}[${index}]`),
        }));
      };

      return {
        eventFilters: [scope],
        fromStatus: statusFilter(fromStatus, 'fromStatus'),
        toStatus: statusFilter(toStatus, 'toStatus'),
        eventKey: 'jira:issue_updated',
        issueEvent: 'issue_generic',
      };
    },
  },
  // The event triggers below come from the rule survey
  // (scripts/find-component-examples.js --survey); each names its source rule.
  // Like `created`, eventFilters is always the rule's own project.
  // "CLSA Jira-Sentinel Comments V2". PRIMARY_ACTION (a comment was added) is
  // the only eventTypes value seen, so it is the only one built.
  'jira.issue.event.trigger:commented': {
    schemaVersion: 1,
    buildValue(_trigger, scope) {
      return { eventTypes: ['PRIMARY_ACTION'], eventFilters: [scope] };
    },
  },
  // "Assign SHG MO CSO Request Participants Automatically".
  'jira.issue.event.trigger:updated': issueEventTrigger('jira:issue_updated', 'issue_updated'),
  // "Time to first response calculation".
  'jira.issue.event.trigger:assigned': issueEventTrigger('jira:issue_updated', 'issue_assigned'),
  // "Delete Issue Log". That rule is SITE-scoped (eventFilters is the site
  // ARI); this app scopes it to one project like every other event trigger,
  // so the project-scoped form is unverified until the first one is created
  // and its GET read-back passes.
  'jira.issue.event.trigger:deleted': issueEventTrigger('jira:issue_deleted', 'issue_deleted'),
  // "Jira-ITHUB (Move Ticket)": sourceProject "10218", targetProject "-1999".
  // -1999 appears to mean "any project" (it is not a real project id).
  'jira.issue.event.trigger:moved': {
    schemaVersion: 1,
    buildValue(trigger, scope) {
      const triggerValue = trigger.value || {};
      // Optional: -1999 means "any project", so a requester who names no source
      // or target project is asking for exactly that.
      const projectFilter = (raw, label) => {
        const text = String(raw ?? '-1999').trim();
        if (text !== '-1999' && !/^\d+$/.test(text)) {
          throw new Error(`trigger.${label} must be a numeric project ID, or "-1999" for any project.`);
        }
        return text;
      };
      return {
        ...issueEventTrigger('jira:issue_updated', 'issue_moved').buildValue(trigger, scope),
        sourceProject: projectFilter(trigger.sourceProject ?? triggerValue.sourceProject, 'sourceProject'),
        targetProject: projectFilter(trigger.targetProject ?? triggerValue.targetProject, 'targetProject'),
      };
    },
  },
  // Non-event triggers: no eventFilters, so (like jira.jql.scheduled) they are
  // confined by ruleScopeARIs alone; see RULE_SCOPED_TRIGGER_TYPES. Their
  // value is taken from the spec and checked against the verified keys.
  // "Test SLA Notification".
  'jira.sla.threshold.trigger': {
    schemaVersion: 1,
    buildValue(trigger) {
      return verifiedTriggerValue(trigger, ['customFieldId', 'thresholdType', 'thresholdValue', 'scheduleConfigIdSet']);
    },
  },
  // "When a deployment is completed, failed or canceled → then transition request accordingly".
  'devops.deploy.event.trigger:statechange': {
    schemaVersion: -1,
    buildValue(trigger) {
      return verifiedTriggerValue(trigger, ['environments', 'states']);
    },
  },
  // "ManageEngine_Update_Webhook". Jira generates the secret webhookToken
  // itself; this app never handles it (invariant 5), so it is never sent and a
  // spec that tries to supply one is rejected. A human copies the generated
  // URL from the Automation UI after approval.
  'jira.incoming.webhook': {
    schemaVersion: 1,
    buildValue(trigger) {
      const triggerValue = trigger.value || {};
      if ('webhookToken' in trigger || 'webhookToken' in triggerValue) {
        throw new Error('Do not supply webhookToken: Jira generates it, and this app never handles it.');
      }
      return verifiedTriggerValue(trigger, ['searchOrProvide', 'jql']);
    },
  },
  // Verified against BulkUpdate.txt (Historical_Time to First Response). This
  // trigger runs the rule body ONCE PER ISSUE matching `jql`, which is the
  // only iteration primitive available on this tenant - there is no iterative
  // container component on the allowlist.
  //
  // Note it carries NO eventFilters: a scheduled rule is confined by
  // ruleScopeARIs alone (see RULE_SCOPED_TRIGGER_TYPES), with the JQL
  // narrowing further inside that scope.
  'jira.jql.scheduled': {
    schemaVersion: 1,
    buildValue(trigger) {
      const triggerValue = trigger.value || {};
      const jql = nonEmptyString(trigger.jql ?? triggerValue.jql, 'trigger.jql');
      // Optional: false (re-scan the whole result set each run) matches the
      // verified export, and is what a requester means by "every issue that matches".
      const onlyUpdatedIssues =
        (trigger.onlyUpdatedIssues ?? triggerValue.onlyUpdatedIssues) === true;
      return {
        schedule: {
          // cronExpression/rate/rateInterval are vestigial when method is
          // BASIC, but the verified export sends them, so send them too.
          cronExpression: '',
          method: 'BASIC',
          rate: 0,
          rateInterval: 86400,
          rRule: buildScheduleRRule(trigger.schedule ?? triggerValue.schedule),
        },
        jql,
        executionMode: 'jql',
        onlyUpdatedIssues,
      };
    },
  },
};

// Triggers whose project containment comes from rule scope ALONE. An event
// trigger repeats the project ARI in trigger.value.eventFilters, and
// validateRulePayload checks that it matches ruleScopeARIs. A scheduled JQL
// trigger has no eventFilters at all, so applying that check to it would
// reject every scheduled rule. ruleScopeARIs is still required and still has
// to be exactly one project, so the safety boundary is unchanged.
const RULE_SCOPED_TRIGGER_TYPES = new Set([
  'jira.jql.scheduled',
  'jira.sla.threshold.trigger',
  'devops.deploy.event.trigger:statechange',
  'jira.incoming.webhook',
]);

// A plain Jira issue-event trigger: fixed event names plus the rule's project.
function issueEventTrigger(eventKey, issueEvent) {
  return {
    schemaVersion: 1,
    buildValue(_trigger, scope) {
      return { eventKey, issueEvent, eventFilters: [scope] };
    },
  };
}

// The trigger's value taken from the spec (either trigger.value or the
// trigger's own keys), with EXACTLY the verified keys: a missing key or an
// invented synonym fails here with its name instead of as an opaque API 400.
function verifiedTriggerValue(trigger, keys) {
  const source = trigger.value && typeof trigger.value === 'object' ? trigger.value : trigger;
  const supplied = Object.keys(source).filter((key) => key !== 'type' && key !== 'schemaVersion');
  const missing = keys.filter((key) => !(key in source));
  const unexpected = supplied.filter((key) => !keys.includes(key));
  if (missing.length > 0 || unexpected.length > 0) {
    throw new Error(
      `trigger "${trigger.type}" takes exactly: ${keys.join(', ')}` +
        (missing.length ? `; missing ${missing.join(', ')}` : '') +
        (unexpected.length ? `; unexpected ${unexpected.join(', ')}` : '') + '.'
    );
  }
  return Object.fromEntries(keys.map((key) => [key, source[key]]));
}

const ALLOWED_TRIGGER_TYPES = Object.keys(TRIGGER_BUILDERS);
const ALLOWED_ACTION_TYPES = [
  'jira.create.variable',
  'codebarrel.action.log',
  'jira.issue.outgoing.webhook',
  'action.wait.for.time.duration',
  'jira.issue.transition',
  'jira.issue.edit',
  'jira.set.entity.property',
  'jira.issue.refresh.issue',
  'jira.create.mapping-variable',
  'jira.issue.comment',
  // Added from the rule survey; shapes and sources are in component-library.js.
  'jira.issue.assign',
  'jira.issue.outgoing.email',
  'jira.auto.approve.action',
  'rovo.invoke-agent.action',
  'jira.issue.related',
  'jira.lookup.issues',
  'jira.edit.request.type',
  'jira.proforma.form.add.action',
  'jira.issue.create',
  'jira.issue.clone',
];
const ALLOWED_CONDITION_TYPES = [
  'jira.comparator.condition',
  'jira.issue.condition',
  'jira.jql.condition',
  'jira.user.condition',
  'jira.affected.services.condition',
];
const ALLOWED_STRUCTURAL_TYPES = [
  'jira.condition.container.block',
  'jira.condition.if.block',
];
const ALLOWED_MATCH_TYPES = ['ALL', 'ANY'];

// Fields the Automation API assigns itself. An exported rule carries them, but
// sending them back on a create request is rejected. Note that `actor` and
// `authorAccountId` are NOT in this list: testing against the tenant showed
// the API returns a generic 400 without them, so they are required input, not
// server-owned metadata.
const SERVER_OWNED_RULE_FIELDS = ['uuid', 'created', 'updated'];

// The Automation API pairs each component type with a schema version. The
// versions below are taken from rules that are currently running on the
// tenant, so they are known-good. Sending version 1 for a component that the
// API expects at a higher version is one way to get an opaque 400.
const CONDITION_SCHEMA_VERSIONS = {
  'jira.comparator.condition': 1,
  'jira.issue.condition': 3,
};
const ACTION_SCHEMA_VERSIONS = {
  'jira.issue.edit': 12,
  'jira.issue.transition': 11,
  'jira.set.entity.property': 3,
  'jira.issue.comment': 2,
};
// Deliberately not credential-shaped, so it is obvious in an export or a diff
// that the rule is not yet ready to enable.
const AUTH_PLACEHOLDER = 'REPLACE_ME_BEFORE_ENABLING';

const FLOAT_CUSTOM_FIELD_TYPE =
  'com.atlassian.jira.plugin.system.customfieldtypes:float';

// The `value` shape for a jira.issue.edit operation is NOT something an LLM
// or a prose spec can reliably guess: it needs a `fieldType` string that
// mirrors Jira's internal custom-field-type class, not just the field name
// and target value. Getting this wrong doesn't fail the API call - the
// Automation API happily stores whatever you send - but Jira's "Edit work
// item fields" UI has nothing it recognizes to render, so it shows an empty
// "Choose fields to set..." even though the rule was created successfully.
//
// To avoid guessing, this is a small, explicit allowlist keyed by the exact
// `schema.custom` string Jira's own field-metadata API returns. Select and
// text operations are serialized here from working rule exports. Jira float
// fields are written through advancedFields instead, matching the numeric
// expression format in the project's Status-Phase-Calc rule export.
const EDIT_OPERATION_VALUE_BUILDERS = {
  'com.atlassian.jira.plugin.system.customfieldtypes:select': (value) => ({
    type: 'NAME',
    value: String(value),
  }),
  // Unlike select fields, a text field's operation value is a plain string -
  // no { type, value } wrapper. Confirmed against a real rule that sets a
  // "Customer ITSM Incident" text field from a webhook response.
  'com.atlassian.jira.plugin.system.customfieldtypes:textfield': (value) => String(value),
  // The shapes below come from the rule survey (scripts/find-component-examples.js
  // --survey); each names the tenant rule it was copied from.
  // "Start date cf" in "Test Workflow-status-time-calculator using ChangeLog":
  // a plain string, typically a smart value such as {{now}}.
  'com.atlassian.jira.plugin.system.customfieldtypes:datetime': (value) => String(value),
  // "Organizations" in "Assign CAM Organization & Request Participants
  // Automatically": a list of NUMERIC organization ids.
  'com.atlassian.servicedesk:sd-customer-organizations': (value) =>
    toList(value).map((id) => ({ type: 'ID', value: numericId(id, 'Organizations') })),
  // "Request participants" in the same rule: a list of account ids (portal
  // customers have "qm:..." ids, licensed users plain ones), kept as strings.
  'com.atlassian.servicedesk:sd-request-participants': (value) =>
    toList(value).map((id) => ({ type: 'ID', value: nonEmptyString(String(id), 'Request participants id') })),
};

// System fields (schema.system) that jira.issue.edit can set. Unlike custom
// fields they are addressed by ID ({ type: 'ID', value: 'assignee' }) with a
// bare fieldType, and some need their own operation type, so each builder
// returns the whole { type, value } pair. Sources (labels: Auto-Triage.txt; the rest from the rule survey):
// assignee "Assign SDG Organization Automatically", priority
// "ManageEngine_Update_Webhook", description "NTCJ P2 Request Participants
// Update", attachment "Copy Triage Report to Customer View".
const SYSTEM_EDIT_OPERATION_BUILDERS = {
  // Auto-Triage.txt (labels set during a transition): an array of { NAME } entries.
  labels: (value) => ({ type: 'SET', value: toList(value).map((label) => ({ type: 'NAME', value: String(label) })) }),
  assignee: (value) => ({ type: 'SET', value: { type: 'ID', value: nonEmptyString(String(value), 'assignee account id') } }),
  priority: (value) => ({ type: 'SET', value: { type: 'ID', value: numericId(value, 'priority').toString() } }),
  description: (value) => ({ type: 'SET', value: String(value) }),
  // Only "copy every attachment from the trigger issue" has been seen, so
  // that is the only accepted value: the string "trigger".
  attachment: (value) => {
    if (value !== 'trigger') {
      throw new Error('attachment can only be copied from the trigger issue: set its value to "trigger".');
    }
    return {
      type: 'COPY',
      value: { copyOptions: [], sourceIssue: 'trigger', sourceField: { type: 'ID', value: 'attachment', fieldType: 'attachment' } },
    };
  },
};

// A single value or a list of values, as a list.
function toList(value) {
  return Array.isArray(value) ? value : [value];
}

// A Jira entity id given as a number or a numeric string, returned as a number.
// A display name here would be stored as-is and silently never match.
function numericId(value, label) {
  const text = String(value).trim();
  if (!/^\d+$/.test(text)) {
    throw new Error(`${label} needs a numeric ID such as "2", not "${text}". Look the ID up with the Search fields tool.`);
  }
  return Number(text);
}

// Same idea as EDIT_OPERATION_VALUE_BUILDERS, but for jira.issue.condition's
// compareValue, which needs its own per-fieldType wrapper. Confirmed only for
// select fields so far (a real "Send to Customer ITSM equals Yes" condition).
const nameCompareValue = (value) => ({
  type: 'NAME',
  modifier: null,
  value: String(value),
  multiValue: false,
  source: null,
});
const CONDITION_FIELD_VALUE_BUILDERS = {
  'com.atlassian.jira.plugin.system.customfieldtypes:select': nameCompareValue,
  // JSM "Request Type", compared by request type NAME. From the rule survey:
  // "When a change request is created → then attach the default change
  // management form" (value "Request a change"); 24 rules use it.
  'com.atlassian.servicedesk:vp-origin': nameCompareValue,
};

// System fields (schema.system in Jira's field metadata) that jira.issue.condition
// can compare. selectedField is ID-based for all of them, but compareValue is
// NOT uniform, so each field records what the tenant rules show:
// - issuetype: ID (Auto-Triage.txt)
// - priority: ID ("NTCJ P2 Request Participants Update", "Test SLA Notification")
// - project: ID ("Cisco XDR - Status update")
// - status: NAME ("Test Workflow-status-time-calculator using ChangeLog")
// - summary: VALUE with STARTS_WITH ("EnnoviPOC_CreateTicket_ServiceDeskPlus")
// The last four were found with scripts/find-component-examples.js --survey.
const SYSTEM_CONDITION_FIELDS = {
  issuetype: { compareType: 'ID', comparisons: ['EQUALS'] },
  priority: { compareType: 'ID', comparisons: ['EQUALS'] },
  project: { compareType: 'ID', comparisons: ['EQUALS'] },
  status: { compareType: 'NAME', comparisons: ['EQUALS'] },
  summary: { compareType: 'VALUE', comparisons: ['STARTS_WITH'] },
};
const VERIFIED_SYSTEM_CONDITION_FIELDS = Object.keys(SYSTEM_CONDITION_FIELDS);

// Custom-field jira.issue.condition only has a confirmed shape for this one
// comparison (system fields list their own above). Anything else is rejected
// rather than guessed, same policy as field types.
const VERIFIED_CONDITION_COMPARISONS = ['EQUALS'];

/**
 * Create a Jira automation rule through the GA Automation Rule Management API.
 *
 * Rovo supplies action inputs as strings, so the rule request is accepted as
 * JSON text. The handler validates safety properties that must not be left to
 * an LLM: the rule must be disabled, it must have one project scope, and that
 * same scope must appear in the trigger event filter.
 *
 * The email and classic API token are Forge environment variables. They are
 * never accepted from the Rovo payload, so a prompt cannot replace the
 * credential used for the API call.
 */
export async function createJiraAutomationRule(payload) {
  // The ONE exit seam. The real work lives in attemptCreate(), which has many
  // `return` statements (one per validation, API and verification failure,
  // plus the success return). Wrapping it here means every outcome passes
  // through finishAttempt() exactly once before Rovo sees it, so features that
  // must observe every attempt (receipt, ledger) attach there and cannot miss
  // a newly added failure exit.
  const outcome = await attemptCreate(payload);
  return finishAttempt(outcome, payload);
}

/**
 * Observers notified of every create outcome. Empty today, so
 * finishAttempt() changes nothing; later tickets register here.
 */
const outcomeObservers = [];

/**
 * Register a function that is called with every create outcome. Exported so
 * tests (and later the receipt/ledger code) can attach to the seam.
 * Returns a function that removes the observer again.
 */
export function onCreateOutcome(observer) {
  outcomeObservers.push(observer);
  return () => {
    const index = outcomeObservers.indexOf(observer);
    if (index !== -1) outcomeObservers.splice(index, 1);
  };
}

/**
 * Every outcome, success or failure, passes through this function last.
 * It returns the outcome unchanged; observers only look at it.
 */
function finishAttempt(outcome, payload) {
  // The receipt echoes what THIS tool received, so a user can compare it with
  // what they typed. It is added here, at the seam, so no exit can skip it.
  const finished = { ...outcome, receipt: buildReceipt(payload) };
  for (const observer of outcomeObservers) observer(finished);
  return finished;
}

/**
 * Pick the raw input string the same way attemptCreate() does:
 * `ruleSpec` first, then `rulePayload`.
 */
function pickRawInput(payload) {
  const { ruleSpec, rulePayload } = payload ?? {};
  return typeof ruleSpec === 'string' && ruleSpec.trim() !== '' ? ruleSpec : rulePayload;
}

/**
 * Re-serialize JSON with object keys sorted, so key order and whitespace do
 * not change the digest. Array order IS meaningful and is kept.
 */
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/**
 * Build the echo receipt: a stable digest of the input as received plus, when
 * the input parses, a plain-language summary of trigger, conditions, actions.
 * Never throws: it runs on every response, including ones for garbage input.
 */
function buildReceipt(payload) {
  const raw = pickRawInput(payload);
  if (typeof raw !== 'string' || raw.trim() === '') {
    return { digest: sha256('(no input)'), summary: null };
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Not JSON: hash the exact text received. There is nothing to summarize.
    return { digest: sha256(raw), summary: null };
  }

  const digest = sha256(canonicalJson(parsed));
  let trigger;
  const conditions = [];
  const actions = [];
  try {
    if (isFullRulePayload(parsed)) {
      trigger = parsed.rule.trigger?.type;
      walkComponents(parsed.rule.components, (node) => {
        if (node.component === 'CONDITION') conditions.push(node.type);
        if (node.component === 'ACTION') actions.push(node.type);
      });
    } else if (parsed && typeof parsed === 'object') {
      trigger = parsed.trigger?.type;
      const specParts = collectSpecParts(parsed);
      for (const part of specParts) {
        for (const c of Array.isArray(part?.conditions) ? part.conditions : []) conditions.push(c?.type);
        for (const a of Array.isArray(part?.actions) ? part.actions : []) actions.push(a?.type);
      }
    }
  } catch {
    // A malformed shape just yields a thinner summary; the digest still stands.
  }

  const list = (items) => (items.length ? items.map(String).join(', ') : 'none');
  const text =
    `Trigger: ${trigger ?? 'none'}. Conditions: ${list(conditions)}. Actions: ${list(actions)}.`;
  // Everything echoed goes through redactSecrets, like all other output.
  return redactSecrets({ digest, summary: { trigger: trigger ?? null, conditions, actions, text } });
}

function sha256(text) {
  return `sha256:${createHash('sha256').update(text).digest('hex')}`;
}

/**
 * The full pipeline in one call: prepare (build + validate) and then create.
 *
 * Since the approval gate was introduced this is NOT exposed to Rovo. Rules
 * are created only by the create-approved-automation-rule action
 * (src/create-approved.js), which calls the two halves separately with a
 * draft frozen and approved in between. This composition is kept because it
 * is exactly what that action runs, so the existing tests exercise it.
 */
async function attemptCreate(payload) {
  const prepared = await prepareRule(payload);
  if (!prepared.ok) return prepared;
  return createAndVerifyRule(prepared);
}

/**
 * Read and check the Forge environment variables both halves need. Returns
 * either `{ ok: true, ... }` or a failure() object.
 */
function readAutomationEnvironment() {
  const email = process.env.AUTOMATION_API_EMAIL;
  const token = process.env.AUTOMATION_API_TOKEN;
  const configuredCloudId = process.env.JIRA_CLOUD_ID;
  const actorAccountId = process.env.AUTOMATION_RULE_ACTOR_ACCOUNT_ID;
  if (!email || !token) {
    return failure(
      'The Forge environment is missing AUTOMATION_API_EMAIL or AUTOMATION_API_TOKEN.'
    );
  }
  if (!configuredCloudId) {
    return failure('The Forge environment is missing JIRA_CLOUD_ID.');
  }
  if (!actorAccountId) {
    return failure('The Forge environment is missing AUTOMATION_RULE_ACTOR_ACCOUNT_ID.');
  }
  return { ok: true, email, token, configuredCloudId, actorAccountId };
}

/**
 * Words and phrases in a request that show it describes more than one case.
 * Matched as whole words, ignoring upper and lower case. An entry that is an
 * array is a pair that counts only when ALL of its words appear (so "if" alone
 * does not, but "if ... else" does). This is a word search, not an
 * understanding of the request: "escalate unless it is already assigned" is
 * one case that contains "unless". That costs one extra question to the
 * requester; the opposite mistake builds a rule that quietly does the wrong thing.
 */
export const BRANCH_WORDS = ['otherwise', 'unless', 'or else', 'in that case', 'depending on', ['if', 'else']];

/** The BRANCH_WORDS found in `requestText`, each as the phrase to show (a pair reads "if ... else"). */
export function findBranchWords(requestText) {
  const hasWord = (phrase) =>
    new RegExp(`\\b${phrase.trim().split(/\s+/).join('\\s+')}\\b`, 'i').test(requestText);
  return BRANCH_WORDS
    .filter((entry) => (Array.isArray(entry) ? entry.every(hasWord) : hasWord(entry)))
    .map((entry) => (Array.isArray(entry) ? entry.join(' ... ') : entry));
}

/**
 * How many cases a built rule has: the number of if-blocks anywhere in it
 * (nested ones included, so a rule that splits twice inside one branch counts
 * as having several cases), and at least 1, because a rule with no blocks still
 * has its one unconditional case.
 */
export function countBranches(rule) {
  let blocks = 0;
  walkComponents(rule.components ?? [], (node) => {
    if (node.type === 'jira.condition.if.block') blocks += 1;
  });
  return Math.max(1, blocks);
}

/**
 * First half: turn the agent's input into a validated Automation API rule
 * WITHOUT creating anything. The only network call is the optional
 * field-metadata GET (read-only).
 *
 * Returns `{ ok: true, rule, scope, cloudId }` or a failure() object. The
 * returned `rule` is exactly what createAndVerifyRule() will POST, which is
 * why a draft stores this object rather than the original ruleSpec: what the
 * approver saw is what gets created, even if field metadata changes later.
 */
export async function prepareRule(payload) {
  const rulePayload = payload?.rulePayload;
  const ruleSpec = payload?.ruleSpec;

  console.log('[createJiraAutomationRule] invoked', safeStringify({
    hasRulePayload: Boolean(rulePayload),
    hasRuleSpec: Boolean(ruleSpec),
  }));

  const environment = readAutomationEnvironment();
  if (!environment.ok) return environment;
  const { email, token, configuredCloudId, actorAccountId } = environment;

  // The manifest only declares `ruleSpec`, so in practice everything arrives
  // there. `rulePayload` is kept as a fallback for any caller that still sends
  // it. Either way the JSON is parsed once and the SHAPE decides how it is
  // handled, rather than the name of the input it came in on.
  const rawInput =
    typeof ruleSpec === 'string' && ruleSpec.trim() !== ''
      ? ruleSpec
      : rulePayload;

  if (typeof rawInput !== 'string' || rawInput.trim() === '') {
    return failure('Provide either ruleSpec or rulePayload as a JSON string.');
  }

  let parsed;
  try {
    parsed = JSON.parse(rawInput);
  } catch (error) {
    return failure(describeJsonError(rawInput, error));
  }

  let requestBody;
  // The project's display name when the spec named it; null for a full payload
  // or a bare projectId. Handed back so the approval ticket can show it.
  let projectName = null;
  console.log(
    `[createJiraAutomationRule] parsed input as ${isFullRulePayload(parsed) ? 'a full rule payload' : 'a rule specification'}`
  );
  if (isFullRulePayload(parsed)) {
    // A complete Automation API payload: an exported rule, or one copied from
    // a working Postman request. Pass it through untouched apart from the
    // server-owned fields and the forced DISABLED state, so the user does not
    // have to hand-translate a payload that already works.
    requestBody = normalizeFullPayload(parsed, actorAccountId);
  } else {
    // The small, LLM-friendly specification. The Rovo agent produces this when
    // the user describes a rule in prose instead of supplying JSON.
    // Shape defects the agent is known to make are caught here, before any
    // network call, with a message naming each action that needs fixing.
    const editDefects = findEditActionDefects(parsed);
    if (editDefects.length > 0) {
      return failure(`ruleSpec has ${editDefects.length} malformed jira.issue.edit action(s): ${editDefects.join('; ')}.`);
    }
    try {
      // A jira.issue.edit action or a jira.issue.condition condition both
      // need real tenant field metadata to resolve a field NAME into the
      // internal fieldType class (see EDIT_OPERATION_VALUE_BUILDERS and
      // CONDITION_FIELD_VALUE_BUILDERS above). Only fetch it when actually
      // needed, so rules that use neither don't pay for an extra API call.
      // Branches (nested ones too) carry their own conditions and actions, so look in those too.
      const specParts = collectSpecParts(parsed);
      const needsFieldMetadata = specParts.some((part) =>
        part && typeof part === 'object' &&
        ((Array.isArray(part.actions) &&
          part.actions.some((action) => action && action.type === 'jira.issue.edit')) ||
        (Array.isArray(part.conditions) &&
          part.conditions.some((condition) => condition && condition.type === 'jira.issue.condition'))));
      console.log(`[createJiraAutomationRule] field metadata needed: ${needsFieldMetadata}`);
      const fieldMetadata = needsFieldMetadata
        ? await fetchJiraFieldMetadata(configuredCloudId, email, token)
        : null;
      if (fieldMetadata) {
        console.log(`[createJiraAutomationRule] fetched ${fieldMetadata.length} Jira field(s)`);
      }

      // The agent sends a project NAME; the numeric id is resolved here so
      // the agent never has to handle (or guess) a number.
      const project = await resolveProjectId(parsed, configuredCloudId, email, token);
      projectName = project.name;

      requestBody = buildRulePayload(
        { ...parsed, projectId: project.id },
        configuredCloudId,
        actorAccountId,
        fieldMetadata
      );
    } catch (error) {
      return failure(`ruleSpec could not be converted into a rule: ${error.message}`);
    }
  }

  const validation = validateRulePayload(requestBody, configuredCloudId);
  if (!validation.ok) return failure(validation.error);

  const allowlistCheck = enforceComponentAllowlist(validation.rule);
  if (!allowlistCheck.ok) return failure(allowlistCheck.error);

  const { cloudId, rule, scope } = validation;

  // Only the built rule is counted, so a spec and a full payload are held to
  // the same standard. requestText is not logged: it is free text from a person.
  if (typeof payload?.requestText === 'string') {
    const found = findBranchWords(payload.requestText);
    if (found.length > 0 && countBranches(rule) < 2) {
      return failure(
        `The request describes more than one case (it contains ${found.map((word) => `"${word}"`).join(', ')}), ` +
          'but the draft has only one branch. Do not put both outcomes in one branch: they would both ' +
          'run every time instead of one or the other. Confirm with the requester what should happen in ' +
          'each case, then send a branch for each in ruleSpec.branches.'
      );
    }
  }
  return { ok: true, rule, scope, cloudId, projectName };
}

/**
 * Second half: POST an already-prepared rule, then GET it back and verify it.
 * Called only by src/create-approved.js, with the rule frozen in the draft.
 *
 * The rule is re-validated here even though prepareRule() already did so. The
 * frozen copy comes back out of storage, and the safety properties (DISABLED,
 * one project scope, allowlisted components) are cheap to re-check right
 * before the only call that can actually create something.
 */
export async function createAndVerifyRule({ rule: preparedRule }) {
  const environment = readAutomationEnvironment();
  if (!environment.ok) return environment;
  const { email, token, configuredCloudId } = environment;

  // The cloud ID is re-derived from the rule's own scope ARI and must match
  // the Forge environment, so a stored draft cannot point at another site.
  const revalidation = validateRulePayload({ rule: preparedRule }, configuredCloudId);
  if (!revalidation.ok) return failure(revalidation.error);
  const allowlistRecheck = enforceComponentAllowlist(revalidation.rule);
  if (!allowlistRecheck.ok) return failure(allowlistRecheck.error);

  const { cloudId, rule, scope } = revalidation;
  const auth = Buffer.from(`${email}:${token}`).toString('base64');
  const createUrl = `${AUTOMATION_API_BASE}/${cloudId}/rest/v1/rule`;

  console.log(`[createJiraAutomationRule] POST ${createUrl}`);
  let createResponse;
  let createBody;
  try {
    createResponse = await fetch(createUrl, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${auth}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({ rule }),
    });
    createBody = await readJsonOrText(createResponse);
    console.log(`[createJiraAutomationRule] create response status: ${createResponse.status}`);
  } catch (error) {
    console.error(`[createJiraAutomationRule] create request threw: ${error.message}`);
    // networkError lets the ticket call this transient rather than a problem
    // with the rule (see explainCreateFailure in draft-render.js).
    return failure(`The create request could not be sent: ${error.message}`, { networkError: true });
  }

  if (createResponse.status !== 201) {
    return failure('The Automation API rejected the create request.', {
      status: createResponse.status,
      apiError: createBody,
      // Atlassian's 400s are generic ("the request body could not be
      // parsed"), so the body we sent is usually the only way to work out
      // which field it disliked. Webhook headers are redacted because they
      // can hold tokens and this value is shown to the Rovo user.
      sentPayload: redactSecrets(rule),
    });
  }

  const ruleUuid = createBody?.ruleUuid;
  if (typeof ruleUuid !== 'string' || ruleUuid.length === 0) {
    return failure('The API returned HTTP 201 but no ruleUuid.', {
      status: createResponse.status,
      apiResponse: createBody,
    });
  }

  const verifyUrl = `${AUTOMATION_API_BASE}/${cloudId}/rest/v1/rule/${encodeURIComponent(ruleUuid)}`;
  console.log(`[createJiraAutomationRule] GET ${verifyUrl}`);
  let verificationResponse;
  let verificationBody;
  try {
    verificationResponse = await fetch(verifyUrl, {
      method: 'GET',
      headers: {
        Authorization: `Basic ${auth}`,
        Accept: 'application/json',
      },
    });
    verificationBody = await readJsonOrText(verificationResponse);
    console.log(`[createJiraAutomationRule] verification response status: ${verificationResponse.status}`);
  } catch (error) {
    console.error(`[createJiraAutomationRule] verification request threw: ${error.message}`);
    return failure('The rule was created, but the verification request failed.', {
      ruleUuid,
      error: error.message,
    });
  }

  if (verificationResponse.status !== 200) {
    return failure('The rule was created, but the verification GET failed.', {
      ruleUuid,
      status: verificationResponse.status,
      apiError: verificationBody,
    });
  }

  const verification = verifyCreatedRule(verificationBody, scope, rule);
  if (!verification.ok) {
    return failure('The rule was created, but verification found a mismatch.', {
      ruleUuid,
      mismatch: verification.error,
      retrievedRule: verificationBody,
    });
  }

  console.log(
    `[createJiraAutomationRule] success: created and verified rule "${rule.name}" (${ruleUuid}) for ${scope}`
  );
  // A rule containing a web request is created WITHOUT authentication by
  // design. Surface that as a required manual step rather than leaving it
  // implicit, so the rule is not enabled while it would 401 on every run.
  let manualStepRequired;
  walkComponents(rule.components, (node) => {
    if (node.component === 'ACTION' && node.type === 'jira.issue.outgoing.webhook') {
      const placeholdered = JSON.stringify(node.value || {}).includes(AUTH_PLACEHOLDER);
      manualStepRequired = placeholdered
        ? 'This rule sends a web request whose Authorization header is set to the placeholder ' +
          `"${AUTH_PLACEHOLDER}". Replace it with the real credential in the Automation UI ` +
          '(the header is already marked hidden) and test the request before enabling the rule.'
        : 'This rule sends a web request and was created with NO Authorization header. Add the ' +
          'credential in the Automation UI (mark the header hidden) and test the request before ' +
          'enabling the rule, or every run will fail authentication.';
    }
  });

  return {
    ok: true,
    ruleCreated: true,
    ruleName: rule.name,
    ruleUuid,
    state: 'DISABLED',
    projectScope: scope,
    trigger: rule.trigger,
    verified: true,
    ...(manualStepRequired ? { manualStepRequired } : {}),
    // Rendered by code, not by the agent, so the user is told exactly what
    // happened even if the agent paraphrases or embellishes.
    message:
      `Created and verified disabled Jira automation rule "${rule.name}" ` +
      `for ${scope}. State: DISABLED. ruleUuid: ${ruleUuid}.`,
  };
}

/**
 * Fetch the tenant's full field list so a jira.issue.edit action's field
 * NAMEs can be resolved to their internal field-type class. Same host and
 * Basic Auth credentials as the Automation API calls above - confirmed
 * reachable via this exact GET /rest/api/3/field request against this site.
 */
async function fetchJiraFieldMetadata(cloudId, email, token) {
  const auth = Buffer.from(`${email}:${token}`).toString('base64');
  const url = `${JIRA_SITE_API_BASE}/${cloudId}/rest/api/3/field`;
  console.log(`[fetchJiraFieldMetadata] GET ${url}`);
  let response;
  let body;
  try {
    response = await fetch(url, {
      method: 'GET',
      headers: {
        Authorization: `Basic ${auth}`,
        Accept: 'application/json',
      },
    });
    body = await readJsonOrText(response);
    console.log(`[fetchJiraFieldMetadata] response status: ${response.status}`);
  } catch (error) {
    console.error(`[fetchJiraFieldMetadata] request threw: ${error.message}`);
    throw new Error(`Field metadata request failed: ${error.message}`);
  }

  if (response.status !== 200 || !Array.isArray(body)) {
    console.error(
      `[fetchJiraFieldMetadata] unexpected response: status ${response.status}, isArray ${Array.isArray(body)}`
    );
    throw new Error(
      `Field metadata request returned status ${response.status}; expected a 200 with a JSON array.`
    );
  }

  return body;
}

// A short query such as "SOC" can match many projects by substring, so the
// search is paged. The cap stops a runaway loop; hitting it is an error, not a
// guess, because an unseen page might hold a second exact-name match.
const PROJECT_SEARCH_PAGE_SIZE = 50;
const PROJECT_SEARCH_MAX_PAGES = 10;
// How many candidate names an error lists. The agent relays them to the
// requester, so a few real options help and a wall of names does not.
const PROJECT_ERROR_CANDIDATE_LIMIT = 10;

/**
 * Decide which numeric project id a ruleSpec means. Exactly one of
 * `projectName` / `projectId` must be present. `projectId` is still accepted
 * (existing drafts, tests) and is validated later by buildRulePayload. When
 * both are present they must resolve to the same project; neither is
 * preferred, because a silent pick is how a rule lands in the wrong project.
 */
async function resolveProjectId(spec, cloudId, email, token) {
  const isPresent = (value) => value !== undefined && value !== null && value !== '';
  const hasId = isPresent(spec.projectId);
  const hasName = isPresent(spec.projectName);

  if (!hasId && !hasName) {
    throw new Error(
      'ruleSpec needs projectName, the Jira project\'s display name (e.g. "SOCDemo"). ' +
        'Neither projectName nor projectId was provided.'
    );
  }
  // A bare projectId has no name to show; the ticket then shows the id alone.
  if (!hasName) return { id: spec.projectId, name: null };

  const projectName = nonEmptyString(spec.projectName, 'projectName');
  const { id: resolvedId, name: resolvedName } = await findProjectByName(projectName, cloudId, email, token);

  if (hasId && String(spec.projectId).trim() !== resolvedId) {
    throw new Error(
      `projectId "${String(spec.projectId).trim()}" and projectName "${projectName}" are different ` +
        `projects (the name resolves to project id ${resolvedId}). Send only projectName.`
    );
  }
  return { id: resolvedId, name: resolvedName };
}

/**
 * Look a project up by exact display name, returning { id, name }. The search endpoint's `query` is a
 * SUBSTRING match on name and key, so its response is a candidate list: the
 * exact-name filter below is what makes this an answer. Zero or several exact
 * matches throw, naming real options so the agent can report them.
 */
async function findProjectByName(projectName, cloudId, email, token) {
  const auth = Buffer.from(`${email}:${token}`).toString('base64');
  const wanted = projectName.trim().toLowerCase();
  const candidates = [];
  let reachedLastPage = false;

  for (let page = 0; page < PROJECT_SEARCH_MAX_PAGES && !reachedLastPage; page += 1) {
    const url =
      `${JIRA_SITE_API_BASE}/${cloudId}/rest/api/3/project/search` +
      `?query=${encodeURIComponent(projectName)}` +
      `&startAt=${candidates.length}&maxResults=${PROJECT_SEARCH_PAGE_SIZE}`;
    console.log(`[findProjectByName] GET ${url}`);
    let response;
    let body;
    try {
      response = await fetch(url, {
        method: 'GET',
        headers: { Authorization: `Basic ${auth}`, Accept: 'application/json' },
      });
      body = await readJsonOrText(response);
    } catch (error) {
      throw new Error(`Project search request failed: ${error.message}`);
    }
    if (response.status !== 200 || !body || !Array.isArray(body.values)) {
      throw new Error(
        `Project search returned status ${response.status}; expected a 200 with a "values" array.`
      );
    }

    candidates.push(...body.values);
    // Trust isLast, fall back to total, and stop on an empty page so a
    // response missing both can never loop forever.
    reachedLastPage =
      body.isLast === true ||
      (Number.isFinite(body.total) && candidates.length >= body.total) ||
      body.values.length === 0;
  }

  if (!reachedLastPage) {
    throw new Error(
      `projectName "${projectName}" matched too many projects to check (more than ` +
        `${candidates.length}). Send the project's full, exact name.`
    );
  }

  const matches = candidates.filter(
    (project) =>
      project && typeof project.name === 'string' && project.name.trim().toLowerCase() === wanted
  );

  if (matches.length === 1) return { id: String(matches[0].id), name: matches[0].name.trim() };

  if (matches.length === 0) {
    const names = candidates
      .map((project) => project?.name)
      .filter((name) => typeof name === 'string');
    const listed = names.slice(0, PROJECT_ERROR_CANDIDATE_LIMIT).join(', ');
    const more = names.length > PROJECT_ERROR_CANDIDATE_LIMIT
      ? ` (first ${PROJECT_ERROR_CANDIDATE_LIMIT} of ${names.length})`
      : '';
    throw new Error(
      `projectName "${projectName}" matched no project. ` +
        (names.length > 0
          ? `Projects the search returned${more}: ${listed}. `
          : 'The search returned no projects. ') +
        'Send the exact project name.'
    );
  }

  const listed = matches
    .map((project) => `${project.name} (key ${project.key}, id ${project.id})`)
    .join('; ');
  throw new Error(
    `projectName "${projectName}" matches more than one project: ${listed}. ` +
      'Ask the requester which one they mean; do not pick one.'
  );
}

/**
 * Resolve one { name, value } edit-field entry from a ruleSpec into the
 * internal operation shape jira.issue.edit expects: field-by-NAME,
 * type: 'SET', and a fieldType-specific value wrapper. Only field types with
 * a builder in EDIT_OPERATION_VALUE_BUILDERS are supported; anything else
 * fails loudly instead of guessing.
 */
function editFieldName(fieldSpec) {
  if (!fieldSpec || typeof fieldSpec !== 'object' || Array.isArray(fieldSpec)) {
    throw new Error(
      'Each entry in actions[].fields must be an object with name or fieldId, plus value.'
    );
  }
  return nonEmptyString(
    fieldSpec.fieldId ?? fieldSpec.id ?? fieldSpec.name,
    'actions[].fields[].name or fieldId'
  );
}

function findJiraField(fieldIdentifier, fieldMetadata) {
  // Prefer an exact field id/key. Display names can be translated or shared
  // by multiple custom fields, while customfield_12345 is stable and
  // unambiguous. The case-insensitive name fallback keeps prose-oriented
  // rule specifications convenient.
  const identifier = fieldIdentifier.trim();
  const idMatch = fieldMetadata.find(
    (field) => field && (field.id === identifier || field.key === identifier)
  );
  if (idMatch) return idMatch;

  const matches = fieldMetadata.filter(
    (field) =>
      field &&
      typeof field.name === 'string' &&
      field.name.trim().toLowerCase() === identifier.toLowerCase()
  );

  if (matches.length === 0) {
    throw new Error(`No Jira field named or identified by "${fieldIdentifier}" was found on this site.`);
  }
  if (matches.length > 1) {
    const ids = matches.map((field) => field.key || field.id).join(', ');
    throw new Error(
      `Field name "${fieldIdentifier}" matches more than one field (${ids}); use fieldId to disambiguate it.`
    );
  }

  return matches[0];
}

function buildEditOperation(fieldSpec, fieldMetadata, resolvedField) {
  const fieldName = editFieldName(fieldSpec);
  if (fieldSpec.value === undefined || fieldSpec.value === null || fieldSpec.value === '') {
    throw new Error(`actions[].fields[].value is required for field "${fieldName}".`);
  }

  const jiraField = resolvedField || findJiraField(fieldName, fieldMetadata);

  // System fields are addressed by ID with a bare fieldType, and their builder
  // supplies the operation type too (attachment is COPY, not SET).
  const systemField = jiraField.schema?.system;
  const systemBuilder = systemField && SYSTEM_EDIT_OPERATION_BUILDERS[systemField];
  if (systemBuilder) {
    return { field: { type: 'ID', value: systemField }, fieldType: systemField, ...systemBuilder(fieldSpec.value) };
  }

  const fieldType = jiraField.schema?.custom;
  const valueBuilder = fieldType && EDIT_OPERATION_VALUE_BUILDERS[fieldType];
  if (!valueBuilder) {
    throw new Error(
      `Field "${fieldName}" has type "${fieldType || jiraField.schema?.type || 'unknown'}", ` +
        'which is not on the verified list for jira.issue.edit operations (currently: ' +
        `${Object.keys(EDIT_OPERATION_VALUE_BUILDERS).map((type) => type.split(':').pop()).join(', ')}, ` +
        `and system fields ${Object.keys(SYSTEM_EDIT_OPERATION_BUILDERS).join(', ')}). ` +
        'Numeric float custom fields are supported through advancedFields.'
    );
  }

  return {
    field: { type: 'NAME', value: jiraField.name },
    fieldType,
    type: 'SET',
    value: valueBuilder(fieldSpec.value),
  };
}

function buildAdvancedNumericValue(value, fieldName) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value);
  }

  if (typeof value !== 'string') {
    throw new Error(
      `Numeric field "${fieldName}" requires a finite number or a Jira math expression.`
    );
  }

  const trimmedValue = value.trim();
  const numericLiteral = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i;
  if (numericLiteral.test(trimmedValue) && Number.isFinite(Number(trimmedValue))) {
    return trimmedValue;
  }

  // advancedFields inserts math expressions as raw JSON numbers. The Rovo
  // agent does not need to remember Jira's outer {{#=}} block: accept either
  // a complete block or a safe expression such as
  // `{{issue.customfield_11594|0}} + {{minutesToAdd|0}}`, then add the block
  // when it is absent. This keeps ruleSpec focused on intent while this
  // builder owns Jira's transport-specific payload shape.
  const completeMathExpression = /^\{\{#=\}\}([\s\S]*)\{\{\/\}\}$/;
  const completeMatch = completeMathExpression.exec(trimmedValue);
  const expressionBody = completeMatch ? completeMatch[1].trim() : trimmedValue;
  if (isSafeJiraNumericExpression(expressionBody)) {
    return completeMatch
      ? trimmedValue
      : `{{#=}}${expressionBody}{{/}}`;
  }

  throw new Error(
    `Numeric field "${fieldName}" requires a finite number, a Jira smart value, ` +
      'or a safe Jira math expression containing a smart value.'
  );
}

function isSafeJiraNumericExpression(expression) {
  // Each smart-value token is deliberately conservative. Quotes, commas,
  // colons, square brackets, backslashes, and newlines are excluded because
  // advancedFields places this expression directly in a JSON number position.
  // After removing valid smart values, only numeric literals and arithmetic
  // operators may remain, preventing the expression from adding JSON fields.
  const smartValue = /\{\{[A-Za-z0-9_.|()\- \t]+\}\}/g;
  const smartValues = expression.match(smartValue) || [];
  if (smartValues.length === 0) return false;

  let arithmetic = expression.replace(smartValue, '0');

  // Jira math supports functions such as ROUND(..., 2). Permit function
  // identifiers only when they are immediately followed by an opening
  // parenthesis; arbitrary words are still rejected. This accepts the
  // calculation requested by the changelog timing specification without
  // allowing quotes or JSON punctuation into advancedFields.
  arithmetic = arithmetic.replace(/\b[A-Za-z_][A-Za-z0-9_]*\s*(?=\()/g, '');
  if (!/^[0-9eE+\-*/%.(), \t]*$/.test(arithmetic)) return false;

  let parenthesisDepth = 0;
  for (const character of arithmetic) {
    if (character === '(') parenthesisDepth += 1;
    if (character === ')') parenthesisDepth -= 1;
    if (parenthesisDepth < 0) return false;
    // A comma is valid as a function argument separator, never at the root
    // where it could terminate the advancedFields JSON value.
    if (character === ',' && parenthesisDepth === 0) return false;
  }
  return parenthesisDepth === 0;
}

const RRULE_WEEKDAYS = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'];
const RRULE_FREQUENCIES = ['DAILY', 'WEEKLY'];

// A value the agent did not send: absent, null or an empty string.
const isMissing = (value) => value === undefined || value === null || value === '';

/**
 * Build the iCal VEVENT string a jira.jql.scheduled trigger expects.
 *
 * Same reasoning as buildEditOperation: an iCal RRULE is transport detail an
 * LLM will get subtly wrong in ways that produce a rule which runs on the
 * wrong days rather than an error. The BulkUpdate export shows exactly that
 * failure mode - it was described as a Monday rule but carries
 * BYDAY=MO,TU,WE,TH,FR, and its DTSTART time of day (15:37) is silently
 * overridden by the RRULE's BYHOUR. So this builder takes intent
 * ({ days, hour, minute }) and owns the encoding, keeping DTSTART's time and
 * BYHOUR/BYMINUTE in agreement so the two cannot disagree.
 *
 * A complete VEVENT string is still accepted as an escape hatch for a
 * schedule this builder cannot express.
 */
function buildScheduleRRule(schedule) {
  if (typeof schedule === 'string') {
    const raw = schedule.trim();
    if (!raw.startsWith('BEGIN:VEVENT') || !raw.includes('RRULE:')) {
      throw new Error(
        'trigger.schedule given as a string must be a complete iCal VEVENT containing an RRULE line.'
      );
    }
    return raw.endsWith('\n') ? raw : `${raw}\n`;
  }

  const config = schedule && typeof schedule === 'object' ? schedule : {};

  // Optional: a WEEKLY schedule must name its days (checked below), so leaving
  // frequency out cannot hide a missing answer; DAILY has to be asked for.
  const frequency = String(config.frequency || 'WEEKLY').toUpperCase();
  if (!RRULE_FREQUENCIES.includes(frequency)) {
    throw new Error(`trigger.schedule.frequency must be one of ${RRULE_FREQUENCIES.join(', ')}.`);
  }

  // The time of day and the time zone decide WHEN the rule runs, so the
  // requester must have chosen them. A made-up 09:00 Singapore time looks fine
  // on the ticket and runs at the wrong hour for everyone else.
  if (isMissing(config.hour) || isMissing(config.minute)) {
    throw new Error(
      'The requester did not say what time of day the rule should run. Ask them for the ' +
        'time (for example 9:30), then send trigger.schedule.hour (0-23) and trigger.schedule.minute (0-59).'
    );
  }
  if (isMissing(config.timezone)) {
    throw new Error(
      'The requester did not say which time zone the schedule is in. Ask them (for example ' +
        '"Asia/Singapore") and send it as trigger.schedule.timezone; do not assume one.'
    );
  }
  const hour = scheduleInteger(config.hour, 'hour', 0, 23);
  const minute = scheduleInteger(config.minute, 'minute', 0, 59);
  // Optional: 1 means "every week" (or every day), which is what a requester
  // who names no gap between runs is asking for.
  const interval = scheduleInteger(config.interval, 'interval', 1, 52, 1);

  const timezone = config.timezone;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone });
  } catch {
    throw new Error(`trigger.schedule.timezone "${timezone}" is not a recognized IANA time zone.`);
  }

  let days = [];
  if (frequency === 'WEEKLY') {
    const requested = config.days ?? config.byDay;
    if (isMissing(requested)) {
      throw new Error(
        'The requester did not say which days of the week the rule should run. Ask them, then ' +
          'send trigger.schedule.days (for example ["MO","TH"]).'
      );
    }
    days = (Array.isArray(requested) ? requested : [requested])
      .map((day) => String(day).trim().toUpperCase().slice(0, 2));
    if (days.length === 0) {
      throw new Error('trigger.schedule.days must name at least one weekday for a WEEKLY schedule.');
    }
    const invalid = days.filter((day) => !RRULE_WEEKDAYS.includes(day));
    if (invalid.length > 0) {
      throw new Error(
        `trigger.schedule.days contains unrecognized day(s): ${invalid.join(', ')}. ` +
          `Use ${RRULE_WEEKDAYS.join(', ')}.`
      );
    }
    days = RRULE_WEEKDAYS.filter((day) => days.includes(day));
  }

  const startDate = scheduleStartDate(config.startDate);
  const time = `${pad2(hour)}${pad2(minute)}00`;
  const rruleParts = [
    `FREQ=${frequency}`,
    `BYHOUR=${hour}`,
    `BYMINUTE=${minute}`,
    'BYSECOND=0',
  ];
  if (days.length > 0) rruleParts.push(`BYDAY=${days.join(',')}`);
  rruleParts.push(`INTERVAL=${interval}`);

  return (
    'BEGIN:VEVENT\n' +
    `DTSTART;TZID=${timezone}:${startDate}T${time}\n` +
    `RRULE:${rruleParts.join(';')}\n` +
    'END:VEVENT\n'
  );
}

function pad2(value) {
  return String(value).padStart(2, '0');
}

function scheduleInteger(value, name, min, max, fallback) {
  if (isMissing(value)) return fallback;
  const parsed = typeof value === 'number' ? value : Number(String(value).trim());
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`trigger.schedule.${name} must be an integer between ${min} and ${max}.`);
  }
  return parsed;
}

function scheduleStartDate(startDate) {
  // Optional: no start date means "from today", which is how Jira's own
  // Automation UI behaves and what "starting now" means to a requester.
  if (isMissing(startDate)) {
    const now = new Date();
    return (
      `${now.getUTCFullYear()}${pad2(now.getUTCMonth() + 1)}${pad2(now.getUTCDate())}`
    );
  }
  const compact = String(startDate).trim().replace(/-/g, '');
  if (!/^\d{8}$/.test(compact)) {
    throw new Error('trigger.schedule.startDate must be a date in YYYYMMDD or YYYY-MM-DD form.');
  }
  return compact;
}


// A deployed rule runs inside Jira Automation with no Forge function in the
// call path, so it cannot read a Forge environment variable at run time. The
// decision (spec section 10) is that this app never handles the runtime
// credential at all: rules are built with NO Authorization header, and a human
// adds it in the Automation UI before enabling the rule.
//
// That keeps the credential out of this codebase, out of the agent's context,
// out of Forge logs, and out of any ruleSpec a person might paste into chat.
// The one thing enforced here is that the agent cannot add one itself.

// Types whose `value` this app builds itself from tenant metadata. Their shape
// is this file's responsibility, not the caller's, so the library check below
// would only be checking our own output.
const SELF_BUILT_COMPONENT_TYPES = new Set([
  'jira.issue.edit',
  'jira.issue.outgoing.webhook',
  'jira.issue.condition',
]);

const COMPONENT_LIBRARIES = {
  action: ACTION_LIBRARY,
  condition: CONDITION_LIBRARY,
  structural: STRUCTURAL_LIBRARY,
};

/**
 * Check a caller-supplied component `value` against the verified shape.
 *
 * The allowlists already stop an unknown component TYPE. Nothing checked the
 * value, so a wrong shape was forwarded to Atlassian and came back as an
 * opaque 500 with a null apiError -- which says nothing about which of a
 * dozen components was malformed. A real example: the wait action arrived as
 * { delay: 10 } instead of { waitTimeInSeconds: 10, randomWaitInterval: null }.
 *
 * Both directions are reported, because they are the same mistake seen from
 * two sides: a missing verified key, and a key that is not in the verified
 * shape at all. Naming the unexpected key is usually what identifies the
 * error, since a wrong shape is normally a plausible invented synonym.
 */
function assertVerifiedComponentValue(kind, type, value) {
  if (SELF_BUILT_COMPONENT_TYPES.has(type)) return;

  const entry = COMPONENT_LIBRARIES[kind]?.[type];
  if (!entry) return;

  if (entry.example === null && entry.unverifiedGuess) {
    throw new Error(
      `"${type}" has no verified value shape on this tenant. Export one real rule using it ` +
        'and add the shape to component-library.js before building with it.'
    );
  }

  // A few types take a bare string rather than an object (the audit-log
  // action). Sending { logMessage: ... } there is a 400.
  if (typeof entry.example === 'string') {
    if (typeof value !== 'string') {
      throw new Error(
        `"${type}" takes a bare string value, not an object. ` +
          `Received ${Array.isArray(value) ? 'an array' : typeof value}.`
      );
    }
    return;
  }

  if (!entry.example || typeof entry.example !== 'object') return;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(
      `"${type}" takes an object value with keys: ${Object.keys(entry.example).join(', ')}.`
    );
  }

  // A key whose verified value is null means "not set" in the export, and an
  // LLM tends to drop such keys as optional. Fill them in (on the caller's
  // value object) rather than fail; a missing key with a real value still fails.
  for (const [key, exampleValue] of Object.entries(entry.example)) {
    if (exampleValue === null && !(key in value)) value[key] = null;
  }

  const expected = Object.keys(entry.example);
  const supplied = Object.keys(value);
  const missing = expected.filter((key) => !(key in value));
  const unexpected = supplied.filter((key) => !expected.includes(key));

  if (missing.length > 0 || unexpected.length > 0) {
    const parts = [];
    if (missing.length > 0) parts.push(`missing ${missing.join(', ')}`);
    if (unexpected.length > 0) parts.push(`unexpected ${unexpected.join(', ')}`);
    throw new Error(
      `"${type}" value does not match the verified shape: ${parts.join('; ')}. ` +
        `The verified shape has exactly: ${expected.join(', ')}.`
    );
  }

  // The comparator condition records which operators have actually been seen
  // in a working rule. An invented one fails at Atlassian, not here.
  if (Array.isArray(entry.verifiedOperators) && value.operator !== undefined) {
    if (!entry.verifiedOperators.includes(value.operator)) {
      throw new Error(
        `"${type}" operator "${value.operator}" is not verified on this tenant. ` +
          `Verified operators: ${entry.verifiedOperators.join(', ')}.`
      );
    }
  }
  if (Array.isArray(entry.verifiedMatchTypes) && value.conditionMatchType !== undefined) {
    if (!entry.verifiedMatchTypes.includes(value.conditionMatchType)) {
      throw new Error(
        `"${type}" conditionMatchType "${value.conditionMatchType}" is not verified. ` +
          `Verified: ${entry.verifiedMatchTypes.join(', ')}.`
      );
    }
  }
}

function buildWebhookValue(rawValue) {
  const value = rawValue && typeof rawValue === 'object' ? { ...rawValue } : {};
  const url = nonEmptyString(value.url, 'actions[].value.url');

  // An Authorization header is never built from agent input. Refuse loudly
  // rather than stripping silently: an agent that believes it configured
  // authentication would report a rule as ready when it is not.
  const suppliedHeaders = Array.isArray(value.headers) ? value.headers : [];
  const authHeaders = suppliedHeaders.filter((header) =>
    /^authorization$/i.test(String(header?.name || '').trim())
  );
  if (authHeaders.length > 0) {
    throw new Error(
      'This app does not put credentials in rules. Remove the Authorization header from the ' +
        'web request action. Set "authenticate": true instead and the header is added with a ' +
        'placeholder value for a human to replace in the Automation UI.'
    );
  }

  const headers = [...suppliedHeaders];
  // `authenticate: true` asks for the header to EXIST, not to be filled in.
  // Adding the placeholder here means the human edits one value in the UI
  // instead of building a header from scratch on every rule, and a placeholder
  // is not a credential, so nothing secret enters this codebase, the agent's
  // context, a Forge log, or a rule export.
  //
  // headerSecure is true from the start, so the field is already masked when
  // the real value is pasted in. A header added later with masking left off is
  // how the credential in the earlier test rule ended up readable.
  if (value.authenticate === true) {
    headers.push({
      id: `_header_${Date.now()}_auth`,
      name: 'Authorization',
      value: AUTH_PLACEHOLDER,
      headerSecure: true,
    });
  }

  // Optional, all of them. url is the only value a web request cannot do
  // without (required above). GET with an empty body is HTTP's own default for
  // "call this address"; secure flags off and no extra headers are what a
  // request that names none of them means; the two response flags are
  // explained below.
  const built = {
    ...value,
    url,
    urlSecure: value.urlSecure === true,
    headers,
    sendIssue: value.sendIssue === true,
    contentType: value.contentType || 'empty',
    method: value.method || 'GET',
    // Both default ON. responseEnabled is what makes the body readable at all;
    // continueOnErrorEnabled is what lets a non-2xx reach a condition and an
    // audit-log step instead of aborting the rule before it can say why.
    responseEnabled: value.responseEnabled !== false,
    continueOnErrorEnabled: value.continueOnErrorEnabled !== false,
  };
  // `authenticate` is this app's own input flag, not part of Jira's component
  // shape. Delete the key rather than setting it undefined: an undefined-valued
  // key survives in memory, so post-create verification would compare it against
  // a retrieved rule that never had it and report a false mismatch.
  delete built.authenticate;
  return built;
}

function normalizeEditFields(fields) {
  if (Array.isArray(fields)) return fields;

  // A name-to-value map is easier for an agent to generate and lets a rule
  // specification describe any number of fields without repeating `name`.
  // Keep supporting the original array form for callers that need duplicate
  // names to be detected by Jira field metadata or prefer an explicit list.
  if (fields && typeof fields === 'object') {
    return Object.entries(fields).map(([name, value]) => ({ name, value }));
  }

  return null;
}

function buildAdvancedNumericFields(fields) {
  const fieldEntries = fields
    .map(({ fieldId, value }) => `    ${JSON.stringify(fieldId)}: ${value}`)
    .join(',\n');
  return `{\n  "fields": {\n${fieldEntries}\n  }\n}`;
}

/**
 * Resolve a { name, value, comparison? } condition spec into
 * jira.issue.condition's internal shape: field-by-NAME plus a
 * selectedFieldType, mirroring how jira.issue.edit resolves fields. Built
 * from a real "Send to Customer ITSM equals Yes" condition on the tenant.
 */
function buildIssueFieldCondition(conditionSpec, fieldMetadata) {
  if (!conditionSpec || typeof conditionSpec !== 'object') {
    throw new Error('conditions[].value must be an object with name and value.');
  }
  const fieldName = nonEmptyString(conditionSpec.name, 'conditions[].value.name');
  if (conditionSpec.value === undefined || conditionSpec.value === null || conditionSpec.value === '') {
    throw new Error(`conditions[].value.value is required for field "${fieldName}".`);
  }
  // Optional: "the field is X" means EQUALS. Any other comparison has to be
  // named, and one that is not verified for the field is refused below.
  const comparison = conditionSpec.comparison || 'EQUALS';
  // Checked once the field is known, because verified comparisons differ per field.
  const assertComparison = (verified) => {
    if (!verified.includes(comparison)) {
      throw new Error(
        `comparison "${comparison}" is not verified for jira.issue.condition on field "${fieldName}" ` +
          `(currently: ${verified.join(', ')}). Use jira.comparator.condition for other comparisons.`
      );
    }
  };

  const matches = fieldMetadata.filter(
    (field) =>
      field &&
      typeof field.name === 'string' &&
      (field.name.trim().toLowerCase() === fieldName.trim().toLowerCase() ||
        // Also accept the field's ID, so "issuetype" finds "Issue Type".
        field.id === fieldName.trim())
  );
  if (matches.length === 0) {
    throw new Error(`No Jira field named "${fieldName}" was found on this site.`);
  }
  if (matches.length > 1) {
    const ids = matches.map((field) => field.key || field.id).join(', ');
    throw new Error(
      `Field name "${fieldName}" matches more than one field (${ids}); disambiguation is not yet supported.`
    );
  }

  // System fields: compareValue's type differs per field (see
  // SYSTEM_CONDITION_FIELDS). For ID-compared fields the tenant rules store
  // e.g. priority "2", never "High"; a name would be saved as-is and the
  // condition would silently never match, so it is rejected here.
  const systemField = matches[0].schema?.system;
  const systemShape = systemField && SYSTEM_CONDITION_FIELDS[systemField];
  if (systemShape) {
    assertComparison(systemShape.comparisons);
    const compared = systemShape.compareType === 'ID'
      ? String(numericId(conditionSpec.value, `Field "${fieldName}"`))
      : String(conditionSpec.value);
    return {
      selectedField: { type: 'ID', value: systemField },
      selectedFieldType: systemField,
      comparison,
      compareValue: { type: systemShape.compareType, modifier: null, value: compared, multiValue: false, source: null },
    };
  }

  const fieldType = matches[0].schema?.custom;
  const valueBuilder = fieldType && CONDITION_FIELD_VALUE_BUILDERS[fieldType];
  if (!valueBuilder) {
    // Point the agent at the verified comparator condition, which compares
    // smart values and so works for any field, instead of dead-ending.
    const fieldId = matches[0].id || matches[0].key || fieldName;
    throw new Error(
      `Field "${fieldName}" has type "${fieldType || matches[0].schema?.type || 'unknown'}", ` +
        'which is not on the verified list for jira.issue.condition ' +
        `(currently: single-select and request-type custom fields, and ${VERIFIED_SYSTEM_CONDITION_FIELDS.join(', ')}). ` +
        'Use jira.comparator.condition instead: first = the field\'s smart value ' +
        `(e.g. "{{issue.${fieldId}}}", or "{{issue.${fieldId}.name}}" for fields like status), ` +
        'second = the value, operator EQUALS.'
    );
  }

  assertComparison(VERIFIED_CONDITION_COMPARISONS);
  return {
    selectedField: { type: 'NAME', value: matches[0].name },
    selectedFieldType: fieldType,
    comparison,
    compareValue: valueBuilder(conditionSpec.value),
  };
}

/**
 * Decide whether the caller handed us a complete Automation API payload or the
 * small specification. A full payload is always `{ "rule": { ... } }` with a
 * trigger inside; the specification never has a top-level `rule` key. Checking
 * the shape rather than the input name means the agent does not have to choose
 * a format, which is where an earlier version went wrong.
 */
function isFullRulePayload(parsed) {
  return Boolean(
    parsed &&
      typeof parsed === 'object' &&
      !Array.isArray(parsed) &&
      parsed.rule &&
      typeof parsed.rule === 'object' &&
      !Array.isArray(parsed.rule)
  );
}

/**
 * Prepare a full payload for the create endpoint: drop the fields Atlassian
 * owns, guarantee an actor, and force DISABLED so a pasted payload cannot
 * bypass the safety boundary. Everything else - components, trigger, scope,
 * writeAccessType - is left exactly as supplied.
 */
function normalizeFullPayload(parsed, actorAccountId) {
  const rule = { ...parsed.rule };
  for (const field of SERVER_OWNED_RULE_FIELDS) {
    delete rule[field];
  }
  // A rule with no actor is rejected with a generic parse error. A pasted
  // payload usually carries one already; supply the configured account when
  // it does not. This comes from the Forge environment, not from the requester,
  // so it is not a value anyone could have been asked for.
  if (!rule.actor) {
    rule.actor = { type: 'ACCOUNT_ID', actor: actorAccountId };
  }
  if (!rule.authorAccountId) {
    rule.authorAccountId = actorAccountId;
  }
  rule.state = 'DISABLED';
  return { rule };
}

/**
 * Convert the small, LLM-friendly rule specification into the exact nested
 * Automation API shape. Keeping this conversion here means the Rovo agent
 * only has to extract intent from a prompt or document; it does not have to
 * invent Atlassian's internal component nesting or UUID relationships.
 *
 * `fieldMetadata` is the tenant's field list (see fetchJiraFieldMetadata),
 * already fetched by the caller, or null when no jira.issue.edit action is
 * present. It is only consulted for jira.issue.edit actions.
 */
function buildRulePayload(spec, configuredCloudId, actorAccountId, fieldMetadata) {
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) {
    throw new Error('ruleSpec must be a JSON object.');
  }

  const projectId = nonEmptyString(spec.projectId, 'projectId');
  // The scope ARI takes the NUMERIC project id. A project key such as
  // "GSOC-Demo" still produces a well-formed-looking ARI, so it passes local
  // validation and then fails at the API with a generic parse error. Catch it
  // here instead, where the message can say what is actually wrong.
  if (!/^\d+$/.test(projectId)) {
    throw new Error(
      `projectId must be the numeric Jira project ID, not the project key (got "${projectId}").`
    );
  }
  const cloudId = nonEmptyString(configuredCloudId, 'cloudId');
  if (Object.prototype.hasOwnProperty.call(spec, 'cloudId') &&
      spec.cloudId !== cloudId) {
    throw new Error('The ruleSpec cloudId does not match the configured Forge site cloud ID.');
  }
  const scope = `ari:cloud:jira:${cloudId}:project/${projectId}`;
  const name = nonEmptyString(spec.name, 'name');
  const trigger = spec.trigger;
  if (!trigger || typeof trigger !== 'object') {
    throw new Error('trigger is required.');
  }

  const triggerBuilder = TRIGGER_BUILDERS[trigger.type];
  if (!triggerBuilder) {
    throw new Error(`trigger.type must be one of ${ALLOWED_TRIGGER_TYPES.join(', ')}.`);
  }

  // Every component the API receives must point at the REAL id of its parent.
  // These ids are generated up front and then handed to component() so that
  // the id written into a child's parentId is the same string that ends up on
  // the parent object itself.
  const triggerId = randomUUID();
  const context = { projectId, fieldMetadata };

  // Optional checks on the trigger itself: they gate the WHOLE rule, setup
  // actions included, which a condition inside a branch cannot do. The export
  // (SDP-Jira.txt) hangs them on the trigger with conditionParentId = the
  // trigger id and parentId null, and the trigger carries no match type, so
  // every check must pass. buildCondition produces exactly that wiring.
  if (trigger.conditions !== undefined && !Array.isArray(trigger.conditions)) {
    throw new Error('trigger.conditions must be an array.');
  }
  const triggerConditions = (trigger.conditions ?? []).map((condition) =>
    buildCondition(condition, triggerId, fieldMetadata));

  // `branches` is the general form: one if.block per entry. The flat
  // conditions + actions input is just a single branch, so both go through the
  // same block-building code.
  let components;
  if (spec.branches !== undefined) {
    // Two ways of writing the same thing: silently preferring one would drop
    // half of the caller's logic, so refuse.
    if (spec.conditions !== undefined && spec.conditions !== null) {
      throw new Error(
        'ruleSpec has both "branches" and top-level "conditions". Put each condition inside the ' +
          'branch it belongs to.'
      );
    }
    // Top-level actions next to branches are setup actions: they run
    // unconditionally, before the branching, so they come first with no parent
    // and the container goes last. Optional: most rules have none.
    const setupActions = spec.actions ?? [];
    if (!Array.isArray(setupActions)) {
      throw new Error('actions must be an array.');
    }
    components = [
      ...setupActions.map((action) => buildAction(action, null, fieldMetadata, projectId)),
      buildBranchContainer(spec.branches, null, context),
    ];
  } else {
    // Optional: a rule with no conditions at all is legitimate ("on every new
    // issue, do X"). Absent actions are left as they were: at least one
    // condition or action is required below, and existing callers build
    // condition-only rules.
    const [block] = buildBranchBlocks([{
      conditions: spec.conditions || [],
      actions: spec.actions || [],
      conditionMatchType: spec.conditionMatchType,
    }], false, context);
    components = block.hasConditions ? [assembleBranchContainer([block], null)] : block.actions;
  }

  return {
    rule: {
      name,
      state: 'DISABLED',
      // Optional: a free-text note for people reading the rule list.
      description: typeof spec.description === 'string' ? spec.description : '',
      // The next four are fixed rule settings copied from the verified exports,
      // not values taken from the request, so there is nothing to ask for.
      canOtherRuleTrigger: true,
      notifyOnError: 'FIRSTERROR',
      // Required by the API. Without an actor the create request fails with a
      // generic "request body could not be parsed" 400.
      authorAccountId: actorAccountId,
      actor: { type: 'ACCOUNT_ID', actor: actorAccountId },
      trigger: {
        component: 'TRIGGER',
        schemaVersion: triggerBuilder.schemaVersion,
        type: trigger.type,
        value: triggerBuilder.buildValue(trigger, scope),
        connectionId: null,
        conditions: triggerConditions,
        id: triggerId,
      },
      components,
      ruleScopeARIs: [scope],
      // Optional: labels are only for finding the rule later.
      labels: Array.isArray(spec.labels) ? spec.labels : [],
      writeAccessType: 'UNRESTRICTED',
      collaborators: [],
    },
  };
}

/**
 * Every spec part that can carry conditions or actions: the spec itself, each
 * branch, and each branch nested inside a branch, to any depth. Used by the
 * field-metadata scan and the receipt summary so nested branches are seen too.
 */
function collectSpecParts(spec) {
  const parts = [spec];
  // The trigger's own conditions are scanned like any other block's.
  if (Array.isArray(spec?.trigger?.conditions)) parts.push({ conditions: spec.trigger.conditions });
  if (spec && typeof spec === 'object' && Array.isArray(spec.branches)) {
    for (const branch of spec.branches) parts.push(...collectSpecParts(branch));
  }
  return parts;
}

/**
 * Turn a JSON.parse error into a message a person can act on. Node reports
 * only a character offset ("position 841"), which means nothing to a
 * requester, so the text around that offset is quoted with a marker at the
 * exact spot the parser gave up.
 *
 * Issue #21: the excerpt alone tells the agent WHERE, not WHAT to change, and
 * on a large nested spec it then resent the same broken text. So a hint is
 * added that names the open block (by path, e.g. "branches[1].actions[2]") and
 * the bracket fix. The hint holds only paths and bracket characters, never
 * values, because a spec can carry header values.
 */
function describeJsonError(text, error) {
  const match = /position (\d+)/.exec(error.message);
  // "Unexpected end of JSON input" carries no position: it failed at the end.
  const endOfInput = !match && /Unexpected end of JSON input/.test(error.message);
  if (!match && !endOfInput) return `ruleSpec is not valid JSON: ${error.message}`;
  const position = endOfInput ? text.length : Number(match[1]);
  const start = Math.max(0, position - 40);
  const end = Math.min(text.length, position + 40);
  const excerpt =
    (start > 0 ? '...' : '') +
    text.slice(start, position) + '>>>HERE<<<' + text.slice(position, end) +
    (end < text.length ? '...' : '');
  // Keep only the parser's reason, e.g. "Expected double-quoted property name".
  // Some messages say "after JSON at position N", without "in JSON".
  const reason = error.message.replace(/\s*(?:in JSON )?at position.*$/s, '');
  const hint = describeBracketFix(text, position, reason);
  return (
    `ruleSpec is not valid JSON (${reason}). The problem is at >>>HERE<<< in: ${excerpt}` +
    (hint ? ` ${hint}` : '') +
    ' Fix the brackets and send the corrected spec; resending the same spec will fail the same way.'
  );
}

/**
 * Say which bracket to change, from the blocks open at `position`. Three
 * shapes cover the faults seen in agent-written specs:
 * - the spec ends with blocks still open: list them, innermost first;
 * - the top level closed before the end: name the run of closers that did it;
 * - a closer that does not match the open block: name the block and its closer.
 * Returns '' when none applies, leaving just the excerpt.
 */
function describeBracketFix(text, position, reason) {
  const { open, closed } = scanJsonBrackets(text, position);

  if (position >= text.trimEnd().length && open.length > 0) {
    const blocks = open.slice().reverse().map(describeBlock).join(', ');
    return `The spec ends with these blocks still open, innermost first: ${blocks}. ` +
      'Close each one where it should end.';
  }

  if (/Unexpected non-whitespace character after JSON/.test(reason) && open.length === 0) {
    // Walk back over the closers that end right before `position` (whitespace
    // between them allowed). The earliest of them closed the deepest block.
    let first = closed.length - 1;
    while (first > 0 && text.slice(closed[first - 1].position + 1, closed[first].position).trim() === '') first -= 1;
    const innermost = closed[first]?.path;
    return `The JSON finished at >>>HERE<<< with ${text.length - position} more characters after it, so ` +
      'that text is outside the rule. The closing brackets just before >>>HERE<<< closed every block ' +
      `from ${innermost ? `\`${innermost}\`` : 'the innermost one'} out to the top level. One of those ` +
      'closers, or one earlier, is extra: remove it rather than adding a bracket at the end.';
  }

  const found = text[position];
  const top = open[open.length - 1];
  if ((found === ']' || found === '}') && top && found !== CLOSER_OF[top.opener]) {
    const kind = top.opener === '{' ? 'object' : 'list';
    return `At >>>HERE<<< you are inside ${describeBlock(top)}, so \`${found}\` is wrong: ` +
      `close the ${kind} with \`${CLOSER_OF[top.opener]}\` first.`;
  }
  return top ? `At >>>HERE<<< you are inside ${describeBlock(top)}.` : '';
}

const CLOSER_OF = { '{': '}', '[': ']' };

const describeBlock = (block) =>
  block.path === ''
    ? `the top-level ${block.opener === '{' ? 'object' : 'list'}`
    : `the ${block.opener === '{' ? 'object' : 'list'} at \`${block.path}\``;

/**
 * Walk `text` up to `end` the way JSON.parse did, tracking only structure.
 * String contents are skipped (honouring \" escapes), so the {{ }} of smart
 * values never count as brackets. Each open block keeps its path: an object's
 * child is named by the key last read, a list's child by its index.
 * Returns the blocks still open (outermost first) and every block closed, in
 * order, with the position of its closer.
 */
function scanJsonBrackets(text, end) {
  const open = [];
  const closed = [];
  let stringStart = -1;
  for (let i = 0; i < end; i += 1) {
    const char = text[i];
    if (stringStart >= 0) {
      if (char === '\\') {
        i += 1;
      } else if (char === '"') {
        const top = open[open.length - 1];
        if (top?.opener === '{' && top.expectingKey) {
          top.key = text.slice(stringStart + 1, i);
          top.expectingKey = false;
        }
        stringStart = -1;
      }
      continue;
    }
    const top = open[open.length - 1];
    if (char === '"') {
      stringStart = i;
    } else if (char === '{' || char === '[') {
      open.push({ opener: char, path: childPath(top), key: null, index: 0, expectingKey: char === '{' });
    } else if (char === '}' || char === ']') {
      const block = open.pop();
      if (block) closed.push({ position: i, path: block.path });
    } else if (char === ',' && top) {
      if (top.opener === '[') top.index += 1;
      else top.expectingKey = true;
    }
  }
  return { open, closed };
}

function childPath(parent) {
  if (!parent) return '';
  if (parent.opener === '[') return `${parent.path}[${parent.index}]`;
  return parent.path === '' ? String(parent.key) : `${parent.path}.${parent.key}`;
}

/**
 * List the jira.issue.edit actions whose `value` has the wrong shape, each
 * named by its path (e.g. "branches[1].actions[3]") so the agent can fix them
 * all in one revision. Walks setup actions and every branch, nested ones too.
 *
 * The defect this exists for: the agent putting `sendNotifications` INSIDE
 * `value.fields`, where it would otherwise be looked up as a Jira field name.
 */
function findEditActionDefects(spec, path = '') {
  if (!spec || typeof spec !== 'object') return [];
  const defects = [];
  const actions = Array.isArray(spec.actions) ? spec.actions : [];
  actions.forEach((action, index) => {
    if (action?.type !== 'jira.issue.edit') return;
    const where = `${path}actions[${index}]`;
    const fields = action.value?.fields;
    const entries = normalizeEditFields(fields);
    if (!entries || entries.length === 0) {
      defects.push(`${where} has no value.fields`);
    } else if (entries.some((entry) => entry?.name === 'sendNotifications')) {
      defects.push(`${where} has sendNotifications inside value.fields; it belongs beside fields, in value`);
    }
  });
  if (Array.isArray(spec.branches)) {
    spec.branches.forEach((branch, index) => {
      defects.push(...findEditActionDefects(branch, `${path}branches[${index}].`));
    });
  }
  return defects;
}

/**
 * Build ONE jira.condition.container.block holding one if.block per entry in
 * `branches` (validated here). `parentId` is the id of the component the
 * container hangs under: null at the top level of a rule, or the id of an
 * enclosing if.block when a container is nested inside a branch.
 * `context` is { projectId, fieldMetadata }, passed through to the builders.
 * `path` names this list in error messages ("branches", then
 * "branches[0].branches" one level down) so the agent can find the bad entry.
 */
function buildBranchContainer(branches, parentId, context, path = 'branches') {
  if (!Array.isArray(branches) || branches.length === 0) {
    throw new Error(`${path} must be a non-empty array.`);
  }
  const branchSpecs = branches.map((branch, index) => {
    if (!branch || typeof branch !== 'object' || Array.isArray(branch)) {
      throw new Error(`${path}[${index}] must be an object.`);
    }
    // An omitted "conditions" would silently turn this branch into the else.
    // The else must be asked for with an explicit empty list.
    if (branch.conditions === undefined) {
      throw new Error(
        `${path}[${index}] has no "conditions". Send the conditions for this case, or an empty ` +
          'list "conditions": [] if it is the else, the case that applies when no other case does.'
      );
    }
    const branchConditions = branch.conditions;
    // Optional: a branch that only splits further has no actions of its own
    // (checked below that it then has nested branches).
    const branchActions = branch.actions ?? [];
    if (!Array.isArray(branchConditions) || !Array.isArray(branchActions)) {
      throw new Error(`${path}[${index}] conditions and actions must be arrays.`);
    }
    // An empty-conditions block is the else: it always matches. Anything
    // after it can never run, so only the last branch may be one. This also
    // means there can be at most one else.
    if (branchConditions.length === 0 && index < branches.length - 1) {
      throw new Error(
        `${path}[${index}] has no conditions, so it is the else and always matches. ` +
          'Every later branch would be unreachable; only the last branch may have empty conditions.'
      );
    }
    // A branch that only splits further (no actions of its own, just nested
    // branches) is meaningful, so nested branches count as something to do.
    if (branchActions.length === 0 && branch.branches === undefined) {
      throw new Error(`${path}[${index}] has no actions or branches; a branch must do something.`);
    }
    return {
      conditions: branchConditions,
      actions: branchActions,
      conditionMatchType: branch.conditionMatchType,
      branches: branch.branches,
      path: `${path}[${index}]`,
    };
  });
  return assembleBranchContainer(buildBranchBlocks(branchSpecs, true, context), parentId);
}

/**
 * Turn validated branch specs into built conditions and actions, each branch
 * with its own block id. `actionsUnderBlock` is false only for the flat input
 * with no conditions, where there is no if-block to hang actions off.
 */
function buildBranchBlocks(branchSpecs, actionsUnderBlock, { projectId, fieldMetadata }) {
  return branchSpecs.map((branchSpec) => {
    // Each branch owns its block id. Its conditions point at it through
    // conditionParentId and its actions through parentId; sharing one id
    // between branches would make Jira treat them all as one branch.
    const blockId = randomUUID();
    const conditions = branchSpec.conditions.map((condition) =>
      buildCondition(condition, blockId, fieldMetadata));
    const hasConditions = conditions.length > 0;
    // With no conditions in the flat form there is no if-block to hang actions
    // off, so they sit at the top of `components` with a null parent. Both
    // shapes are accepted by the API; this one matches what the Automation UI
    // produces for a rule that has no conditions. A branch is always a block.
    const actions = branchSpec.actions.map((action) =>
      buildAction(action, hasConditions || actionsUnderBlock ? blockId : null, fieldMetadata, projectId));

    // A branch's own actions run first; the nested container follows them as
    // the block's last child, hung under this block's id (as in a real export).
    if (branchSpec.branches !== undefined) {
      actions.push(buildBranchContainer(
        branchSpec.branches, blockId, { projectId, fieldMetadata }, `${branchSpec.path}.branches`));
    }

    if (!hasConditions && actions.length === 0) {
      throw new Error('Provide at least one condition or action.');
    }

    // With two or more conditions, ALL ("every one") and ANY ("at least one")
    // build different rules, so the requester must have chosen. With one
    // condition or none the two are the same, so ALL is just a placeholder.
    if (!branchSpec.conditionMatchType && conditions.length > 1) {
      throw new Error(
        'This case has more than one condition, but the requester did not say whether ALL of them ' +
          'must be true or just ANY one. Ask them, then send conditionMatchType "ALL" or "ANY".'
      );
    }
    const conditionMatchType = branchSpec.conditionMatchType || 'ALL';
    if (!ALLOWED_MATCH_TYPES.includes(conditionMatchType)) {
      throw new Error(`conditionMatchType must be one of ${ALLOWED_MATCH_TYPES.join(', ')}.`);
    }
    return { blockId, conditions, actions, hasConditions, conditionMatchType };
  });
}

/** Wrap built branch blocks in one container component with the given parent. */
function assembleBranchContainer(branchBlocks, parentId) {
  const containerId = randomUUID();
  const conditionBlocks = branchBlocks.map((branch) => {
    const conditionBlock = component('CONDITION_BLOCK', 'jira.condition.if.block', {
      conditionMatchType: branch.conditionMatchType,
    }, { id: branch.blockId, parentId: containerId });
    conditionBlock.conditions = branch.conditions;
    conditionBlock.children = branch.actions;
    return conditionBlock;
  });

  const conditionContainer = component('CONDITION', 'jira.condition.container.block', {}, {
    id: containerId,
    parentId,
  });
  conditionContainer.children = conditionBlocks;
  return conditionContainer;
}

/**
 * Build one condition component for the if-block whose id is `blockId`.
 * `fieldMetadata` is only consulted for jira.issue.condition.
 */
function buildCondition(condition, blockId, fieldMetadata) {
  if (!condition || !ALLOWED_CONDITION_TYPES.includes(condition.type)) {
    const received = condition?.type
      ? `"${condition.type}"`
      : condition
        ? 'a condition with no "type"'
        : 'a null/undefined condition';
    throw new Error(
      `conditions[] received ${received}, which is not a verified condition type. ` +
        `Allowed: ${ALLOWED_CONDITION_TYPES.join(', ')}.`
    );
  }
  // Use the type the caller actually asked for. Forcing every condition to
  // be a comparator produced a comparator component holding an issue
  // condition's value, which the API cannot parse.
  let value = condition.value;
  if (condition.type === 'jira.issue.condition') {
    // Same problem as jira.issue.edit: the internal shape (field-by-NAME
    // plus a selectedFieldType) is not something a prompt or an LLM can
    // reliably invent, so it's built here from real tenant field metadata.
    if (!fieldMetadata) {
      throw new Error('Field metadata was not loaded for a jira.issue.condition.');
    }
    value = buildIssueFieldCondition(condition.value, fieldMetadata);
  }
  assertVerifiedComponentValue('condition', condition.type, value);
  return component('CONDITION', condition.type, value, {
    conditionParentId: blockId,
    schemaVersion:
      condition.schemaVersion || CONDITION_SCHEMA_VERSIONS[condition.type] ||
      CONDITION_LIBRARY[condition.type]?.schemaVersion || 1,
  });
}

/**
 * Build one action component whose parent is `parentId` (an if-block id, or
 * null for a top-level action). `fieldMetadata` is only consulted for
 * jira.issue.edit; `projectId` pins form actions to the rule's own project.
 */
function buildAction(action, parentId, fieldMetadata, projectId) {
  if (!action || !ALLOWED_ACTION_TYPES.includes(action.type)) {
    // Name what was rejected, not just what is allowed. Without the offending
    // type the caller cannot tell which of a dozen actions was wrong, and
    // neither can anyone reading the logs afterwards.
    const received = action?.type
      ? `"${action.type}"`
      : action
        ? 'an action with no "type"'
        : 'a null/undefined action';
    throw new Error(
      `actions[] received ${received}, which is not a verified action type. ` +
        `Allowed: ${ALLOWED_ACTION_TYPES.join(', ')}.`
    );
  }

  // Not a silent default: an action that needs a value but got none fails the
  // checks below by naming the missing key (assertVerifiedComponentValue, or
  // the webhook url and edit fields checks), so {} never reaches the API.
  let value = action.value ?? {};
  if (action.type === 'jira.issue.outgoing.webhook') {
    value = buildWebhookValue(value);
  }
  if (action.type === 'jira.issue.edit') {
    // The internal `operations` shape - field-by-NAME plus a fieldType
    // class Jira's UI needs to populate "Choose fields to set..." - is not
    // something a prompt or an LLM can reliably invent, so it is built
    // here from real tenant field metadata instead of trusting it
    // directly. Standard select/text fields become operations; Jira float
    // fields use the numeric advancedFields JSON format from the rule sample.
    //
    // `fields` lives inside `value`, same as every other action type here
    // (log's value.text, comment's value.comment, etc.) - keeping this
    // action consistent with that convention means the agent does not
    // have to special-case it.
    const editFields = normalizeEditFields(value.fields);
    if (!editFields || editFields.length === 0) {
      throw new Error(
        'jira.issue.edit takes "value.fields" and builds the Jira payload itself - do not ' +
          'supply "operations" or "advancedFields" directly. Use an array of ' +
          '{ name or fieldId, value } entries, or an object mapping field names/IDs to values, ' +
          'e.g. { "fields": { "customfield_11594": "{{#=}}ROUND({{issue.customfield_11594|0}} ' +
          '+ 1, 2){{/}}" } }. Numeric fields are routed to advancedFields automatically.'
      );
    }
    if (!fieldMetadata) {
      throw new Error('Field metadata was not loaded for a jira.issue.edit action.');
    }
    const operations = [];
    const numericFields = [];
    for (const fieldSpec of editFields) {
      const fieldName = editFieldName(fieldSpec);
      const jiraField = findJiraField(fieldName, fieldMetadata);
      if (jiraField.schema?.custom === FLOAT_CUSTOM_FIELD_TYPE) {
        const fieldId = jiraField.key || jiraField.id;
        if (typeof fieldId !== 'string' || fieldId.trim() === '') {
          throw new Error(`Numeric field "${fieldName}" has no Jira field ID.`);
        }
        numericFields.push({
          fieldId,
          value: buildAdvancedNumericValue(fieldSpec.value, fieldName),
        });
      } else {
        operations.push(buildEditOperation(fieldSpec, fieldMetadata, jiraField));
      }
    }
    value = {
      operations,
      advancedFields: numericFields.length > 0
        ? buildAdvancedNumericFields(numericFields)
        : null,
      // Optional. Matches the confirmed working rule's value, and is what Jira's
      // own edit action does: people watching the issue are told of the change.
      // Explicit `false` in the spec opts out; anything else (including omitted) keeps this default.
      sendNotifications: value.sendNotifications !== false,
    };
  }

  if (action.type === 'jira.proforma.form.add.action') {
    // The form is attached from the rule's OWN project's templates, whatever
    // the spec says, so a draft cannot reach into another project's forms.
    value = {
      ...value,
      templateFormsConfig: { ...(value.templateFormsConfig || {}), projectId: Number(projectId) },
    };
  }

  assertVerifiedComponentValue('action', action.type, value);

  return component('ACTION', action.type, value, {
    parentId,
    schemaVersion: action.schemaVersion || ACTION_SCHEMA_VERSIONS[action.type] ||
      ACTION_LIBRARY[action.type]?.schemaVersion || 1,
  });
}

// `id` is pulled out of `extra` first so a caller can supply one. Previously
// `id: randomUUID()` sat after the spread, which silently discarded any id
// passed in and replaced it with a brand new one.
function component(componentType, type, value, extra = {}) {
  const { id = randomUUID(), ...rest } = extra;
  return {
    component: componentType,
    schemaVersion: 1,
    type,
    value,
    connectionId: null,
    conditions: [],
    parentId: null,
    conditionParentId: null,
    children: [],
    ...rest,
    id,
  };
}

function nonEmptyString(value, fieldName) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${fieldName} is required and must be a non-empty string.`);
  }
  return value.trim();
}

function normalizeTriggerFieldName(field) {
  const fieldName =
    typeof field === 'string'
      ? field
      : field && typeof field === 'object' && !Array.isArray(field)
        ? field.name
        : undefined;
  if (typeof fieldName !== 'string' || fieldName.trim() === '') {
    throw new Error(
      'Each trigger.fields entry must be a Jira field-name string or an object with a non-empty name.'
    );
  }
  return fieldName.trim();
}

function validateRulePayload(requestBody, configuredCloudId) {
  if (!requestBody || typeof requestBody !== 'object' || Array.isArray(requestBody)) {
    return { ok: false, error: 'The request must be a JSON object.' };
  }

  const rule = requestBody.rule;
  if (!rule || typeof rule !== 'object' || Array.isArray(rule)) {
    return { ok: false, error: 'The request must have a nested rule object.' };
  }

  // `uuid` is genuinely server-assigned and must not be sent on create.
  // `actor` used to be rejected here too, which was wrong: the API requires
  // it, so that check failed every single request.
  if (Object.prototype.hasOwnProperty.call(rule, 'uuid')) {
    return { ok: false, error: 'Do not include uuid when creating a rule.' };
  }

  if (!rule.actor || typeof rule.actor !== 'object' ||
      typeof rule.actor.actor !== 'string' || rule.actor.actor.trim() === '') {
    return {
      ok: false,
      error: 'rule.actor must be an { type, actor } object naming the account the rule runs as.',
    };
  }

  if (rule.state !== 'DISABLED') {
    return { ok: false, error: 'Rules created by this action must have state DISABLED.' };
  }

  if (!Array.isArray(rule.ruleScopeARIs) || rule.ruleScopeARIs.length !== 1) {
    return {
      ok: false,
      error: 'rule.ruleScopeARIs must contain exactly one target-project scope ARI.',
    };
  }

  const scope = rule.ruleScopeARIs[0];
  // The project segment must be numeric. Allowing any non-slash string let a
  // project KEY through, which the API then rejected with a generic error.
  const scopeMatch = /^ari:cloud:jira:([^:]+):project\/(\d+)$/.exec(scope);
  if (!scopeMatch) {
    return {
      ok: false,
      error: 'rule.ruleScopeARIs[0] must be ari:cloud:jira:{cloudId}:project/{numericProjectId}.',
    };
  }

  if (!rule.trigger || typeof rule.trigger !== 'object') {
    return { ok: false, error: 'The rule must include a trigger.' };
  }

  // A scheduled JQL trigger has no eventFilters; ruleScopeARIs (already
  // validated above as exactly one numeric project) is its only scope.
  if (!RULE_SCOPED_TRIGGER_TYPES.has(rule.trigger.type)) {
    const eventFilters = rule.trigger.value?.eventFilters;
    if (!Array.isArray(eventFilters) || eventFilters.length === 0) {
      return {
        ok: false,
        error: 'trigger.value.eventFilters must include the target-project filter.',
      };
    }

    const hasMatchingProjectFilter = eventFilters.some((filter) =>
      JSON.stringify(filter).includes(scope)
    );
    if (!hasMatchingProjectFilter) {
      return {
        ok: false,
        error: 'ruleScopeARIs and trigger.value.eventFilters must use the same project scope.',
      };
    }
  }

  // A pasted full payload skips the builder, so the rules the builder enforces
  // for these types are re-checked here, on both input paths. An incoming
  // webhook's token is a secret Jira generates (invariant 5), and a ProForma
  // form must come from the rule's own project.
  if (rule.trigger.type === 'jira.incoming.webhook' && rule.trigger.value?.webhookToken) {
    return { ok: false, error: 'An incoming webhook trigger must not carry a webhookToken; Jira generates it.' };
  }
  const foreignForms = [];
  walkComponents(rule.components, (node) => {
    const formProjectId = node.type === 'jira.proforma.form.add.action' && node.value?.templateFormsConfig?.projectId;
    if (formProjectId !== undefined && formProjectId !== false && String(formProjectId) !== scopeMatch[2]) {
      foreignForms.push(String(formProjectId));
    }
  });
  if (foreignForms.length > 0) {
    return { ok: false, error: `ProForma forms must come from the rule's own project ${scopeMatch[2]}, not ${foreignForms.join(', ')}.` };
  }

  // Jira validates a web request's URL when the rule is CREATED, even though
  // it is created disabled. Caught there, a typo or a "<SYNC_SERVICE_URL>"
  // placeholder costs a whole approval cycle, and the creation claim means the
  // ticket cannot simply be retried. Caught here, nothing has been raised yet.
  // The quoted value stops at "?" so a signed URL's signature is never echoed.
  const positions = describeComponentPositions(rule);
  const badUrls = [];
  // Issue #22: "<redacted URL>" is never written by this app. It is put in
  // upstream, before the input reaches Forge, when a URL holds placeholder text
  // such as "https://<your-site>...". Resending cannot fix it, so it gets its
  // own message telling the agent what to write instead.
  const strippedUrls = [];
  walkComponents(rule.components, (node) => {
    if (node.component === 'ACTION' && node.type === 'jira.issue.outgoing.webhook' && !parseHttpUrl(node.value?.url)) {
      const url = String(node.value?.url ?? '');
      if (/^\s*<redacted url>/i.test(url)) strippedUrls.push(`the url of ${positions.get(node)}`);
      else badUrls.push(`the url of ${positions.get(node)} is "${url.split('?')[0]}"`);
    }
  });
  const urlErrors = [];
  if (badUrls.length > 0) {
    urlErrors.push(
      `Every web request needs a full http(s) URL, but ${badUrls.join('; ')}. ` +
      'If the real address cannot go in the request, use a stand-in on a reserved domain, e.g. ' +
      'https://sync-service.invalid/path: it passes Jira\'s check, can never reach a real server, ' +
      'and the approval ticket lists it as a stand-in to replace before enabling.'
    );
  }
  if (strippedUrls.length > 0) {
    const which = strippedUrls.join(' and ');
    urlErrors.push(
      `${which[0].toUpperCase()}${which.slice(1)} ${strippedUrls.length > 1 ? 'were' : 'was'} removed before ` +
      'it reached this app ("<redacted URL>"). This happens when a URL contains placeholder text such as ' +
      '`<your-site>`. Resending the same spec will fail the same way. For Jira\'s own REST API use the real ' +
      'site address; for an unknown external host use a reserved-domain stand-in such as ' +
      'https://sync-service.invalid/path. Never put `<...>` in a URL.'
    );
  }
  if (urlErrors.length > 0) {
    return { ok: false, error: urlErrors.join(' ') };
  }

  if (configuredCloudId !== scopeMatch[1]) {
    return {
      ok: false,
      error: 'The rule scope cloud ID does not match the configured Forge site cloud ID.',
    };
  }

  if (typeof rule.name !== 'string' || rule.name.trim() === '') {
    return { ok: false, error: 'rule.name is required.' };
  }

  return { ok: true, cloudId: scopeMatch[1], rule, scope };
}

// Apply the same verified-type policy to both the specification and the full
// payload path, so neither input can bypass the safety boundary.
function enforceComponentAllowlist(rule) {
  if (!ALLOWED_TRIGGER_TYPES.includes(rule.trigger?.type)) {
    return {
      ok: false,
      error: `trigger.type "${rule.trigger?.type}" is not on the verified allowlist.`,
    };
  }

  const offending = [];
  const inspect = (node) => {
    if (node.component === 'ACTION' && !ALLOWED_ACTION_TYPES.includes(node.type)) {
      offending.push(`action type "${node.type}"`);
    }
    if (
      node.component === 'CONDITION' &&
      !ALLOWED_CONDITION_TYPES.includes(node.type) &&
      !ALLOWED_STRUCTURAL_TYPES.includes(node.type)
    ) {
      offending.push(`condition type "${node.type}"`);
    }
  };

  walkComponents(rule.components, inspect);
  // The Automation UI attaches a trigger's own conditions directly to the
  // trigger rather than to a condition block. Those were previously never
  // inspected, which let an unverified condition type slip past the allowlist.
  walkComponents(rule.trigger?.conditions, inspect);

  if (offending.length > 0) {
    return {
      ok: false,
      error: `Rejected unverified component type(s): ${offending.join(', ')}.`,
    };
  }

  return { ok: true };
}

function walkComponents(components, visit) {
  if (!Array.isArray(components)) return;
  for (const node of components) {
    if (!node || typeof node !== 'object') continue;
    visit(node);
    if (Array.isArray(node.conditions)) walkComponents(node.conditions, visit);
    if (Array.isArray(node.children)) walkComponents(node.children, visit);
  }
}

// Words a person sees in the Automation UI, for the component types people most
// need to find. Any other type is named by its type string, which is also what
// the attached payload shows.
const COMPONENT_NOUNS = Object.freeze({
  'jira.issue.outgoing.webhook': 'web request action',
  'jira.issue.comment': 'comment action',
  'jira.create.variable': 'create variable action',
  'jira.issue.edit': 'edit issue action',
  'jira.comparator.condition': 'compare condition',
  'jira.issue.condition': 'issue field condition',
  'jira.condition.if.block': 'if-block',
  'jira.condition.container.block': 'if/else group',
});

/** 1 -> "1st", 2 -> "2nd", 11 -> "11th", 23 -> "23rd". */
function ordinal(n) {
  const teen = n % 100 >= 11 && n % 100 <= 13;
  const suffix = teen ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] ?? 'th');
  return `${n}${suffix}`;
}

/**
 * Name every component of a rule the way a person can find it in the Jira UI:
 * "the 2nd web request action", "the 1st comment action (inside the 3rd
 * if-block)". Never a component id: ids are random, and Atlassian assigns new
 * ones on create, so an id appears nowhere a human can look.
 *
 * Components are counted per type in rule order, the same depth-first order
 * as walkComponents (a node, then its conditions, then its children), which is
 * the top-to-bottom order the rule editor draws them in. The suffix names the
 * nearest enclosing if-block, because "the 2nd comment action" alone is hard
 * to spot in a rule with many branches. Trigger conditions say "(on the trigger)".
 *
 * Returns a Map keyed by the component OBJECTS of this `rule`, so look nodes up
 * in the same object (not a redacted copy).
 */
function describeComponentPositions(rule) {
  const labels = new Map();
  const counts = new Map();
  if (rule?.trigger && typeof rule.trigger === 'object') labels.set(rule.trigger, 'the trigger');

  const visit = (components, where) => {
    if (!Array.isArray(components)) return;
    for (const node of components) {
      if (!node || typeof node !== 'object') continue;
      const count = (counts.get(node.type) ?? 0) + 1;
      counts.set(node.type, count);
      const label = `the ${ordinal(count)} ${COMPONENT_NOUNS[node.type] ?? `"${node.type}" ${node.component === 'ACTION' ? 'action' : 'component'}`}`;
      labels.set(node, where ? `${label} (${where})` : label);
      const inner = node.type === 'jira.condition.if.block' ? `inside ${label}` : where;
      visit(node.conditions, inner);
      visit(node.children, inner);
    }
  };
  visit(rule?.trigger?.conditions, 'on the trigger');
  visit(rule?.components, null);
  return labels;
}

// Webhook actions carry Authorization headers and other secrets in their
// value. The failure object is shown to the Rovo user, so strip anything that
// looks like a credential before echoing the payload back.
function redactSecrets(value) {
  if (Array.isArray(value)) return value.map(redactSecrets);
  if (!value || typeof value !== 'object') return value;

  const out = {};
  for (const [key, entry] of Object.entries(value)) {
    if (key === 'headers' && Array.isArray(entry)) {
      out[key] = entry.map((header) => ({ ...header, value: '[redacted]' }));
    } else if (/token|secret|password|authorization|webhook_?url/i.test(key)) {
      out[key] = '[redacted]';
    } else if (key === 'url' && typeof entry === 'string') {
      out[key] = redactUrl(entry);
    } else {
      out[key] = redactSecrets(entry);
    }
  }
  return out;
}

/**
 * Parse a web request URL the way Jira will see it, or return null.
 *
 * A URL may legitimately contain smart values ("https://host/{{issue.key}}"),
 * which only become real text when the rule runs. Each {{...}} span is swapped
 * for a harmless "x" before parsing, so those pass while placeholder text such
 * as "<SYNC_SERVICE_URL>" (angle brackets are not allowed in a host) does not.
 * Only http and https count: a web request cannot call anything else.
 */
function parseHttpUrl(text) {
  if (typeof text !== 'string') return null;
  try {
    const url = new URL(text.replace(/\{\{[^}]*\}\}/g, 'x'));
    return url.protocol === 'http:' || url.protocol === 'https:' ? url : null;
  } catch {
    return null;
  }
}

/**
 * Redact the secret PARTS of a URL and keep the rest readable.
 *
 * The secret in a signed URL (a Logic App's ?sig=..., a token in the query, a
 * user:password@ prefix) is never the host or the path, and the host and path
 * are exactly what a person needs to tell which call failed. So:
 *   - userinfo becomes "[redacted]@"
 *   - every query value becomes "[redacted]" (the parameter names stay);
 *     a bare "?abc" with no "=" may itself be the secret, so it goes whole
 *   - a fragment becomes "#[redacted]"
 * The ORIGINAL string is edited rather than re-serialised through URL, which
 * would percent-encode smart values ("{{" -> "%7B%7B") and make them unreadable.
 * A URL that does not parse cannot be picked apart safely, so it is replaced whole.
 */
function redactUrl(url) {
  if (!parseHttpUrl(url)) return '[redacted]';

  const hashAt = url.indexOf('#');
  const withoutFragment = hashAt === -1 ? url : url.slice(0, hashAt);
  const queryAt = withoutFragment.indexOf('?');
  const base = queryAt === -1 ? withoutFragment : withoutFragment.slice(0, queryAt);

  const query = queryAt === -1 ? '' : `?${withoutFragment.slice(queryAt + 1).split('&')
    .map((pair) => (pair.includes('=') ? `${pair.slice(0, pair.indexOf('='))}=[redacted]` : '[redacted]'))
    .join('&')}`;
  const fragment = hashAt === -1 ? '' : '#[redacted]';

  // Userinfo sits between "scheme://" and the first "@" before any "/".
  return `${base.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/]*@/i, '$1[redacted]@')}${query}${fragment}`;
}

function verifyCreatedRule(retrieved, expectedScope, expectedRule) {
  const actualRule = retrieved?.rule || retrieved;
  if (!actualRule || typeof actualRule !== 'object') {
    return { ok: false, error: 'The GET response did not contain a rule object.' };
  }

  if (actualRule.state !== 'DISABLED') {
    return { ok: false, error: `Retrieved state was ${actualRule.state}.` };
  }

  if (!Array.isArray(actualRule.ruleScopeARIs) ||
      !actualRule.ruleScopeARIs.includes(expectedScope)) {
    return { ok: false, error: 'Retrieved rule scope did not match the requested project.' };
  }

  // Event triggers repeat the scope in eventFilters, so verify it survived the
  // round trip. A scheduled JQL trigger has none - its containment is the
  // ruleScopeARIs check above - so verify its query round-tripped instead,
  // since a dropped or rewritten JQL would change which issues it touches.
  if (RULE_SCOPED_TRIGGER_TYPES.has(expectedRule.trigger?.type)) {
    const actualValue = actualRule.trigger?.value ?? {};
    const expectedValue = expectedRule.trigger?.value ?? {};
    if (actualValue.jql !== expectedValue.jql) {
      return { ok: false, error: 'Retrieved scheduled trigger JQL did not match the request.' };
    }
    if (actualValue.executionMode !== expectedValue.executionMode) {
      return {
        ok: false,
        error: 'Retrieved scheduled trigger execution mode did not match the request.',
      };
    }
  } else {
    const retrievedFilters = actualRule.trigger?.value?.eventFilters;
    if (!Array.isArray(retrievedFilters) ||
        !retrievedFilters.some((filter) => JSON.stringify(filter).includes(expectedScope))) {
      return { ok: false, error: 'Retrieved trigger event filters did not match the requested project.' };
    }
  }

  if (actualRule.trigger?.type !== expectedRule.trigger?.type) {
    return { ok: false, error: 'Retrieved trigger type did not match the requested trigger.' };
  }

  if (!componentsContainExpectedValues(actualRule.components, expectedRule.components)) {
    return { ok: false, error: 'Retrieved conditions or actions did not match the request.' };
  }

  // A dropped trigger condition would remove the gate in front of the whole
  // rule, so compare those too (only when some were requested).
  if (expectedRule.trigger?.conditions?.length > 0 &&
      !componentsContainExpectedValues(actualRule.trigger?.conditions, expectedRule.trigger.conditions)) {
    return { ok: false, error: 'Retrieved trigger conditions did not match the request.' };
  }

  return { ok: true };
}

// The API may normalize or add metadata to component objects. Compare the
// requested component values as a subset so those harmless response changes do
// not create a false failure, while still detecting changed actions/conditions.
function componentsContainExpectedValues(actualComponents, expectedComponents) {
  if (!Array.isArray(expectedComponents)) return true;
  if (!Array.isArray(actualComponents)) return false;

  return expectedComponents.every((expectedComponent) =>
    actualComponents.some((actualComponent) =>
      deepContains(actualComponent, expectedComponent)
    )
  );
}

function deepContains(actual, expected) {
  if (expected === null || typeof expected !== 'object') return actual === expected;
  if (actual === null || typeof actual !== 'object') return false;

  if (Array.isArray(expected)) {
    if (!Array.isArray(actual)) return false;
    return expected.every((expectedItem) =>
      actual.some((actualItem) => deepContains(actualItem, expectedItem))
    );
  }

  // Atlassian assigns fresh UUIDs to every component on create. They are
  // identity metadata, not user intent, so comparing them causes a false
  // verification failure after every successful request.
  return Object.entries(expected).every(([key, value]) =>
    ['id', 'parentId', 'conditionParentId'].includes(key) ||
    (Object.prototype.hasOwnProperty.call(actual, key) && deepContains(actual[key], value))
  );
}

async function readJsonOrText(response) {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function failure(message, details = {}) {
  // Every failure() call in this file funnels through here, so this single
  // console.error is what makes every rejected/failed request visible in the
  // Forge Logs tab / `forge logs`. Details are redacted the same way the
  // Rovo-facing response is, so a webhook Authorization header can't end up
  // in Forge's (retained, billable) log storage.
  const safeDetails = redactSecrets(details);
  console.error(`[createJiraAutomationRule] ${message}`, safeStringify(safeDetails));
  // The RETURNED object must be redacted too, not just the log line. This
  // previously spread the raw `details`, so a verification mismatch handed the
  // whole retrieved rule -- Authorization headers and all -- back to the Rovo
  // agent, which shows it to the user and puts it in the chat transcript.
  // `ruleCreated` is redundant with `ok`, deliberately. The failure mode this
  // guards against is a caller announcing a rule that does not exist, so the
  // response carries a field named for exactly that claim rather than leaving
  // it to be inferred from a generic success flag.
  // `summary` is the code-rendered sentence the agent should relay. It says
  // plainly whether a rule exists, so a failure can't be reported as success.
  // The one failure path where the rule DOES exist (created, then
  // verification failed) is stated truthfully rather than as "not created".
  const ruleExists = typeof safeDetails.ruleUuid === 'string';
  const summary = ruleExists
    ? `The rule WAS created (ruleUuid: ${safeDetails.ruleUuid}) but could not be verified: ${message} ` +
      'Check it in Jira before relying on it.'
    : `The rule was NOT created. ${message}`;
  return { ok: false, ruleCreated: false, error: message, summary, ...safeDetails };
}

// JSON.stringify throws on circular structures or BigInt; logging must never
// itself be the thing that crashes the function.
function safeStringify(value) {
  try {
    return JSON.stringify(value);
  } catch (error) {
    return `[unserializable details: ${error.message}]`;
  }
}

// Helpers shared with the draft/approval modules. They are pure functions;
// exporting them keeps one implementation of digesting and redaction.
export {
  canonicalJson,
  sha256,
  redactSecrets,
  redactUrl,
  describeComponentPositions,
  AUTH_PLACEHOLDER,
  parseHttpUrl,
  walkComponents,
  failure,
  safeStringify,
  buildRulePayload,
  ALLOWED_TRIGGER_TYPES,
  ALLOWED_ACTION_TYPES,
  ALLOWED_CONDITION_TYPES,
  // Read by scripts/find-component-examples.js --survey to mark which field types are supported.
  CONDITION_FIELD_VALUE_BUILDERS,
  VERIFIED_SYSTEM_CONDITION_FIELDS,
  EDIT_OPERATION_VALUE_BUILDERS,
  SYSTEM_EDIT_OPERATION_BUILDERS,
  FLOAT_CUSTOM_FIELD_TYPE,
};
