// Shared test doubles for the approval flow. Not a test file itself; node
// --test loads it (it lives under test/) and finds no tests, which is fine.

/** In-memory stand-in for Forge KVS, including the FAIL_IF_EXISTS key policy. */
export function fakeStorage() {
  const data = new Map();
  return {
    data,
    async get(key) {
      return data.has(key) ? structuredClone(data.get(key)) : undefined;
    },
    async set(key, value, options = {}) {
      if (options.keyPolicy === 'FAIL_IF_EXISTS' && data.has(key)) {
        const error = new Error('key already exists');
        error.code = 'KEY_ALREADY_EXISTS';
        throw error;
      }
      data.set(key, structuredClone(value));
    },
  };
}

/** Records every Jira call; behaviour can be overridden per test. */
export function fakeJira(overrides = {}) {
  const calls = { createIssue: [], getIssue: [], getChangelog: [], addComment: [], addAttachment: [], transitionIssue: [] };
  return {
    calls,
    async createIssue(fields) {
      calls.createIssue.push(fields);
      return overrides.createIssue ? overrides.createIssue(fields) : { id: '20001', key: 'AUTOAPR-7' };
    },
    async getIssue(key) {
      calls.getIssue.push(key);
      return overrides.getIssue ? overrides.getIssue(key) : null;
    },
    async getChangelog(key) {
      calls.getChangelog.push(key);
      return overrides.getChangelog ? overrides.getChangelog(key) : [];
    },
    async addComment(key, body) {
      calls.addComment.push({ key, body });
    },
    async addAttachment(key, filename, content) {
      calls.addAttachment.push({ key, filename, content });
      if (overrides.addAttachment) return overrides.addAttachment(key, filename, content);
      return [{ id: '30001', filename }];
    },
    async transitionIssue(key, transitionId) {
      calls.transitionIssue.push({ key, transitionId });
      if (overrides.transitionIssue) return overrides.transitionIssue(key, transitionId);
      return null;
    },
  };
}

export const APPROVAL_ENV = Object.freeze({
  APPROVAL_PROJECT_KEY: 'AUTOAPR',
  APPROVAL_ISSUE_TYPE_ID: '10100',
  APPROVED_STATUS_ID: '10201',
  CHANGES_REQUESTED_STATUS_ID: '10203',
  RESUBMIT_TRANSITION_ID: '31',
  APPROVER_ACCOUNT_IDS: 'manager-1, me-1',
});

/** A built rule as prepareRule() would return it. */
export function sampleRule(name = 'Notify on P1') {
  const scope = 'ari:cloud:jira:test-cloud:project/10449';
  return {
    name,
    state: 'DISABLED',
    actor: { type: 'ACCOUNT_ID', actor: 'test-actor' },
    ruleScopeARIs: [scope],
    trigger: {
      component: 'TRIGGER',
      type: 'jira.issue.event.trigger:created',
      value: { eventKey: 'jira:issue_created', issueEvent: 'issue_created', eventFilters: [scope] },
    },
    components: [{ component: 'ACTION', type: 'codebarrel.action.log', value: 'hello' }],
  };
}

/** A prepare() stub that succeeds with sampleRule(). */
export function preparedOk(name) {
  const rule = sampleRule(name);
  return async () => ({ ok: true, rule, scope: rule.ruleScopeARIs[0], cloudId: 'test-cloud' });
}

/** Concatenate every text node in an ADF document, for simple assertions. */
export function adfText(node) {
  if (!node || typeof node !== 'object') return '';
  if (node.type === 'text') return node.text;
  return (node.content ?? []).map(adfText).join(' ');
}
