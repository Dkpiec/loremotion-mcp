# Test Status

## Local repository checks

- JavaScript syntax checks: run with `npm run check`.
- Google-login bootstrap: implemented with a visible persistent Playwright profile.
- Saved-session verification: implemented with `npm run verify-login`.
- 20-run signed-in soak harness: implemented in `scripts/soak-test.js`.

## Live LoreMotion verification

A real Google sign-in and video generation require an interactive browser plus outbound access to LoreMotion from the machine running this repository. The repository must not be described as live-generation verified unless those runs have actually completed and the generated share/video results are recorded.
