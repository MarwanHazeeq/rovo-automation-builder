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
        // OPTIONAL on purpose: "when <field> changes" means ANY change to it.
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
      // OPTIONAL on purpose: an empty list means "any status". Either filter
      // alone ("to Done") is a normal request. Do not remove.
      return {
        eventFilters: [scope],
        fromStatus: Array.isArray(fromStatus) ? fromStatus : [],
        toStatus: Array.isArray(toStatus) ? toStatus : [],
        eventKey: 'jira:issue_updated',
        issueEvent: 'issue_generic',
      };
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
      // Default false matches the verified export: re-scan the whole result
      // set each run rather than only issues touched since the last run.
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
const RULE_SCOPED_TRIGGER_TYPES = new Set(['jira.jql.scheduled']);

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
];
const ALLOWED_CONDITION_TYPES = [
  'jira.comparator.condition',
  'jira.issue.condition',
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
};

// Same idea as EDIT_OPERATION_VALUE_BUILDERS, but for jira.issue.condition's
// compareValue, which needs its own per-fieldType wrapper. Confirmed only for
// select fields so far (a real "Send to Customer ITSM equals Yes" condition).
const CONDITION_FIELD_VALUE_BUILDERS = {
  'com.atlassian.jira.plugin.system.customfieldtypes:select': (value) => ({
    type: 'NAME',
    modifier: null,
    value: String(value),
    multiValue: false,
    source: null,
  }),
};

// jira.issue.condition only has a confirmed shape for this one comparison.
// Anything else is rejected rather than guessed, same policy as field types.
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
      for (const c of Array.isArray(parsed.conditions) ? parsed.conditions : []) conditions.push(c?.type);
      for (const a of Array.isArray(parsed.actions) ? parsed.actions : []) actions.push(a?.type);
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
    return failure(`Input is not valid JSON: ${error.message}`);
  }

  let requestBody;
  // Display name of the target project, for the approval ticket. Null when
  // the spec carried only an id (or a full payload was pasted).
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
    try {
      // A jira.issue.edit action or a jira.issue.condition condition both
      // need real tenant field metadata to resolve a field NAME into the
      // internal fieldType class (see EDIT_OPERATION_VALUE_BUILDERS and
      // CONDITION_FIELD_VALUE_BUILDERS above). Only fetch it when actually
      // needed, so rules that use neither don't pay for an extra API call.
      // Branches carry their own conditions and actions, so look in those too.
      const specParts = [parsed, ...(Array.isArray(parsed.branches) ? parsed.branches : [])];
      const needsFieldMetadata = specParts.some((part) =>
        (Array.isArray(part?.actions) &&
          part.actions.some((action) => action && action.type === 'jira.issue.edit')) ||
        (Array.isArray(part?.conditions) &&
          part.conditions.some((condition) => condition && condition.type === 'jira.issue.condition'))
      );
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
    return failure(`The create request could not be sent: ${error.message}`);
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
  if (!hasName) return { id: spec.projectId, name: null };

  const projectName = nonEmptyString(spec.projectName, 'projectName');
  const { id: resolvedId, name: resolvedName } =
    await findProjectIdByName(projectName, cloudId, email, token);

  if (hasId && String(spec.projectId).trim() !== resolvedId) {
    throw new Error(
      `projectId "${String(spec.projectId).trim()}" and projectName "${projectName}" are different ` +
        `projects (the name resolves to project id ${resolvedId}). Send only projectName.`
    );
  }
  return { id: resolvedId, name: resolvedName };
}

/**
 * Look a project up by exact display name. The search endpoint's `query` is a
 * SUBSTRING match on name and key, so its response is a candidate list: the
 * exact-name filter below is what makes this an answer. Zero or several exact
 * matches throw, naming real options so the agent can report them.
 */
async function findProjectIdByName(projectName, cloudId, email, token) {
  const auth = Buffer.from(`${email}:${token}`).toString('base64');
  const wanted = projectName.trim().toLowerCase();
  const candidates = [];
  let reachedLastPage = false;

  for (let page = 0; page < PROJECT_SEARCH_MAX_PAGES && !reachedLastPage; page += 1) {
    const url =
      `${JIRA_SITE_API_BASE}/${cloudId}/rest/api/3/project/search` +
      `?query=${encodeURIComponent(projectName)}` +
      `&startAt=${candidates.length}&maxResults=${PROJECT_SEARCH_PAGE_SIZE}`;
    console.log(`[findProjectIdByName] GET ${url}`);
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

  if (matches.length === 1) return { id: String(matches[0].id), name: matches[0].name };

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
  const fieldType = jiraField.schema?.custom;
  const valueBuilder = fieldType && EDIT_OPERATION_VALUE_BUILDERS[fieldType];
  if (!valueBuilder) {
    throw new Error(
      `Field "${fieldName}" has type "${fieldType || jiraField.schema?.type || 'unknown'}", ` +
        'which is not on the verified list for jira.issue.edit operations (currently: single-select and text fields). ' +
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

  // No schedule, or no frequency / time of day / time zone, used to be filled
  // in with a weekly Monday 09:00 Asia/Singapore rule that nobody chose. When
  // the requester has not said WHEN the rule runs, the agent must ask.
  if (!schedule || typeof schedule !== 'object' || Array.isArray(schedule)) {
    throw new Error(
      'The requester did not say when the rule should run. Ask how often (daily or weekly), ' +
        'at what time, and in which time zone, then send trigger.schedule.'
    );
  }
  const config = schedule;

  if (config.frequency === undefined || config.frequency === null || config.frequency === '') {
    throw new Error(
      `The requester did not say how often the rule should run. Ask whether it is ${RRULE_FREQUENCIES.join(' or ')}.`
    );
  }
  const frequency = String(config.frequency).toUpperCase();
  if (!RRULE_FREQUENCIES.includes(frequency)) {
    throw new Error(`trigger.schedule.frequency must be one of ${RRULE_FREQUENCIES.join(', ')}.`);
  }

  const hour = requiredScheduleInteger(config.hour, 'hour', 0, 23, 'what hour of the day');
  const minute = requiredScheduleInteger(config.minute, 'minute', 0, 59, 'at what minute past the hour');
  // OPTIONAL on purpose: an interval of 1 means "every day / every week",
  // which is what a requester who names no interval means. Do not remove.
  const interval = scheduleInteger(config.interval, 'interval', 1, 52, 1);

  if (typeof config.timezone !== 'string' || config.timezone.trim() === '') {
    throw new Error(
      'The requester did not say which time zone the schedule uses. Ask for it ' +
        '(for example "Asia/Singapore"); a schedule without a time zone could run hours off.'
    );
  }
  const timezone = config.timezone.trim();
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone });
  } catch {
    throw new Error(`trigger.schedule.timezone "${timezone}" is not a recognized IANA time zone.`);
  }

  let days = [];
  if (frequency === 'WEEKLY') {
    const requested = config.days ?? config.byDay;
    if (requested === undefined || requested === null || requested === '') {
      throw new Error(
        'The requester did not say which day(s) of the week a weekly rule runs. Ask which days.'
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

// Like scheduleInteger, but a missing value throws: hour and minute have no
// sensible default, and a rule that runs at a time nobody chose is a bug.
function requiredScheduleInteger(value, name, min, max, question) {
  if (value === undefined || value === null || value === '') {
    throw new Error(`The requester did not say ${question} the rule should run. Ask, then send trigger.schedule.${name}.`);
  }
  return scheduleInteger(value, name, min, max, undefined);
}

function scheduleInteger(value, name, min, max, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = typeof value === 'number' ? value : Number(String(value).trim());
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`trigger.schedule.${name} must be an integer between ${min} and ${max}.`);
  }
  return parsed;
}

function scheduleStartDate(startDate) {
  if (startDate === undefined || startDate === null || startDate === '') {
    // OPTIONAL on purpose: startDate only anchors the recurrence. The rule is
    // created DISABLED, and the hour, minute and days decide when it fires, so
    // "from today" changes nothing a requester would notice. Do not remove.
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

  // The HTTP method decides whether the call reads or changes the other
  // system, so a missing one must not quietly become GET.
  const method = typeof value.method === 'string' ? value.method.trim().toUpperCase() : '';
  if (method === '') {
    throw new Error(
      'The requester did not say which HTTP method the web request uses (for example GET or POST). ' +
        'Ask them, then send actions[].value.method.'
    );
  }

  const built = {
    ...value,
    url,
    urlSecure: value.urlSecure === true,
    headers,
    sendIssue: value.sendIssue === true,
    // OPTIONAL on purpose: 'empty' means "no request body", which is what a
    // requester who names no content type means. Do not remove.
    contentType: value.contentType || 'empty',
    method,
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
  // OPTIONAL on purpose: EQUALS is the ONLY verified comparison, so a missing
  // one cannot mean anything else. Do not remove.
  const comparison = conditionSpec.comparison || 'EQUALS';
  if (!VERIFIED_CONDITION_COMPARISONS.includes(comparison)) {
    throw new Error(
      `comparison "${comparison}" is not on the verified list for jira.issue.condition (currently: ${VERIFIED_CONDITION_COMPARISONS.join(', ')}).`
    );
  }

  const matches = fieldMetadata.filter(
    (field) =>
      field &&
      typeof field.name === 'string' &&
      field.name.trim().toLowerCase() === fieldName.trim().toLowerCase()
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

  const fieldType = matches[0].schema?.custom;
  const valueBuilder = fieldType && CONDITION_FIELD_VALUE_BUILDERS[fieldType];
  if (!valueBuilder) {
    throw new Error(
      `Field "${fieldName}" has type "${fieldType || matches[0].schema?.type || 'unknown'}", ` +
        'which is not on the verified list for jira.issue.condition (currently: single-select fields only).'
    );
  }

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
  // it does not.
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
  const conditionContainerId = randomUUID();

  // Builds one condition component for the branch whose if.block has id
  // `conditionBlockId`. The id is per branch: a condition pointing at another
  // branch's block looks right in the payload and misbehaves in Jira.
  const buildCondition = (condition, conditionBlockId) => {
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
      conditionParentId: conditionBlockId,
      schemaVersion:
        condition.schemaVersion || CONDITION_SCHEMA_VERSIONS[condition.type] || 1,
    });
  };

  // Builds one action component whose parent is `parentId` (the branch's
  // if.block id, or null for a rule with no conditions).
  const buildAction = (action, parentId) => {
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

    // OPTIONAL on purpose: some actions take an empty value (for example
    // jira.issue.refresh.issue). Actions that need keys are checked next by
    // assertVerifiedComponentValue, which throws and names the missing key.
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
        // OPTIONAL on purpose: matches the confirmed working rule's value, and
        // "set a field" with no word about e-mail means Jira's normal behaviour.
        // Explicit `false` in the spec opts out; anything else (including omitted) keeps this default.
        sendNotifications: value.sendNotifications !== false,
      };
    }

    assertVerifiedComponentValue('action', action.type, value);

    // With no conditions there is no if-block to hang actions off, so they sit
    // at the top of `components` with a null parent. Both shapes are accepted
    // by the API; this one matches what the Automation UI produces for a rule
    // that has no conditions.
    return component('ACTION', action.type, value, {
      parentId,
      schemaVersion: action.schemaVersion || ACTION_SCHEMA_VERSIONS[action.type] || 1,
    });
  };

  // One code path: the flat conditions + actions input is treated as a single
  // branch (see normalizeBranches).
  const branches = normalizeBranches(spec);

  let components;
  const onlyBranch = branches[0];
  if (branches.length === 1 && onlyBranch.conditions.length === 0) {
    // No conditions means no if-block to hang actions off, so they sit at the
    // top of `components` with a null parent. Both shapes are accepted by the
    // API; this one matches what the Automation UI produces for a rule that
    // has no conditions.
    if (onlyBranch.actions.length === 0) {
      throw new Error('Provide at least one condition or action.');
    }
    components = onlyBranch.actions.map((action) => buildAction(action, null));
  } else {
    // One if.block per branch, in the order given, all inside ONE container.
    // An empty-conditions block is the ELSE (validated last by normalizeBranches).
    const conditionBlocks = branches.map((branch) => {
      const conditionBlockId = randomUUID();
      const conditionBlock = component('CONDITION_BLOCK', 'jira.condition.if.block', {
        conditionMatchType: branch.conditionMatchType,
      }, { id: conditionBlockId, parentId: conditionContainerId });
      conditionBlock.conditions = branch.conditions.map((condition) =>
        buildCondition(condition, conditionBlockId)
      );
      conditionBlock.children = branch.actions.map((action) =>
        buildAction(action, conditionBlockId)
      );
      return conditionBlock;
    });

    const conditionContainer = component('CONDITION', 'jira.condition.container.block', {}, {
      id: conditionContainerId,
    });
    conditionContainer.children = conditionBlocks;

    components = [conditionContainer];
  }

  return {
    rule: {
      name,
      state: 'DISABLED',
      // OPTIONAL on purpose: a description is documentation for the human who
      // enables the rule and changes what the rule does in no way.
      description: typeof spec.description === 'string' ? spec.description : '',
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
        conditions: [],
        id: triggerId,
      },
      components,
      ruleScopeARIs: [scope],
      // OPTIONAL on purpose: labels only tag the rule in the Automation UI.
      labels: Array.isArray(spec.labels) ? spec.labels : [],
      writeAccessType: 'UNRESTRICTED',
      collaborators: [],
    },
  };
}

/**
 * Turn the ruleSpec's condition logic into one list of branches.
 *
 * The flat `conditions` + `actions` input means a single branch, so there is
 * one build path. A `branches` array expresses if / else-if / else: each entry
 * has its own conditions, actions and conditionMatchType (default ALL), and an
 * entry with EMPTY conditions is the ELSE, which always matches.
 */
function normalizeBranches(spec) {
  const hasBranches = spec.branches !== undefined;

  if (!hasBranches) {
    return [{
      conditions: spec.conditions || [],
      actions: spec.actions || [],
      conditionMatchType: checkMatchType(spec.conditionMatchType),
    }];
  }

  // Both at once has no obvious meaning, and silently dropping one is how a
  // rule ends up missing half its logic.
  if (spec.conditions !== undefined || spec.actions !== undefined ||
      spec.conditionMatchType !== undefined) {
    throw new Error(
      'Send EITHER "branches" OR top-level "conditions"/"actions"/"conditionMatchType", not both. ' +
        'Put every condition and action inside a branch.'
    );
  }
  if (!Array.isArray(spec.branches) || spec.branches.length === 0) {
    throw new Error('branches must be a non-empty array of { conditions, actions } entries.');
  }

  const lastIndex = spec.branches.length - 1;
  return spec.branches.map((branch, index) => {
    const label = `branches[${index}]`;
    if (!branch || typeof branch !== 'object' || Array.isArray(branch)) {
      throw new Error(`${label} must be an object with conditions and actions.`);
    }
    const conditions = branch.conditions ?? [];
    const actions = branch.actions ?? [];
    if (!Array.isArray(conditions) || !Array.isArray(actions)) {
      throw new Error(`${label}: conditions and actions must be arrays.`);
    }
    if (actions.length === 0) {
      throw new Error(`${label} has no actions, so it would do nothing. Give it at least one action.`);
    }
    // A branch with no conditions always matches, so it is the else. Anywhere
    // but last, every branch after it could never run.
    if (conditions.length === 0 && index !== lastIndex) {
      throw new Error(
        `${label} has no conditions, so it always matches and branches after it would be ` +
          'unreachable. Only the LAST branch may have empty conditions (the else), and there ' +
          'can be only one.'
      );
    }
    return { conditions, actions, conditionMatchType: checkMatchType(branch.conditionMatchType) };
  });
}

function checkMatchType(value) {
  // OPTIONAL on purpose: ALL is the Automation UI's own default for a
  // condition block, and a single condition reads the same either way.
  const conditionMatchType = value || 'ALL';
  if (!ALLOWED_MATCH_TYPES.includes(conditionMatchType)) {
    throw new Error(`conditionMatchType must be one of ${ALLOWED_MATCH_TYPES.join(', ')}.`);
  }
  return conditionMatchType;
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
    } else {
      out[key] = redactSecrets(entry);
    }
  }
  return out;
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
  walkComponents,
  failure,
  safeStringify,
  buildRulePayload,
  ALLOWED_TRIGGER_TYPES,
  ALLOWED_ACTION_TYPES,
  ALLOWED_CONDITION_TYPES,
};
