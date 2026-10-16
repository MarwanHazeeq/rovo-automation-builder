import { redactSecrets, safeStringify } from './index.js';
import { createJiraClient } from './jira-client.js';

/**
 * Marks an approval ticket "ready for review" so the manager gets a Teams
 * heads-up. It is NOT a Rovo action: draft-automation-rule calls it right
 * after the ticket exists and the draft JSON is attached, so the heads-up
 * never depends on the agent remembering a step, and an agent retry of the
 * draft makes a new ticket instead of a second message about this one.
 *
 * TWO NOTIFICATION PATHS, CHOSEN AT RUNTIME
 * The Jira project property `request-notify-mode` on the approval project
 * picks the path on every call. A project property is a small JSON value an
 * admin can change with one REST call, so switching needs no redeploy
 * (Forge environment variables only change on redeploy).
 *
 *   "rule"    (default) add the label `ready-for-review`. A Jira automation
 *             rule on the project (built by hand, outside this repo) sees the
 *             label change, posts to the Power Automate flow and adds
 *             `teams-notified` itself.
 *   "webhook" post the card to the flow from here, then add BOTH labels in
 *             one request. With `teams-notified` already present, that Jira
 *             rule's JQL guard skips the ticket, so nobody gets two messages.
 *
 * WHAT A SUCCESS MEANS
 * The flow answers 202 Accepted as soon as it has QUEUED the request. A 2xx
 * here means "the flow accepted it", never "Teams delivered it". Delivery can
 * only be checked in the flow's run history in Power Automate.
 *
 * SECRETS
 * TEAMS_WEBHOOK_URL carries its secret (`sig=`) in the query string, so
 * anyone holding the URL can post to the flow. It is never logged, returned
 * or put in an error message, and every caught fetch error has URLs scrubbed
 * out of its text before it goes anywhere.
 *
 * drafts.js builds the real marker with createReadyMarker() (real Forge Jira
 * client, global fetch). Tests pass fakes for both.
 */

export const READY_LABEL = 'ready-for-review';
export const NOTIFIED_LABEL = 'teams-notified';
export const MODE_PROPERTY_KEY = 'request-notify-mode';
const MODES = new Set(['rule', 'webhook']);
const ISSUE_KEY_PATTERN = /^[A-Z][A-Z0-9]+-\d+$/;
const WEBHOOK_TIMEOUT_MS = 5000;

export function createReadyMarker({
  jira = createJiraClient(),
  fetchFn = (...args) => fetch(...args),
  getEnv = () => process.env,
  timeoutMs = WEBHOOK_TIMEOUT_MS,
} = {}) {
  /**
   * Mark `issueKey` ready for review. `projectKey` is the approval project
   * (APPROVAL_PROJECT_KEY); tickets anywhere else are refused.
   * `targetProject` is the human-readable project the rule would be created
   * in; it goes on the webhook-mode Teams card. In rule mode the card is built
   * by the Jira rule outside this repo, which must add the line itself.
   *
   * Never throws: every outcome is a result object, because the caller has
   * already raised the ticket and must not fail because of the heads-up.
   */
  async function markRequestReady(issueKey, projectKey, { targetProject } = {}) {
    // The base result. Every return below fills in what actually happened.
    const result = {
      ok: false,
      marked: false,
      mode: null,
      issueKey: typeof issueKey === 'string' ? issueKey : null,
      labelsAdded: [],
      attachmentCount: 0,
      alreadyMarked: false,
      notificationSent: false,
    };

    if (typeof issueKey !== 'string' || !ISSUE_KEY_PATTERN.test(issueKey)) {
      return notMarked(result, 'issueKey must look like SOC-123.');
    }

    // a. Read only the fields the guards need.
    let issue;
    try {
      issue = await jira.getIssue(issueKey, 'attachment,labels,project,summary,reporter');
    } catch (error) {
      return notMarked(result, `${issueKey} could not be read: ${scrubUrls(error.message)}`);
    }
    if (!issue?.fields) return notMarked(result, `${issueKey} was not found.`);

    // b. Only approval tickets are ever labelled.
    if (issue.fields.project?.key !== projectKey) {
      return notMarked(result, `${issueKey} is not an approval ticket in project ${projectKey}.`);
    }

    // c. The point of the heads-up is that the draft can be reviewed, so a
    //    ticket whose attachment upload failed is not "ready".
    const attachments = Array.isArray(issue.fields.attachment) ? issue.fields.attachment : [];
    result.attachmentCount = attachments.length;
    if (attachments.length === 0) return notMarked(result, 'no draft attached; not marking ready');

    // d. Already marked (by an earlier call or by the Jira rule): do nothing,
    //    so a second call can never post a second message.
    const labels = Array.isArray(issue.fields.labels) ? issue.fields.labels : [];
    if (labels.includes(READY_LABEL) || labels.includes(NOTIFIED_LABEL)) {
      console.log(`[markRequestReady] ${issueKey} already marked; nothing posted or changed`);
      return { ...result, ok: true, alreadyMarked: true };
    }

    // Choose the path, read fresh on every call.
    const { mode, reason } = await readMode(projectKey);
    result.mode = mode;
    console.log(`[markRequestReady] ${issueKey} using mode "${mode}" (${reason})`);

    if (mode === 'rule') {
      return addAndVerify(result, issueKey, [READY_LABEL]);
    }

    // Webhook mode. The two variables are required here only; rule mode
    // works without them.
    const env = getEnv();
    const missing = ['TEAMS_WEBHOOK_URL', 'JIRA_SITE_URL'].filter(
      (name) => !env[name] || String(env[name]).trim() === ''
    );
    if (missing.length > 0) {
      return notMarked(result, `Webhook mode needs the Forge variable(s): ${missing.join(', ')}.`);
    }

    const card = buildCard({
      issueKey,
      summary: issue.fields.summary,
      requestedBy: issue.fields.reporter?.displayName,
      targetProject,
      siteUrl: String(env.JIRA_SITE_URL).trim(),
    });
    const posted = await postCard(String(env.TEAMS_WEBHOOK_URL).trim(), card);
    if (!posted.ok) {
      // e. Nothing was accepted, so nothing is labelled.
      return notMarked(result, `The notification flow did not accept the heads-up: ${posted.error}`);
    }
    console.log(`[markRequestReady] ${issueKey} heads-up accepted by the flow (HTTP ${posted.status}); Teams delivery is not confirmed`);
    result.notificationSent = true;

    // d./f. Both labels in ONE request. If it fails, say so and stop: a retry
    //    could not tell whether to post again, so none is attempted.
    return addAndVerify(result, issueKey, [READY_LABEL, NOTIFIED_LABEL]);
  }

  /**
   * Read `request-notify-mode`. Anything other than a valid value (never
   * set, a typo, a failed read) falls back to "rule", the path that needs
   * nothing from this app beyond a label. `reason` is for the log line.
   */
  async function readMode(projectKey) {
    let value;
    try {
      value = await jira.getProjectProperty(projectKey, MODE_PROPERTY_KEY);
    } catch (error) {
      const reason = error.status === 404
        ? `${MODE_PROPERTY_KEY} is not set`
        : `${MODE_PROPERTY_KEY} could not be read: ${scrubUrls(error.message)}`;
      return { mode: 'rule', reason: `${reason}; defaulting to rule` };
    }
    if (typeof value === 'string' && MODES.has(value)) {
      return { mode: value, reason: `${MODE_PROPERTY_KEY} is "${value}"` };
    }
    return { mode: 'rule', reason: `${MODE_PROPERTY_KEY} has invalid value ${safeStringify(value)}; defaulting to rule` };
  }

  /**
   * POST the card. Returns `{ ok, status }` or `{ ok: false, error }`, with
   * every URL scrubbed from the error text. The AbortController cancels the
   * request after `timeoutMs`, so a hung flow cannot eat the function's
   * whole time budget.
   */
  async function postCard(url, card) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchFn(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // JSON.stringify escapes quotes and newlines in the ticket summary,
        // so a title like `Notify on "P1"` cannot break the payload.
        body: JSON.stringify(card),
        signal: controller.signal,
      });
      if (response.status < 200 || response.status >= 300) {
        return { ok: false, error: `HTTP ${response.status}` };
      }
      return { ok: true, status: response.status };
    } catch (error) {
      const message = error?.name === 'AbortError'
        ? `no answer within ${timeoutMs} ms`
        : scrubUrls(error?.message ?? String(error));
      return { ok: false, error: message };
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Add `labels` in one PUT, then GET the issue again and confirm they are
   * there, the same create-then-verify habit the rule creation uses.
   */
  async function addAndVerify(result, issueKey, labels) {
    const sentNote = result.notificationSent
      ? ' The heads-up was already accepted by the flow, so it may have been sent; do not retry.'
      : '';
    try {
      await jira.addLabels(issueKey, labels);
    } catch (error) {
      return notMarked(result, `The label(s) ${labels.join(', ')} could not be added to ${issueKey}: ${scrubUrls(error.message)}.${sentNote}`);
    }

    let after;
    try {
      after = await jira.getIssue(issueKey, 'labels');
    } catch (error) {
      return notMarked(result, `The labels on ${issueKey} could not be read back to verify them: ${scrubUrls(error.message)}.${sentNote}`);
    }
    const present = Array.isArray(after?.fields?.labels) ? after.fields.labels : [];
    const missing = labels.filter((label) => !present.includes(label));
    if (missing.length > 0) {
      return notMarked(result, `${issueKey} is missing label(s) ${missing.join(', ')} after the update.${sentNote}`);
    }

    console.log(`[markRequestReady] ${issueKey} marked: ${labels.join(', ')}`);
    return { ...result, ok: true, marked: true, labelsAdded: labels };
  }

  return { markRequestReady };
}

/**
 * The Teams message: a `message` envelope with one Adaptive Card, the shape
 * Teams Workflows' "Post card in a chat or channel" expects. Built as an
 * object and serialised once, never by string concatenation.
 */
export function buildCard({ issueKey, summary, requestedBy, targetProject, siteUrl }) {
  return {
    type: 'message',
    attachments: [
      {
        contentType: 'application/vnd.microsoft.card.adaptive',
        contentUrl: null,
        content: {
          $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
          type: 'AdaptiveCard',
          version: '1.2',
          body: [
            { type: 'TextBlock', text: 'Automation request ready for review', weight: 'Bolder', size: 'Medium', wrap: true },
            {
              type: 'FactSet',
              facts: [
                // The target project goes first: it is the one thing the
                // manager must check, and the app cannot verify it.
                { title: 'Target project', value: String(targetProject ?? 'unknown') },
                { title: 'Ticket', value: issueKey },
                { title: 'Summary', value: String(summary ?? '') },
                { title: 'Requested by', value: String(requestedBy ?? 'unknown') },
              ],
            },
          ],
          actions: [
            { type: 'Action.OpenUrl', title: 'Open ticket', url: `${siteUrl.replace(/\/+$/, '')}/browse/${issueKey}` },
          ],
        },
      },
    ],
  };
}

/**
 * Replace every URL in a piece of text. Fetch errors can quote the request
 * URL, and this one carries the flow's secret. Removing all URLs, not just the
 * configured one, also covers encoded or partial copies of it.
 */
export function scrubUrls(text) {
  return String(text ?? '').replace(/https?:\/\/[^\s"'<>]+/gi, '[redacted url]');
}

/**
 * The not-marked result: logged and returned, both redacted. It carries no
 * `ruleCreated` (as failure() in index.js does), because this step has
 * nothing to do with whether a rule exists. `ok` stays false so a caller can
 * never mistake it for success.
 */
function notMarked(result, message) {
  const safe = redactSecrets({ ...result, error: scrubUrls(message) });
  console.error(`[markRequestReady] ${safe.error}`, safeStringify(safe));
  return safe;
}
