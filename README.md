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
Rovo agent ──draft──> approval ticket (Pending Approval) ──Teams──> manager
  Approve          → Jira automation runs the agent → create-approved-automation-rule
                     → rule created DISABLED, "Rule created" comment
  Request Changes  → Jira automation runs the agent → Draft v2 → Pending Approval
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

   Put the **Assignee** field on that issue type's create screen, and give
   requesters the **Assign Issues** permission in SOC: the app assigns the
   ticket to the approver when it raises it, and Jira rejects the whole create
   request otherwise. The assignee is who gets notified, not who may approve.
2. **Workflow.** Give that issue type this workflow:

   | From | Transition | To | Who |
   |---|---|---|---|
   | Pending Approval | Approve | Approved | approvers only (workflow condition) |
   | Pending Approval | Request Changes | Changes Requested | approvers only |
   | Pending Approval | Reject | Rejected | approvers only |
   | Changes Requested | Resubmit | Pending Approval | the app (and admins) |
   | Changes Requested | Reject | Rejected | approvers only |

   Approved and Rejected are final. Add a comment field to the Request Changes
   transition screen, so the manager's feedback is saved with the transition.
3. **Notify the manager.** Add a Jira automation rule to SOC, limited to
   the rule-request issue type: *Issue created* or *Transitioned to Pending Approval*, then *Send web request* to a
   Microsoft Teams **Workflows** webhook (Teams → Workflows → "Post to a channel
   when a webhook request is received"). The message can name the approver
   with `{{issue.assignee.displayName}}`. The webhook URL works as a password:
   keep it only in the rule and never commit it. If your tenant blocks Workflows,
   use *Send email* instead.
4. **Revise on Request Changes.** Add a second rule: *Transitioned to Changes
   Requested*, then *Use Rovo agent* with the custom agent and the revise prompt
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
7. **Forge variables.** Find the IDs (Jira settings → Issues → Statuses, or
   `GET /rest/api/3/issue/{key}/transitions` on a test ticket) and set:

   ```text
   forge variables set APPROVAL_PROJECT_KEY SOC --environment development
   forge variables set APPROVAL_ISSUE_TYPE_ID <issue-type-id> --environment development
   forge variables set APPROVED_STATUS_ID <id> --environment development
   forge variables set CHANGES_REQUESTED_STATUS_ID <id> --environment development
   forge variables set RESUBMIT_TRANSITION_ID <id> --environment development
   forge variables set APPROVER_ACCOUNT_IDS <accountId>[,<accountId>] --environment development
   ```

   IDs rather than names, so renaming a status cannot silently break approvals.
   `APPROVER_ACCOUNT_IDS` is checked in code as well as in the workflow: the
   app reads the ticket's changelog to find who moved it to Approved, and
   refuses an approval made before the latest draft version was stored. A
   requester may approve their own request; the result comment labels this
   "self-approved". Rejected tickets need no variable: the app simply never
   creates anything for a ticket that is not Approved.

The app needs the `read:jira-work`, `write:jira-work` and `storage:app` scopes,
so after the first deploy with them the installation must be **upgraded**
(`forge install --upgrade ...` below). A redeploy alone keeps the old
permissions.

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
  "projectId": "10001",
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
    "value": {"text": "Priority is low"}
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
specification. The `projectId` still needs to be identifiable in the
prompt/document or supplied by the agent from Jira context.

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
