/**
 * parse.js — pure functions for extracting structured data from the page.
 *
 * No DOM, no chrome.* APIs, no network. Everything here is a pure function so
 * it can be unit-tested under Node (see README "Running the tests").
 *
 * Loaded BEFORE content.js in the manifest's content_scripts "js" array, so in
 * the extension these functions are plain globals in the content script's
 * isolated world. Under Node they are exported via the module.exports guard at
 * the bottom of the file.
 */

/**
 * Parse an owner/repo pair out of a GitHub pulls URL.
 *
 * Accepts a full href or a pathname. Only matches the PR list page
 * (".../{owner}/{repo}/pulls"), not an individual PR (".../pull/123").
 *
 * @param {string} url - e.g. "https://github.com/octocat/hello-world/pulls?q=is%3Aopen"
 * @returns {{owner: string, repo: string} | null} null when the URL is not a pulls page.
 */
function parseOwnerRepoFromUrl(url) {
  if (typeof url !== 'string' || url.length === 0) {
    return null;
  }

  // Reduce a full URL to its pathname. Fall back to the raw string when it is
  // already a path (URL() throws on a bare "/owner/repo/pulls").
  let pathname = url;
  try {
    pathname = new URL(url).pathname;
  } catch (_e) {
    // url was not absolute; treat it as a pathname as-is.
  }

  // /{owner}/{repo}/pulls  (trailing slash optional, query/hash already stripped)
  const match = pathname.match(/^\/([^/]+)\/([^/]+)\/pulls\/?$/);
  if (!match) {
    return null;
  }

  return { owner: decodeURIComponent(match[1]), repo: decodeURIComponent(match[2]) };
}

/**
 * Extract the PR number from a single PR list row element.
 *
 * GitHub renders each PR row with an id like "issue_123" and a title anchor
 * whose href ends in "/pull/123". We try the id first (stable, cheap) and fall
 * back to scanning anchor hrefs.
 *
 * @param {Element} rowEl - a PR list row element (must expose getAttribute / querySelector).
 * @returns {number | null} the PR number, or null when none could be found.
 */
function extractPrNumberFromRow(rowEl) {
  if (!rowEl || typeof rowEl.getAttribute !== 'function') {
    return null;
  }

  // 1) The row id is typically "issue_<number>".
  const id = rowEl.getAttribute('id');
  if (id) {
    const idMatch = id.match(/(?:issue|pr)[_-](\d+)/i);
    if (idMatch) {
      return Number(idMatch[1]);
    }
  }

  // 2) Fall back to a "/pull/<number>" link inside the row.
  if (typeof rowEl.querySelectorAll === 'function') {
    const anchors = rowEl.querySelectorAll('a[href]');
    for (const a of anchors) {
      const num = extractPrNumberFromHref(a.getAttribute('href'));
      if (num !== null) {
        return num;
      }
    }
  }

  return null;
}

/**
 * Extract a PR number from a "/pull/<n>" href. Exposed separately so it can be
 * unit-tested without constructing DOM nodes.
 *
 * @param {string} href
 * @returns {number | null}
 */
function extractPrNumberFromHref(href) {
  if (typeof href !== 'string') {
    return null;
  }
  const match = href.match(/\/pull\/(\d+)(?:[/?#]|$)/);
  return match ? Number(match[1]) : null;
}

/**
 * De-duplicate and sort a list of PR numbers. Filters out anything that is not
 * a positive integer so a malformed row can never poison the GraphQL query.
 *
 * @param {Array<number|string>} numbers
 * @returns {number[]} unique, ascending, valid PR numbers.
 */
function normalizePrNumbers(numbers) {
  if (!Array.isArray(numbers)) {
    return [];
  }
  const seen = new Set();
  for (const raw of numbers) {
    const n = Number(raw);
    if (Number.isInteger(n) && n > 0) {
      seen.add(n);
    }
  }
  return Array.from(seen).sort((a, b) => a - b);
}

// Module export guard — present so Node tests can `require()` these functions.
// In the extension `module` is undefined, so this block is skipped and the
// functions remain plain globals shared across the content script bundle.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    parseOwnerRepoFromUrl,
    extractPrNumberFromRow,
    extractPrNumberFromHref,
    normalizePrNumbers,
  };
}
