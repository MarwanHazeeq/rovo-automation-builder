import { parseHttpUrl, redactUrl, walkComponents } from './index.js';
import { AMBIGUOUS_REQUEST, describeText } from './smart-values.js';

/**
 * A built rule, described in plain technical English for the approver.
 *
 * The Automation API names every component by an internal type string such as
 * "jira.condition.container.block". Nobody reviewing a rule should need to
 * know those, so this module turns each component into a sentence ("Set
 * Escalated to Customer to Yes") and the rule into numbered steps that keep
 * the if/else nesting. The draft comment and the ticket description both
 * render from here, so the two can never disagree.
 *
 * Everything is read from the frozen rule object, never from text the agent
 * wrote. Smart values ({{...}}) are put into words by smart-values.js. Header
 * values are never shown, URLs go through redactUrl, and long text is cut
 * short: the attached JSON is the full record.
 *
 * Every phrase takes a context `ctx` (see smart-values.js) so the words can
 * name custom fields, rule variables and the web request whose response is
 * live at that step.
 */

// Long free text (comments, log lines, JQL) is cut here; the attachment has it all.
// Room for a translated smart value or two, which is longer than its {{...}}.
const MAX_TEXT = 160;

const clip = (value) => {
  const flat = String(value ?? '').replace(/\s+/g, ' ').trim();
  return flat.length > MAX_TEXT ? `${flat.slice(0, MAX_TEXT - 1)}…` : flat;
};

/** Rule text with its smart values in words: a lone value unquoted, literal text in quotes. */
function shown(value, ctx) {
  const { text, onlyValue } = describeText(value, ctx);
  return onlyValue ? clip(text) : `"${clip(text)}"`;
}

/** The same, never quoted: for operands and field values inside a sentence. */
const said = (value, ctx) => clip(describeText(value, ctx).text);

// A variable whose name says it holds a credential is shown without its value,
// unless that value is a smart value or a stand-in: a literal is the one place
// a real secret could sit, and the accessor in a smart value is worth seeing.
const SECRET_NAME = /token|secret|password|api.?key/i;
const NOT_A_LITERAL = /{{|^<[^<>]+>$/;

/**
 * One value from a component, as a reader would say it:
 *   "Yes"                          -> Yes
 *   "{{issue.key}}"                -> the work item key
 *   { type: 'NAME', value: 'P1' }  -> P1
 *   { type: 'ID', value: '2' }     -> ID 2
 *   { type: 'COPY', ... }          -> the same value as the trigger work item
 *   [a, b]                         -> a, b
 */
function plainValue(value, ctx = {}) {
  if (Array.isArray(value)) return value.map((entry) => plainValue(entry, ctx)).join(', ') || 'nothing';
  if (value && typeof value === 'object') {
    if (value.type === 'COPY') return 'the same value as the trigger work item';
    if (value.type === 'ID') return `ID ${value.value}`;
    return plainValue(value.value, ctx);
  }
  if (value === '' || value === null || value === undefined) return 'empty';
  return said(value, ctx);
}

/** "Set labels to suspicious-activity", from one edit/transition/create operation. */
function describeOperation(op, ctx) {
  const field = op?.field?.value ?? 'a field';
  if (field === 'attachment' && op?.type === 'COPY') return 'copy the attachments from the trigger work item';
  if (op?.type === 'ADD') return `add ${plainValue(op.value, ctx)} to ${field}`;
  if (op?.type === 'REMOVE') return `remove ${plainValue(op.value, ctx)} from ${field}`;
  return `set ${field} to ${plainValue(op?.value, ctx)}`;
}

/**
 * The fields an edit-style value changes: its operations, plus any number
 * fields written through advancedFields (a JSON-shaped string keyed by field ID).
 */
function describeFieldChanges(value, ctx = {}) {
  const parts = (Array.isArray(value?.operations) ? value.operations : []).map((op) => describeOperation(op, ctx));
  const advanced = typeof value?.advancedFields === 'string' ? value.advancedFields : '';
  for (const [, fieldId] of advanced.matchAll(/"(customfield_\d+)"\s*:/g)) {
    parts.push(`set ${ctx.fieldNames?.[fieldId] ?? fieldId} to a calculated value`);
  }
  return parts;
}

const capitalise = (sentence) => sentence.charAt(0).toUpperCase() + sentence.slice(1);
const joinAnd = (parts) => parts.join(', and ');

// "operator" names in a comparison, as words.
const OPERATORS = {
  EQUALS: 'equals',
  NOT_EQUALS: 'does not equal',
  GREATER_THAN: 'is greater than',
  LESS_THAN: 'is less than',
  STARTS_WITH: 'starts with',
  CONTAINS: 'contains',
};
const operatorWords = (operator) => OPERATORS[operator] ?? String(operator ?? 'equals').toLowerCase().replace(/_/g, ' ');

/** Where a create/clone action puts the new work item, or null when it sets no project. */
export function issueTarget(node) {
  const projectOperation = (node?.value?.operations ?? []).find((op) => op?.field?.value === 'project');
  const target = projectOperation?.value;
  if (target?.type === 'ID') return { projectId: String(target.value) };
  if (target?.type === 'COPY') return { sameAsTrigger: true };
  return null;
}

/** "in project 10284, OUTSIDE this rule's project 10086", for create/clone. */
export function describeIssueTarget(target, scopeProjectId) {
  if (!target) return 'in a project the draft does not set (Jira decides; check the attached payload)';
  if (target.sameAsTrigger) return 'in the same project as the trigger work item';
  return target.projectId === scopeProjectId
    ? `in project ${target.projectId} (this rule's project)`
    : `in project ${target.projectId}, OUTSIDE this rule's project ${scopeProjectId}`;
}

// "weekly on MO at 9:00 (Asia/Singapore)", read from the iCal rRule the builder writes.
function describeSchedule(schedule) {
  const rRule = String(schedule?.rRule ?? '');
  const part = (name) => new RegExp(`${name}=([^;\\n]+)`).exec(rRule)?.[1];
  const frequency = (part('FREQ') ?? 'scheduled').toLowerCase();
  const days = part('BYDAY');
  const hour = part('BYHOUR');
  const minute = part('BYMINUTE') ?? '0';
  const zone = /TZID=([^:;\n]+)/.exec(rRule)?.[1];
  return [
    frequency,
    days ? `on ${days}` : null,
    hour !== undefined ? `at ${hour}:${String(minute).padStart(2, '0')}` : null,
    zone ? `(${zone})` : null,
  ].filter(Boolean).join(' ');
}

const statusList = (refs) => (Array.isArray(refs) ? refs : []).map((ref) => plainValue(ref)).join(' or ');

/**
 * Trigger phrases: `(value, where, ctx)` -> the "When ..." sentence, where
 * `where` is the project wording ("SOCDemo (ID 10086)").
 */
const TRIGGER_PHRASES = {
  'jira.issue.event.trigger:created': (v, where) => `When a work item is created in ${where}`,
  'jira.issue.event.trigger:transitioned': (v, where) => {
    const from = statusList(v?.fromStatus);
    const to = statusList(v?.toStatus);
    const move = from && to ? `moves from ${from} to ${to}` : to ? `moves to ${to}` : from ? `moves out of ${from}` : 'changes status';
    return `When a work item in ${where} ${move}`;
  },
  'jira.issue.field.changed': (v, where) =>
    `When ${(Array.isArray(v?.fields) ? v.fields : []).map((field) => plainValue(field)).join(' or ') || 'a field'} changes on a work item in ${where}`,
  'jira.jql.scheduled': (v, where, ctx) =>
    `On a schedule (${describeSchedule(v?.schedule)}) in ${where}, for each work item matching ${shown(v?.jql, ctx)}`,
  'jira.issue.event.trigger:commented': (v, where) => `When a comment is added to a work item in ${where}`,
  'jira.issue.event.trigger:updated': (v, where) => `When a work item in ${where} is edited`,
  'jira.issue.event.trigger:assigned': (v, where) => `When a work item in ${where} is assigned`,
  'jira.issue.event.trigger:deleted': (v, where) => `When a work item in ${where} is deleted`,
  'jira.issue.event.trigger:moved': (v, where) => {
    // "-1999" means any project in the exports this was captured from.
    const project = (id) => (id && String(id) !== '-1999' ? `project ${id}` : 'any project');
    return `When a work item is moved from ${project(v?.sourceProject)} to ${project(v?.targetProject)} (rule project ${where})`;
  },
  'jira.sla.threshold.trigger': (v, where, ctx) =>
    `When the SLA in ${ctx.fieldNames?.[v?.customFieldId] ?? v?.customFieldId ?? 'an SLA field'} will breach within ` +
    `${Math.round(Number(v?.thresholdValue) / 60000)} minutes on a work item in ${where}`,
  'devops.deploy.event.trigger:statechange': (v, where) =>
    `When a linked deployment to ${plainValue(v?.environments)} becomes ${(Array.isArray(v?.states) ? v.states : []).join(', ')} (in ${where})`,
  'jira.incoming.webhook': (v, where) => `When an external system calls this rule's incoming webhook (in ${where})`,
};

/** Condition phrases: `(value, ctx)` -> "priority equals ID 2". */
const CONDITION_PHRASES = {
  'jira.comparator.condition': (v, ctx) => {
    if (v?.second === '' && v?.operator === 'NOT_EQUALS') return `${said(v.first, ctx)} is not empty`;
    if (v?.second === '' && v?.operator === 'EQUALS') return `${said(v.first, ctx)} is empty`;
    return `${said(v?.first, ctx)} ${operatorWords(v?.operator)} ${plainValue(v?.second, ctx)}`;
  },
  'jira.issue.condition': (v, ctx) =>
    `${plainValue(v?.selectedField, ctx)} ${operatorWords(v?.comparison)} ${plainValue(v?.compareValue, ctx)}`,
  'jira.jql.condition': (v, ctx) => `the work item matches ${shown(v, ctx)}`,
  'jira.user.condition': (v) =>
    (Array.isArray(v?.conditions) ? v.conditions : [])
      .map((c) => `the ${c?.field ?? 'user'} ${c?.check === 'IN_ROLE' ? 'is in role' : operatorWords(c?.check)} ${plainValue(c?.criteria)}`)
      .join(v?.operator === 'OR' ? ' or ' : ' and '),
  'jira.affected.services.condition': (v) =>
    `an affected service's ${v?.selectedAttribute ?? 'attribute'} ${operatorWords(v?.selectedComparison)} ${plainValue(v?.compareValue)}`,
};

/** Action phrases: `(value, ctx)` -> "Send a POST web request to ...". */
const ACTION_PHRASES = {
  'jira.create.variable': (v, ctx) => {
    const name = plainValue(v?.name);
    const query = String(v?.query?.value ?? '');
    const hidden = SECRET_NAME.test(name) && !NOT_A_LITERAL.test(query.trim());
    return `Create variable ${name} = ${hidden ? '[redacted]' : shown(query, ctx)}`;
  },
  'jira.create.mapping-variable': (v) =>
    `Create lookup table ${plainValue(v?.name)} (${(Array.isArray(v?.mappings) ? v.mappings : []).length} entries)`,
  'codebarrel.action.log': (v, ctx) => `Write to the audit log: ${shown(v, ctx)}`,
  'jira.issue.outgoing.webhook': (v, ctx) =>
    `Send a ${String(v?.method ?? 'GET').toUpperCase()} web request to ${said(redactUrl(String(v?.url ?? '')), ctx)}`,
  'action.wait.for.time.duration': (v) => `Wait ${v?.waitTimeInSeconds ?? '?'} seconds`,
  'jira.issue.transition': (v, ctx) => {
    const changes = describeFieldChanges(v, ctx);
    const move = `Move the work item to ${plainValue(v?.destinationStatus)}`;
    return changes.length ? `${move}, and ${joinAnd(changes)}` : move;
  },
  'jira.issue.edit': (v, ctx) => capitalise(joinAnd(describeFieldChanges(v, ctx)) || 'edit the work item'),
  'jira.set.entity.property': (v) => `Store data in the ${String(v?.entityType ?? 'issue').toLowerCase()} property ${v?.key}`,
  'jira.issue.refresh.issue': () => "Reload the work item's fields",
  'jira.issue.comment': (v, ctx) => `Add ${v?.publicComment ? 'a public' : 'an internal'} comment: ${shown(v?.comment, ctx)}`,
  'jira.issue.assign': (v) => `Assign the work item to user ${plainValue(v?.assignee)}`,
  'jira.issue.outgoing.email': (v, ctx) => `Send an email to ${plainValue(v?.to)} with subject ${shown(v?.subject, ctx)}`,
  'jira.auto.approve.action': () => 'Approve the pending approval on the work item (this skips a human approval)',
  'rovo.invoke-agent.action': (v, ctx) => `Ask the Rovo agent ${v?.agentDisplayName ?? v?.agentId} to: ${shown(v?.agentInstruction, ctx)}`,
  'jira.issue.related': (v, ctx) => `For each work item matching ${shown(v?.jql, ctx)}:`,
  'jira.lookup.issues': (v, ctx) => `Look up work items matching ${shown(v?.query?.value, ctx)} into ${plainValue(v?.name)}`,
  'jira.edit.request.type': (v) => `Change the request type to ${plainValue(v?.requestType)}`,
  'jira.proforma.form.add.action': (v) =>
    `Attach form template ${plainValue(v?.templateFormsConfig?.templateFormIds)} to the work item (${v?.formVisibility ?? 'internal'})`,
  'jira.issue.create': (v, ctx) => {
    const rest = describeFieldChanges(v, ctx).filter((part) => !/^set (project|issuetype) /.test(part));
    return `Create a work item ${describeIssueTarget(issueTarget({ value: v }), ctx.scopeProjectId)}${rest.length ? `: ${joinAnd(rest)}` : ''}`;
  },
  'jira.issue.clone': (v, ctx) =>
    `Clone the work item ${describeIssueTarget(issueTarget({ value: v }), ctx.scopeProjectId)}`,
};

/** Every type this module can describe, for the contract test. */
export const DESCRIBED_TYPES = Object.freeze({
  triggers: Object.keys(TRIGGER_PHRASES),
  conditions: Object.keys(CONDITION_PHRASES),
  actions: Object.keys(ACTION_PHRASES),
});

// Validation refuses unknown types before a draft exists, so this only shows if
// a type was allowed without a phrase; the contract test stops that.
const UNKNOWN = 'an unsupported step (see the attached payload)';

function describeCondition(node, ctx) {
  const phrase = CONDITION_PHRASES[node?.type];
  return phrase ? phrase(node.value, ctx) : UNKNOWN;
}

function describeConditions(nodes, matchType, ctx) {
  return (Array.isArray(nodes) ? nodes : [])
    .map((node) => describeCondition(node, ctx))
    .join(matchType === 'ANY' ? ' or ' : ' and ');
}

/**
 * The variables a rule creates, by name, so {{AuthToken}} reads as "the value
 * of AuthToken" and {{SiteMap.get(x)}} as a lookup-table entry.
 */
function ruleVariables(rule) {
  const kinds = { 'jira.create.variable': 'variable', 'jira.create.mapping-variable': 'table', 'jira.lookup.issues': 'lookup' };
  const variables = new Map();
  walkComponents(rule?.components, (node) => {
    const name = node.value?.name?.value;
    if (kinds[node.type] && typeof name === 'string') variables.set(name, kinds[node.type]);
  });
  return variables;
}

/**
 * The opening sentence: what starts the rule, in which project, and the
 * checks that must hold before anything runs (trigger conditions).
 */
export function describeTrigger(rule, where, { fieldNames = {} } = {}) {
  const ctx = { fieldNames, variables: ruleVariables(rule), request: null };
  const phrase = TRIGGER_PHRASES[rule?.trigger?.type];
  const opening = phrase ? phrase(rule.trigger.value ?? {}, where, ctx) : `When the rule starts (in ${where})`;
  const checks = describeConditions(rule?.trigger?.conditions, 'ALL', ctx);
  return checks ? `${opening}, if ${checks}:` : `${opening}:`;
}

/**
 * The rule body as numbered steps, in rule order:
 *   [{ number: '1', text, depth: 0, node }, { number: '3.1', text, depth: 1, node }, ...]
 *
 * The if/else group wrapper is structure, not a step: each of its branches
 * becomes one "If ...:" / "Otherwise:" step at the group's own level, and
 * whatever runs inside a branch is numbered beneath it. Setup actions before
 * the group therefore come first, in order. Any depth of nesting works.
 *
 * The walk also tracks which web request's response is live, for smart values
 * such as {{webhookResponse.status}}. A later request overwrites the response,
 * and the branches of a group never run one after another, so each branch
 * starts from the request that was live when the group was entered. After a
 * group (or a lone if-block) in which a request may have been sent, the live
 * response depends on the branch taken, and the words say so.
 */
export function describeSteps(rule, { scopeProjectId = null, fieldNames = {} } = {}) {
  const steps = [];
  const ctx = { scopeProjectId, fieldNames, variables: ruleVariables(rule), request: null };

  // Runs `walk` and reports whether a web request was sent inside it.
  const sentWithin = (walk) => {
    const before = ctx.request;
    walk();
    return ctx.request !== before;
  };

  const visit = (nodes, prefix, depth) => {
    let count = 0;
    const add = (node, text) => {
      count += 1;
      const number = prefix ? `${prefix}.${count}` : String(count);
      steps.push({ number, text, depth, node });
      return number;
    };
    for (const node of Array.isArray(nodes) ? nodes : []) {
      if (!node || typeof node !== 'object') continue;
      if (node.type === 'jira.condition.container.block') {
        // Unwrap: its branches sit at this level, numbered with the steps around
        // them. Only the first matching branch runs, so every later one is an
        // "Otherwise, if" (or a plain "Otherwise" when it has no conditions).
        const branches = Array.isArray(node.children) ? node.children : [];
        const entry = ctx.request;
        let sent = false;
        branches.forEach((branch, index) => {
          ctx.request = entry;
          const conditions = Array.isArray(branch?.conditions) ? branch.conditions : [];
          const test = describeConditions(conditions, branch?.value?.conditionMatchType, ctx);
          const text = !conditions.length ? 'Otherwise:' : index === 0 ? `If ${test}:` : `Otherwise, if ${test}:`;
          const number = add(branch, text);
          if (sentWithin(() => visit(branch?.children, number, depth + 1))) sent = true;
        });
        ctx.request = sent ? AMBIGUOUS_REQUEST : entry;
        continue;
      }
      if (node.type === 'jira.condition.if.block') {
        // A lone if-block (no surrounding group) reads the same way. It may not
        // run at all, so a request inside it leaves the live response uncertain.
        const number = add(node, `If ${describeConditions(node.conditions, node.value?.conditionMatchType, ctx)}:`);
        if (sentWithin(() => visit(node.children, number, depth + 1))) ctx.request = AMBIGUOUS_REQUEST;
        continue;
      }
      let text;
      if (node.component === 'CONDITION') text = `Continue only if ${describeCondition(node, ctx)}`;
      else text = ACTION_PHRASES[node.type]?.(node.value, ctx) ?? UNKNOWN;
      const number = add(node, text);
      // Set AFTER the text: a request's own body reads the previous response.
      if (node.type === 'jira.issue.outgoing.webhook') {
        ctx.request = { number, host: parseHttpUrl(node.value?.url)?.hostname ?? null };
      }
      // A component with its own children (e.g. "for each related work item") nests them.
      if (Array.isArray(node.children) && node.children.length) visit(node.children, number, depth + 1);
    }
  };
  visit(rule?.components, '', 0);
  return steps;
}
