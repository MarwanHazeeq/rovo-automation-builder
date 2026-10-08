# Approval-Gated Rule Drafting

> Status: building · 2026-10-07, revised 2026-10-08 · supersedes the ledger,
> global page and measurement phases of [agent-trust-boundary.md](agent-trust-boundary.md).
> The echo receipt from that design is kept. 2026-10-08: the agent, not an
> event trigger, now creates the approved rule; see
> [ADR 0001](../adr/0001-agent-triggers-creation-of-frozen-draft.md).

## Problem Statement

**How might we** let an agent build and create automation rules from plain
language, so that a **human approves the exact rule** before it exists, and
nothing the agent says can change what was approved?

## Recommended Direction

**The agent drafts, a human approves, the agent creates exactly what was
approved.** When drafting, the app validates the rule, raises a ticket in a
dedicated approvals project, freezes the exact Automation API payload in Forge
storage and attaches a redacted copy. A Teams message (sent by a plain Jira
automation rule) tells the manager. When the ticket moves to **Approved**, a
Jira automation rule wakes the agent (*Use Rovo agent*), which calls
`create-approved-automation-rule` with only the ticket key. The app confirms
the approval in the ticket's changelog (an allowlisted approver, after the
latest draft version), creates the frozen rule DISABLED, and posts the result
as an app-authored comment. **Request Changes** wakes the agent the same way
to revise and resubmit. **Reject** ends it.

This replaces most of the trust-boundary design because the approval ticket
*is* the non-agent surface: the manager approves a code-rendered draft, not
the agent's prose, so silent input rewrites (#4) are caught by a human. The
agent decides *when* creation happens, never *what* is created. Fabricated
success (#3) is possible again in chat, so the app's own ticket comment and
code-written `message` are the record of truth. The ticket's history is the
ledger.

The drafter sits behind a fixed contract, the `ruleSpec` JSON. Everything after
it is deterministic code, so a different drafter (a Foundry model, or a human
pasting JSON) can be swapped in later without touching the approval path.

## Key Assumptions to Validate

- [ ] **"Use Rovo agent" exists on this site's plan and can call this app's
      actions headlessly.** *Test:* spike S7. Fallback: the user tells Rovo
      "revise AUTOAPR-n" or "create AUTOAPR-n".
- [ ] **The ticket changelog names the approver and the target status ID.**
      *Test:* spike S9. Without the author, every approval fails closed.
- [ ] **Jira accepts the hand-built multipart attachment.** *Test:* spike S9.
      Without it, drafts carry a warning and the comment summary only.
- [ ] **The tenant allows a Teams Workflows webhook.** *Test:* create one.
      Fallback: Jira email notification.
- [ ] **`.asUser()` works inside a Rovo action** (the user has granted the app
      access). *Test:* first end-to-end run.

## MVP Scope

**In:** `draft-automation-rule`, `revise-automation-rule-draft` and
`create-approved-automation-rule` actions; frozen drafts plus an atomic
creation claim in Forge KVS; code-rendered ticket comments and redacted draft
attachments; the AUTOAPR project, workflow and three Jira automation rules
(notify, revise, create), set up by hand.

**Out:** everything in "Not Doing".

## Not Doing (and Why)

- **A global page / ledger UI.** The ticket and its comments already show
  every draft, decision and outcome, written by code.
- **Foundry / a smarter model.** A human gate catches bad drafts; a better
  drafter can plug in behind `ruleSpec` later if drafts are often rejected.
- **Letting the manager edit the draft JSON.** Edits would bypass validation;
  Request Changes sends every change back through the same checks.
- **Separation of duties.** The requester may approve their own request (an
  explicit decision for an internal, me-and-my-manager tool). It is labelled
  "self-approved" on the ticket rather than blocked. Revisit before customers
  use this.
- **Auto-enabling rules.** Invariant 1 stands: a human enables every rule.
- **A post function on the Approve transition.** It is a preview module with
  undocumented sync/rollback behaviour (spike S4/S5), and the agent must be
  the one that creates.
- **An event trigger that creates on Approved.** Built first, then removed:
  the requirement is that the agent creates (ADR 0001).
- **Letting the agent pass rule content at creation.** The create action takes
  a ticket key only; the approved, frozen draft is what gets created.

## Open Questions

- After an approved rule fails to create (NEEDS_ATTENTION), what is the human
  procedure? Today: read the comment, check the project's rules, raise a new
  request. A scheduled sweep for "Approved but never created" could follow.
- Should the rule's actor become the requester (spike S1/S6) now that the
  requester's identity is recorded on the ticket anyway?
