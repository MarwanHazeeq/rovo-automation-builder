// Finds real examples of automation components in the rules that already
// exist on the site, so new types can be added to src/component-library.js
// without building a throwaway rule first.
//
// Usage (Node 22+, reads credentials from the local, git-ignored .env):
//   node --env-file=.env scripts/find-component-examples.js <componentType> [--field <text>]
//   node --env-file=.env scripts/find-component-examples.js --survey > survey.json
//
// The first form prints up to 3 examples of one type. The second scans EVERY
// rule and reports which component types and field types are in use, marking
// the ones this app does not support yet (summary on stderr, JSON report of
// the unsupported ones on stdout - redirect it outside the repo).
//
// .env needs AUTOMATION_API_EMAIL, AUTOMATION_API_TOKEN and JIRA_CLOUD_ID.
// This is a local developer tool: it is not part of the Forge app and is
// never deployed. It only READS rules (GET); it never creates or edits one.
//
// Only individual components are printed, never whole rules: other teams'
// rules can hold webhook URLs and tokens. The API is asked to redact sensitive
// fields, and the app's own redactSecrets() runs on top as a second layer.

import { pathToFileURL } from 'node:url';
import {
  redactSecrets,
  walkComponents,
  CONDITION_FIELD_VALUE_BUILDERS,
  VERIFIED_SYSTEM_CONDITION_FIELDS,
  EDIT_OPERATION_VALUE_BUILDERS,
  SYSTEM_EDIT_OPERATION_BUILDERS,
  FLOAT_CUSTOM_FIELD_TYPE,
} from '../src/index.js';
import {
  TRIGGER_LIBRARY,
  ACTION_LIBRARY,
  CONDITION_LIBRARY,
  STRUCTURAL_LIBRARY,
} from '../src/component-library.js';

const AUTOMATION_API_BASE = 'https://api.atlassian.com/automation/public/jira';

// Stop once this many examples are found: one verified shape is enough, a few
// show whether the shape varies. Avoids fetching every rule on a large site.
const MAX_MATCHES = 3;

// Every component type the library has a verified shape for.
const KNOWN_COMPONENT_TYPES = new Set([
  ...Object.keys(TRIGGER_LIBRARY),
  ...Object.keys(ACTION_LIBRARY),
  ...Object.keys(CONDITION_LIBRARY),
  ...Object.keys(STRUCTURAL_LIBRARY),
]);

// The trigger is a component too, and the UI hangs trigger-level conditions
// off it, which walkComponents follows via `conditions`.
function ruleRoots(rule) {
  return [rule?.trigger, ...(Array.isArray(rule?.components) ? rule.components : [])];
}

/**
 * Returns the components of `rule` (trigger included) whose type is
 * `componentType`, optionally narrowed to those whose value mentions
 * `fieldText` anywhere (case-insensitive).
 *
 * shortcut: --field is a plain substring match on the value's JSON, so
 * "priority" also matches a value that merely mentions priority in a JQL
 * string; read the printed value before trusting it.
 */
export function findMatches(rule, componentType, fieldText) {
  const matches = [];
  const needle = fieldText ? fieldText.toLowerCase() : null;
  walkComponents(ruleRoots(rule), (node) => {
    if (node.type !== componentType) return;
    if (needle && !JSON.stringify(node.value ?? null).toLowerCase().includes(needle)) return;
    matches.push({ type: node.type, schemaVersion: node.schemaVersion, value: node.value });
  });
  return matches;
}

/**
 * Adds one rule's components to `tally` (a Map of key -> entry). The key is
 * the component type, plus "type / fieldType" sub-keys for the two components
 * whose support depends on the field: jira.issue.condition (selectedFieldType)
 * and jira.issue.edit (each operation's fieldType). Each entry keeps a count,
 * the set of rule uuids it appears in, and the FIRST example seen.
 */
export function surveyRule(rule, ruleRef, tally) {
  const record = (key, example) => {
    let entry = tally.get(key);
    if (!entry) {
      entry = { count: 0, rules: new Set(), example: redactSecrets(example), source: ruleRef };
      tally.set(key, entry);
    }
    entry.count += 1;
    entry.rules.add(ruleRef.uuid);
  };

  walkComponents(ruleRoots(rule), (node) => {
    if (typeof node.type !== 'string') return;
    record(node.type, { type: node.type, schemaVersion: node.schemaVersion, value: node.value });

    if (node.type === 'jira.issue.condition' && node.value?.selectedFieldType) {
      record(`jira.issue.condition / ${node.value.selectedFieldType}`, node.value);
    }
    if (node.type === 'jira.issue.edit' && Array.isArray(node.value?.operations)) {
      for (const operation of node.value.operations) {
        if (operation?.fieldType) record(`jira.issue.edit / ${operation.fieldType}`, operation);
      }
    }
  });
}

/** True when the app can already build the component or field type in `key`. */
export function isSupported(key) {
  const [type, fieldType] = key.split(' / ');
  if (fieldType === undefined) return KNOWN_COMPONENT_TYPES.has(type);
  if (type === 'jira.issue.condition') {
    return fieldType in CONDITION_FIELD_VALUE_BUILDERS || VERIFIED_SYSTEM_CONDITION_FIELDS.includes(fieldType);
  }
  // Float edits are supported, but built as advancedFields rather than operations.
  return fieldType in EDIT_OPERATION_VALUE_BUILDERS || fieldType in SYSTEM_EDIT_OPERATION_BUILDERS ||
    fieldType === FLOAT_CUSTOM_FIELD_TYPE;
}

/**
 * GET a JSON resource from the Automation API with Basic Auth. Retries on
 * 429 (rate limited) after the server's Retry-After delay, because a site
 * with hundreds of rules can hit the limit partway through a scan.
 */
async function getJson(url, auth) {
  for (let attempt = 1; ; attempt += 1) {
    const response = await fetch(url, {
      headers: { Authorization: `Basic ${auth}`, Accept: 'application/json' },
    });
    if (response.status === 429 && attempt < 5) {
      const waitSeconds = Number(response.headers.get('retry-after')) || 5;
      console.error(`Rate limited; waiting ${waitSeconds}s...`);
      await new Promise((resolve) => setTimeout(resolve, waitSeconds * 1000));
      continue;
    }
    if (!response.ok) {
      // The body is not echoed: an error page could repeat request details.
      throw new Error(`GET ${url} failed with HTTP ${response.status}.`);
    }
    return response.json();
  }
}

/**
 * Pages through every rule summary and fetches each rule (redacted by the
 * API). `visit(summary, rule)` returns true to stop early. `links.next`
 * carries the next cursor as a query string (or URL); absent on the last page.
 * Returns the number of rules visited.
 */
async function forEachRule(auth, base, visit) {
  let cursor = null;
  let scanned = 0;
  do {
    const listUrl = `${base}/summary?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
    const page = await getJson(listUrl, auth);
    for (const summary of page.data ?? []) {
      scanned += 1;
      const detail = await getJson(`${base}/${encodeURIComponent(summary.uuid)}?redactSensitiveFields=true`, auth);
      if (visit(summary, detail.rule)) return scanned;
    }
    const next = page.links?.next;
    cursor = next ? new URL(next, 'https://placeholder.invalid').searchParams.get('cursor') : null;
  } while (cursor);
  return scanned;
}

async function findExamples(auth, base, componentType, fieldText) {
  let found = 0;
  const scanned = await forEachRule(auth, base, (summary, rule) => {
    for (const match of findMatches(rule, componentType, fieldText)) {
      found += 1;
      console.log(`\n--- Example ${found}: rule "${summary.name}" (uuid ${summary.uuid}, ${summary.state})`);
      console.log(JSON.stringify(redactSecrets(match), null, 2));
      if (found >= MAX_MATCHES) return true;
    }
    return false;
  });

  console.error(`\nScanned ${scanned} rule(s); found ${found} example(s) of ${componentType}${fieldText ? ` mentioning "${fieldText}"` : ''}.`);
  if (found === 0) {
    console.error('No existing rule uses it: build one throwaway rule in the UI (see HOW TO ADD in src/component-library.js).');
  }
}

async function survey(auth, base) {
  const tally = new Map();
  const scanned = await forEachRule(auth, base, (summary, rule) => {
    surveyRule(rule, { name: summary.name, uuid: summary.uuid, state: summary.state }, tally);
    return false;
  });

  const rows = [...tally.entries()]
    .map(([key, entry]) => ({ key, ...entry, supported: isSupported(key) }))
    .sort((a, b) => Number(a.supported) - Number(b.supported) || b.rules.size - a.rules.size);

  console.error(`\nScanned ${scanned} rule(s). Unsupported first, then by number of rules using it.\n`);
  console.error(`${'supported'.padEnd(10)}${'rules'.padStart(6)}${'uses'.padStart(6)}  key`);
  for (const row of rows) {
    console.error(`${(row.supported ? 'yes' : 'NO').padEnd(10)}${String(row.rules.size).padStart(6)}${String(row.count).padStart(6)}  ${row.key}`);
  }

  const report = rows
    .filter((row) => !row.supported)
    .map(({ key, count, rules, example, source }) => ({ key, rules: rules.size, uses: count, source, example }));
  console.log(JSON.stringify(report, null, 2));
}

async function main(argv) {
  const surveyMode = argv[0] === '--survey';
  const [componentType, ...rest] = argv;
  const fieldIndex = rest.indexOf('--field');
  const fieldText = fieldIndex >= 0 ? rest[fieldIndex + 1] : null;
  if (!surveyMode && (!componentType || (fieldIndex >= 0 && !fieldText))) {
    console.error('Usage: node --env-file=.env scripts/find-component-examples.js <componentType> [--field <text>]');
    console.error('       node --env-file=.env scripts/find-component-examples.js --survey > survey.json');
    process.exitCode = 1;
    return;
  }

  const { AUTOMATION_API_EMAIL: email, AUTOMATION_API_TOKEN: token, JIRA_CLOUD_ID: cloudId } = process.env;
  if (!email || !token || !cloudId) {
    console.error('Missing AUTOMATION_API_EMAIL, AUTOMATION_API_TOKEN or JIRA_CLOUD_ID. Add them to .env and run with --env-file=.env.');
    process.exitCode = 1;
    return;
  }

  const auth = Buffer.from(`${email}:${token}`).toString('base64');
  const base = `${AUTOMATION_API_BASE}/${encodeURIComponent(cloudId)}/rest/v1/rule`;
  if (surveyMode) {
    await survey(auth, base);
  } else {
    await findExamples(auth, base, componentType, fieldText);
  }
}

// Run only when executed directly, so tests can import the helpers.
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
