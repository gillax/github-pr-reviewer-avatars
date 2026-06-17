/**
 * options.js — logic for the settings page (options.html).
 *
 * Lets the user save / clear / test their GitHub PAT.
 *
 * SECURITY note: the token IS handled here because this is the trusted
 * extension UI (not a web page). Save writes it to chrome.storage.local; Test
 * hands it to the background worker for a one-off `viewer { login }` check. The
 * token is never written to chrome.storage.sync and never reaches any web page.
 */

(() => {
  'use strict';

  const STORAGE_KEY_PAT = 'githubPat';

  const els = {
    input: document.getElementById('pat'),
    save: document.getElementById('save'),
    clear: document.getElementById('clear'),
    test: document.getElementById('test'),
    toggle: document.getElementById('toggle-visibility'),
    status: document.getElementById('status'),
  };

  /**
   * Render a status message with a severity class for styling.
   * @param {string} text
   * @param {'info'|'success'|'error'} kind
   */
  function setStatus(text, kind) {
    els.status.textContent = text;
    els.status.className = 'prra-options__status';
    if (kind) {
      els.status.classList.add(`prra-options__status--${kind}`);
    }
  }

  /** Load any previously saved token into the input on page open. */
  async function loadExisting() {
    try {
      const stored = await chrome.storage.local.get(STORAGE_KEY_PAT);
      const pat = stored && stored[STORAGE_KEY_PAT];
      if (typeof pat === 'string' && pat.length > 0) {
        els.input.value = pat;
        setStatus('A token is saved. Test the connection to confirm it still works.', 'info');
      }
    } catch (err) {
      setStatus(`Could not read stored token: ${err}`, 'error');
    }
  }

  /** Persist the token to chrome.storage.local. */
  async function save() {
    const pat = els.input.value.trim();
    if (!pat) {
      setStatus('Enter a token first, or use Clear to remove the saved one.', 'error');
      return;
    }
    try {
      await chrome.storage.local.set({ [STORAGE_KEY_PAT]: pat });
      setStatus('Saved. Reload any open PR list pages to see reviewer avatars.', 'success');
    } catch (err) {
      setStatus(`Could not save token: ${err}`, 'error');
    }
  }

  /** Remove the stored token. */
  async function clear() {
    try {
      await chrome.storage.local.remove(STORAGE_KEY_PAT);
      els.input.value = '';
      setStatus('Token cleared. The extension will no longer show reviewers.', 'info');
    } catch (err) {
      setStatus(`Could not clear token: ${err}`, 'error');
    }
  }

  /**
   * Ask the background worker to validate the currently entered token via
   * `viewer { login }`. We send the value from the input (not necessarily the
   * saved one) so the user can verify before saving.
   */
  async function testConnection() {
    const pat = els.input.value.trim();
    if (!pat) {
      setStatus('Enter a token to test.', 'error');
      return;
    }
    setStatus('Testing…', 'info');
    try {
      const response = await chrome.runtime.sendMessage({ type: 'VERIFY_PAT', pat });
      if (response && response.ok) {
        setStatus(`Success — authenticated as ${response.login}.`, 'success');
        return;
      }
      if (response && response.status === 'unauthorized') {
        setStatus('Token rejected (401). Check it has not expired and has the right scope.', 'error');
        return;
      }
      setStatus(`Could not verify token: ${describeFailure(response)}`, 'error');
    } catch (err) {
      setStatus(`Could not reach the background worker: ${err}`, 'error');
    }
  }

  /** Human-readable description of a non-ok verify/fetch envelope. */
  function describeFailure(response) {
    if (!response) {
      return 'no response';
    }
    if (response.reason === 'network') {
      return 'network error (are you online?)';
    }
    if (response.reason === 'http') {
      return `HTTP ${response.httpStatus}`;
    }
    if (response.reason === 'no_viewer') {
      return 'GitHub did not return a user for this token';
    }
    return response.reason || response.status || 'unknown error';
  }

  /** Toggle the password field between hidden and visible. */
  function toggleVisibility() {
    if (els.input.type === 'password') {
      els.input.type = 'text';
      els.toggle.textContent = 'Hide';
    } else {
      els.input.type = 'password';
      els.toggle.textContent = 'Show';
    }
  }

  els.save.addEventListener('click', save);
  els.clear.addEventListener('click', clear);
  els.test.addEventListener('click', testConnection);
  els.toggle.addEventListener('click', toggleVisibility);

  loadExisting();
})();
