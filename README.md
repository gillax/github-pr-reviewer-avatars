# GitHub PR Reviewer Avatars

A small, auditable Chrome extension (Manifest V3) that adds **reviewer avatars**
to the GitHub pull request list page — `https://github.com/{owner}/{repo}/pulls`.

GitHub does not show reviewers on the PR list, and the information is not in the
page's HTML, so the extension fetches it from the GitHub API and injects an
avatar into each row. It works on **public and private** repositories you have
access to, using a Personal Access Token (PAT) you provide.

## Why you can trust it

The whole point of this extension is that it is **readable and auditable**. It
has no build step — what you see in the repository is exactly what runs.

- Your token is stored only in `chrome.storage.local` (never `chrome.storage.sync`,
  so it is never synced to your Google account).
- Your token is used in exactly **one file**, `src/background.js`, and is sent to
  exactly **one destination**, `https://api.github.com/graphql`.
- The content script that runs on `github.com` never reads or receives the
  token. It only asks the background worker for reviewer data and gets back
  already-public avatars and logins.

You can confirm all of this by reading the code — `grep` for `api.github.com`
and `Authorization` and you will find them only in `src/background.js`.

## What it shows

On each PR row, next to the "#&lt;number&gt; opened … by &lt;author&gt;"
metadata (on its own line below it in GitHub's classic list, inline at the end
of that line in the newer React list), the extension shows:

- **The avatar of every reviewer.** "Reviewers" means the **union** of:
  - people still **requested** to review (`reviewRequests`), and
  - people who have **already reviewed** (`latestReviews`).
  This union matters because approving a PR removes you from `reviewRequests`;
  without the union, anyone who already approved would disappear from the list.
- **A review-state ring around each avatar**, coloured by that person's latest
  review: green = approved, red = changes requested, gold = commented, grey =
  pending (requested but not yet reviewed). The state is also in the avatar's
  tooltip, e.g. "Reviewer: alice (approved)".
- **Team** reviewers (which have no personal avatar) are shown as a small text
  label so they are not silently dropped.

It also **highlights the whole PR row** (a subtle background + left accent) when
**you** (the token owner) are a reviewer who has **not yet approved** — so PRs
still awaiting your review stand out. PRs you have already approved are not
highlighted.

## Install (load unpacked)

1. Clone or download this repository.
2. Open `chrome://extensions` in Chrome.
3. Turn on **Developer mode** (top-right).
4. Click **Load unpacked** and select this repository's folder (the one with
   `manifest.json`).
5. Click the extension's toolbar icon (or open its options) and set your token —
   see below.

## Set up a Personal Access Token

Open the extension's options page (toolbar icon → it opens the settings tab),
paste a token, click **Test connection**, then **Save**.

Either kind of GitHub PAT works:

- **Classic token** with the `repo` scope — covers public and private repos.
  Create one at <https://github.com/settings/tokens/new> (preselect the scope
  with `?scopes=repo`).
- **Fine-grained token** scoped to the repositories you care about, with
  **Repository permissions → Pull requests: Read-only**.
  Create one at <https://github.com/settings/personal-access-tokens/new>.

If no token is set, the extension does nothing except show a small "Set GitHub
token to show reviewers" link on the PR list. If the token is rejected (401),
the options page shows a notice and the PR list stays silent — the extension
never breaks the page.

## How the code is organised (no bundler)

The extension uses plain JavaScript with **no build step**, which constrains how
modules are shared. There are three pure-function libraries under `src/lib/`:

| File | Responsibility |
| --- | --- |
| `src/lib/parse.js` | Extract owner/repo and PR numbers from the URL and DOM rows. |
| `src/lib/query.js` | Build the single aliased GraphQL query from a list of PR numbers. |
| `src/lib/transform.js` | Turn the GraphQL response into `{ prNumber → reviewers[] }`. |

These same files run in three places, so they use a deliberate dual-mode
pattern instead of ES `import`/`export`:

- Each file declares **plain functions** at the top level, and at the bottom has:

  ```js
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { /* … */ };
  }
  ```

- **In the content script** (`github.com`): the libs are listed in
  `manifest.json` under `content_scripts.js` **before** `src/content.js`.
  Content scripts share one isolated-world global scope and **cannot** use ES
  `import` without a bundler, so the functions are simply available as globals.
  (The `module.exports` guard is skipped because `module` is undefined there.)
- **In the background service worker** (`src/background.js`): the libs are loaded
  with `importScripts('lib/parse.js', …)`. The worker is a **classic** (non-module)
  service worker precisely so `importScripts` works.
- **Under Node** (the unit tests): the libs are loaded with `require(...)`, which
  triggers the `module.exports` guard.

The `chrome.*`-dependent code (content script, background, options) is kept as a
thin layer around these pure functions, which is what makes the logic testable.

### Files

```
manifest.json          MV3 manifest (permissions, matches, scripts)
src/content.js         Runs on the PR list; collects PR numbers, injects avatars
src/background.js       Service worker; the ONLY place the token is used / fetches run
src/options.html       Settings UI
src/options.js          Settings logic (save / clear / test the token)
src/styles.css          Avatar styles + options page styles
src/lib/parse.js        Pure: URL/DOM parsing
src/lib/query.js        Pure: GraphQL query building
src/lib/transform.js    Pure: GraphQL response → display data
```

## Running the unit tests

The pure functions in `src/lib/` are tested with Node's built-in test runner —
no dependencies to install.

```bash
node --test
```

(The tests live alongside the project and `require()` the `src/lib/*` modules
directly. They cover PR-number extraction, GraphQL query generation, and
response transformation.)

## Scope and limitations

- Only the repository PR list page (`/{owner}/{repo}/pulls`) on **github.com**.
- Row detection targets both the classic server-rendered list (`.js-issue-row`)
  and the newer React "ListView" list (`li[class*="ListItem-module__listItem"]`).
  The React markup uses CSS modules whose class hashes change on every GitHub
  deploy, so the selectors deliberately match only the stable class prefixes;
  a larger GitHub redesign can still require an update here.
- Not the global dashboards (`/pulls`, `/pulls/assigned`) — possible future work.
- Not GitHub Enterprise Server (custom hosts) — possible future work.
- The "you are a reviewer" highlight matches **direct** user review requests
  only; being a member of a **team** that was requested does not flag the PR
  (teams are not expanded to their members).

## Security

Your token stays in `chrome.storage.local` on your device, and only the
background service worker sends it — exclusively to `api.github.com`. See
[SECURITY.md](.github/SECURITY.md) for the full threat model, recommended token
scope, and how to report a vulnerability privately.

## License

[MIT](LICENSE) © gillax
