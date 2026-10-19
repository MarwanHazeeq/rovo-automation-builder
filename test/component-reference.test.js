import assert from 'node:assert/strict';
import test from 'node:test';
import { getComponentReference } from '../src/component-reference.js';

test('no arguments returns an index of every kind plus usage notes', async () => {
  const result = await getComponentReference();

  assert.equal(result.ok, true);
  assert.deepEqual(Object.keys(result.kinds).sort(), [
    'action', 'condition', 'structural', 'trigger',
  ]);

  const triggerTypes = result.kinds.trigger.map((t) => t.type);
  assert.ok(triggerTypes.includes('jira.jql.scheduled'));
  assert.ok(triggerTypes.includes('jira.issue.event.trigger:transitioned'));

  // The constraints a value shape cannot convey must travel with the index.
  const notes = result.usageNotes.join(' ');
  assert.match(notes, /webhookResponse/);
  assert.match(notes, /ONE condition branch/);
  assert.match(notes, /no iteration component/i);
  assert.match(notes, /smart-value expressions/);

  assert.ok(result.smartValueTopics.length > 0);
});

test('a component type returns its full shape and schema version', async () => {
  const result = await getComponentReference({ componentType: 'jira.issue.edit' });

  assert.equal(result.ok, true);
  assert.equal(result.kind, 'action');
  assert.equal(result.schemaVersion, 12);
  assert.equal(result.verified, true);
  // The documented example is the INPUT the builder accepts: value.fields.
  assert.deepEqual(Object.keys(result.example), ['fields']);
  // The exported operations / advancedFields shapes stay reachable, but only
  // as clearly labelled builder output, never as the example to copy.
  assert.equal('variants' in result, false);
  assert.match(result.builtInternally.description, /NOT AN INPUT/);
  assert.deepEqual(Object.keys(result.builtInternally.shapes).sort(), [
    'advancedFields', 'operations', 'operationsFloat', 'operationsSystemField',
  ]);
});

test('the scheduled trigger keeps the vestigial schedule fields as builder output', async () => {
  const result = await getComponentReference({ componentType: 'jira.jql.scheduled' });

  assert.equal(result.ok, true);
  assert.equal(result.kind, 'trigger');
  // `example` is what the agent sends; the vestigial fields are builder output.
  assert.equal(result.example.schedule.method, undefined);
  assert.equal(result.example.executionMode, undefined);
  assert.equal(result.builtInternally.value.schedule.method, 'BASIC');
  assert.equal(result.builtInternally.value.schedule.rateInterval, 86400);
  assert.equal(result.builtInternally.value.executionMode, 'jql');
  assert.match(result.notes, /IMPLEMENTED in index\.js/);
});

test('an unverified type is flagged and carries a warning, not a usable example', async () => {
  const result = await getComponentReference({ componentType: 'jira.issue.transition' });

  assert.equal(result.ok, true);
  // Verified from Auto-Triage.txt, so it must NOT be flagged unverified.
  assert.equal(result.verified, true);
  assert.equal(result.example.transitionMatch, '');
  assert.equal(result.example.destinationStatus.type, 'NAME');
  // The guess that was wrong must be gone.
  assert.equal('ignoreConditions' in result.example, false);
});

test('kind returns every shape of that kind', async () => {
  const result = await getComponentReference({ kind: 'condition' });

  assert.equal(result.ok, true);
  const types = result.components.map((c) => c.type);
  assert.deepEqual(types.sort(), [
    'jira.affected.services.condition', 'jira.comparator.condition', 'jira.issue.condition',
    'jira.jql.condition', 'jira.user.condition',
  ]);
  assert.ok(result.components.every((c) => c.schemaVersion !== undefined));
});

test('an unknown type names near misses instead of just failing', async () => {
  const result = await getComponentReference({ componentType: 'jira.issue.ed' });

  assert.equal(result.ok, false);
  assert.match(result.error, /not a supported component type/);
  assert.ok(result.didYouMean.includes('jira.issue.edit'));
});

test('an unknown type with no near miss lists everything supported', async () => {
  const result = await getComponentReference({ componentType: 'zzz.nonsense' });

  assert.equal(result.ok, false);
  assert.ok(result.supportedTypes.includes('jira.issue.edit'));
  assert.equal(result.didYouMean, undefined);
});

test('an unknown kind is rejected with the valid list', async () => {
  const result = await getComponentReference({ kind: 'sideways' });

  assert.equal(result.ok, false);
  assert.match(result.error, /trigger, action, condition, structural/);
});

test('smartValues returns the verified expressions', async () => {
  const result = await getComponentReference({ smartValues: 'true' });

  assert.equal(result.ok, true);
  assert.ok(result.smartValues['math block'].verified.some((v) => v.includes('ROUND')));
});

test('smartValues carries the date-diff operand order and the .toDate requirement', async () => {
  const result = await getComponentReference({ smartValues: 'true' });
  const dates = result.smartValues['string timestamps and date diffs'];

  // Closed by the 2026-09-30 gate test. Both findings must survive any future
  // edit of the library, because either one alone produces a rule that runs
  // cleanly and writes nothing.
  assert.ok(dates.verified.some((v) => v.includes('.toDate.diff(')));
  assert.match(dates.notes, /ARGUMENT MINUS RECEIVER/);
  assert.match(dates.notes, /EARLIER timestamp as the receiver/);
  assert.match(dates.notes, /\.toDate is mandatory/);

  // The two expressions that came back empty must stay recorded, so nobody
  // retries them.
  assert.equal(dates.doesNotWork.length, 2);
  assert.ok(dates.doesNotWork.every((v) => v.includes('EMPTY')));
});
