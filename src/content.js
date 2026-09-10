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

/* global parseOwnerRepoFromUrl, extractPrNumberFromRow, normalizePrNumbers, viewerReviewState */

(() => {
  'use strict';

  // data-* markers so we never inject twice into the same row, and so we can
  // find our own nodes again across re-runs.
  const ROW_DECORATED_ATTR = 'data-prra-decorated';
  const CONTAINER_CLASS = 'prra-reviewers';
  const OPTIONS_LINK_CLASS = 'prra-options-link';
  const MINE_CLASS = 'prra-mine'; // row highlight when YOU are a reviewer

  let running = false; // re-entrancy guard for run()
  let observer = null; // MutationObserver instance
  let optionsLinkShown = false; // only show the "set token" hint once per page

  /**
   * Candidate selectors for PR list rows, most-specific first. GitHub changes
   * its markup periodically, so we keep a few fallbacks. A row is only used if
   * we can extract a PR number from it (extractPrNumberFromRow), which filters
   * out non-PR matches.
   *
   * Two generations of markup are covered:
   *   - the classic server-rendered list (.js-issue-row / id="issue_<n>");
   *   - the React "ListView" rollout, where each row is
   *     <li id="…-list-view-node-…" class="ListItem-module__listItem__<hash>
   *     PullsListItem-module__listItem__<hash>">. Those class names are CSS
   *     modules, so the trailing hash changes on every GitHub deploy — always
   *     match the stable prefix with [class*=…], never the full class.
   */
  const ROW_SELECTORS = [
    '.js-issue-row', // classic list: long-standing class for issue/PR rows
    '[id^="issue_"]', // classic list: row ids are "issue_<number>"
    'li[class*="ListItem-module__listItem"]', // React ListView rows
    '[id*="list-view-node"]', // React ListView rows (id-based fallback)
    'li[data-id]', // older list-item rows
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
   * Find the main content column of a PR row — the part holding the title and
   * the "#<number> opened … by <author>" metadata line.
   *
   * Classic markup:
   *   .js-issue-row > div.d-flex > [state col][THIS .flex-auto.min-width-0 col][meta col]…
   *
   * React ListView markup: the row is a CSS grid whose "main-content" area
   * holds that metadata line, nested as
   *   li > MainContent-module__container > …__inner > Description-module__container
   * The Description container is the "#<n> · <author> opened … · <checks>" line
   * itself, so appending there keeps the avatars next to that text; appending to
   * the MainContent container instead would push them to the far right of the
   * row (its inner wrapper is flex: 1 1 auto).
   *
   * @param {Element} row
   * @returns {Element|null}
   */
  function findMainColumn(row) {
    const inner = row.querySelector(':scope > div') || row;
    const classicCol = Array.from(inner.children).find(
      (c) => /flex-auto/.test(c.className) && /min-width-0/.test(c.className)
    );
    if (classicCol) {
      return classicCol;
    }
    // React ListView (hashed CSS-module classes — match the stable prefix only).
    return (
      row.querySelector('[class*="Description-module__container"]') ||
      row.querySelector('[class*="MainContent-module__container"]') ||
      null
    );
  }

  /**
   * Within the main column, find the "opened by" metadata line — the row that
   * shows "#<number> opened … by <author>". We insert reviewers just below it.
   *
   * @param {Element} mainCol
   * @returns {Element|null}
   */
  function findOpenedByLine(mainCol) {
    const openedBy = mainCol.querySelector('.opened-by');
    if (openedBy) {
      let line = openedBy;
      while (line && line.parentElement !== mainCol) {
        line = line.parentElement;
      }
      if (line) return line;
    }
    // Fallback: a muted, small metadata line directly under the title.
    const muted = mainCol.querySelector(':scope > .color-fg-muted');
    if (muted) {
      return muted;
    }
    // React ListView: the metadata line is the column's own inner wrapper, so
    // there is nothing to insert *after* — placeReviewersEl appends instead.
    return null;
  }

  /**
   * Place the reviewers element on its OWN row, immediately below the
   * "#<number> opened … by <author>" line. This keeps it clear of GitHub's
   * right-hand metadata column, whose linked-issue / assignee icons can collide
   * with injected content. Falls back to the end of the main column, then the
   * row itself, so we always render something.
   *
   * @param {Element} row
   * @param {HTMLElement} el
   */
  function placeReviewersEl(row, el) {
    const mainCol = findMainColumn(row);
    if (mainCol) {
      const openedByLine = findOpenedByLine(mainCol);
      if (openedByLine) {
        openedByLine.after(el);
      } else {
        mainCol.appendChild(el);
      }
      return;
    }
    row.appendChild(el);
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

    // A block-level row of its own (placed below the opened-by line).
    const container = document.createElement('div');
    container.className = CONTAINER_CLASS;

    for (const reviewer of reviewers) {
      if (reviewer.type === 'User') {
        const link = document.createElement('a');
        link.className = 'prra-reviewer prra-reviewer--user';
        if (reviewer.url) {
          link.href = reviewer.url;
        }
        // Human-readable state in the tooltip (doubles as a legend for the
        // ring colours): "Reviewer: alice (approved)" / "(changes requested)".
        const stateLabel = (reviewer.state || 'PENDING').toLowerCase().replace(/_/g, ' ');
        link.title = `Reviewer: ${reviewer.login} (${stateLabel})`;
        // data-state drives the review-state ring colour purely via CSS.
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
   * Also toggles MINE_CLASS on each row so PRs where YOU (the token owner) are a
   * reviewer get a highlighted background.
   *
   * @param {Element[]} rows
   * @param {{ [n: number]: object[] }} reviewersByNumber
   * @param {string|null} viewerLogin - the token owner's login, for the highlight.
   */
  function decorateRows(rows, reviewersByNumber, viewerLogin) {
    for (const row of rows) {
      const number = extractPrNumberFromRow(row);
      if (number === null) {
        continue;
      }

      const reviewers = reviewersByNumber[number];

      // Highlight the row when you are a reviewer who has NOT yet approved, so
      // PRs still awaiting your review stand out (approved-by-you PRs are left
      // un-highlighted). Toggle both ways so a re-render that no longer matches
      // clears a previous highlight.
      const myReviewState = viewerReviewState(reviewers, viewerLogin);
      if (myReviewState !== undefined && myReviewState !== 'APPROVED') {
        row.classList.add(MINE_CLASS);
      } else {
        row.classList.remove(MINE_CLASS);
      }

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
    const mainCol = findMainColumn(firstRow);
    const target = (mainCol && findOpenedByLine(mainCol)) || mainCol || firstRow;
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
        decorateRows(undecorated, response.reviewers || {}, response.viewerLogin || null);
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
