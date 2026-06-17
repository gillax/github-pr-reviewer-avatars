'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  parseOwnerRepoFromUrl,
  extractPrNumberFromRow,
  extractPrNumberFromHref,
  normalizePrNumbers,
} = require('../src/lib/parse.js');
const { makeRow } = require('../test-helpers/fake-row.js');

// ---------------------------------------------------------------------------
// parseOwnerRepoFromUrl — owner/repo extraction from /{owner}/{repo}/pulls
// ---------------------------------------------------------------------------

test('parseOwnerRepoFromUrl: full https pulls URL', () => {
  assert.deepEqual(parseOwnerRepoFromUrl('https://github.com/octocat/hello-world/pulls'), {
    owner: 'octocat',
    repo: 'hello-world',
  });
});

test('parseOwnerRepoFromUrl: pulls URL with query string (?q=is:open)', () => {
  assert.deepEqual(
    parseOwnerRepoFromUrl('https://github.com/octocat/hello-world/pulls?q=is%3Aopen+is%3Apr'),
    { owner: 'octocat', repo: 'hello-world' }
  );
});

test('parseOwnerRepoFromUrl: pulls URL with hash fragment', () => {
  assert.deepEqual(parseOwnerRepoFromUrl('https://github.com/foo/bar/pulls#anything'), {
    owner: 'foo',
    repo: 'bar',
  });
});

test('parseOwnerRepoFromUrl: trailing slash is tolerated', () => {
  assert.deepEqual(parseOwnerRepoFromUrl('https://github.com/foo/bar/pulls/'), {
    owner: 'foo',
    repo: 'bar',
  });
});

test('parseOwnerRepoFromUrl: bare pathname (no origin) is accepted', () => {
  assert.deepEqual(parseOwnerRepoFromUrl('/octocat/hello-world/pulls'), {
    owner: 'octocat',
    repo: 'hello-world',
  });
});

test('parseOwnerRepoFromUrl: percent-encoded segments are decoded', () => {
  // dots are common in repo names; ensure decoding works and dots survive.
  assert.deepEqual(parseOwnerRepoFromUrl('https://github.com/my-org/my%2Erepo/pulls'), {
    owner: 'my-org',
    repo: 'my.repo',
  });
});

// --- rejection of non-PR-list URLs ----------------------------------------

test('parseOwnerRepoFromUrl: rejects an individual PR page (/pull/123)', () => {
  assert.equal(parseOwnerRepoFromUrl('https://github.com/octocat/hello-world/pull/123'), null);
});

test('parseOwnerRepoFromUrl: rejects the repo root', () => {
  assert.equal(parseOwnerRepoFromUrl('https://github.com/octocat/hello-world'), null);
});

test('parseOwnerRepoFromUrl: rejects the issues list', () => {
  assert.equal(parseOwnerRepoFromUrl('https://github.com/octocat/hello-world/issues'), null);
});

test('parseOwnerRepoFromUrl: rejects the global dashboard /pulls (no owner/repo)', () => {
  assert.equal(parseOwnerRepoFromUrl('https://github.com/pulls'), null);
});

test('parseOwnerRepoFromUrl: rejects a deeper path under pulls', () => {
  // e.g. a sub-route; only the exact .../pulls (optionally trailing slash) matches.
  assert.equal(parseOwnerRepoFromUrl('https://github.com/foo/bar/pulls/something'), null);
});

test('parseOwnerRepoFromUrl: rejects the projects/pulls nesting (too many segments)', () => {
  assert.equal(parseOwnerRepoFromUrl('https://github.com/foo/bar/baz/pulls'), null);
});

test('parseOwnerRepoFromUrl: rejects empty / non-string input', () => {
  assert.equal(parseOwnerRepoFromUrl(''), null);
  assert.equal(parseOwnerRepoFromUrl(null), null);
  assert.equal(parseOwnerRepoFromUrl(undefined), null);
  assert.equal(parseOwnerRepoFromUrl(12345), null);
});

// ---------------------------------------------------------------------------
// extractPrNumberFromHref — "/pull/<n>" extraction
// ---------------------------------------------------------------------------

test('extractPrNumberFromHref: relative pull href', () => {
  assert.equal(extractPrNumberFromHref('/octocat/hello-world/pull/42'), 42);
});

test('extractPrNumberFromHref: absolute pull href', () => {
  assert.equal(extractPrNumberFromHref('https://github.com/octocat/hello-world/pull/7'), 7);
});

test('extractPrNumberFromHref: pull href with trailing segment (/files)', () => {
  assert.equal(extractPrNumberFromHref('/o/r/pull/123/files'), 123);
});

test('extractPrNumberFromHref: pull href with query string', () => {
  assert.equal(extractPrNumberFromHref('/o/r/pull/55?diff=split'), 55);
});

test('extractPrNumberFromHref: ignores issues links', () => {
  assert.equal(extractPrNumberFromHref('/o/r/issues/99'), null);
});

test('extractPrNumberFromHref: non-string returns null', () => {
  assert.equal(extractPrNumberFromHref(null), null);
  assert.equal(extractPrNumberFromHref(undefined), null);
});

// ---------------------------------------------------------------------------
// extractPrNumberFromRow — PR number from representative row markup
// ---------------------------------------------------------------------------

test('extractPrNumberFromRow: reads number from id="issue_<n>"', () => {
  const row = makeRow({ id: 'issue_2048', hrefs: [] });
  assert.equal(extractPrNumberFromRow(row), 2048);
});

test('extractPrNumberFromRow: reads number from id="pr-<n>" variant', () => {
  const row = makeRow({ id: 'pr-17', hrefs: [] });
  assert.equal(extractPrNumberFromRow(row), 17);
});

test('extractPrNumberFromRow: falls back to a /pull/<n> anchor when id is absent', () => {
  const row = makeRow({
    id: null,
    hrefs: ['/octocat/hello-world/pull/314', '/octocat/hello-world/labels/bug'],
  });
  assert.equal(extractPrNumberFromRow(row), 314);
});

test('extractPrNumberFromRow: representative GitHub-like row (id wins over anchors)', () => {
  // A realistic row carries both an "issue_<n>" id AND a title anchor to /pull/<n>.
  const row = makeRow({
    id: 'issue_900',
    hrefs: [
      '/octocat/hello-world/pull/900',
      '/octocat/hello-world/pull/900/files',
      '/octocat/hello-world#partial-pull-ref', // a label/avatar link, not a pull
    ],
  });
  assert.equal(extractPrNumberFromRow(row), 900);
});

test('extractPrNumberFromRow: returns null when nothing identifies a PR', () => {
  const row = makeRow({ id: 'some-unrelated-node', hrefs: ['/octocat/hello-world/issues/5'] });
  assert.equal(extractPrNumberFromRow(row), null);
});

test('extractPrNumberFromRow: null / malformed element returns null (no throw)', () => {
  assert.equal(extractPrNumberFromRow(null), null);
  assert.equal(extractPrNumberFromRow({}), null);
});

// ---------------------------------------------------------------------------
// normalizePrNumbers — dedupe, sort, reject invalid
// ---------------------------------------------------------------------------

test('normalizePrNumbers: dedupes and sorts ascending', () => {
  assert.deepEqual(normalizePrNumbers([3, 1, 2, 3, 1]), [1, 2, 3]);
});

test('normalizePrNumbers: coerces numeric strings', () => {
  assert.deepEqual(normalizePrNumbers(['10', 2, '2']), [2, 10]);
});

test('normalizePrNumbers: drops non-positive / non-integer / junk values', () => {
  assert.deepEqual(normalizePrNumbers([0, -5, 1.5, NaN, 'abc', null, undefined, 7]), [7]);
});

test('normalizePrNumbers: non-array input yields []', () => {
  assert.deepEqual(normalizePrNumbers(null), []);
  assert.deepEqual(normalizePrNumbers('1,2,3'), []);
});
