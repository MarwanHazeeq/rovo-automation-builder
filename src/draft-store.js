import { kvs } from '@forge/kvs';

/**
 * Storage for drafted (not yet created) automation rules.
 *
 * WHY FORGE STORAGE AND NOT THE JIRA TICKET
 * Forge key-value storage (KVS) can only be read and written by this app. If
 * the draft lived on the approval ticket (description, attachment or issue
 * property), anyone allowed to edit the ticket could change it AFTER the
 * manager approved it, so rule X would be approved and rule Y created.
 * Keeping the frozen payload here means what was approved is what is created.
 *
 * KEYS
 *   draft:<issueId>         the draft record (see shape below)
 *   create-claim:<issueId>  written once, atomically, right before creation
 *
 * The issue ID is used rather than the issue key because a key changes when
 * an issue is moved to another project; the numeric ID never changes.
 *
 * DRAFT RECORD SHAPE
 *   {
 *     issueId, issueKey,
 *     version,             1 for the first draft, +1 per revision
 *     state,               one of DRAFT_STATES
 *     rule,                the exact Automation API rule object that will be POSTed
 *     scope,               the single project scope ARI of that rule
 *     digest,              sha256 of the canonical rule JSON, shown on the ticket
 *     requesterAccountId,  who asked for it (may be null, see spike S1)
 *     ruleUuid,            set once the rule exists
 *     lastError,           set when state is NEEDS_ATTENTION
 *     history: [{ version, digest, state, at }]
 *   }
 */

export const DRAFT_STATES = Object.freeze({
  PENDING: 'PENDING',
  CREATING: 'CREATING',
  CREATED: 'CREATED',
  NEEDS_ATTENTION: 'NEEDS_ATTENTION',
});

/**
 * The only legal moves between states. Anything not listed is refused.
 *
 *   PENDING ──approve──> CREATING ──created──> CREATED
 *     │ ▲                   └──────fail──────> NEEDS_ATTENTION
 *     │ └─revise (new version, still PENDING)
 *     └──fail────────────> NEEDS_ATTENTION   (approval refused before any attempt)
 *
 * WHY THERE ARE NO "CHANGES_REQUESTED" OR "REJECTED" STATES HERE
 * What the humans decided (approve, reject, request changes) is recorded by
 * the ticket's live Jira status and its changelog. Copying it here would give
 * two sources of truth that can disagree. So the actions read the live ticket,
 * and this store only tracks what was drafted, whether it is still open
 * (PENDING), and what happened when creation was attempted. A rejected draft
 * simply stays PENDING here; the create action refuses it because the ticket
 * is not Approved.
 *
 * CREATED and NEEDS_ATTENTION are terminal.
 */
const TRANSITIONS = Object.freeze({
  [DRAFT_STATES.PENDING]: {
    approve: DRAFT_STATES.CREATING,
    revise: DRAFT_STATES.PENDING,
    fail: DRAFT_STATES.NEEDS_ATTENTION,
  },
  [DRAFT_STATES.CREATING]: {
    created: DRAFT_STATES.CREATED,
    fail: DRAFT_STATES.NEEDS_ATTENTION,
  },
});

/**
 * Pure function: the state a draft moves to when `event` happens, or null if
 * that move is not allowed. Kept free of storage so it can be unit-tested.
 */
export function nextState(currentState, event) {
  return TRANSITIONS[currentState]?.[event] ?? null;
}

/**
 * Build the store. `storage` defaults to Forge KVS; tests pass an in-memory
 * fake with the same get/set methods.
 */
export function createDraftStore(storage = kvs) {
  const draftKey = (issueId) => `draft:${issueId}`;
  const claimKey = (issueId) => `create-claim:${issueId}`;

  return {
    async getDraft(issueId) {
      return storage.get(draftKey(issueId));
    },

    async saveDraft(record) {
      await storage.set(draftKey(record.issueId), record);
      return record;
    },

    /**
     * Apply a state-machine event to a stored draft and save the result.
     * Returns the updated record, or null when the move is not allowed (the
     * stored record is left unchanged in that case). `changes` lets the
     * caller set extra fields such as ruleUuid or lastError in the same write.
     */
    async applyEvent(record, event, changes = {}) {
      const state = nextState(record.state, event);
      if (!state) return null;
      // History records the version/digest AFTER the change, so a revision
      // entry shows the new draft, not the one it replaced.
      const merged = { ...record, ...changes, state };
      const updated = {
        ...merged,
        history: [
          ...(record.history ?? []),
          { version: merged.version, digest: merged.digest, state, at: new Date().toISOString() },
        ],
      };
      await storage.set(draftKey(record.issueId), updated);
      return updated;
    },

    /**
     * Atomically claim the right to create the rule for this ticket.
     *
     * The create action can be called more than once for the same ticket,
     * even at the same moment: the agent may retry a tool call it thinks
     * failed, the automation rule and a user in chat may both ask, or the
     * automation rule may fire twice. Reading the draft state and then
     * writing CREATING would leave a gap in which two calls both read PENDING
     * and both create a rule. `keyPolicy: 'FAIL_IF_EXISTS'` makes the write itself
     * the check: exactly one caller can create this key.
     *
     * Returns true only for the caller that won. ANY error is treated as a
     * lost claim, including a transient storage error. That fails closed: in
     * the worst case a human is asked to check, and a rule is never created twice.
     */
    async claimCreation(issueId) {
      try {
        await storage.set(
          claimKey(issueId),
          { claimedAt: new Date().toISOString() },
          { keyPolicy: 'FAIL_IF_EXISTS' }
        );
        return true;
      } catch (error) {
        console.warn(
          `[draft-store] creation claim for issue ${issueId} not acquired: ${error?.code ?? ''} ${error?.message ?? error}`
        );
        return false;
      }
    },
  };
}
