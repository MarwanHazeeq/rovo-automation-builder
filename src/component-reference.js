import {
  TRIGGER_LIBRARY,
  ACTION_LIBRARY,
  CONDITION_LIBRARY,
  STRUCTURAL_LIBRARY,
  VERIFIED_SMART_VALUES,
} from './component-library.js';

// Atlassian publishes no schema for automation component `value` objects; per
// their own support answer, "the component identifier must be obtained by
// exporting an existing rule". This tool serves the shapes captured that way,
// so the agent looks a shape up instead of inventing one.

const LIBRARIES = {
  trigger: TRIGGER_LIBRARY,
  action: ACTION_LIBRARY,
  condition: CONDITION_LIBRARY,
  structural: STRUCTURAL_LIBRARY,
};

const KINDS = Object.keys(LIBRARIES);

// Returned with every index response. The agent cannot read these constraints
// off a value shape, and each one is a rule it would otherwise break.
const USAGE_NOTES = [
  'Design the rule from the request and the shapes here. You do not need an existing rule, or an ' +
    'earlier approval ticket, that does the same thing: combine these components into whatever the ' +
    'request needs.',
  'These are component `value` OBJECT shapes. The smart-value expressions that go inside a ' +
    'value -- a log message, a variable query, a field value -- are free text and are not ' +
    'described here. Do not refuse to use a smart value because it is absent from this reference.',
  'An entry marked verified: false has no confirmed export on this tenant. Do not build with it; ' +
    'say it is unverified and stop.',
  'A rule supports several condition branches through `branches`; the last branch with empty ' +
    'conditions is the else. Different outcomes for different cases are ONE rule, not several. ' +
    'Steps that always run before the branches go in top-level `actions` next to `branches`; a ' +
    'branch can hold nested `branches`. Setup then branching is still ONE rule: see workedExample ' +
    'on jira.condition.container.block.',
  'A check that must hold for the WHOLE rule, setup actions included, goes in `trigger.conditions` ' +
    '(an array of ordinary conditions, next to the trigger `type`), not in a branch. Every one must ' +
    'pass; there is no ALL/ANY choice there, so do not send conditionMatchType for them.',
  'There is no iteration component. Per issue, use the jira.jql.scheduled trigger. Per list item, ' +
    'use {{#list}}...{{/}} inside a jira.create.variable step.',
  'Read a web-request response as {{webhookResponse.*}} or {{webResponse.*}}; when a spec names one, ' +
    'keep it exactly as written. A second request ' +
    'in the same rule overwrites it.',
];

function isVerified(entry) {
  // The only unverified marker in the library is an explicit unverifiedGuess
  // alongside a null example.
  return !(entry && entry.example === null && entry.unverifiedGuess);
}

// `source` (which rule export a shape came from) is for maintainers. Served
// to the agent, it reads as a lead: it searched the site for a cited rule and
// read an old approval ticket instead of designing from the request.
// Only STRING sources are provenance: some real Jira shapes have their own
// `source` key (jira.issue.condition's compareValue.source: null), kept as is.
function withoutSources(value) {
  if (Array.isArray(value)) return value.map(withoutSources);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key, inner]) => !(key === 'source' && typeof inner === 'string'))
      .map(([key, inner]) => [key, withoutSources(inner)])
  );
}

function summarise(type, entry) {
  return {
    type,
    description: entry.description,
    verified: isVerified(entry),
  };
}

function detail(kind, type, entry) {
  const out = {
    kind,
    type,
    schemaVersion: entry.schemaVersion,
    description: entry.description,
    verified: isVerified(entry),
  };
  for (const key of [
    'example',
    'workedExample',
    'builtInternally',
    'verifiedOperators',
    'verifiedMatchTypes',
    'notes',
  ]) {
    if (entry[key] !== undefined) out[key] = withoutSources(entry[key]);
  }
  if (!out.verified) {
    out.unverifiedGuess = entry.unverifiedGuess;
    out.warning =
      'No confirmed export exists for this type on this tenant. The guess above is adapted from ' +
      'a different tenant and schema version. Do not build with it.';
  }
  return out;
}

function findByType(componentType) {
  for (const kind of KINDS) {
    const entry = LIBRARIES[kind][componentType];
    if (entry) return { kind, entry };
  }
  return null;
}

/**
 * get-component-reference.
 *
 * No arguments        -> an index of every supported type, by kind, plus the
 *                        usage notes above.
 * componentType       -> the full verified shape for one type.
 * kind                -> every shape for one kind.
 * smartValues: true   -> the verified smart-value expressions.
 */
export async function getComponentReference(payload = {}) {
  const input = payload || {};
  const componentType =
    typeof input.componentType === 'string' ? input.componentType.trim() : '';
  const kind = typeof input.kind === 'string' ? input.kind.trim().toLowerCase() : '';
  const wantsSmartValues = input.smartValues === true || input.smartValues === 'true';

  if (componentType) {
    const found = findByType(componentType);
    if (!found) {
      // Name the near misses rather than just failing: a wrong type string is
      // usually a near miss, and the agent cannot list the allowlist itself.
      const all = KINDS.flatMap((k) => Object.keys(LIBRARIES[k]));
      const needle = componentType.toLowerCase();
      const close = all.filter(
        (t) => t.toLowerCase().includes(needle) || needle.includes(t.toLowerCase())
      );
      return {
        ok: false,
        error: `"${componentType}" is not a supported component type.`,
        didYouMean: close.length > 0 ? close : undefined,
        supportedTypes: close.length > 0 ? undefined : all,
      };
    }
    return { ok: true, ...detail(found.kind, componentType, found.entry) };
  }

  if (kind) {
    if (!LIBRARIES[kind]) {
      return { ok: false, error: `kind must be one of: ${KINDS.join(', ')}.` };
    }
    const library = LIBRARIES[kind];
    return {
      ok: true,
      kind,
      components: Object.keys(library).map((type) => detail(kind, type, library[type])),
    };
  }

  if (wantsSmartValues) {
    return { ok: true, smartValues: withoutSources(VERIFIED_SMART_VALUES) };
  }

  return {
    ok: true,
    usageNotes: USAGE_NOTES,
    kinds: Object.fromEntries(
      KINDS.map((k) => [
        k,
        Object.keys(LIBRARIES[k]).map((type) => summarise(type, LIBRARIES[k][type])),
      ])
    ),
    smartValueTopics: Object.keys(VERIFIED_SMART_VALUES),
    next:
      'Call again with componentType set to one of the types above for its full value shape, ' +
      'with kind set to return every shape of one kind, or with smartValues true for the ' +
      'verified smart-value expressions.',
  };
}
