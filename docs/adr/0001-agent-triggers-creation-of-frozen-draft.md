---
status: accepted
---

# The agent triggers creation, but only of the frozen, approved draft

The agent must be the one that creates the automation rule: the work is meant to show an agent doing the job, with a human approval gate in front of it. We gave it a `create-approved-automation-rule` action whose only input is the Approval ticket key. The app creates the draft frozen in Forge storage, and only after Jira's changelog shows that an allowlisted Approver moved the ticket to Approved after the latest Draft version was stored. The agent decides *when* creation happens, never *what* is created, so what the human approved is exactly what exists.

## Considered Options

- **A Forge event trigger creates the rule on Approved, and the agent never creates anything.** This was built first. It is the tighter design, because the agent has nothing to claim. It was rejected because the requirement is that the agent creates.
- **The agent re-sends the full rule spec at creation, and the app refuses unless its digest matches the approved draft.** Rejected. It lets the agent's words reach the create path again, and a rebuild can legitimately differ from the approved payload because site field metadata changes between approval and creation.
- **The agent sends anything, and the app only checks that the ticket is Approved.** Rejected. The manager would be approving a description, not a payload, so the gate would be cosmetic.

## Consequences

- The fabricated-success risk returns in chat, because the agent can now say "created". The app's own ticket comment and the code-written `message` are the record of truth, and the agent is told to relay that message word for word.
- Without the event, the app no longer learns who approved for free. It reads the ticket changelog instead, which adds the "approval newer than the draft" check that the event made implicit.
- Agents retry tool calls, so the atomic Creation claim and "answer a repeat call from the stored outcome" are load-bearing, not defensive extras.
- A headless "Use Rovo agent" automation rule wakes the agent on Approved (spike S7). If that is unavailable, the Requester asks the agent in chat.
