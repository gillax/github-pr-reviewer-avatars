/**
 * query.js — pure functions for building the GraphQL request.
 *
 * No DOM, no chrome.* APIs, no network. Pure string construction so it can be
 * unit-tested under Node.
 *
 * Design constraint (see spec section 5): ONE GraphQL request per page. We
 * alias-expand every PR number into the same `repository(...)` selection:
 *
 *   pr_123: pullRequest(number: 123) { ...fields }
 *   pr_456: pullRequest(number: 456) { ...fields }
 *
 * so a list of N PRs costs a single round trip instead of N REST calls.
 *
 * Loaded BEFORE content.js in the manifest, and via importScripts() in the
 * background service worker.
 */

/**
 * The shared field selection for a single pullRequest.
 *
 * We fetch BOTH reviewRequests and latestReviews:
 *   - reviewRequests: people/teams asked to review who have NOT reviewed yet.
 *   - latestReviews:  the most recent review per author (carries `state`).
 * The union of the two is the full reviewer set (see transform.js); approving
 * removes a user from reviewRequests, so latestReviews is needed to keep them.
 *
 * `state` is fetched now (MVP renders avatars only) so the future review-state
 * colour feature is a pure presentation change with no query change.
 */
const PR_FIELDS = `
    reviewRequests(first: 50) {
      nodes {
        requestedReviewer {
          __typename
          ... on User { login avatarUrl url }
          ... on Team { name slug url }
        }
      }
    }
    latestReviews(first: 50) {
      nodes {
        state
        author {
          __typename
          login
          avatarUrl
          url
        }
      }
    }`;

/**
 * Build the aliased pullRequest selections for a list of PR numbers.
 *
 * @param {number[]} numbers - validated, positive integers (use parse.normalizePrNumbers first).
 * @returns {string} e.g. "pr_1: pullRequest(number: 1) { ... } pr_2: pullRequest(number: 2) { ... }"
 */
function buildPrAliases(numbers) {
  if (!Array.isArray(numbers)) {
    return '';
  }
  return numbers
    .filter((n) => Number.isInteger(n) && n > 0)
    .map((n) => `    pr_${n}: pullRequest(number: ${n}) {${PR_FIELDS}\n    }`)
    .join('\n');
}

/**
 * Convert a PR number into its response alias key.
 * Kept in one place so query.js and transform.js cannot drift apart.
 *
 * @param {number} n
 * @returns {string} e.g. "pr_123"
 */
function aliasForNumber(n) {
  return `pr_${n}`;
}

/**
 * Build the complete GraphQL query string for one page of PRs.
 *
 * owner/name are passed as GraphQL variables ($owner/$name) so user-controlled
 * strings are never concatenated into the query body. The PR numbers are
 * integers we have already validated, so alias-expanding them inline is safe.
 *
 * @param {string} owner
 * @param {string} repo
 * @param {number[]} numbers
 * @returns {{ query: string, variables: {owner: string, name: string} } | null}
 *          null when there are no valid PR numbers to ask about.
 */
function buildReviewersQuery(owner, repo, numbers) {
  const aliases = buildPrAliases(numbers);
  if (!aliases) {
    return null;
  }

  const query = `query($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) {
${aliases}
  }
}`;

  return { query, variables: { owner: String(owner), name: String(repo) } };
}

// Module export guard — see parse.js for rationale.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    PR_FIELDS,
    buildPrAliases,
    aliasForNumber,
    buildReviewersQuery,
  };
}
