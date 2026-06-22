# Security Policy

This is a Manifest V3 Chrome extension that reads a GitHub Personal Access
Token (PAT) you provide and uses it to call the GitHub API. Because it handles
a credential, the threat model matters — this document explains how the token
is handled and how to report a problem.

## How your token is handled

- The token is stored in `chrome.storage.local` **on your device only**. It is
  deliberately never written to `chrome.storage.sync`, so it is never synced to
  Google's servers or to your other machines.
- Only the extension's background service worker (`src/background.js`) reads the
  token, and it is sent **only** to `https://api.github.com`. The host
  permissions in `manifest.json` are limited to `github.com` and
  `api.github.com`.
- The page-side content script never reads or receives the token, so a
  compromised or malicious web page cannot exfiltrate it through this extension.
- The extension has no build step. The code you review here is the code that
  runs — you can audit every line before loading it.

### Recommended token scope

Use the **minimum** scope the extension needs. A fine-grained token with
read-only access to the repositories you care about is preferred over a classic
token with the full `repo` scope. Treat the token like a password and revoke it
from <https://github.com/settings/tokens> if you ever stop using the extension.

## Supported versions

This project is pre-1.0. Security fixes are applied to the latest release only.

## Reporting a vulnerability

Please report security issues **privately** rather than opening a public issue:

- Preferred: open a [private security advisory](https://github.com/gillax/github-pr-reviewer-avatars/security/advisories/new)
  via GitHub's "Report a vulnerability" button on the Security tab.

Please include steps to reproduce and the impact you observed. I will
acknowledge the report and work on a fix; once a fix is released, the advisory
can be published with credit to the reporter if desired.
