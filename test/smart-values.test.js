import assert from 'node:assert/strict';
import test from 'node:test';
import { AMBIGUOUS_REQUEST, describeSmartValue, describeText } from '../src/smart-values.js';
import { describeSteps } from '../src/rule-steps.js';

// The approver reads smart values as what they mean, never as {{...}} code.

const CTX = {
  fieldNames: { customfield_10300: 'Customer ITSM Incident' },
  variables: new Map([['AuthToken', 'variable'], ['PriorityMap', 'table'], ['lookupIssues', 'lookup']]),
  request: { number: '12', host: 'sdp-host.invalid' },
};
const say = (expression, ctx = CTX) => describeSmartValue(expression, ctx);

test('work item and comment fields read as plain nouns', () => {
  assert.equal(say('issue.attachments.size'), 'the number of attachments on the work item');
  assert.equal(say('comment.attachments.size'), 'the number of attachments on the comment');
  assert.equal(say('issue.priority.name'), "the work item's priority");
  assert.equal(say('issue.reporter.displayName'), "the work item's reporter");
  assert.equal(say('issue.key'), 'the work item key');
  assert.equal(say('issue.summary.jsonEncode'), "the work item's summary");
  assert.equal(say('comment.body'), "the comment's text");
  assert.equal(say('changelog.status.toString'), 'the status the work item changed to');
});

test('a custom field reads as its name, or by number when the name is unknown', () => {
  assert.equal(say('issue.customfield_10300'), 'Customer ITSM Incident');
  assert.equal(say('issue.customfield_10300.value'), 'Customer ITSM Incident');
  assert.equal(say('issue.customfield_99999'), 'custom field 99999');
});

test('web responses are named by the step that sent the request and its host', () => {
  assert.equal(say('webhookResponse.status'), 'the HTTP status returned by step 12');
  assert.equal(say('webResponse.body'), 'the response body from step 12 (sdp-host.invalid)');
  assert.equal(say('webhookResponse.body.request.id'), 'the request ID from the step 12 response (sdp-host.invalid)');
  assert.equal(say('webResponse.body.access_token'), 'the access token from the step 12 response (sdp-host.invalid)');
  assert.equal(say('webhookResponse.status', { ...CTX, request: AMBIGUOUS_REQUEST }),
    'the HTTP status returned by the most recent web request (depends on the branch taken)');
  assert.equal(say('webhookResponse.status', { ...CTX, request: null }),
    'a web request response, but no web request runs before this step');
});

test('rule variables, lookup tables, dates and the webhook payload', () => {
  assert.equal(say('AuthToken'), 'the value of AuthToken');
  assert.equal(say('PriorityMap.get(issue.priority.name)'), "the PriorityMap entry for the work item's priority");
  assert.equal(say('lookupIssues.size'), 'the number of work items looked up as lookupIssues');
  assert.equal(say('now.diff(issue.created).minutes.abs|0'), 'the number of minutes between the current time and the work item\'s creation time');
  assert.equal(say('webhookData.alert.id'), 'the alert ID from the incoming webhook payload');
});

test('anything the dictionary does not know is flagged, never shown as code', () => {
  assert.equal(say('somethingElse.entirely'), 'a calculated value (see the attached JSON)');
  assert.equal(say('issue.summary.substring(0, 5)'), "the work item's summary (transformed; see the attached JSON)");
  assert.equal(describeText('{{#issue.comments}}{{body}}{{/}}', CTX).text, 'a calculated value (see the attached JSON)');
});

test('text: a lone value, inline values in brackets, templates and calculations', () => {
  assert.deepEqual(describeText('{{issue.key}}', CTX), { text: 'the work item key', onlyValue: true });
  assert.deepEqual(describeText('Bearer {{webResponse.body.access_token}}', CTX), {
    text: 'Bearer [the access token from the step 12 response (sdp-host.invalid)]', onlyValue: false,
  });
  assert.equal(describeText('{"subject":"{{issue.summary.jsonEncode}}","key":"{{issue.key}}"}', CTX).text,
    "a JSON body built from the work item's summary and the work item key");
  assert.equal(describeText('client_id={{AuthToken}}&grant_type=client_credentials', CTX).text,
    'form data built from the value of AuthToken');
  assert.equal(describeText('{{#=}}ROUND({{issue.customfield_10300|0}} / 60000, 1){{/}}', CTX).text,
    'a calculation using Customer ITSM Incident');
  assert.deepEqual(describeText('No smart values here', CTX), { text: 'No smart values here', onlyValue: false });
});

// --- which response a read gets, through branches ----------------------------

const node = (component, type, value, extra = {}) => ({ component, type, value, conditions: [], children: [], ...extra });
const request = (host) => node('ACTION', 'jira.issue.outgoing.webhook', { url: `https://${host}/x`, method: 'POST' });
const comment = (text) => node('ACTION', 'jira.issue.comment', { comment: text });
const ifBlock = (children, conditions = [node('CONDITION', 'jira.comparator.condition', { first: 'a', operator: 'EQUALS', second: 'b' })]) =>
  node('CONDITION_BLOCK', 'jira.condition.if.block', { conditionMatchType: 'ALL' }, { conditions, children });
const group = (...branches) => node('CONDITION', 'jira.condition.container.block', {}, { children: branches });
const texts = (rule) => describeSteps(rule).map(({ number, text }) => `${number} ${text}`);

test('a read in the other branch gets the response from before the group, not the sibling branch', () => {
  assert.deepEqual(texts({ components: [
    request('first.invalid'),
    group(ifBlock([request('second.invalid'), comment('{{webResponse.body}}')]), ifBlock([comment('{{webResponse.body}}')], [])),
  ] }), [
    '1 Send a POST web request to https://first.invalid/x',
    '2 If a equals b:',
    '2.1 Send a POST web request to https://second.invalid/x',
    '2.2 Add an internal comment: the response body from step 2.1 (second.invalid)',
    '3 Otherwise:',
    '3.1 Add an internal comment: the response body from step 1 (first.invalid)',
  ]);
});

test('after a group in which a branch sent a request, the response depends on the branch', () => {
  const steps = texts({ components: [request('first.invalid'), group(ifBlock([request('second.invalid')])), comment('{{webhookResponse.status}}')] });
  assert.equal(steps.at(-1), '3 Add an internal comment: the HTTP status returned by the most recent web request (depends on the branch taken)');
});

test('a request\'s own body reads the response of the request before it', () => {
  const second = node('ACTION', 'jira.issue.outgoing.webhook', { url: 'https://b.invalid/{{webResponse.body.id}}', method: 'GET' });
  assert.deepEqual(texts({ components: [request('a.invalid'), second] }), [
    '1 Send a POST web request to https://a.invalid/x',
    '2 Send a GET web request to https://b.invalid/[the ID from the step 1 response (a.invalid)]',
  ]);
});
