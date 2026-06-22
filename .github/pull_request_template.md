## What this changes

<!-- A short description of the change and why it is needed. -->

## Checklist

- [ ] `node --test` passes locally
- [ ] No secrets, tokens, or personal data are included in the diff
- [ ] If the change touches token handling or network calls, the security notes
      in `.github/SECURITY.md` still hold (token stays in `chrome.storage.local`,
      only `background.js` talks to `api.github.com`)
- [ ] README / docs updated if behaviour changed
