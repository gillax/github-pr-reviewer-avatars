/**
 * background.js — the extension's service worker.
 *
 * SECURITY: This is the ONLY file that reads the Personal Access Token (PAT)
 * and the ONLY file that talks to the network. The token is read from
 * chrome.storage.local here, attached to a request to https://api.github.com/
 * graphql, and never sent anywhere else. The content script and the page never
 * see it — they only receive the already-public reviewer data (avatars/logins)
 * in the response. Read this file top to bottom to confirm that claim.
 *
 * This is a CLASSIC (non-module) service worker. The shared pure-function libs
 * are loaded with importScripts so the exact same parse/query/transform code
 * runs here and in the content script (and under Node in the unit tests).
 */

/* global buildReviewersQuery, transformResponse */

importScripts('lib/parse.js', 'lib/query.js', 'lib/transform.js');

const GITHUB_GRAPHQL_ENDPOINT = 'https://api.github.com/graphql';
const STORAGE_KEY_PAT = 'githubPat';

/**
 * Read the stored PAT from chrome.storage.local.
 * Deliberately NOT chrome.storage.sync — we never want the token synced to
 * Google's servers across the user's devices.
 *
 * @returns {Promise<string|null>}
 */
async function getStoredPat() {
  const stored = await chrome.storage.local.get(STORAGE_KEY_PAT);
  const pat = stored && stored[STORAGE_KEY_PAT];
  return typeof pat === 'string' && pat.trim().length > 0 ? pat.trim() : null;
}

/**
 * Result envelope returned to the content script. We return a small status
 * string instead of throwing across the message boundary so the content script
 * can degrade gracefully (and never break the PR list).
 *
 *  ok          -> { ok: true, reviewers: { number -> Reviewer[] } }
 *  no_pat      -> token not configured; content shows the options link only
 *  unauthorized-> 401; options page surfaces a re-auth notice
 *  error       -> rate limit / network / GraphQL errors; content logs a warning
 */

/**
 * Fetch reviewers for one page of PRs via a single GraphQL request.
 *
 * @param {{owner: string, repo: string, numbers: number[]}} payload
 * @returns {Promise<object>} the result envelope described above.
 */
async function fetchReviewers(payload) {
  const { owner, repo, numbers } = payload || {};

  const built = buildReviewersQuery(owner, repo, numbers);
  if (!built) {
    // Nothing to ask about (empty/invalid number list) — not an error.
    return { ok: true, reviewers: {} };
  }

  const pat = await getStoredPat();
  if (!pat) {
    return { ok: false, status: 'no_pat' };
  }

  let response;
  try {
    response = await fetch(GITHUB_GRAPHQL_ENDPOINT, {
      method: 'POST',
      headers: {
        // The ONLY place the PAT leaves storage. Destination is hard-coded to
        // api.github.com above; there is no other fetch in this extension.
        Authorization: `Bearer ${pat}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(built),
    });
  } catch (networkError) {
    // Offline, DNS failure, etc. Never throw back to the content script.
    return { ok: false, status: 'error', reason: 'network', detail: String(networkError) };
  }

  if (response.status === 401) {
    return { ok: false, status: 'unauthorized' };
  }

  if (response.status === 403) {
    // 403 from the GraphQL API is typically rate limiting / abuse detection.
    return { ok: false, status: 'error', reason: 'rate_limited', httpStatus: 403 };
  }

  if (!response.ok) {
    return { ok: false, status: 'error', reason: 'http', httpStatus: response.status };
  }

  let json;
  try {
    json = await response.json();
  } catch (parseError) {
    return { ok: false, status: 'error', reason: 'bad_json', detail: String(parseError) };
  }

  // GraphQL can return data AND errors together (e.g. one inaccessible PR among
  // many). Surface the errors for logging but still return whatever data came
  // back so the rest of the list decorates normally.
  const reviewers = transformResponse(json);
  const result = { ok: true, reviewers };
  if (json && Array.isArray(json.errors) && json.errors.length > 0) {
    result.partialErrors = json.errors.map((e) => (e && e.message) || 'unknown');
  }
  return result;
}

/**
 * Validate a candidate PAT by calling `viewer { login }`. Used by the options
 * page's "Test connection" button. The token is passed in from options.js (it
 * has just been typed there); it is used once for this check and not stored by
 * this function.
 *
 * @param {string} pat
 * @returns {Promise<object>} { ok, login } | { ok: false, status, ... }
 */
async function verifyPat(pat) {
  if (typeof pat !== 'string' || pat.trim().length === 0) {
    return { ok: false, status: 'no_pat' };
  }

  let response;
  try {
    response = await fetch(GITHUB_GRAPHQL_ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${pat.trim()}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({ query: 'query { viewer { login } }' }),
    });
  } catch (networkError) {
    return { ok: false, status: 'error', reason: 'network', detail: String(networkError) };
  }

  if (response.status === 401) {
    return { ok: false, status: 'unauthorized' };
  }
  if (!response.ok) {
    return { ok: false, status: 'error', reason: 'http', httpStatus: response.status };
  }

  let json;
  try {
    json = await response.json();
  } catch (parseError) {
    return { ok: false, status: 'error', reason: 'bad_json', detail: String(parseError) };
  }

  const login = json && json.data && json.data.viewer && json.data.viewer.login;
  if (!login) {
    return { ok: false, status: 'error', reason: 'no_viewer' };
  }
  return { ok: true, login };
}

// Single message router. Both content.js and options.js talk to the worker
// through here. Returning true keeps the sendResponse channel open for the
// async work above.
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || typeof message.type !== 'string') {
    return false;
  }

  if (message.type === 'GET_REVIEWERS') {
    fetchReviewers(message.payload)
      .then(sendResponse)
      .catch((err) => sendResponse({ ok: false, status: 'error', detail: String(err) }));
    return true;
  }

  if (message.type === 'VERIFY_PAT') {
    // The PAT here comes from the options page input (user just typed it), used
    // only to validate. Options.js stores it separately via chrome.storage.
    verifyPat(message.pat)
      .then(sendResponse)
      .catch((err) => sendResponse({ ok: false, status: 'error', detail: String(err) }));
    return true;
  }

  if (message.type === 'OPEN_OPTIONS') {
    // Content scripts cannot reliably open the options page themselves, so they
    // ask the worker to do it. No token involved.
    chrome.runtime.openOptionsPage();
    return false;
  }

  return false;
});

// Clicking the toolbar icon opens the options page (where the PAT is set).
chrome.action.onClicked.addListener(() => {
  chrome.runtime.openOptionsPage();
});
