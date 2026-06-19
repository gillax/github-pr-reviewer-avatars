/**
 * transform.js — pure functions turning a GraphQL response into display data.
 *
 * No DOM, no chrome.* APIs, no network. Pure data shaping so it can be
 * unit-tested under Node.
 *
 * Output shape: { [prNumber: number]: Reviewer[] }
 *
 * A Reviewer is one of:
 *   User: { type: 'User', login, avatarUrl, url, state }
 *   Team: { type: 'Team', name, slug, url, state: null }
 *
 * `state` comes from latestReviews (e.g. "APPROVED", "CHANGES_REQUESTED",
 * "COMMENTED") or null when the reviewer is still pending. The MVP renders
 * avatars only and ignores `state`; it is carried through so the future
 * colour/badge feature is purely presentational.
 *
 * Reviewer set = UNION of reviewRequests (pending) + latestReviews (already
 * reviewed), deduped by login (Users) / slug (Teams). See spec section 5:
 * approving drops a user from reviewRequests, so we must union the two or
 * "people who approved" would vanish from the list.
 *
 * Loaded BEFORE content.js in the manifest, and via importScripts() in the
 * background service worker.
 */

/**
 * Build a stable dedupe key for a reviewer so the same person/team appearing in
 * both reviewRequests and latestReviews collapses to one entry.
 *
 * @param {object} reviewer - a normalized reviewer ({type, login} or {type, slug}).
 * @returns {string|null}
 */
function reviewerKey(reviewer) {
  if (!reviewer) {
    return null;
  }
  if (reviewer.type === 'Team') {
    // Prefer slug (stable), fall back to name.
    const id = reviewer.slug || reviewer.name;
    return id ? `team:${String(id).toLowerCase()}` : null;
  }
  if (reviewer.type === 'User') {
    return reviewer.login ? `user:${String(reviewer.login).toLowerCase()}` : null;
  }
  return null;
}

/**
 * Normalize a `requestedReviewer` node (from reviewRequests) into a Reviewer.
 * A pending request has no review state yet, so state is null.
 *
 * @param {object} requestedReviewer
 * @returns {object|null}
 */
function normalizeRequestedReviewer(requestedReviewer) {
  if (!requestedReviewer || typeof requestedReviewer !== 'object') {
    return null;
  }
  const typename = requestedReviewer.__typename;

  if (typename === 'User') {
    if (!requestedReviewer.login) {
      return null;
    }
    return {
      type: 'User',
      login: requestedReviewer.login,
      avatarUrl: requestedReviewer.avatarUrl || null,
      url: requestedReviewer.url || null,
      state: null,
    };
  }

  if (typename === 'Team') {
    if (!requestedReviewer.name && !requestedReviewer.slug) {
      return null;
    }
    return {
      type: 'Team',
      name: requestedReviewer.name || requestedReviewer.slug,
      slug: requestedReviewer.slug || null,
      url: requestedReviewer.url || null,
      state: null,
    };
  }

  // Unknown reviewer subtype (e.g. Mannequin/Bot variants we don't model) — skip.
  return null;
}

/**
 * Normalize a `latestReviews` node into a Reviewer (always a User author).
 *
 * @param {object} reviewNode - { state, author }
 * @returns {object|null}
 */
function normalizeReviewNode(reviewNode) {
  if (!reviewNode || typeof reviewNode !== 'object') {
    return null;
  }
  const author = reviewNode.author;
  if (!author || !author.login) {
    return null; // ghost/deleted author
  }
  return {
    type: 'User',
    login: author.login,
    avatarUrl: author.avatarUrl || null,
    url: author.url || null,
    state: reviewNode.state || null,
  };
}

/**
 * Build the reviewer list for ONE pullRequest node: the deduped union of its
 * reviewRequests and latestReviews.
 *
 * latestReviews wins on conflict (it carries the real review state), so we add
 * those first, then fold in any still-pending requests not already present.
 *
 * @param {object} prNode - a single `pullRequest` object from the response.
 * @returns {object[]} reviewers (possibly empty).
 */
function reviewersForPrNode(prNode) {
  if (!prNode || typeof prNode !== 'object') {
    return [];
  }

  const byKey = new Map();

  // 1) latestReviews first — these carry review state and should win.
  const reviewNodes = (prNode.latestReviews && prNode.latestReviews.nodes) || [];
  for (const node of reviewNodes) {
    const reviewer = normalizeReviewNode(node);
    const key = reviewerKey(reviewer);
    if (key && !byKey.has(key)) {
      byKey.set(key, reviewer);
    }
  }

  // 2) reviewRequests — pending reviewers; add only if not already reviewed.
  const requestNodes = (prNode.reviewRequests && prNode.reviewRequests.nodes) || [];
  for (const node of requestNodes) {
    const reviewer = normalizeRequestedReviewer(node && node.requestedReviewer);
    const key = reviewerKey(reviewer);
    if (key && !byKey.has(key)) {
      byKey.set(key, reviewer);
    }
  }

  return Array.from(byKey.values());
}

/**
 * Transform a full GraphQL response into { prNumber -> reviewers[] }.
 *
 * The response aliases each PR as "pr_<n>" under data.repository (see
 * query.js). We read the requested numbers back out of the keys so the caller
 * does not need to pass them in again. PRs that returned null (deleted,
 * inaccessible) are simply omitted.
 *
 * Tolerant of partial responses: GraphQL can return both `data` and `errors`
 * (e.g. one inaccessible PR among many). We extract whatever data is present
 * and leave error surfacing to the caller.
 *
 * @param {object} response - parsed JSON: { data?: { repository?: {...} }, errors?: [...] }
 * @returns {{ [prNumber: number]: object[] }}
 */
function transformResponse(response) {
  const result = {};
  const repository =
    response && response.data && response.data.repository ? response.data.repository : null;
  if (!repository) {
    return result;
  }

  for (const key of Object.keys(repository)) {
    const match = key.match(/^pr_(\d+)$/);
    if (!match) {
      continue;
    }
    const prNumber = Number(match[1]);
    const prNode = repository[key];
    if (!prNode) {
      continue; // null PR (not found / no access)
    }
    result[prNumber] = reviewersForPrNode(prNode);
  }

  return result;
}

/**
 * Extract the authenticated viewer's login from a response that included a
 * top-level `viewer { login }` selection (see query.js). Used to decide which
 * PRs to highlight as "you are a reviewer".
 *
 * @param {object} response - parsed JSON.
 * @returns {string|null}
 */
function viewerLoginFromResponse(response) {
  const login =
    response && response.data && response.data.viewer ? response.data.viewer.login : null;
  return typeof login === 'string' && login ? login : null;
}

/**
 * Find the viewer's OWN review state within a reviewer list. Case-insensitive,
 * matching GitHub's login semantics. Teams are NOT expanded to their members,
 * so only a direct user-reviewer match counts.
 *
 * @param {object[]} reviewers - output of reviewersForPrNode.
 * @param {string} viewerLogin
 * @returns {string|null|undefined}
 *   - a state string ("APPROVED" / "CHANGES_REQUESTED" / "COMMENTED" / ...) or
 *     null (requested but not yet reviewed) when the viewer IS a reviewer;
 *   - undefined when the viewer is NOT among the reviewers.
 */
function viewerReviewState(reviewers, viewerLogin) {
  if (!Array.isArray(reviewers) || !viewerLogin) {
    return undefined;
  }
  const target = String(viewerLogin).toLowerCase();
  const match = reviewers.find(
    (r) =>
      r && r.type === 'User' && typeof r.login === 'string' && r.login.toLowerCase() === target
  );
  return match ? match.state || null : undefined;
}

/**
 * Is `viewerLogin` one of the User reviewers in `reviewers`? (Membership only,
 * regardless of review state.) See viewerReviewState for the semantics.
 *
 * @param {object[]} reviewers - output of reviewersForPrNode.
 * @param {string} viewerLogin
 * @returns {boolean}
 */
function viewerIsReviewer(reviewers, viewerLogin) {
  return viewerReviewState(reviewers, viewerLogin) !== undefined;
}

// Module export guard — see parse.js for rationale.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    reviewerKey,
    normalizeRequestedReviewer,
    normalizeReviewNode,
    reviewersForPrNode,
    transformResponse,
    viewerLoginFromResponse,
    viewerReviewState,
    viewerIsReviewer,
  };
}
