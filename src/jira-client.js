import api, { route } from '@forge/api';

/**
 * The few Jira REST calls the approval flow needs, in one place.
 *
 * WHICH IDENTITY MAKES EACH CALL, AND WHY
 * - createIssue uses .asUser(): the ticket is raised AS the person who asked
 *   for the rule, so Jira records them as reporter and applies their own
 *   create permission. This requires the user to have granted the app access
 *   (Forge prompts for this the first time).
 * - Everything else uses .asApp(): comments, attachments, status and
 *   changelog reads, and the resubmit transition. These run from Rovo actions
 *   that are often invoked headlessly by a Jira automation rule, where there
 *   is no user to act as. A comment written as the app shows the app as its
 *   author and cannot be edited by ordinary users, which is what makes the
 *   "Draft vN" and "Rule created" comments trustworthy.
 *
 *   Using .asApp() on behalf of whoever invoked the agent is safe here
 *   because no call grants that person anything: rule creation is authorised
 *   by the ticket's own changelog (an allowlisted approver moved it to
 *   Approved), not by who asked the agent to press the button.
 *
 * `route` is a tagged template from @forge/api that URL-encodes every
 * interpolated value, so an issue key can never alter the request path.
 *
 * Every method throws a JiraRequestError on a non-2xx response so callers can
 * decide what a failure means at their step.
 */

export class JiraRequestError extends Error {
  constructor(operation, status, body) {
    super(`Jira ${operation} failed with HTTP ${status}: ${typeof body === 'string' ? body : JSON.stringify(body)}`);
    this.name = 'JiraRequestError';
    this.status = status;
    this.body = body;
  }
}

async function readBody(response) {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function expectOk(operation, responsePromise) {
  const response = await responsePromise;
  const body = await readBody(response);
  if (response.status < 200 || response.status >= 300) {
    throw new JiraRequestError(operation, response.status, body);
  }
  return body;
}

/**
 * Build the client. `forgeApi` defaults to the real @forge/api; tests do not
 * use this factory at all and pass a plain fake object instead.
 */
export function createJiraClient(forgeApi = api) {
  const jsonHeaders = { Accept: 'application/json', 'Content-Type': 'application/json' };

  return {
    /** Create an issue as the invoking user. Returns `{ id, key }`. */
    async createIssue(fields) {
      return expectOk(
        'create issue',
        forgeApi.asUser().requestJira(route`/rest/api/3/issue`, {
          method: 'POST',
          headers: jsonHeaders,
          body: JSON.stringify({ fields }),
        })
      );
    },

    /** Read an issue's id, key, project, status and reporter, as the app. */
    async getIssue(issueIdOrKey) {
      return expectOk(
        'get issue',
        forgeApi
          .asApp()
          .requestJira(route`/rest/api/3/issue/${issueIdOrKey}?fields=status,project,reporter`, {
            headers: { Accept: 'application/json' },
          })
      );
    },

    /** Add a comment as the app. `adfBody` is an Atlassian Document Format doc. */
    async addComment(issueIdOrKey, adfBody) {
      return expectOk(
        'add comment',
        forgeApi.asApp().requestJira(route`/rest/api/3/issue/${issueIdOrKey}/comment`, {
          method: 'POST',
          headers: jsonHeaders,
          body: JSON.stringify({ body: adfBody }),
        })
      );
    },

    /**
     * Every changelog entry of an issue, oldest first, as the app.
     *
     * Jira pages this endpoint (at most 100 entries per page), so keep asking
     * for the next page until Jira says `isLast`. Each entry looks like
     *   { id, author: { accountId }, created: '2026-10-08T10:00:00.000+0800',
     *     items: [{ field, fieldId, from, to, ... }] }
     * The `maxPages` cap is a safety stop so a misbehaving response can never
     * loop forever; 50 pages is 5,000 changes, far beyond any approval ticket.
     */
    async getChangelog(issueIdOrKey, { maxPages = 50 } = {}) {
      const entries = [];
      let startAt = 0;
      for (let page = 0; page < maxPages; page += 1) {
        const body = await expectOk(
          'get changelog',
          forgeApi
            .asApp()
            .requestJira(route`/rest/api/3/issue/${issueIdOrKey}/changelog?startAt=${startAt}&maxResults=100`, {
              headers: { Accept: 'application/json' },
            })
        );
        const values = Array.isArray(body?.values) ? body.values : [];
        entries.push(...values);
        if (body?.isLast !== false || values.length === 0) return entries;
        startAt += values.length;
      }
      throw new JiraRequestError('get changelog', 0, `more than ${maxPages} pages`);
    },

    /**
     * Attach a text file to an issue, as the app.
     *
     * Jira's attachment endpoint only accepts multipart/form-data, and Forge's
     * requestJira only accepts a string, ArrayBuffer or URLSearchParams body
     * (its RequestInit type has no FormData). So the multipart body is built
     * by hand: one part named "file", wrapped in a random boundary string.
     * `X-Atlassian-Token: no-check` is required by Jira for this endpoint;
     * without it the request is rejected as a possible CSRF attempt.
     */
    async addAttachment(issueIdOrKey, filename, content, contentType = 'application/json') {
      const boundary = `----forge-attachment-${Math.random().toString(16).slice(2)}${Date.now().toString(16)}`;
      const safeName = String(filename).replace(/["\r\n]/g, '_');
      const body =
        `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="file"; filename="${safeName}"\r\n` +
        `Content-Type: ${contentType}\r\n\r\n` +
        `${content}\r\n` +
        `--${boundary}--\r\n`;
      return expectOk(
        'add attachment',
        forgeApi.asApp().requestJira(route`/rest/api/3/issue/${issueIdOrKey}/attachments`, {
          method: 'POST',
          headers: {
            Accept: 'application/json',
            'Content-Type': `multipart/form-data; boundary=${boundary}`,
            'X-Atlassian-Token': 'no-check',
          },
          body,
        })
      );
    },

    /** Move an issue through a workflow transition, as the app. */
    async transitionIssue(issueIdOrKey, transitionId) {
      return expectOk(
        'transition issue',
        forgeApi.asApp().requestJira(route`/rest/api/3/issue/${issueIdOrKey}/transitions`, {
          method: 'POST',
          headers: jsonHeaders,
          body: JSON.stringify({ transition: { id: String(transitionId) } }),
        })
      );
    },
  };
}
