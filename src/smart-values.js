/**
 * Smart values, in plain words.
 *
 * Jira automation reads data through "smart values": template expressions in
 * double braces such as {{issue.attachments.size}} or
 * {{webhookResponse.body.request.id}}. They are code, and the approver of a
 * draft should not have to read code. This module turns each one into what it
 * means ("the number of attachments on the work item", "the request ID from
 * the step 12 response (sdp-host.invalid)").
 *
 * It is a FIXED DICTIONARY, deliberately: the same rule always reads the same
 * way, nothing here comes from text the agent wrote, and every phrase can be
 * tested. The cost is that it cannot know what an external system IS (that
 * step 12 talks to ServiceDesk Plus), so a web request is named by its step
 * number and host instead. Anything the dictionary does not recognise is
 * flagged as a calculated value rather than printed as raw {{...}}: the
 * attached JSON keeps the exact expression for anyone who needs it.
 *
 * The context object `ctx` carries what the words depend on:
 *   fieldNames  { customfield_10300: 'Customer ITSM Incident', ... }
 *   variables   Map of rule variable name -> 'variable' | 'table' | 'lookup'
 *   request     the web request whose response is live at this point:
 *               { number: '12', host: 'sdp-host.invalid' }, AMBIGUOUS_REQUEST,
 *               or null when no request has run yet
 */

/** Marks a point after an if/else group in which some branch sent a request. */
export const AMBIGUOUS_REQUEST = 'ambiguous';

const FALLBACK = 'a calculated value (see the attached JSON)';
const TRANSFORMED = ' (transformed; see the attached JSON)';

// Modifiers that only change the encoding or format, not the meaning.
const ENCODERS = new Set([
  'jsonEncode', 'urlEncode', 'htmlEncode', 'xmlEncode', 'trim', 'abs', 'toDate',
  'jiraDate', 'jiraDateTime', 'shortDate', 'longDateTime', 'asNumber', 'format',
]);
// Trailing parts that pick the display form of a field: "priority.name" is the priority.
const DISPLAY_SUFFIXES = new Set(['name', 'value', 'displayName']);
// How fields of a work item or comment are read out.
const FIELD_WORDS = {
  key: 'key', summary: 'summary', description: 'description', status: 'status', priority: 'priority',
  reporter: 'reporter', assignee: 'assignee', creator: 'creator', created: 'creation time',
  updated: 'last update time', resolution: 'resolution', duedate: 'due date', labels: 'labels',
  issuetype: 'issue type', project: 'project', attachments: 'attachments', comments: 'comments',
  body: 'text', author: 'author', url: 'link',
};
// Units a .diff(...) can be read in.
const DIFF_UNITS = new Set(['millis', 'seconds', 'minutes', 'hours', 'days', 'weeks', 'months', 'years', 'businessDays']);

/** "access_token" -> "access token", "requestId" -> "request ID". */
function words(name) {
  return String(name)
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .split(' ')
    .map((word) => (/^id$/i.test(word) ? 'ID' : word.toLowerCase()))
    .join(' ');
}

/**
 * Split "a.b(c.d).e" into [{ name: 'a' }, { name: 'b', args: 'c.d' }, { name: 'e' }],
 * keeping dots inside parentheses with their call.
 */
function tokenize(path) {
  const tokens = [];
  let current = '';
  let depth = 0;
  for (const char of path) {
    if (char === '(') depth += 1;
    if (char === ')') depth -= 1;
    if (char === '.' && depth === 0) {
      tokens.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  tokens.push(current);
  return tokens.map((token) => {
    const call = /^([\w$]+)\(([\s\S]*)\)$/.exec(token.trim());
    return call ? { name: call[1], args: call[2].trim() } : { name: token.trim() };
  });
}

const untokenize = (tokens) => tokens.map((t) => (t.args === undefined ? t.name : `${t.name}(${t.args})`)).join('.');

/** A call argument, which is a path without braces or a quoted literal. */
function describeArgument(arg, ctx) {
  const literal = /^(["'])(.*)\1$/.exec(arg);
  return literal ? `"${literal[2]}"` : describeSmartValue(arg, ctx);
}

/**
 * The fields of something that has fields (the work item, the comment):
 * "the work item's priority", "the number of attachments on the comment".
 * A custom field reads as its own name, which is how people know it.
 */
function describeOwned(owner, tokens, ctx) {
  let parts = tokens.filter((t) => !ENCODERS.has(t.name));
  let transformed = false;
  const call = parts.findIndex((t) => t.args !== undefined);
  if (call !== -1) {
    transformed = true;
    parts = parts.slice(0, call);
  }
  let count = false;
  if (parts.at(-1)?.name === 'size') {
    count = true;
    parts = parts.slice(0, -1);
  }
  if (parts.length > 1 && DISPLAY_SUFFIXES.has(parts.at(-1).name)) parts = parts.slice(0, -1);

  const suffix = transformed ? TRANSFORMED : '';
  const customField = /^customfield_\d+$/.test(parts[0]?.name ?? '') ? parts[0].name : null;
  if (customField && parts.length === 1 && !count) {
    return `${ctx.fieldNames?.[customField] ?? `custom field ${customField.slice('customfield_'.length)}`}${suffix}`;
  }
  const noun = parts.map(({ name }) =>
    /^customfield_\d+$/.test(name)
      ? ctx.fieldNames?.[name] ?? `custom field ${name.slice('customfield_'.length)}`
      : FIELD_WORDS[name] ?? words(name)).join(' ');
  if (count) return `the number of ${noun || 'items'} on ${owner}${suffix}`;
  if (!noun) return `${owner}${suffix}`;
  if (noun === 'key') return `${owner} key${suffix}`;
  return `${owner}'s ${noun}${suffix}`;
}

/** "the step 12 response (sdp-host.invalid)" and friends, for a web response read. */
function describeResponse(tokens, ctx) {
  const parts = tokens.filter((t) => !ENCODERS.has(t.name));
  const request = ctx.request;
  if (!request) return 'a web request response, but no web request runs before this step';
  const ambiguous = request === AMBIGUOUS_REQUEST;
  const who = ambiguous ? 'the most recent web request (depends on the branch taken)' : `step ${request.number}`;
  const host = !ambiguous && request.host ? ` (${request.host})` : '';
  const head = parts[0]?.name;
  if (head === undefined || head === '') return `the response from ${who}${host}`;
  if (head === 'status' && parts.length === 1) return `the HTTP status returned by ${who}`;
  if (head === 'body' && parts.length === 1) return `the response body from ${who}${host}`;
  const path = head === 'body' ? parts.slice(1) : parts;
  const transformed = path.some((t) => t.args !== undefined);
  const noun = path.filter((t) => t.args === undefined).map((t) => words(t.name)).join(' ');
  const from = ambiguous ? `the response of ${who}` : `the ${who} response${host}`;
  return `the ${noun} from ${from}${transformed ? TRANSFORMED : ''}`;
}

/**
 * One smart value, given without its braces ("issue.attachments.size"), in
 * plain words. Filters after "|" (defaults such as |0) are left out.
 */
export function describeSmartValue(expression, ctx = {}) {
  const path = String(expression).split('|')[0].trim();
  if (path === '' || /^[#/^]/.test(path)) return FALLBACK;
  const tokens = tokenize(path);

  // "A.diff(B).minutes" -> the minutes between A and B.
  const diff = tokens.findIndex((t) => t.name === 'diff' && t.args !== undefined);
  if (diff > 0) {
    const unit = tokens[diff + 1]?.name;
    const between = `between ${describeSmartValue(untokenize(tokens.slice(0, diff)), ctx)} and ${describeArgument(tokens[diff].args, ctx)}`;
    return DIFF_UNITS.has(unit) ? `the number of ${words(unit)} ${between}` : `the time ${between}`;
  }

  const [root, ...rest] = tokens;
  switch (root.name) {
    case 'issue':
    case 'triggerIssue':
      return describeOwned('the work item', rest, ctx);
    case 'comment':
      return describeOwned('the comment', rest, ctx);
    case 'webhookResponse':
    case 'webResponse':
      return describeResponse(rest, ctx);
    case 'now':
      return 'the current time';
    case 'webhookData': {
      const noun = rest.filter((t) => !ENCODERS.has(t.name) && t.args === undefined).map((t) => words(t.name)).join(' ');
      return noun ? `the ${noun} from the incoming webhook payload` : 'the incoming webhook payload';
    }
    case 'changelog': {
      const field = rest[0]?.name;
      const end = rest.at(-1)?.name;
      if (field && end === 'fromString') return `the ${FIELD_WORDS[field] ?? words(field)} the work item had before this change`;
      if (field && end === 'toString') return `the ${FIELD_WORDS[field] ?? words(field)} the work item changed to`;
      return FALLBACK;
    }
    default:
      break;
  }

  // A variable created earlier in this rule.
  const kind = ctx.variables?.get(root.name);
  if (kind) {
    const parts = rest.filter((t) => !ENCODERS.has(t.name));
    if (kind === 'table' && parts[0]?.name === 'get' && parts[0].args !== undefined && parts.length === 1) {
      return `the ${root.name} entry for ${describeArgument(parts[0].args, ctx)}`;
    }
    const base = kind === 'lookup' ? `the work items looked up as ${root.name}` : `the value of ${root.name}`;
    if (parts.length === 0) return base;
    if (parts.length === 1 && parts[0].name === 'size') {
      return kind === 'lookup' ? `the number of work items looked up as ${root.name}` : `the size of ${root.name}`;
    }
    return `${base}${TRANSFORMED}`;
  }
  return FALLBACK;
}

// Text that is itself structured data, so inlining meanings would only make it unreadable.
const looksLikeJson = (literal) => /[{[]/.test(literal) && /"\s*:/.test(literal);
const looksLikeForm = (literal) => /(^|&)[\w.-]+=/.test(literal) && !/\s/.test(literal.trim());

/** "a, b and c" */
function joinList(items) {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`;
}

/**
 * Any text from a rule (a comment body, a variable value, a JQL query) with
 * its smart values put into words. Returns { text, onlyValue }:
 *   - the whole text is one smart value -> its meaning, onlyValue true
 *   - a JSON or form template -> "a JSON body built from A, B and C"
 *   - otherwise the literal text, each smart value replaced by "[meaning]"
 * Text with no smart values comes back unchanged.
 */
export function describeText(text, ctx = {}) {
  const source = String(text ?? '');
  const meanings = [];
  // Blocks first: a calculation, or a loop / section this dictionary cannot read.
  const marked = source
    .replace(/\{\{#=\}\}([\s\S]*?)\{\{\/\}\}/g, (match, inner) => {
      const refs = [...new Set([...inner.matchAll(/\{\{([^{}]*)\}\}/g)].map(([, expr]) => describeSmartValue(expr, ctx)))];
      meanings.push(refs.length ? `a calculation using ${joinList(refs)}` : 'a calculated value');
      return `\u0000${meanings.length - 1}\u0000`;
    })
    .replace(/\{\{#([\w.]+)\}\}[\s\S]*?\{\{\/[\w.]*\}\}/g, () => {
      meanings.push(FALLBACK);
      return `\u0000${meanings.length - 1}\u0000`;
    })
    .replace(/\{\{([^{}]*)\}\}/g, (match, expr) => {
      meanings.push(describeSmartValue(expr, ctx));
      return `\u0000${meanings.length - 1}\u0000`;
    });
  if (meanings.length === 0) return { text: source, onlyValue: false };

  if (/^\u0000\d+\u0000$/.test(marked.trim())) return { text: meanings[0], onlyValue: true };
  const literal = marked.replace(/\u0000\d+\u0000/g, '');
  const unique = [...new Set(meanings)];
  if (looksLikeJson(literal)) return { text: `a JSON body built from ${joinList(unique)}`, onlyValue: true };
  if (looksLikeForm(literal)) return { text: `form data built from ${joinList(unique)}`, onlyValue: true };
  return { text: marked.replace(/\u0000(\d+)\u0000/g, (match, index) => `[${meanings[Number(index)]}]`), onlyValue: false };
}
