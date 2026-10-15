import assert from 'node:assert/strict';
import test from 'node:test';
import { createReadyMarker, NOTIFIED_LABEL, READY_LABEL, scrubUrls } from '../src/mark-request-ready.js';
import { JiraRequestError } from '../src/jira-client.js';
import { fakeJira } from './fakes.js';

// A made-up URL shaped like a Power Automate trigger: the secret is the
// `sig` query value. Tests assert this never leaks into logs or results.
const SECRET_SIG = 'TEST-SIG-do-not-leak-123';
const WEBHOOK_URL = `https://flow.example.test:443/workflows/abc/triggers/manual/paths/invoke?api-version=1&sig=${SECRET_SIG}`;
const WEBHOOK_ENV = Object.freeze({ TEAMS_WEBHOOK_URL: WEBHOOK_URL, JIRA_SITE_URL: 'https://example.atlassian.net/' });

/** An approval ticket as Jira returns it; `labels` changes after a PUT. */
function ticket({ project = 'SOC', attachments = 1, labels = [], summary = 'Automation rule request: Notify on P1' } = {}) {
  return {
    id: '20001',
    key: 'SOC-145',
    fields: {
      project: { key: project },
      attachment: Array.from({ length: attachments }, (_, i) => ({ id: String(30000 + i), filename: `draft-v1-${i}.json` })),
      labels,
      summary,
      reporter: { displayName: 'Requester One' },
    },
  };
}

/**
 * Wire a marker to fakes. The fake Jira keeps a live label list, so the
 * verify GET sees whatever the PUT added unless a test says otherwise.
 */
function setup({ issue = ticket(), mode, modeError, env = {}, fetchImpl, addLabels, verifyLabels } = {}) {
  let labels = [...(issue?.fields?.labels ?? [])];
  const jira = fakeJira({
    getIssue: (key, fields) => {
      if (issue instanceof Error) throw issue;
      if (!issue) return null;
      if (fields === 'labels') return { fields: { labels: verifyLabels ?? labels } };
      return issue;
    },
    getProjectProperty: () => {
      if (modeError) throw modeError;
      return mode;
    },
    addLabels: (key, added) => {
      if (addLabels) return addLabels(key, added);
      labels = [...labels, ...added];
      return null;
    },
  });
  const posts = [];
  const fetchFn = async (url, init) => {
    posts.push({ url, init });
    return fetchImpl ? fetchImpl(url, init) : new Response(null, { status: 202 });
  };
  const { markRequestReady } = createReadyMarker({ jira, fetchFn, getEnv: () => env, timeoutMs: 50 });
  return { jira, posts, mark: () => markRequestReady('SOC-145', 'SOC'), markRequestReady };
}

/** Capture console output during `fn`, so tests can check what was logged. */
async function captureLogs(fn) {
  const lines = [];
  const original = { log: console.log, error: console.error };
  console.log = (...args) => lines.push(args.join(' '));
  console.error = (...args) => lines.push(args.join(' '));
  try {
    return { result: await fn(), lines };
  } finally {
    Object.assign(console, original);
  }
}

test('a malformed issue key is refused before any Jira call', async () => {
  const { jira, markRequestReady } = setup();
  const result = await markRequestReady('soc-1; DROP', 'SOC');
  assert.equal(result.marked, false);
  assert.match(result.error, /SOC-123/);
  assert.equal(jira.calls.getIssue.length, 0);
});

test('an issue that cannot be found is not marked', async () => {
  const notFound = setup({ issue: null });
  assert.match((await notFound.mark()).error, /not found/);

  const unreadable = setup({ issue: new JiraRequestError('get issue', 404, 'Issue does not exist') });
  const result = await unreadable.mark();
  assert.equal(result.marked, false);
  assert.match(result.error, /could not be read/);
  assert.equal(unreadable.jira.calls.addLabels.length, 0);
});

test('a ticket outside the approval project is refused', async () => {
  const { jira, posts, mark } = setup({ issue: ticket({ project: 'OTHER' }) });
  const result = await mark();
  assert.equal(result.marked, false);
  assert.match(result.error, /not an approval ticket in project SOC/);
  assert.equal(posts.length, 0);
  assert.equal(jira.calls.addLabels.length, 0);
});

test('a ticket with no attachment is not marked: no post, no PUT', async () => {
  const { jira, posts, mark } = setup({ issue: ticket({ attachments: 0 }), mode: 'webhook', env: WEBHOOK_ENV });
  const result = await mark();
  assert.equal(result.marked, false);
  assert.equal(result.error, 'no draft attached; not marking ready');
  assert.equal(result.attachmentCount, 0);
  assert.equal(posts.length, 0);
  assert.equal(jira.calls.addLabels.length, 0);
});

test('a ticket that already carries either label is left alone: no post, no PUT', async () => {
  for (const label of [READY_LABEL, NOTIFIED_LABEL]) {
    const { jira, posts, mark } = setup({ issue: ticket({ labels: [label] }), mode: 'webhook', env: WEBHOOK_ENV });
    const result = await mark();
    assert.equal(result.ok, true);
    assert.equal(result.alreadyMarked, true);
    assert.equal(result.marked, false);
    assert.equal(posts.length, 0);
    assert.equal(jira.calls.addLabels.length, 0);
  }
});

test('a failed, missing or invalid mode read falls back to rule mode and logs why', async () => {
  const cases = [
    { modeError: new JiraRequestError('get project property', 500, 'boom'), reason: /could not be read/ },
    { modeError: new JiraRequestError('get project property', 404, 'not found'), reason: /is not set/ },
    { mode: 'teams', reason: /invalid value "teams"/ },
  ];
  for (const { reason, ...opts } of cases) {
    const ctx = setup({ ...opts, env: WEBHOOK_ENV });
    const { result, lines } = await captureLogs(() => ctx.mark());
    assert.equal(result.mode, 'rule');
    assert.equal(result.marked, true);
    assert.equal(ctx.posts.length, 0);
    assert.ok(lines.some((line) => /mode "rule"/.test(line) && reason.test(line)), lines.join('\n'));
  }
});

test('rule mode adds only ready-for-review, verifies it and posts nothing', async () => {
  const { jira, posts, mark } = setup({ mode: 'rule' });
  const result = await mark();
  assert.deepEqual(jira.calls.addLabels, [{ key: 'SOC-145', labels: [READY_LABEL] }]);
  assert.deepEqual(jira.calls.getProjectProperty, [{ projectKey: 'SOC', propertyKey: 'request-notify-mode' }]);
  assert.equal(posts.length, 0);
  assert.deepEqual(result, {
    ok: true,
    marked: true,
    mode: 'rule',
    issueKey: 'SOC-145',
    labelsAdded: [READY_LABEL],
    attachmentCount: 1,
    alreadyMarked: false,
    notificationSent: false,
  });
});

test('webhook mode posts the card as JSON with an explicit content type', async () => {
  const { posts, mark } = setup({
    mode: 'webhook',
    env: WEBHOOK_ENV,
    issue: ticket({ summary: 'Notify on "P1" \\ urgent' }),
  });
  await mark();

  assert.equal(posts.length, 1);
  const [{ url, init }] = posts;
  assert.equal(url, WEBHOOK_URL);
  assert.equal(init.method, 'POST');
  assert.equal(init.headers['Content-Type'], 'application/json');
  assert.ok(init.signal instanceof AbortSignal);

  const card = JSON.parse(init.body); // quotes in the summary did not break it
  assert.equal(card.type, 'message');
  const content = card.attachments[0].content;
  assert.equal(card.attachments[0].contentType, 'application/vnd.microsoft.card.adaptive');
  assert.equal(content.version, '1.2');
  assert.equal(content.body[0].text, 'Automation request ready for review');
  assert.equal(content.body[0].weight, 'Bolder');
  assert.deepEqual(content.body[1].facts, [
    { title: 'Ticket', value: 'SOC-145' },
    { title: 'Summary', value: 'Notify on "P1" \\ urgent' },
    { title: 'Requested by', value: 'Requester One' },
  ]);
  assert.deepEqual(content.actions, [
    { type: 'Action.OpenUrl', title: 'Open ticket', url: 'https://example.atlassian.net/browse/SOC-145' },
  ]);
});

test('webhook mode adds both labels in ONE PUT after the flow accepts', async () => {
  const { jira, mark } = setup({ mode: 'webhook', env: WEBHOOK_ENV });
  const result = await mark();
  assert.deepEqual(jira.calls.addLabels, [{ key: 'SOC-145', labels: [READY_LABEL, NOTIFIED_LABEL] }]);
  assert.equal(result.marked, true);
  assert.equal(result.mode, 'webhook');
  assert.equal(result.notificationSent, true);
  assert.deepEqual(result.labelsAdded, [READY_LABEL, NOTIFIED_LABEL]);
});

test('webhook mode without its variables is not marked; rule mode does not need them', async () => {
  const webhook = setup({ mode: 'webhook', env: { JIRA_SITE_URL: 'https://example.atlassian.net' } });
  const result = await webhook.mark();
  assert.equal(result.marked, false);
  assert.match(result.error, /TEAMS_WEBHOOK_URL/);
  assert.equal(webhook.posts.length, 0);
  assert.equal(webhook.jira.calls.addLabels.length, 0);

  const rule = setup({ mode: 'rule', env: {} });
  assert.equal((await rule.mark()).marked, true);
});

test('a rejected or failed post adds no labels', async () => {
  const outcomes = [
    () => new Response('bad', { status: 400 }),
    () => { throw new TypeError(`fetch failed for ${WEBHOOK_URL}`); },
  ];
  for (const fetchImpl of outcomes) {
    const { jira, mark } = setup({ mode: 'webhook', env: WEBHOOK_ENV, fetchImpl });
    const result = await mark();
    assert.equal(result.marked, false);
    assert.equal(result.notificationSent, false);
    assert.match(result.error, /did not accept/);
    assert.equal(jira.calls.addLabels.length, 0);
  }
});

test('a flow that does not answer in time is aborted and nothing is labelled', async () => {
  const fetchImpl = (url, init) => new Promise((resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
  });
  const { jira, mark } = setup({ mode: 'webhook', env: WEBHOOK_ENV, fetchImpl });
  const result = await mark();
  assert.equal(result.marked, false);
  assert.match(result.error, /no answer within 50 ms/);
  assert.equal(jira.calls.addLabels.length, 0);
});

test('a post that succeeded but a PUT that failed says so and is not retried', async () => {
  const { jira, posts, mark } = setup({
    mode: 'webhook',
    env: WEBHOOK_ENV,
    addLabels: () => { throw new JiraRequestError('add labels', 403, 'no'); },
  });
  const result = await mark();
  assert.equal(result.ok, false);
  assert.equal(result.marked, false);
  assert.equal(result.notificationSent, true);
  assert.match(result.error, /may have been sent; do not retry/);
  assert.equal(posts.length, 1);
  assert.equal(jira.calls.addLabels.length, 1);
});

test('labels missing on the verify GET are reported as not marked', async () => {
  const { mark } = setup({ mode: 'rule', verifyLabels: [] });
  const result = await mark();
  assert.equal(result.marked, false);
  assert.match(result.error, /missing label\(s\) ready-for-review/);
});

test('the webhook URL and its secret never appear in logs or results', async () => {
  const scenarios = [
    {},
    { fetchImpl: () => { throw new TypeError(`request to ${WEBHOOK_URL} failed, reason: ECONNRESET`); } },
    { addLabels: () => { throw new JiraRequestError('add labels', 500, `echo ${WEBHOOK_URL}`); } },
  ];
  for (const opts of scenarios) {
    const ctx = setup({ mode: 'webhook', env: WEBHOOK_ENV, ...opts });
    const { result, lines } = await captureLogs(() => ctx.mark());
    const everything = `${JSON.stringify(result)}\n${lines.join('\n')}`;
    assert.ok(!everything.includes(SECRET_SIG), everything);
    assert.ok(!everything.includes('flow.example.test'), everything);
  }
});

test('scrubUrls removes every URL from error text', () => {
  assert.equal(scrubUrls(`failed: ${WEBHOOK_URL} (x)`), 'failed: [redacted url] (x)');
});
