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
  const calls = {
    createIssue: [], getIssue: [], getChangelog: [], addComment: [], addAttachment: [], transitionIssue: [],
    addLabels: [], getProjectProperty: [], getProjectStatuses: [], getTransitions: [], isUserInGroup: [],
  };
  return {
    calls,
    async createIssue(fields) {
      calls.createIssue.push(fields);
      return overrides.createIssue ? overrides.createIssue(fields) : { id: '20001', key: 'AUTOAPR-7' };
    },
    async getIssue(key, fields) {
      calls.getIssue.push(key);
      return overrides.getIssue ? overrides.getIssue(key, fields) : null;
    },
    async addLabels(key, labels) {
      calls.addLabels.push({ key, labels });
      return overrides.addLabels ? overrides.addLabels(key, labels) : null;
    },
    async getProjectProperty(projectKey, propertyKey) {
      calls.getProjectProperty.push({ projectKey, propertyKey });
      return overrides.getProjectProperty ? overrides.getProjectProperty(projectKey, propertyKey) : undefined;
    },
    async getProjectStatuses(projectKey) {
      calls.getProjectStatuses.push(projectKey);
      return overrides.getProjectStatuses ? overrides.getProjectStatuses(projectKey) : PROJECT_STATUSES;
    },
    async getTransitions(key) {
      calls.getTransitions.push(key);
      return overrides.getTransitions ? overrides.getTransitions(key) : [{ id: APPROVAL_IDS.resubmitTransition, name: 'resubmit pending' }];
    },
    async isUserInGroup(accountId, groupId) {
      calls.isUserInGroup.push({ accountId, groupId });
      if (overrides.isUserInGroup) return overrides.isUserInGroup(accountId, groupId);
      return groupId === APPROVAL_ENV.APPROVER_GROUP_ID && APPROVER_GROUP_MEMBERS.includes(accountId);
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
  APPROVAL_ISSUE_TYPE_NAME: 'Automation Request',
  APPROVED_STATUS_NAME: 'Approved',
  CHANGES_REQUESTED_STATUS_NAME: 'Change Request',
  RESUBMIT_TRANSITION_NAME: 'resubmit pending',
  APPROVER_GROUP_ID: 'group-approvers',
});

/** The IDs the names above resolve to through the fake Jira. */
export const APPROVAL_IDS = Object.freeze({
  issueType: '10100',
  approvedStatus: '10201',
  changesRequestedStatus: '10203',
  resubmitTransition: '31',
});

export const APPROVER_GROUP_MEMBERS = Object.freeze(['manager-1', 'me-1']);

/** GET /project/{key}/statuses as Jira returns it, with a decoy issue type. */
export const PROJECT_STATUSES = Object.freeze([
  { id: '10001', name: 'Task', statuses: [{ id: '1', name: 'To Do' }, { id: '10201', name: 'Done' }] },
  {
    id: APPROVAL_IDS.issueType,
    name: 'Automation Request',
    statuses: [
      { id: '10200', name: 'Pending' },
      { id: APPROVAL_IDS.approvedStatus, name: 'Approved' },
      { id: APPROVAL_IDS.changesRequestedStatus, name: 'Change Request' },
    ],
  },
]);

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
