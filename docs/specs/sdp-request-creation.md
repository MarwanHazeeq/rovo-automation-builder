# SDP request creation: spec for the Rovo agent

Acceptance-test input for issue #7. Hand this document to the deployed agent
as the request. Expected outcome: ONE rule, created DISABLED, with the setup
steps first, then two sibling branches (accepted, rejected), and a nested
branch inside the accepted one. The hand-written equivalent is
`test/sdp-acceptance.test.js`; the source rule is
`sample-jira-auto-rules/SDP-Jira.txt`.

## Request

Create one automation rule in project SOC (or the test project) that mirrors
a Jira incident into a customer's ManageEngine ServiceDesk Plus (SDP)
instance. Name it "SDP request creation".

### Credentials: read this first

Every secret below is a placeholder written in angle brackets, for example
`<SDP_CLIENT_SECRET>`. Pass each one into the rule exactly as written,
character for character. Never invent, guess or "improve" a value. A human
replaces them in the Jira UI before the rule is enabled, which is why the
rule is created disabled.

| Placeholder | Where it goes |
| --- | --- |
| `<SDP_CLIENT_ID>` | query of the `ClientID` variable |
| `<SDP_CLIENT_SECRET>` | query of the `ClientSecret` variable |
| `<SYNC_AUTH_KEY>` | value of the `Auth-Key` header on the sync-service call |

A web-request URL is NOT one of these placeholders, and must never be written
as one. Jira validates every web request's URL when the rule is created, even
though the rule is created disabled, and rejects the whole rule with
"Please enter a valid web request URL" if any of them is not a real URL.
So the token and SDP hosts below are the real ones (public vendor hostnames,
not secrets), and the sync-service URL — which does carry a signature — is a
syntactically valid stand-in on the reserved `.invalid` domain, which a human
replaces before enabling. It parses as a URL and can never resolve to
anything real.

### Trigger

Field changed, on the field "Send to Customer ITSM".

The rule must only act when the ticket is flagged for forwarding
("Send to Customer ITSM" equals "Yes") AND no SDP request id is recorded yet
(the "Customer ITSM Incident" field is empty). These two checks gate
everything below. Put them in `trigger.conditions`, on the trigger itself, so
they guard the setup steps; do not move the setup steps inside a branch.

### Setup steps (run every time, in this order, before any branch)

1. Variable `ClientID` = `<SDP_CLIENT_ID>`.
2. Variable `ClientSecret` = `<SDP_CLIENT_SECRET>`.
3. Token request: POST `https://accounts.zoho.com.cn/oauth/v2/token`, header
   `Content-Type: application/x-www-form-urlencoded`, custom body
   `client_id={{ClientID}}&client_secret={{ClientSecret}}&grant_type=client_credentials&scope=SDPOnDemand.requests.ALL`.
4. Variable `AuthToken` = `Bearer {{webResponse.body.access_token}}`.
5. Lookup table `SiteMap` mapping the Jira site code in the customfield used
   for the customer site to the SDP site name. Use two entries:
   `<SITE_KEY_1>` to `<SDP_SITE_1>` and `<SITE_KEY_2>` to `<SDP_SITE_2>`.
6. Variable `SDPSite` = `{{SiteMap.get(issue.customfield_10257)}}`.
7. Lookup table `PriorityMap`: Informational to P3, Low to P3, Medium to P2,
   High to P1, Critical to Urgent.
8. Variable `SDPPriority` = `{{PriorityMap.get(issue.priority.name)}}`.
9. Audit log write: `{{SDPPriority}}`.
10. Variable `sdppayload` = a JSON object
    `{"request":{"subject":"{{issue.summary.jsonEncode}}","description":"{{issue.description.jsonEncode}}","udf_fields":{"udf_char31":"{{issue.key}}"}}}`.
11. Audit log write: `{{sdppayload}}`.
12. SDP request: POST `https://servicedeskplus.cn/api/v3/requests`, headers
    `Content-Type: application/x-www-form-urlencoded` and
    `Accept: application/vnd.manageengine.sdp.v3+json`, custom body
    `input_data={{sdppayload.urlEncode}}`, with authentication switched on
    (the app adds the Authorization header placeholder; a human sets it to
    `{{AuthToken}}` before enabling). Never send an Authorization header
    yourself.
13. Wait 5 seconds.

That is 13 steps, all at the top level of the rule.

### Branches on the SDP response

Two sibling branches after the setup steps. The rejected branch is the last
and is checked after the accepted one.

**Accepted**: all of `{{webhookResponse.status}}` greater than 199 and
`{{webhookResponse.status}}` less than 300. Match type ALL.

1. Wait 5 seconds.
2. Edit the issue: set "Customer ITSM Incident" to
   `{{webhookResponse.body.request.id}}`.
3. Then a nested branch (inside this accepted branch, after steps 1 and 2).
   Its conditions, any one of (match type ANY):
   - `{{issue.attachments.size}}` greater than 0
   - `{{issue.comments.size}}` greater than 0
   - `{{comment.attachments.size}}` greater than 0

   Its actions:
   1. Sync-service request: POST `https://replace-before-enabling.invalid/sync`, headers
      `Content-Type: application/json` and `Auth-Key: <SYNC_AUTH_KEY>`
      (secret header), custom body
      `{"jiraTicketKey":"{{issue.key}}","SDPToken":"{{AuthToken}}","SDPRequestID":"{{webhookResponse.body.request.id}}"}`.
   2. Wait 5 seconds.
   3. Add an internal comment `{{webResponse.body}}`.

**Rejected**: `{{webhookResponse.status}}` greater than 399.

1. Add an internal comment
   `Failed to create SDP ticket. Response: {{webResponse.body}}`.

### The accessor trap

`webResponse` and `webhookResponse` are NOT interchangeable. Copy each one
exactly where this spec uses it. Do not normalise them to a single name.

In the source rule:

- the token call is read with `webResponse` (`{{webResponse.body.access_token}}`);
- the sync-service call is read with `webResponse`
  (`{{webResponse.body}}` in the nested comment);
- the SDP call is read with `webhookResponse` (`.status` in every branch
  condition, `.body.request.id` for the request id).

Writing `webhookResponse` for the token call would give an empty bearer token
and a silent failure with nothing in the audit log to explain it.

Known oddity, kept on purpose so the rule matches the source: the rejected
comment reads `webResponse.body` even though the failing call was the SDP
call.
