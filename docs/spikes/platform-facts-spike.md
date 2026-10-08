# Spike: platform facts the docs do not answer

> Status: open · opened 2026-10-06 · updated 2026-10-08 for
> [ADR 0001](../adr/0001-agent-triggers-creation-of-frozen-draft.md): the agent
> now triggers creation through `create-approved-automation-rule`, and the
> event trigger was removed. S4/S5 matter only if a post function is
> reconsidered; **S7 and S9 gate the approval flow.**

## What this is

A **spike** is a time-boxed, throwaway piece of code whose only output is an
answer. Nothing built here ships. The code is deleted once each blank below is
filled in.

Six questions block the approval-gate design. Three of them (S4, S5, S6) are
**not answered anywhere in Atlassian's documentation** — not poorly documented,
*undocumented*. The only instrument that can answer them is a deployed app.

The cost of skipping this is not hypothetical. Earlier in the design we built on
`avi:jira:transitioned:issue`, a Jira event that does not exist. Had it shipped,
the symptom would have been a trigger that silently never fired, with no error
anywhere to explain it. Each question below is phrased so a wrong assumption
produces a visible failure here instead of a silent one in production.

## How to run anything in this file

Always establish the working directory first, then work from the app root:

```bash
pwd
```

Logs, after any invocation:

```bash
forge logs -e development --since 15m
```

Deploy (never with `--no-verify`):

```bash
forge deploy --non-interactive -e development
```

`forge lint` after every `manifest.yml` change. Remember that adding a scope or
an egress entry requires a **redeploy and then a reinstall** — a redeploy alone
leaves the old permission grant in place.

## Sequencing

| Batch | Questions | Needs | Rough cost |
|-------|-----------|-------|------------|
| 1 | S1, S2, S3 | one deploy of the existing app | under an hour |
| 2 | S4, S5 | governance project + a workflow with an Approve transition | half a day |
| 3 | S6 | two rules in one project | an hour |
| 4 | S7, S8, S9 | the approval flow deployed, AUTOAPR set up | an hour |

Batch 2's setup is not throwaway — the governance project and workflow are
needed for the real build regardless.

**Do S2 first and alone.** It is the only question whose answer can change the
*shape* of the design rather than its parameters.

---

## S1 — Does the action's `context` carry the invoking user's `accountId`?

**Status:** ☐ open  **Answer:**

### Why it matters

Q6 settled that the created rule's *actor* should be the person who asked for
it, not a shared service account, so the Jira Automation audit trail reads
"Marwan asked for this" rather than "the robot did something". That requires
knowing who invoked the action.

The docs describe a `principal: { accountId }` on the handler's second argument,
and a separate nested `payload.context` carrying product fields. Both are
documented. Neither has been *observed* populated in a real `rovo:mcp`
invocation, and the handler in this repo has never looked:

```js
// src/index.js — currently declares one parameter and never reads the second
export async function createJiraAutomationRule(payload) {
```

### Method

Add the second parameter and log both arguments whole. This is the only
change — keep the existing body untouched.

```js
export async function createJiraAutomationRule(payload, context) {
  // SPIKE S1/S3 — remove before merging. Logs the full invocation shape so we
  // can see what Rovo actually hands a rovo:mcp action, rather than inferring
  // it from documentation.
  console.log('[spike] t0', Date.now());
  console.log('[spike] payload', JSON.stringify(payload));
  console.log('[spike] context', JSON.stringify(context));
```

Deploy, invoke the action once from Rovo, then read the logs.

The logged objects here are a *spike* payload, not a production response — but
note that the real handler must keep routing anything it returns or logs through
`redactSecrets`. Do not copy this raw `JSON.stringify` into shipped code.

### Record

- `context.principal.accountId` present? ☐ yes ☐ no — value shape:
- `payload.context` fields observed:
- `context.installContext` / `license` / `workspaceId` present?

### What changes on the answer

- **Present:** Q6 proceeds. The actor becomes the requester, pending S6.
- **Absent:** Q6 is dead; the actor stays the configured service account and the
  requester is recorded in the ledger only.

Either way, the **fail-closed** rule stands: an action that cannot identify its
caller refuses rather than guesses.

---

## S2 — Does Rovo show the user the extracted input values before a `CREATE` action runs?

**Status:** ☐ open  **Answer:**

### Why it matters

Failure #4 was the agent silently rewriting a JSON it was told to pass through
verbatim. The reason that failure is invisible is structural: **there is a
translation step between what the user said and what the tool received, and the
user never sees its output.** You say "comment on the issue and then transition
it"; the agent emits a `ruleSpec`; the tool validates that `ruleSpec`. If the
extraction drifted, every component downstream is behaving correctly on wrong
input.

If Rovo renders the argument values it is about to send, that render is
trustworthy in the one sense that matters here: it shows the **actual arguments**
rather than the agent's prose description of them. The agent cannot re-word a
JSON field it has already committed to. This is categorically different from the
chat echo in Q5, which is agent-authored narration and therefore useless as a
control.

### Method

No code. `draft-automation-rule` declares `actionVerb: CREATE` (it creates the approval ticket).
Invoke it from Rovo and watch the UI.

1. Does anything appear *before* execution?
2. If so, does it show the `ruleSpec` **value**, or only the action's name?
3. Screenshot it either way and attach the screenshot beside this file.

### Record

- Pre-execution UI shown? ☐ yes ☐ no
- Shows input values? ☐ full ☐ truncated ☐ name only
- Screenshot:

### What changes on the answer

This does **not** touch the approval gate. The gate is a governance requirement
and it is what structurally eliminates failure #3; nothing here changes that.

What it changes is narrower: if the platform already exposes the extracted
arguments at the moment of extraction, the draft step no longer has to carry the
whole burden of surfacing input drift. Platform-level detection is strictly
earlier and cheaper than catching drift at approval time. The question is
whether we get a free pre-flight check or have to hand-build one.

---

## S3 — What is the real end-to-end timeout through the MCP path?

**Status:** ☐ open  **Answer:**

### Why it matters

The documented ceiling for an `action` module is **55 seconds**. But this action
is reached *through* `rovo:mcp`, and no document states that the MCP wrapper
inherits the action's budget rather than imposing a tighter one of its own.

The draft step will do real work: validation, a KVS write, a Jira issue
creation, and a Teams POST. That is several network round trips on one
invocation.

### Method

Two variants, cheapest first.

**Measure actual usage** — pair the `t0` log from S1 with an exit log:

```js
console.log('[spike] t1', Date.now(), 'elapsed_ms', Date.now() - t0);
```

**Find the ceiling** — deliberately overrun, then see whether you get a result
or a timeout:

```js
// SPIKE S3 — remove before merging.
await new Promise((resolve) => setTimeout(resolve, 50000));
```

### Record

- Observed elapsed time for a realistic draft:
- 50s deliberate delay: ☐ returned ☐ timed out — error text:
- Effective ceiling:

### What changes on the answer

If the real ceiling is well under 55s, the **draft** step moves its work into an
async event too, exactly as the commit step already does. Forge async events
allow up to 900s via `timeoutSeconds`, so the headroom exists; it just costs an
extra hop and makes the draft's completion asynchronous from the chat turn.

---

## S4 — Is the post function synchronous, and what happens to the issue if it fails?

**Status:** ⏸ deferred (2026-10-07) — the build uses an event trigger instead
of a post function. The retry/duplicate concern moved to S8, and the handler
guards it with an atomic `FAIL_IF_EXISTS` claim in KVS rather than with
`transition.executionId`.  **Answer:**

> **Undocumented.** Atlassian documents the `jira:workflowPostFunction` payload
> and its retry mechanics, but not its synchronicity, its timeout, or its
> rollback behaviour.

### Why it matters

Jira's transition runs as a sequence: **conditions** ("may you take this
arrow?", evaluated before the button is even shown) → **validators** ("is this
input valid?", can block) → **the status change** → **post functions** (the
consequences). Post functions run *after* the status has already changed.

So the question is not whether the post function can block the transition. It
is **what state the world is left in when it fails.**

- **If async and non-blocking** (what I expect): the issue reads **Approved**
  immediately and the rule appears a moment later. A failure leaves the issue
  reading Approved with **no rule in existence** — harm (c), silent absence,
  ranked worst in Q1. This is exactly the job Q16's scheduled sweep exists to
  do: notice "approved, never created".
- **If synchronous**: the approver's browser waits on an Automation API call,
  which is a poor experience and puts a network call on a human's click path.

There is a sharper problem nested inside this one. Post functions **retry — up
to 4 attempts with backoff**. A retry following a partially-successful attempt
can create the rule **twice**. That is why Q21 settled on `transition.executionId`
as the dedupe key: it is shared across all post functions within one transition,
making it a stable answer to "have I already processed this approval?".
Idempotency here is not polish; it is the only thing standing between an
approval and two live rules.

### Method

A throwaway post function on the Approve transition that logs on entry and then
fails:

```js
export async function spikePostFunction(payload) {
  // SPIKE S4 — remove before merging.
  console.log('[spike] postfunction entered', Date.now());
  console.log('[spike] executionId', payload?.transition?.executionId);
  console.log('[spike] atlassianId', payload?.atlassianId);
  throw new InvocationError({ retryAfter: 5, retryReason: 'SPIKE' });
}
```

Fire the transition and observe.

### Record

- Transition completed despite the throw? ☐ yes ☐ no
- Status stuck in the new status? ☐ yes ☐ no
- Entry log count (retry evidence):
- `executionId` stable across retries? ☐ yes ☐ no
- `atlassianId` present and correct?
- Approver's browser blocked while it ran? ☐ yes ☐ no — for how long:
- Observed timeout, if any:

### What changes on the answer

- `executionId` stable across retries ⇒ Q21's dedupe key is sound as designed.
- **Not** stable ⇒ the dedupe key has to be derived from the issue id plus the
  payload digest instead, and that changes the KVS schema.
- Issue left Approved after total failure ⇒ confirms the sweep is mandatory, not
  optional, and sets its detection window.

---

## S5 — Does copying or exporting a workflow preserve the post function and its config?

**Status:** ☐ open  **Answer:**

> **Undocumented** for Forge post functions.

### Why it matters

This is an operational-durability question rather than a correctness one. Jira
admins clone workflows constantly — new project, same process. If the clone
silently drops the Forge post function, the new project gets an approval
transition that **looks identical and does nothing**.

That is the same shape as failure #3: a control that appears present and is
absent. Worth noting that `jira:workflowPostFunction` is still a **preview**
module (accepted as a known risk under Q22), which makes its behaviour under
copy less safe to assume than a GA module's would be.

### Method

1. Configure the post function on one workflow's Approve transition.
2. Copy the workflow in the Jira admin UI. Inspect the copy's transition.
3. Export the workflow to XML. Check whether the post function and its stored
   configuration both survive.

### Record

- Survives workflow copy? ☐ yes ☐ no
- Configuration survives, or only the function reference?
- Survives XML export/import? ☐ yes ☐ no
- Behaviour when the workflow is copied into a **team-managed** project:

### What changes on the answer

If it does not survive copying, that becomes a documented operational constraint
("this workflow must not be cloned"), plus ideally an attachment check on the
global page: verify the post function is actually bound where it is supposed to
be, rather than trusting that it is.

---

## S6 — Does changing the rule actor to the requesting user alter rule-permission behaviour?

**Status:** ☐ open  **Answer:**  **Depends on:** S1

### Why it matters

In Jira Automation the **actor** is the identity the rule's actions execute as.
Change the actor and you change what the rule is *permitted* to do. The service
account may be able to transition issues in a project where the requester
cannot.

So Q6's audit-trail improvement could buy a rule that creates cleanly and then
fails at runtime on permissions — which, again, lands as silent absence rather
than a loud error.

The current code defaults the actor from an environment variable:

```js
// src/index.js — normalizeFullPayload()
if (!rule.actor) { rule.actor = { type: 'ACCOUNT_ID', actor: actorAccountId }; }
if (!rule.authorAccountId) { rule.authorAccountId = actorAccountId; }
```

### Method

Create two rules in the same project — one with each actor — using the same
trigger and the same action. Enable both, fire both, compare the Automation
audit logs.

Rules are created `DISABLED` by design, so enabling is a deliberate manual step
here; disable or delete both when the spike is done.

### Record

- Service-account rule outcome:
- Requester-actor rule outcome:
- Divergence observed? ☐ yes ☐ no — where:

### What changes on the answer

- **No divergence:** Q6 proceeds unchanged.
- **Divergence:** either keep the service account as the actor and record the
  requester separately in the ledger, or accept that rules only function where
  the requester holds the rights. The first preserves capability; the second
  preserves attribution. They cannot both be had from one field.

---

## S7 — Can Jira automation's "Use Rovo agent" run our agent headlessly and call this app's actions?

**Status:** ☐ open  **Answer:**

### Why it matters

Both revision (after **Request Changes**) and creation (after **Approved**)
are event-initiated: a Jira automation rule in AUTOAPR runs the custom agent
with the ticket key. Three things must all be true, and none is confirmed on
this site: the action exists on this plan, it can target a *custom* agent, and
an agent invoked this way (no human in the chat) is allowed to call a
`rovo:mcp` action.

### Method

1. In AUTOAPR's automation, add a rule: *Transitioned to Changes Requested* →
   *Use Rovo agent* (custom agent), prompt from
   [rovo-agent-instructions.md](../rovo-agent-instructions.md).
2. Request changes on a test ticket with a comment.
3. Read the rule's audit log and `forge logs -e development --since 15m`.

### Record

- Action available? ☐ yes ☐ no — plan/edition:
- Custom agent selectable? ☐ yes ☐ no
- `revise-automation-rule-draft` invoked? ☐ yes ☐ no
- `create-approved-automation-rule` invoked on Approved? ☐ yes ☐ no
- What `.asApp()` calls in the action logged (any auth error?):
- Did the comment smart value render?

### What changes on the answer

- **Works:** the loop is fully automatic.
- **Fails:** revision and creation become human-initiated (the user asks Rovo
  to "revise AUTOAPR-n" or "create AUTOAPR-n"). Neither action needs a code
  change: both check the live ticket rather than who called them.

---

## S8 — Is the creation claim's error code what we expect?

**Status:** ☐ open (narrowed 2026-10-08)  **Answer:**

The event-delivery questions this section used to ask are retired: the
`avi:jira:updated:issue` trigger was removed when creation moved to the
`create-approved-automation-rule` action
([ADR 0001](../adr/0001-agent-triggers-creation-of-frozen-draft.md)). One
question remains.

### Why it matters

`draftStore.claimCreation` treats ANY error from the `FAIL_IF_EXISTS` write as
a lost claim. That fails closed, but a transient storage error is then
indistinguishable from "someone else is creating", and the ticket is left for a
human. Knowing the real error code would let the logs say which happened.

### Method

On a test ticket, call `create-approved-automation-rule` twice in quick
succession (e.g. ask the agent twice). Read `[draft-store] creation claim ...
not acquired` in `forge logs -e development --since 15m`.

### Record

- KVS error `code` when the claim loses:

---

## S9 — Do attachments upload, and does the changelog name the approver?

**Status:** ☐ open (opened 2026-10-08)  **Answer:**

### Why it matters

| Assumption | If wrong |
|---|---|
| Jira accepts the hand-built multipart body from `requestJira` (Forge's `RequestInit.body` has no `FormData`, verified in `@forge/api` 8.2.0 types) | every draft carries a "could not be attached" warning; the draft itself still works |
| The changelog entry for an Approve click via the workflow UI has `author.accountId` = the clicking user | every approval fails closed ("not in APPROVER_ACCOUNT_IDS (unknown)") |
| The status item's `to` is the status **ID** (not the name) | every approval fails closed ("shows no move to Approved") |
| Changelog `created` and the Forge runtime clock agree to within seconds | an approval made seconds after a revise could be refused as "older than the draft" |

### Method

1. Draft a rule. Check the ticket for `draft-v1-<digest8>.json` and open it.
2. Approve it via the UI. Before the create runs, read the history:
   `GET /rest/api/3/issue/AUTOAPR-n/changelog` (as yourself, in a browser).
3. Read `[create-approved]` lines in the Forge logs.

### Record

- Attachment uploaded? ☐ yes ☐ no — HTTP status if not:
- Approval entry `author.accountId` = the approver? ☐ yes ☐ no
- Status item: `field` / `fieldId` = , `to` is an ID? ☐ yes ☐ no

### What changes on the answer

- Upload fails → try an `ArrayBuffer` body built with `TextEncoder`; if that
  also fails, drop the attachment and put the JSON back in the comment.
- `to` is a name → match on `toString` against the status name instead (less
  robust; renaming the status breaks it).
- No author → approvals cannot be verified in code; fall back to the workflow
  condition alone and record that decision as an ADR.

---

## Cleanup checklist

- [ ] Remove every `[spike]` log line and the second-parameter logging from
      `src/index.js`
- [ ] Remove the deliberate 50s delay
- [ ] Remove the throwaway post function and its `manifest.yml` entry
- [ ] `forge lint`
- [ ] Disable or delete both S6 test rules
- [ ] Transcribe each answer above into
      [agent-trust-boundary.md](../ideas/agent-trust-boundary.md)
