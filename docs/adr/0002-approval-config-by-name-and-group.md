---
status: accepted
---

# Approval config is resolved from names, and approvers are a Jira group

The six approval variables used to be raw Jira IDs plus a static list of approver account IDs, so any change (a new approver, a workflow rebuilt with new IDs, a new customer site) meant finding IDs by hand and redeploying. Now the issue type, statuses and resubmit transition are configured by **name** and resolved to IDs on every call (`resolveApprovalConfig`, `findTransitionId` in `src/approval-config.js`). Approvers are the members of the Jira group `APPROVER_GROUP_ID`, checked at creation time. The app sends no assignee on Approval tickets; Jira's project default applies.

## Considered Options

- **Keep IDs.** Rejected: setup per site is error-prone and every change needs a redeploy.
- **Hard-coded names in code.** Rejected: every customer would have to use our exact names.
- **Infer the statuses from the workflow's shape.** Rejected: too fragile and too magic for an authorisation check.
- **Approvers from a project role.** Rejected in favour of a group: project admins could grant themselves approval.

## Consequences

- Renaming a status or transition breaks the flow until its variable is updated (and the app redeployed, as for any Forge variable change). It fails closed: zero or several matches are refused by variable name, never guessed.
- **Trust boundary widened on purpose.** Whoever can edit the approver group (site/org admins, and group admins if delegated) can grant themselves the right to approve rule creation, without a deploy. Keep the group admin-managed.
- Membership is checked when the rule is created, not when the ticket was approved: removing someone from the group revokes their pending approvals.
- New scope `read:jira-user` (group membership), so the app needs a reinstall after deploy. The app (`.asApp()`) must be able to read group membership; this is unconfirmed on the site.
- One to two extra Jira GETs per action. No caching, because Forge invocations are short-lived.
- The app no longer chooses an assignee, so the manager notification must target the approver group or channel, not an assignee.
