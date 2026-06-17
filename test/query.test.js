'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  PR_FIELDS,
  buildPrAliases,
  aliasForNumber,
  buildReviewersQuery,
} = require('../src/lib/query.js');

// ---------------------------------------------------------------------------
// aliasForNumber
// ---------------------------------------------------------------------------

test('aliasForNumber: produces the pr_<n> key used by transform.js', () => {
  assert.equal(aliasForNumber(123), 'pr_123');
});

// ---------------------------------------------------------------------------
// PR_FIELDS — must request BOTH reviewRequests and latestReviews (spec §5)
// ---------------------------------------------------------------------------

test('PR_FIELDS: includes reviewRequests with requestedReviewer User+Team', () => {
  assert.match(PR_FIELDS, /reviewRequests\s*\(/);
  assert.match(PR_FIELDS, /requestedReviewer/);
  assert.match(PR_FIELDS, /\.\.\.\s*on\s+User/);
  assert.match(PR_FIELDS, /\.\.\.\s*on\s+Team/);
});

test('PR_FIELDS: includes latestReviews with state + author', () => {
  assert.match(PR_FIELDS, /latestReviews\s*\(/);
  assert.match(PR_FIELDS, /\bstate\b/);
  assert.match(PR_FIELDS, /\bauthor\b/);
});

test('PR_FIELDS: requests __typename so transform can discriminate User vs Team', () => {
  assert.match(PR_FIELDS, /__typename/);
});

// ---------------------------------------------------------------------------
// buildPrAliases — alias expansion for multiple PR numbers
// ---------------------------------------------------------------------------

test('buildPrAliases: expands every PR number into its own aliased selection', () => {
  const out = buildPrAliases([1, 2, 3]);
  assert.match(out, /pr_1:\s*pullRequest\(number:\s*1\)/);
  assert.match(out, /pr_2:\s*pullRequest\(number:\s*2\)/);
  assert.match(out, /pr_3:\s*pullRequest\(number:\s*3\)/);

  // Exactly three aliases, one per number.
  const aliasCount = (out.match(/pullRequest\(number:/g) || []).length;
  assert.equal(aliasCount, 3);
});

test('buildPrAliases: each alias carries the full field selection', () => {
  const out = buildPrAliases([7]);
  assert.match(out, /pr_7:\s*pullRequest\(number:\s*7\)/);
  assert.match(out, /reviewRequests/);
  assert.match(out, /latestReviews/);
});

test('buildPrAliases: filters out invalid numbers before expansion', () => {
  const out = buildPrAliases([5, -1, 0, 1.2, NaN]);
  const aliasCount = (out.match(/pullRequest\(number:/g) || []).length;
  assert.equal(aliasCount, 1);
  assert.match(out, /pr_5:\s*pullRequest\(number:\s*5\)/);
});

test('buildPrAliases: empty / non-array yields empty string', () => {
  assert.equal(buildPrAliases([]), '');
  assert.equal(buildPrAliases(null), '');
});

// ---------------------------------------------------------------------------
// buildReviewersQuery — valid single-request shape
// ---------------------------------------------------------------------------

test('buildReviewersQuery: wraps aliases in ONE repository() request with variables', () => {
  const built = buildReviewersQuery('octocat', 'hello-world', [10, 20]);
  assert.ok(built, 'expected a non-null result');

  // owner/name are passed as GraphQL variables, NOT concatenated into the body.
  assert.deepEqual(built.variables, { owner: 'octocat', name: 'hello-world' });
  assert.match(built.query, /query\(\$owner:\s*String!,\s*\$name:\s*String!\)/);
  assert.match(built.query, /repository\(owner:\s*\$owner,\s*name:\s*\$name\)/);

  // A single repository() block (one round trip) containing both aliases.
  assert.equal((built.query.match(/repository\(/g) || []).length, 1);
  assert.match(built.query, /pr_10:\s*pullRequest\(number:\s*10\)/);
  assert.match(built.query, /pr_20:\s*pullRequest\(number:\s*20\)/);
});

test('buildReviewersQuery: does NOT inline the owner/repo strings into the query body', () => {
  // Defence: even a repo named like an injection attempt must go via variables.
  const built = buildReviewersQuery('evil") { x }', 'repo', [1]);
  assert.ok(built);
  assert.ok(
    !built.query.includes('evil")'),
    'owner string must not be concatenated into the query body'
  );
  assert.equal(built.variables.owner, 'evil") { x }');
});

test('buildReviewersQuery: returns null when there are no valid numbers', () => {
  assert.equal(buildReviewersQuery('o', 'r', []), null);
  assert.equal(buildReviewersQuery('o', 'r', [0, -3, NaN]), null);
  assert.equal(buildReviewersQuery('o', 'r', null), null);
});

test('buildReviewersQuery: single-number request is well formed', () => {
  const built = buildReviewersQuery('o', 'r', [99]);
  assert.ok(built);
  assert.equal((built.query.match(/pullRequest\(number:/g) || []).length, 1);
  assert.match(built.query, /pr_99:\s*pullRequest\(number:\s*99\)/);
  // Braces are balanced.
  const opens = (built.query.match(/{/g) || []).length;
  const closes = (built.query.match(/}/g) || []).length;
  assert.equal(opens, closes);
});
