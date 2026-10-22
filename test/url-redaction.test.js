import assert from 'node:assert/strict';
import test from 'node:test';
import { redactSecrets, redactUrl } from '../src/index.js';

// Issue #12: a redacted URL keeps the parts a person needs to recognise the
// call (scheme, host, path) and loses the parts that would let someone make it.

const LOGIC_APP_URL =
  'https://prod-12.westeurope.logic.azure.com/workflows/abc/triggers/manual/paths/invoke?api-version=2016-10-01&sig=SECRETSIG';

test('a signed Logic App URL keeps its host and path and loses its signature', () => {
  const redacted = redactUrl(LOGIC_APP_URL);
  assert.equal(
    redacted,
    'https://prod-12.westeurope.logic.azure.com/workflows/abc/triggers/manual/paths/invoke?api-version=[redacted]&sig=[redacted]'
  );
  assert.ok(!redacted.includes('SECRETSIG'));
});

test('userinfo and fragment are redacted', () => {
  assert.equal(redactUrl('https://bob:hunter2@api.example.com/v1#tok=abc'), 'https://[redacted]@api.example.com/v1#[redacted]');
});

test('a bare query string with no name is redacted whole', () => {
  assert.equal(redactUrl('https://api.example.com/hook?SECRETKEY'), 'https://api.example.com/hook?[redacted]');
});

test('smart values in the path stay readable', () => {
  assert.equal(redactUrl('https://api.example.com/issues/{{issue.key}}'), 'https://api.example.com/issues/{{issue.key}}');
});

test('an unparseable URL is still replaced whole', () => {
  assert.equal(redactUrl('<SYNC_SERVICE_URL>'), '[redacted]');
  assert.equal(redactUrl('ftp://files.example.com/x?sig=1'), '[redacted]');
});

test('redactSecrets applies URL redaction to a web request and leaves headers as before', () => {
  const out = redactSecrets({
    type: 'jira.issue.outgoing.webhook',
    value: { url: LOGIC_APP_URL, headers: [{ name: 'Auth-Key', value: 'K' }], customBody: '{"a":1}' },
  });
  assert.match(out.value.url, /^https:\/\/prod-12\.westeurope\.logic\.azure\.com\/workflows\/abc\//);
  assert.ok(!out.value.url.includes('SECRETSIG'));
  assert.deepEqual(out.value.headers, [{ name: 'Auth-Key', value: '[redacted]' }]);
  assert.equal(out.value.customBody, '{"a":1}');
});
