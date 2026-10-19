# Jira Automation Rule Builder

This Forge app lets a Rovo agent create Jira automation rules, with a human
approval in front of every one. The agent extracts a small `ruleSpec` from the
user's prompt or an attached document. The app builds the exact Automation API
payload, enforces `DISABLED` state and project-scope alignment, raises an
approval ticket, freezes the payload in Forge storage and attaches a redacted
copy to the ticket. Once the ticket is approved, the agent calls
`create-approved-automation-rule` with the ticket key. The app checks the
approval in the ticket's history, creates the frozen rule through the
Automation Rule Management API, verifies it with a follow-up GET, and comments
the result on the ticket. The agent chooses *when* the rule is created, never
*what* is created.

```
Rovo agent ──draft──> approval ticket (Pending) + draft attached
                     → labelled ready-for-review ──Teams heads-up──> manager
  Approve          → Jira automation runs the agent → create-approved-automation-rule
                     → rule created DISABLED, "Rule created" comment
  Request Changes  → Jira automation runs the agent → Draft v2 → Pending
  Reject           → nothing created
```

A complete Automation API payload (`{ "rule": { ... } }`) is also accepted as
`ruleSpec`, for already-validated rules.

## Deploy locally with PowerShell

Forge CLI authentication is separate from the app's `AUTOMATION_API_EMAIL` and
`AUTOMATION_API_TOKEN` runtime credentials below. Log in to the CLI once with a
Forge-scoped Atlassian API token:

```text
forge login
```

Forge CLI saves the login in the operating system's credential store. From the
project root, lint first and deploy to the development environment only if
lint succeeds:

```powershell
forge lint && forge deploy --non-interactive -e development
```

Neither command needs credentials passed on the command line. If Forge
prompts for credentials again, check that the CLI is running as the same
Windows user and outside an environment without access to the Windows
credential store, such as WSL or a container.

For environments without a usable credential store, Forge CLI also supports
`FORGE_EMAIL` and `FORGE_API_TOKEN` environment variables. Use a secrets store
to provide them in CI; do not add tokens to this repository, scripts, or
command-line arguments. When set, these variables take precedence
over credentials saved in the local credential store.

## Configure credentials

Use Node.js 22.x or 24.x for the Forge CLI. Node.js 20 is unsupported by the
current Forge CLI and can cause its linter to fail inside the CLI's own
`archiver` dependency before it checks this app.

Set these as encrypted Forge environment variables. Never put the API token in
the Rovo prompt, action input, source code, or manifest:

- `AUTOMATION_API_EMAIL`: Atlassian account email used for Basic Auth.
- `AUTOMATION_API_TOKEN`: Atlassian API token. Keep it encrypted and rotate it
  if it has ever been exposed.
- `JIRA_CLOUD_ID`: required site cloud ID. The handler is pinned to this site
  and never accepts a cloud ID from the request or Rovo context.

Use the Forge CLI's encrypted variable command for the development environment:

```text
forge variables set --encrypt AUTOMATION_API_EMAIL <your-email> --environment development
forge variables set --encrypt AUTOMATION_API_TOKEN <your-classic-token> --environment development
forge variables set --encrypt JIRA_CLOUD_ID <your-cloud-id> --environment development
```

The angle-bracket values above are command-line notation and must be replaced
with real values; do not commit them to this repository.

## Set up the approval workflow

These steps are done once, by a Jira admin, in the Jira UI.

1. **Project.** Approval tickets live in **SOCAIAutomation** (key `SOC`, id 10086),
   the same project the created rules are scoped to. Add a dedicated issue type
   for rule requests (for example "Automation Request") so that:
   - approvals get their own workflow and SOC's incident workflow is untouched;
   - the Jira automation rules below can be limited to that issue type;
   - approved rules can exclude it (issue type ≠ Automation Request), so a rule
     that fires on SOC issues does not also fire on approval tickets.

   The app sends **no assignee**, so Jira's project default applies (on SOC,
   the project lead). Any member of the approver group can pick a ticket up.
   Being the assignee grants nothing.
2. **Workflow.** Give that issue type this workflow. These are the names on
   SOC ("LDX Automation Spec-Build Workflow") and the setup script's defaults;
   other sites can use other names and pass them to the script:

   | From | Transition | To | Who |
   |---|---|---|---|
   | Pending | pending approval | Approved | approvers only (workflow condition) |
   | Pending | request changes | Change Request | approvers only |
   | Pending | rejected | Declined | approvers only |
   | Change Request | resubmit pending | Pending | the app (and admins) |
   | Approved | Automation built | Done | after the rule is enabled |
   | Declined | automation not built | Done | |

   The way back from Change Request must be ONE transition straight to Pending:
   the app makes exactly one transition after storing a revised draft, so a
   middle status would leave the ticket where nobody can approve it. Add a
   comment field to the request changes transition screen, so the manager's
   feedback is saved with the transition.
3. **Notify the manager.** The app marks the ticket ready once the draft is
   attached; the Teams message is set up as described in
   [Manager notification (Teams)](#manager-notification-teams).
4. **Revise on Request Changes.** Add a second rule: *Transitioned to Change
   Request*, then *Use Rovo agent* with the custom agent and the revise prompt
   in [docs/rovo-agent-instructions.md](docs/rovo-agent-instructions.md). If
   this action is not available (spike S7), the requester asks Rovo to "revise
   SOC-n" instead.
5. **Create on Approved.** Add a third rule: *Transitioned to Approved*, then
   *Use Rovo agent* with the create prompt from the same file. The agent passes
   only the ticket key; the app creates the stored draft. Without *Use Rovo
   agent*, the requester asks Rovo to "create SOC-n". Calling it twice is
   safe: the second call reports the rule that already exists.
6. **Rovo Studio.** Replace the agent's instructions with the block in
   [docs/rovo-agent-instructions.md](docs/rovo-agent-instructions.md).
7. **Approver group.** Create a Jira group for approvers (for example
   `soc-automation-approvers`), add the approvers, and note its **group ID**
   (Jira admin → User management → Groups, or `GET /rest/api/3/group/bulk`).
   Adding or removing an approver is then a Jira admin task with no redeploy.
   Whoever can edit this group decides who may approve rule creation, so keep
   it admin-managed. Use the same group in the workflow's Approve condition.
8. **Forge variables.** The setup script checks the values on the site and
   then sets all six. Create `.env` in the repo root (it is git-ignored) with
   a Jira login that can browse the project and its groups:

   ```text
   JIRA_SITE_URL=https://<your-site>.atlassian.net
   JIRA_EMAIL=<your Atlassian email>
   JIRA_API_TOKEN=<token from id.atlassian.com > Security > API tokens>
   ```

   Then run it with the approver group ID. The workflow names default to the
   ones above; override any of them with `--project`, `--issue-type`,
   `--approved`, `--changes-requested`, `--resubmit` or `--env`:

   ```text
   npm run setup -- --group <group-id>
   forge deploy --non-interactive -e development
   ```

   Nothing is set unless every name and the group are found. The resubmit
   transition is checked by the app on each ticket instead. To set the values
   by hand, use the names exactly as they appear in the workflow (case and
   outer spaces are ignored):

   ```text
   forge variables set APPROVAL_PROJECT_KEY SOC --environment development
   forge variables set APPROVAL_ISSUE_TYPE_NAME "Automation Request" --environment development
   forge variables set APPROVED_STATUS_NAME Approved --environment development
   forge variables set CHANGES_REQUESTED_STATUS_NAME "Change Request" --environment development
   forge variables set RESUBMIT_TRANSITION_NAME "resubmit pending" --environment development
   forge variables set APPROVER_GROUP_ID <group-id> --environment development
   ```

   The app looks the IDs up on every call, so the same values work on any
   site. A name that matches nothing, or matches two things, is refused by
   variable name rather than guessed. Renaming a status or transition means
   updating its variable (and redeploying, as for any Forge variable change).
   See [ADR 0002](docs/adr/0002-approval-config-by-name-and-group.md).
   The approver group is checked in code as well as in the workflow: the
   app reads the ticket's changelog to find who moved it to Approved, checks
   that person is in the group **at creation time**, and refuses an approval
   made before the latest draft version was stored. A
   requester may approve their own request; the result comment labels this
   "self-approved". Rejected tickets need no variable: the app simply never
   creates anything for a ticket that is not Approved.

The app needs the `read:jira-work`, `read:jira-user` (approver group checks),
`write:jira-work` and `storage:app` scopes,
so after the first deploy with them the installation must be **upgraded**
(`forge install --upgrade ...` below). A redeploy alone keeps the old
permissions.

## Manager notification (Teams)

The manager gets a Teams card when an approval ticket is **ready**: the ticket
exists and the draft JSON is attached. `draft-automation-rule` calls
`src/mark-request-ready.js` right after the upload, so this never depends on
the agent remembering a step. A ticket without an attachment is never marked.
Revisions (Draft v2+) keep the labels and send nothing new.

There are two paths. Both stay ready, and the Jira project property
`request-notify-mode` on SOC picks one **on every call**:

| Mode | What the app does | Who posts to Teams |
|---|---|---|
| `rule` (default; also used when the property is missing, invalid or unreadable) | adds `ready-for-review` | a Jira automation rule on SOC: trigger *labels changed*, JQL condition `labels = "ready-for-review" AND labels != "teams-notified"`, *Send web request* to the Power Automate flow, then add label `teams-notified` |
| `webhook` | posts the card to the flow, then adds `ready-for-review` **and** `teams-notified` in one update | the app |

Both labels go on in one update in webhook mode, so the Jira rule's
`labels != "teams-notified"` check skips the ticket and nobody gets two
messages. The rule's trigger still fires, so its audit log shows a run with
no actions. That is expected.

**Flip the switch** (no redeploy; needs SOC project admin):

```text
PUT https://api.atlassian.com/ex/jira/{cloudId}/rest/api/3/project/SOC/properties/request-notify-mode
Content-Type: application/json

"webhook"
```

The body is a JSON string, so the quotes are part of it. Send `"rule"` to
switch back. The mode lives in a Jira property rather than a Forge variable
because variable changes only take effect after a redeploy.

**Arm webhook mode once.** Set the flow URL as an encrypted variable. It is
the flow's password, so never put it in the repo, a ticket or chat. Then
deploy and upgrade the install, because the manifest adds an egress host:

```text
forge variables set --encrypt -e development TEAMS_WEBHOOK_URL <flow-url>
forge variables set -e development JIRA_SITE_URL https://<site>.atlassian.net
forge lint
forge deploy --non-interactive -e development
forge install --non-interactive --upgrade --site <site>.atlassian.net --product jira --environment development
```

In webhook mode, if either variable is missing, the ticket is left
unmarked and the draft message says so. If you settle on the rule path,
remove the Power Automate egress entry from `manifest.yml` and redeploy, so
the app cannot call Microsoft at all.

**Things that bite:**
- Jira's *Send web request* must send the header `Content-Type: application/json`.
  Without it the flow rejects the call with a 400 about `application/octet-stream`.
- The flow answers **202 Accepted** as soon as it queues the request. A green
  result in Jira, or `marked: true` from the app, only means the flow **accepted**
  it; it never proves Teams showed the card. Check the flow's run history in
  Power Automate.
- In rule mode the URL lives hidden inside the Jira rule, and it is lost when
  the rule is exported or duplicated. Give the flow a co-owner so it survives
  one person leaving.
- In webhook mode a failed post adds no labels. If the post was accepted but
  the label update failed, the result has `notificationSent: true` and the
  app does **not** retry, because a retry would post twice.
- **To retest** on the same ticket, remove **both** labels, then trigger a
  new draft. The marker only runs inside `draft-automation-rule`.

Out of scope: a second manager, approve/reject buttons on the card, and
automatic fallback from webhook to rule.

## Deploy and connect the tool

Run these commands from the project root:

```text
forge lint
forge deploy --non-interactive --e development
```

Install or upgrade the app on the Jira site where the Rovo Agent will use it:

```text
forge install --non-interactive --upgrade --site <your-site>.atlassian.net --product jira --environment development
```

After deployment, add the published **Jira Automation Rule Tools** tool to the
Rovo Agent in Rovo Studio and use the instructions in
[docs/rovo-agent-instructions.md](docs/rovo-agent-instructions.md). The agent
extracts the user's request into `ruleSpec` rather than inventing the full
Automation API JSON. A minimal specification looks like this:

```json
{
  "name": "Notify on priority changes",
  "projectName": "SOCDemo",
  "trigger": {
    "type": "jira.issue.field.changed",
    "fields": ["priority"],
    "changeType": "ANY_CHANGE"
  },
  "conditions": [{
    "type": "jira.comparator.condition",
    "value": {
      "first": "{{issue.priority.name}}",
      "second": "Low",
      "operator": "EQUALS"
    }
  }],
  "actions": [{
    "type": "codebarrel.action.log",
    "value": "Priority is low"
  }]
}
```

The safe builder supports every component type in `src/component-library.js`
(call `get-component-reference` for the live list). Each shape was copied from
a real rule on the site, most of them found with:

```bash
node --env-file=.env scripts/find-component-examples.js --survey > survey.json
```

which scans every rule (read-only) and lists the trigger, condition, action
and field types that are in use but not yet supported. A document can contain the business
request in any prose format; the agent's job is to populate this small
specification. The project is named by its display name in `projectName`; the app looks it
up with the Jira project search and refuses a name that matches no project or
more than one. A numeric `projectId` is still accepted (older drafts); if both
are sent they must be the same project.

### Jira number fields and decimal minutes

Jira's `Response Time` field in this site is `customfield_11639`, a numeric
float; `Time to first response` is the SLA field `customfield_10049`. When
`jira.issue.edit` sets a float field, the builder puts its value in the
action's `advancedFields`, using the raw numeric/math-expression format shown
in `sample-jira-auto-rules/Status-Phase-Calc.txt`. Finite numeric values, bare
smart values, and smart-value math expressions are accepted. The builder adds
the outer `{{#=}}...{{/}}` block when it is omitted. Values such as
`"2.5 minutes"` are deliberately rejected because a number field must receive
a number.

`actions[].value.fields` accepts either the original array form or a compact
field-name/field-ID map. Prefer an ID when it is known because IDs are stable
and unambiguous. These are equivalent:

```json
[{ "name": "Time Taken at Open Phase", "value": "{{minutesToAdd}}" }]
```

```json
{ "customfield_11594": "{{minutesToAdd}}" }
```

Jira math functions are supported. For example, the changelog-based timing
rule can round the accumulated decimal-minute value without manually adding
the outer Jira math block:

```text
ROUND({{issue.customfield_11594|0}} + ({{durationMillis}} / 60000), 2)
```

For an SLA completion rule, the intended conversion is elapsed milliseconds
divided by `60000`, producing decimal minutes. For example, the field value
can be specified as:

```text
{{#=}}{{issue.customfield_10049.completedCycles.last.elapsedTime.millis}} / 60000{{/}}
```

The project field export confirms the two field IDs and types, and the local
rule sample confirms the numeric `advancedFields` expression format. The exact
SLA smart-value property path above is based on the SLA cycle structure and
should be confirmed with a test issue's Automation audit log on the target
site; Atlassian's published smart-value reference does not enumerate this
SLA-specific path. The general formats are documented in Atlassian's
[advanced field editing guide](https://support.atlassian.com/cloud-automation/docs/advanced-field-editing-using-json/)
and [math expressions guide](https://support.atlassian.com/cloud-automation/docs/jira-smart-values-math-expressions/).

The Jira Automation UI currently sends the issue-created trigger as a value
containing `eventKey: "jira:issue_created"` and `issueEvent: "issue_created"`,
with project scope carried separately by the rule scope. The builder mirrors
that shape. An optional `trigger.events` value is passed through when supplied,
but its public API shape is not yet confirmed.

For a `jira.issue.field.changed` trigger, provide each field in
`trigger.fields` as a Jira field-name string (for example, `"Assignee"`); the
builder also accepts `{ "name": "Assignee" }` and normalizes it to the API
shape used by the captured rule exports.

The action rejects enabled rules, missing project scope, mismatched trigger
filters, missing credentials, malformed JSON, and API responses other than the
confirmed create status `201` or verification status `200`. The follow-up
verification checks the disabled state, project scope, trigger type, and that
the requested condition/action component values are present in the retrieved
rule.
