# Jira Automation Rule Builder

A Rovo agent drafts Jira automation rules from plain-language requests, a manager approves each one on a Jira ticket, and the agent then creates exactly the approved rule, disabled.

## Language

### People

**Requester**:
The person who asked the agent for a rule. They become the reporter of the Approval ticket.
_Avoid_: user, author, submitter

**Approver**:
A person allowed to approve an Approval ticket, listed by account ID in the app's configuration.
_Avoid_: manager (a role, not a permission), reviewer

**Assignee**:
The Approver the Approval ticket was sent to, so that they are notified. It grants nothing: only an Approver on the allowlist moving the ticket to Approved (per its changelog) authorises creation.
_Avoid_: owner, approver (when you mean the assignee)

**Self-approval**:
An approval where the Requester and the Approver are the same person. It is allowed, and recorded on the ticket.

### The approval

**Approval ticket**:
The Jira issue in the approvals project that carries one requested rule through review. Its key names the rule it produces.
_Avoid_: request, approval, AUTOAPR issue

**Approved**:
The Approval ticket's live Jira status meaning an Approver accepted the current Draft version. Jira's status and changelog are the only record of human decisions (approve, reject, request changes).
_Avoid_: accepted, signed off

**Draft**:
A proposed automation rule, built and validated but not yet created, attached to one Approval ticket.
_Avoid_: proposal, spec, pending rule

**Draft version**:
One revision of a Draft. Each Request Changes produces the next version, and only the latest can be created.

**Frozen draft**:
The exact rule payload of the latest Draft version, held in app-only storage. It is what gets created, byte for byte, and is never rebuilt after approval.
_Avoid_: stored rule, saved payload

**Digest**:
The fingerprint of a Frozen draft, shown on the Approval ticket, so the draft shown and the draft created can be proven to be the same.
_Avoid_: hash, checksum

**Rule spec**:
The small JSON description of a rule that the agent writes and the app expands into a full payload. It is the contract between whatever drafts and everything that follows.
_Avoid_: payload (that is the expanded form), rule JSON

### Creation

**Creation claim**:
The single, atomically taken right to create the rule for one Approval ticket. Whoever takes it is the only one that may create; nobody can take it twice.
_Avoid_: lock, idempotency key

**Needs attention**:
The outcome of a Draft whose creation was refused or failed after checks ran. It ends that Draft; a human decides what happens next.
_Avoid_: failed, error state
