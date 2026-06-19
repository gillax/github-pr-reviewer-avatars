/**
 * content.js — runs on the GitHub PR list page (isolated world).
 *
 * Responsibilities:
 *   1. Confirm we are on /{owner}/{repo}/pulls.
 *   2. Collect the PR numbers from the rendered rows.
 *   3. Ask the background worker for reviewers (chrome.runtime.sendMessage).
 *   4. Inject reviewer avatars into each row, idempotently.
 *   5. Re-run on GitHub's Turbo/pjax soft navigations + a MutationObserver.
 *
 * SECURITY: This file NEVER reads the PAT and NEVER receives it. It only sends
 * {owner, repo, numbers} to the background worker and gets back already-public
 * reviewer data (avatar URLs + logins). The token stays in the worker.
 *
 * This script shares one isolated-world scope with src/lib/parse.js, query.js
 * and transform.js, which the manifest lists BEFORE this file. Their functions
 * (parseOwnerRepoFromUrl, extractPrNumberFromRow, normalizePrNumbers, ...) are
 * therefore available here as plain globals — no `import` needed (and none is
 * possible for a content script without a bundler).
 */

/* global parseOwnerRepoFromUrl, extractPrNumberFromRow, normalizePrNumbers */

(() => {
  'use strict';

  // data-* markers so we never inject twice into the same row, and so we can
  // find our own nodes again across re-runs.
  const ROW_DECORATED_ATTR = 'data-prra-decorated';
  const CONTAINER_CLASS = 'prra-reviewers';
  const OPTIONS_LINK_CLASS = 'prra-options-link';

  let running = false; // re-entrancy guard for run()
  let observer = null; // MutationObserver instance
  let optionsLinkShown = false; // only show the "set token" hint once per page

  /**
   * Candidate selectors for PR list rows, most-specific first. GitHub changes
   * its markup periodically, so we keep a few fallbacks. A row is only used if
   * we can extract a PR number from it (extractPrNumberFromRow), which filters
   * out non-PR matches.
   */
  const ROW_SELECTORS = [
    '.js-issue-row', // long-standing class for issue/PR rows
    '[id^="issue_"]', // row ids are "issue_<number>"
    'li[data-id]', // newer list-item rows
  ];

  /**
   * Find PR rows on the current page. Returns the first selector that yields
   * rows we can read a PR number from.
   *
   * @returns {Element[]}
   */
  function findPrRows() {
    for (const selector of ROW_SELECTORS) {
      const candidates = Array.from(document.querySelectorAll(selector));
      const rows = candidates.filter((el) => extractPrNumberFromRow(el) !== null);
      if (rows.length > 0) {
        return rows;
      }
    }
    return [];
  }

  /**
   * Find the right-hand metadata column of a PR row — the "Reviews" column that
   * also holds the assignee avatars and the comment count. Verified against the
   * current github.com PR-list markup:
   *   .js-issue-row > div.d-flex > [state col][main col][THIS col][mobile link]
   * where THIS col is `div.col-md-3.text-right.no-wrap`. We fall back through
   * progressively looser heuristics so a markup tweak does not silently break
   * placement.
   *
   * @param {Element} row
   * @returns {Element|null}
   */
  function findReviewsColumn(row) {
    const inner = row.querySelector(':scope > div') || row;
    const cols = Array.from(inner.children).filter((c) => c.tagName === 'DIV');
    // 1) The metadata column by its characteristic classes.
    let col = cols.find(
      (c) => /\bcol-md-3\b/.test(c.className) && /(text-right|no-wrap)/.test(c.className)
    );
    if (col) return col;
    // 2) A non-main column that holds an assignee stack or is right-aligned.
    col = cols.find(
      (c) =>
        !/flex-auto/.test(c.className) &&
        (c.querySelector('.AvatarStack') || /text-right/.test(c.className))
    );
    if (col) return col;
    // 3) The last non-main column.
    const nonMain = cols.filter((c) => !/flex-auto/.test(c.className));
    return nonMain[nonMain.length - 1] || null;
  }

  /**
   * Within the Reviews column, find the direct child (slot) that contains the
   * assignee avatars, so we can insert reviewers immediately to its LEFT.
   *
   * @param {Element} col
   * @returns {Element|null} null when the PR has no assignees.
   */
  function findAssigneeSlot(col) {
    const assignee = col.querySelector(
      'a[aria-label$="assigned issues"], a.avatar.avatar-user, .AvatarStack'
    );
    if (!assignee) {
      return null;
    }
    return Array.from(col.children).find((ch) => ch.contains(assignee)) || null;
  }

  /**
   * Last-resort target when the Reviews column cannot be found (older/unknown
   * markup): the row's "opened by" line, else the row itself. We always render
   * something rather than nothing.
   *
   * @param {Element} row
   * @returns {Element}
   */
  function findFallbackTarget(row) {
    return (
      row.querySelector('.opened-by') ||
      row.querySelector('[class*="opened-by"]') ||
      row
    );
  }

  /**
   * Place the reviewers element to the LEFT of the assignee avatars inside the
   * Reviews column. With no assignees it goes at the column's left edge; with no
   * column at all it falls back to the opened-by line.
   *
   * @param {Element} row
   * @param {HTMLElement} el
   */
  function placeReviewersEl(row, el) {
    const col = findReviewsColumn(row);
    if (col) {
      el.classList.add('prra-in-column');
      const assigneeSlot = findAssigneeSlot(col);
      if (assigneeSlot) {
        col.insertBefore(el, assigneeSlot);
      } else {
        col.insertBefore(el, col.firstChild);
      }
      return;
    }
    findFallbackTarget(row).appendChild(el);
  }

  /**
   * Build the avatar container for one PR's reviewers. Users render as <img>
   * avatars linking to their profile; Teams (no avatar in our query) render as
   * a small text label so they are not silently dropped (spec section 9).
   *
   * @param {Array<object>} reviewers
   * @returns {HTMLElement|null} null when there are no reviewers to show.
   */
  function buildReviewersEl(reviewers) {
    if (!Array.isArray(reviewers) || reviewers.length === 0) {
      return null;
    }

    const container = document.createElement('span');
    container.className = CONTAINER_CLASS;

    for (const reviewer of reviewers) {
      if (reviewer.type === 'User') {
        const link = document.createElement('a');
        link.className = 'prra-reviewer prra-reviewer--user';
        if (reviewer.url) {
          link.href = reviewer.url;
        }
        link.title = `Reviewer: ${reviewer.login}`;
        // data-state is set now (MVP ignores it visually) so the future
        // review-state colour feature can style purely via CSS.
        link.setAttribute('data-state', reviewer.state || 'PENDING');

        const img = document.createElement('img');
        img.className = 'prra-avatar';
        img.width = 20;
        img.height = 20;
        img.alt = reviewer.login;
        img.loading = 'lazy';
        if (reviewer.avatarUrl) {
          // Request a small avatar to keep things light.
          img.src = withAvatarSize(reviewer.avatarUrl, 40);
        }
        link.appendChild(img);
        container.appendChild(link);
      } else if (reviewer.type === 'Team') {
        const label = document.createElement('a');
        label.className = 'prra-reviewer prra-reviewer--team';
        if (reviewer.url) {
          label.href = reviewer.url;
        }
        label.title = `Team reviewer: ${reviewer.name}`;
        label.setAttribute('data-state', reviewer.state || 'PENDING');
        label.textContent = reviewer.name;
        container.appendChild(label);
      }
    }

    return container;
  }

  /**
   * Append a size query param to a GitHub avatar URL when one is not present.
   * @param {string} url
   * @param {number} size
   * @returns {string}
   */
  function withAvatarSize(url, size) {
    try {
      const u = new URL(url);
      if (!u.searchParams.has('s') && !u.searchParams.has('size')) {
        u.searchParams.set('s', String(size));
      }
      return u.toString();
    } catch (_e) {
      return url;
    }
  }

  /**
   * Inject reviewer avatars into the matched rows. Idempotent: a row already
   * marked decorated is skipped, and any stale container we previously added is
   * removed before re-rendering (so Turbo re-renders stay correct).
   *
   * @param {Element[]} rows
   * @param {{ [n: number]: object[] }} reviewersByNumber
   */
  function decorateRows(rows, reviewersByNumber) {
    for (const row of rows) {
      const number = extractPrNumberFromRow(row);
      if (number === null) {
        continue;
      }

      const reviewers = reviewersByNumber[number];
      const el = buildReviewersEl(reviewers);

      // Remove any container we added on a previous pass for this row.
      const existing = row.querySelector(`:scope .${CONTAINER_CLASS}`);
      if (existing) {
        existing.remove();
      }

      if (!el) {
        // Mark as decorated even with no reviewers so we don't keep re-querying
        // a row that simply has none.
        row.setAttribute(ROW_DECORATED_ATTR, 'empty');
        continue;
      }

      placeReviewersEl(row, el);
      row.setAttribute(ROW_DECORATED_ATTR, 'true');
    }
  }

  /**
   * When no PAT is configured, render nothing but a single subtle link to the
   * options page so the user knows how to enable the extension (spec section 9).
   */
  function showOptionsHint(rows) {
    if (optionsLinkShown || rows.length === 0) {
      return;
    }
    const firstRow = rows[0];
    const target = findReviewsColumn(firstRow) || findFallbackTarget(firstRow);
    if (target.querySelector(`.${OPTIONS_LINK_CLASS}`)) {
      optionsLinkShown = true;
      return;
    }
    const link = document.createElement('a');
    link.className = OPTIONS_LINK_CLASS;
    link.href = '#';
    link.textContent = 'Set GitHub token to show reviewers';
    link.title = 'Open the PR Reviewer Avatars settings';
    link.addEventListener('click', (event) => {
      event.preventDefault();
      chrome.runtime.sendMessage({ type: 'OPEN_OPTIONS' });
      // Fallback: also try opening directly (works from the extension context).
      try {
        chrome.runtime.openOptionsPage();
      } catch (_e) {
        /* openOptionsPage may be unavailable from a content script; ignore. */
      }
    });
    target.appendChild(link);
    optionsLinkShown = true;
  }

  /**
   * Main entry: detect the page, collect PR numbers, ask the worker, inject.
   * Guards against overlapping runs triggered by rapid mutations/navigations.
   */
  async function run() {
    // URL guard — only act on /{owner}/{repo}/pulls (defence in depth on top of
    // the manifest match patterns).
    const ownerRepo = parseOwnerRepoFromUrl(window.location.href);
    if (!ownerRepo) {
      return;
    }

    if (running) {
      return;
    }
    running = true;

    try {
      const rows = findPrRows();
      if (rows.length === 0) {
        return;
      }

      // Only consider rows we have not decorated yet (idempotency / efficiency).
      const undecorated = rows.filter((r) => !r.hasAttribute(ROW_DECORATED_ATTR));
      if (undecorated.length === 0) {
        return;
      }

      const numbers = normalizePrNumbers(undecorated.map((r) => extractPrNumberFromRow(r)));
      if (numbers.length === 0) {
        return;
      }

      const response = await sendMessageAsync({
        type: 'GET_REVIEWERS',
        payload: { owner: ownerRepo.owner, repo: ownerRepo.repo, numbers },
      });

      if (!response) {
        // Worker unreachable (e.g. during reload). Don't break the list.
        return;
      }

      if (response.ok) {
        if (response.partialErrors && response.partialErrors.length) {
          console.warn(
            '[PR Reviewer Avatars] some PRs returned GraphQL errors:',
            response.partialErrors
          );
        }
        decorateRows(undecorated, response.reviewers || {});
        return;
      }

      // Non-ok envelopes: degrade gracefully, never throw.
      switch (response.status) {
        case 'no_pat':
          showOptionsHint(rows);
          break;
        case 'unauthorized':
          // The options page surfaces the re-auth notice; the list stays silent.
          console.warn('[PR Reviewer Avatars] GitHub token rejected (401). Update it in settings.');
          break;
        default:
          console.warn('[PR Reviewer Avatars] could not load reviewers:', response);
      }
    } catch (err) {
      // Last-resort safety net: a bug here must never break GitHub's PR list.
      console.warn('[PR Reviewer Avatars] unexpected error (ignored):', err);
    } finally {
      running = false;
    }
  }

  /**
   * Promise wrapper around chrome.runtime.sendMessage. Resolves to undefined
   * (instead of rejecting) if the messaging channel errors, so callers can
   * simply bail out.
   *
   * @param {object} message
   * @returns {Promise<object|undefined>}
   */
  function sendMessageAsync(message) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(message, (response) => {
          // Touch lastError to silence "Unchecked runtime.lastError" noise.
          if (chrome.runtime.lastError) {
            resolve(undefined);
            return;
          }
          resolve(response);
        });
      } catch (_e) {
        resolve(undefined);
      }
    });
  }

  /**
   * Reset per-page state and re-run. Called on soft navigations: a Turbo nav to
   * a different repo's pulls page must re-evaluate everything from scratch.
   */
  function onNavigation() {
    optionsLinkShown = false;
    run();
  }

  /**
   * Set up a MutationObserver as a fallback for cases where Turbo events don't
   * fire (or rows stream in after the event). It is debounced and only re-runs
   * when new, undecorated rows appear.
   */
  function setupObserver() {
    if (observer) {
      return;
    }
    let scheduled = false;
    observer = new MutationObserver(() => {
      if (scheduled) {
        return;
      }
      scheduled = true;
      // Defer to the microtask/timer queue so we batch bursts of mutations.
      setTimeout(() => {
        scheduled = false;
        run();
      }, 150);
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  // --- Wire up triggers -----------------------------------------------------

  // GitHub's Turbo soft navigation and legacy pjax both signal page swaps.
  document.addEventListener('turbo:load', onNavigation);
  document.addEventListener('pjax:end', onNavigation);

  // Initial run (content scripts inject at document_idle, but rows may still be
  // arriving, so the observer covers late additions).
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', run, { once: true });
  } else {
    run();
  }

  setupObserver();
})();
