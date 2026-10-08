import assert from 'node:assert/strict';
import test from 'node:test';
import { createDraftStore, DRAFT_STATES, nextState } from '../src/draft-store.js';
import { fakeStorage } from './fakes.js';

const { PENDING, CREATING, CREATED, NEEDS_ATTENTION } = DRAFT_STATES;

test('legal transitions move to the expected state', () => {
  assert.equal(nextState(PENDING, 'approve'), CREATING);
  assert.equal(nextState(PENDING, 'revise'), PENDING);
  assert.equal(nextState(PENDING, 'fail'), NEEDS_ATTENTION);
  assert.equal(nextState(CREATING, 'created'), CREATED);
  assert.equal(nextState(CREATING, 'fail'), NEEDS_ATTENTION);
});

test('illegal transitions are refused', () => {
  // The important ones: nothing re-opens a finished draft, and a draft
  // cannot skip straight to CREATED without passing through CREATING.
  for (const terminal of [CREATED, NEEDS_ATTENTION]) {
    for (const event of ['approve', 'revise', 'created', 'fail']) {
      assert.equal(nextState(terminal, event), null, `${terminal} --${event}-->`);
    }
  }
  assert.equal(nextState(PENDING, 'created'), null);
  // Rejection is the live Jira status's job, not a stored state.
  assert.equal(nextState(PENDING, 'reject'), null);
  assert.equal(nextState(CREATING, 'approve'), null);
  assert.equal(nextState(CREATING, 'revise'), null);
  assert.equal(nextState('BOGUS', 'approve'), null);
});

test('applyEvent saves the new state and history; a refused move changes nothing', async () => {
  const storage = fakeStorage();
  const store = createDraftStore(storage);
  const record = await store.saveDraft({ issueId: '1', version: 1, digest: 'd1', state: PENDING, history: [] });

  const revised = await store.applyEvent(record, 'revise', { version: 2, digest: 'd2' });
  assert.equal(revised.state, PENDING);
  assert.deepEqual(revised.history.map((h) => [h.version, h.digest, h.state]), [[2, 'd2', PENDING]]);
  assert.equal((await store.getDraft('1')).version, 2);

  const created = await store.applyEvent(revised, 'created');
  assert.equal(created, null);
  assert.equal((await store.getDraft('1')).state, PENDING);
});

test('only the first creation claim wins', async () => {
  const store = createDraftStore(fakeStorage());
  const results = await Promise.all([store.claimCreation('9'), store.claimCreation('9'), store.claimCreation('9')]);
  assert.deepEqual(results.filter(Boolean).length, 1);
  assert.equal(await store.claimCreation('10'), true, 'claims are per issue');
});

test('a storage error while claiming counts as a lost claim (fail closed)', async () => {
  const store = createDraftStore({
    async set() { throw new Error('storage unavailable'); },
  });
  assert.equal(await store.claimCreation('9'), false);
});
