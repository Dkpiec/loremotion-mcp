# Test Status

## Implemented for the verified headless target

- Persistent profile import from a directory, `.zip`, `.tar`, `.tar.gz`, or `.tgz`.
- Import staging and structural completeness checks.
- Verification of an imported profile through the existing LoreMotion auth-status logic.
- Rollback to the previous profile when imported authentication does not verify.
- `LOREMOTION_PROFILE_IMPORT_PATH` for non-interactive/Hermes bootstrap.
- `LOREMOTION_EXECUTABLE_PATH`, with automatic fallback to `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH`.
- `LOREMOTION_LAUNCH_ARGS` passed to both `chromium.launch` and `chromium.launchPersistentContext`.
- Default launch args: `--no-sandbox --disable-dev-shm-usage --disable-gpu --single-process` (see "Headless verification results" below — headless-shell on this server OOMs without `--single-process`).
- Headless `npm run probe`; no forced headed browser.
- Range-slider duration setter using the native HTMLInputElement value setter plus React-visible `input`/`change` events.
- Requested-duration max/min validation and post-write verification.
- `loremotion_probe_ui` output includes duration range metadata and `durationSliderMax`.
- Prompt filling prefers textarea placeholder matching.
- Visible/unsolved Cloudflare Turnstile fast-fail.
- Non-TTY `npm run login` exits non-zero rather than waiting on readline.
- `setup-google-login.sh` supports profile import for headless setup.
- Hermes bootstrap entrypoint verifies/imports auth before starting MCP while keeping stdout clean.
- Soak-test harness and selector overrides retained.

## Verification performed in this build environment

- `npm run check`: **PASS** after all modifications.
- MCP tool definitions were not renamed or schema-modified in `src/server.js`.
- `scripts/mcp-list-tools.js` was added to perform an actual stdio `tools/list` assertion for all five tools once dependencies are available.

## Verification blocked in this build environment

The current build container cannot resolve `registry.npmjs.org` (`EAI_AGAIN`), so dependencies could not be installed here. Because of that environment limitation, this container could not execute `npm run check-tools` against the MCP SDK runtime.

A real `signedIn:true` imported-profile test also requires an actual authenticated LoreMotion browser profile. No user credential/profile was provided to this build container, so such a result is not fabricated here.

On the target headless VPS, the final acceptance sequence is:

```bash
npm install
npm run check
npm run check-tools
npm run import-profile -- /secure/path/loremotion-profile.tgz
npm run verify-login
node scripts/hermes-mcp.js
```

Acceptance criteria:

1. `npm run check` exits 0.
2. `npm run check-tools` reports exactly five tools and no missing/unexpected tools.
3. `npm run import-profile` exits 0 only after its headless auth verification reports `signedIn:true`.
4. `npm run verify-login` reports `signedIn:true` using the configured headless-shell executable.
5. Hermes can spawn `scripts/hermes-mcp.js` over stdio without any bootstrap text on stdout.

## Headless verification results (2026-09-24, target VPS)

Environment: Linux arm64, headless (no X), no system Chrome/Chromium. Browser is
Playwright's chromium **headless-shell** only, resolved via
`PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH`. `npm install` and `npm run check` both run.

| Check | Result |
|---|---|
| `npm install` | PASS |
| `npm run check` | PASS |
| `npm run check-tools` (stdio tools/list) | PASS — all 5 tools, none missing/unexpected |
| `loremotion_probe_ui` against live `/generate/` | PASS — real DOM, title, inputs, screenshot |
| Duration range metadata / `durationSliderMax` | PASS — reads max 5 (LTX 2.5 temporary free-tier cap) |
| Aspect selection (9:16) | PASS |
| Range-slider duration write (requested 3s) | PASS — React-visible, value re-read as 3 |
| Generate button enabled after form fill | PASS |
| Import-profile: missing source | PASS — non-zero, clear message, no hang |
| Import-profile: bogus path | PASS — non-zero, clear message, no hang |
| Import-profile: structurally-valid but unauthenticated | PASS — non-zero, "not authenticated" message, `Default/` left behind (see note 1) |
| `loremotion_generate_video` (no signed-in profile) | FAIL — Cloudflare Turnstile |
| `loremotion_list_history` (no signed-in profile) | NOT RUN — blocked on the same Turnstile/signed-in profile |
| `npm run login` (interactive Google sign-in) | NOT RUN — no interactive desktop; Google MFA cannot be done on this box |
| Import of an authenticated profile → `signedIn:true` | NOT RUN — no authenticated profile provided |

The single remaining blocker for the full generate → history → download chain is
Cloudflare Turnstile on an anonymous, datacenter egress IP. The automation does not
attempt to solve it: `hasBlockingTurnstile()` is checked before clicking Generate,
after the click, and while waiting, and it fails fast with:

    Cloudflare challenge present; a signed-in profile or different egress is required

On this server the challenge iframe additionally crashes the headless-shell page
(`Target page, context or browser has been closed`), so anonymous generation cannot
be verified here at all. This is exactly the case the guard exists for.

### Notes

1. **Import-profile partial state.** When the imported profile is structurally
   complete but fails the headless auth verification, the copy is rolled back to
   the previous profile, but if the previous profile was **empty** the staging
   `Default/` directory is left behind in `LOREMOTION_PROFILE_DIR`. Harmless
   (the next import overwrites it) but worth knowing. Verified 2026-09-24.
2. **`--single-process` is required, not optional, on this host.** Without it every
   page interaction crashes with `Target crashed` — the headless-shell process
   OOMs in the default multi-process mode. It is now in the default launch args.

### What an operator must do to get the signed-in chain working

1. On a desktop (not this server), run `npm run login` and complete the Google
   sign-in including MFA. This produces a persistent profile directory.
2. Ship that profile to the server as a `.tgz`/`.zip` (do not put a Google password
   or cookie string anywhere in `.env`, source, or git — see SECURITY.md).
3. On the server: `npm run import-profile -- /secure/path/loremotion-profile.tgz`.
   It exits 0 only when the headless auth verification reports `signedIn:true`.
4. Then `loremotion_generate_video`, `loremotion_list_history`, and
   `loremotion_download_video` become exercisable. A signed-in session is also
   far less likely to hit the Turnstile challenge in the first place.

