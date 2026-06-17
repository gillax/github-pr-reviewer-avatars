'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  reviewerKey,
  normalizeRequestedReviewer,
  normalizeReviewNode,
  reviewersForPrNode,
  transformResponse,
} = require('../src/lib/transform.js');

// --- small builders to keep the GraphQL fixtures readable -------------------

function userRequest(login, extra = {}) {
  return {
    requestedReviewer: { __typename: 'User', login, avatarUrl: `https://a/${login}`, url: `https://github.com/${login}`, ...extra },
  };
}
function teamRequest(name, slug) {
  return {
    requestedReviewer: { __typename: 'Team', name, slug, url: `https://github.com/orgs/x/teams/${slug}` },
  };
}
function review(login, state) {
  return { state, author: { __typename: 'User', login, avatarUrl: `https://a/${login}`, url: `https://github.com/${login}` } };
}
function prNode({ requests = [], reviews = [] } = {}) {
  return {
    reviewRequests: { nodes: requests },
    latestReviews: { nodes: reviews },
  };
}

// ---------------------------------------------------------------------------
// reviewerKey
// ---------------------------------------------------------------------------

test('reviewerKey: users key by lowercased login', () => {
  assert.equal(reviewerKey({ type: 'User', login: 'Octocat' }), 'user:octocat');
});

test('reviewerKey: teams key by lowercased slug, falling back to name', () => {
  assert.equal(reviewerKey({ type: 'Team', slug: 'Core-Team' }), 'team:core-team');
  assert.equal(reviewerKey({ type: 'Team', name: 'Core Team' }), 'team:core team');
});

test('reviewerKey: null / unknown type returns null', () => {
  assert.equal(reviewerKey(null), null);
  assert.equal(reviewerKey({ type: 'Mannequin', login: 'x' }), null);
  assert.equal(reviewerKey({ type: 'User' }), null); // no login
});

// ---------------------------------------------------------------------------
// normalizeRequestedReviewer — User vs Team handling
// ---------------------------------------------------------------------------

test('normalizeRequestedReviewer: User -> typed reviewer with null state', () => {
  const r = normalizeRequestedReviewer({
    __typename: 'User',
    login: 'alice',
    avatarUrl: 'https://a/alice',
    url: 'https://github.com/alice',
  });
  assert.deepEqual(r, {
    type: 'User',
    login: 'alice',
    avatarUrl: 'https://a/alice',
    url: 'https://github.com/alice',
    state: null,
  });
});

test('normalizeRequestedReviewer: Team -> typed reviewer (name/slug/url), null state', () => {
  const r = normalizeRequestedReviewer({
    __typename: 'Team',
    name: 'Platform',
    slug: 'platform',
    url: 'https://github.com/orgs/x/teams/platform',
  });
  assert.deepEqual(r, {
    type: 'Team',
    name: 'Platform',
    slug: 'platform',
    url: 'https://github.com/orgs/x/teams/platform',
    state: null,
  });
});

test('normalizeRequestedReviewer: missing avatar/url default to null', () => {
  const r = normalizeRequestedReviewer({ __typename: 'User', login: 'bob' });
  assert.equal(r.avatarUrl, null);
  assert.equal(r.url, null);
});

test('normalizeRequestedReviewer: unknown subtype / malformed -> null', () => {
  assert.equal(normalizeRequestedReviewer({ __typename: 'Bot', login: 'dependabot' }), null);
  assert.equal(normalizeRequestedReviewer({ __typename: 'User' }), null); // no login
  assert.equal(normalizeRequestedReviewer({ __typename: 'Team' }), null); // no name/slug
  assert.equal(normalizeRequestedReviewer(null), null);
});

// ---------------------------------------------------------------------------
// normalizeReviewNode — latestReviews author + state
// ---------------------------------------------------------------------------

test('normalizeReviewNode: carries the review state through', () => {
  const r = normalizeReviewNode(review('carol', 'APPROVED'));
  assert.deepEqual(r, {
    type: 'User',
    login: 'carol',
    avatarUrl: 'https://a/carol',
    url: 'https://github.com/carol',
    state: 'APPROVED',
  });
});

test('normalizeReviewNode: ghost / deleted author -> null', () => {
  assert.equal(normalizeReviewNode({ state: 'APPROVED', author: null }), null);
  assert.equal(normalizeReviewNode({ state: 'COMMENTED', author: {} }), null);
  assert.equal(normalizeReviewNode(null), null);
});

// ---------------------------------------------------------------------------
// reviewersForPrNode — UNION + dedupe (the core spec §5 behaviour)
// ---------------------------------------------------------------------------

test('reviewersForPrNode: UNION of requested reviewers and latestReviews authors', () => {
  const node = prNode({
    requests: [userRequest('pending-pat')],
    reviews: [review('approver-amy', 'APPROVED')],
  });
  const out = reviewersForPrNode(node);
  const logins = out.map((r) => r.login).sort();
  assert.deepEqual(logins, ['approver-amy', 'pending-pat']);
});

test('reviewersForPrNode: an APPROVER (dropped from reviewRequests) is STILL listed', () => {
  // This is the exact regression the spec warns about: after approving, GitHub
  // removes the user from reviewRequests. Only latestReviews still has them.
  const node = prNode({
    requests: [], // amy approved, so she is no longer "requested"
    reviews: [review('amy', 'APPROVED')],
  });
  const out = reviewersForPrNode(node);
  assert.equal(out.length, 1);
  assert.equal(out[0].login, 'amy');
  assert.equal(out[0].state, 'APPROVED');
});

test('reviewersForPrNode: dedupes someone in BOTH lists; latestReviews state wins', () => {
  // Re-review case: a user can be re-requested AND have a latest review.
  const node = prNode({
    requests: [userRequest('dave')],
    reviews: [review('dave', 'CHANGES_REQUESTED')],
  });
  const out = reviewersForPrNode(node);
  assert.equal(out.length, 1, 'dave must appear exactly once');
  assert.equal(out[0].login, 'dave');
  assert.equal(out[0].state, 'CHANGES_REQUESTED', 'latestReviews state should win over the pending null');
});

test('reviewersForPrNode: dedupe by login is case-insensitive', () => {
  const node = prNode({
    requests: [userRequest('Octocat')],
    reviews: [review('octocat', 'COMMENTED')],
  });
  const out = reviewersForPrNode(node);
  assert.equal(out.length, 1);
});

test('reviewersForPrNode: Team reviewer is preserved alongside Users', () => {
  const node = prNode({
    requests: [userRequest('erin'), teamRequest('Platform', 'platform')],
    reviews: [review('frank', 'APPROVED')],
  });
  const out = reviewersForPrNode(node);
  const types = out.map((r) => r.type).sort();
  assert.deepEqual(types, ['Team', 'User', 'User']);
  const team = out.find((r) => r.type === 'Team');
  assert.equal(team.name, 'Platform');
  assert.equal(team.slug, 'platform');
  assert.equal(team.state, null);
});

test('reviewersForPrNode: empty / missing review sets -> []', () => {
  assert.deepEqual(reviewersForPrNode(prNode({ requests: [], reviews: [] })), []);
  assert.deepEqual(reviewersForPrNode({}), []);
  assert.deepEqual(reviewersForPrNode(null), []);
});

test('reviewersForPrNode: tolerates missing nodes arrays', () => {
  assert.deepEqual(reviewersForPrNode({ reviewRequests: {}, latestReviews: {} }), []);
});

// ---------------------------------------------------------------------------
// transformResponse — full response -> { prNumber: reviewers[] }
// ---------------------------------------------------------------------------

test('transformResponse: maps each pr_<n> alias to its reviewer list', () => {
  const response = {
    data: {
      repository: {
        pr_1: prNode({ requests: [userRequest('alice')], reviews: [] }),
        pr_2: prNode({ requests: [], reviews: [review('bob', 'APPROVED')] }),
      },
    },
  };
  const out = transformResponse(response);
  assert.deepEqual(Object.keys(out).sort(), ['1', '2']);
  assert.equal(out[1][0].login, 'alice');
  assert.equal(out[2][0].login, 'bob');
  assert.equal(out[2][0].state, 'APPROVED');
});

test('transformResponse: numeric keys (PR numbers) are real numbers', () => {
  const response = { data: { repository: { pr_42: prNode({ requests: [userRequest('z')] }) } } };
  const out = transformResponse(response);
  // Property exists under the numeric key.
  assert.ok(Object.prototype.hasOwnProperty.call(out, '42'));
  assert.equal(out[42].length, 1);
});

test('transformResponse: a null PR node (deleted/no access) is omitted', () => {
  const response = {
    data: { repository: { pr_1: null, pr_2: prNode({ reviews: [review('c', 'COMMENTED')] }) } },
  };
  const out = transformResponse(response);
  assert.deepEqual(Object.keys(out), ['2']);
});

test('transformResponse: ignores non-alias keys on repository', () => {
  const response = {
    data: { repository: { id: 'R_123', name: 'repo', pr_5: prNode({ requests: [userRequest('q')] }) } },
  };
  const out = transformResponse(response);
  assert.deepEqual(Object.keys(out), ['5']);
});

test('transformResponse: partial response (data + errors) still yields the present data', () => {
  // GraphQL returns data for accessible PRs and an error entry for an inaccessible one.
  const response = {
    data: { repository: { pr_1: prNode({ requests: [userRequest('alice')] }), pr_2: null } },
    errors: [{ message: 'Could not resolve pr_2' }],
  };
  const out = transformResponse(response);
  assert.deepEqual(Object.keys(out), ['1']);
  assert.equal(out[1][0].login, 'alice');
});

test('transformResponse: missing data / repository -> {}', () => {
  assert.deepEqual(transformResponse({}), {});
  assert.deepEqual(transformResponse({ data: {} }), {});
  assert.deepEqual(transformResponse({ data: { repository: null } }), {});
  assert.deepEqual(transformResponse({ errors: [{ message: 'Bad credentials' }] }), {});
  assert.deepEqual(transformResponse(null), {});
});
