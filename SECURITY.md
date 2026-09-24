# Security

This repository is designed around a dedicated persistent Playwright browser profile authenticated through LoreMotion's normal Google sign-in flow.

## Secrets

The effective authentication secret is the browser profile directory configured by `LOREMOTION_PROFILE_DIR` (default `.loremotion-profile/`). It may contain session cookies and browser storage that can provide account access.

- Never commit, upload, email, or share `.loremotion-profile/`.
- Never place a Google password, browser cookies, OAuth refresh token, MFA seed, or recovery code in `.env`.
- `.env` and `.loremotion-profile/` are ignored by Git in this repo.
- Prefer a dedicated Google/LoreMotion account with only the access required for this automation.

## Authentication behavior

`npm run login` opens a visible browser and requires the operator to complete Google's normal sign-in/MFA flow manually. The script then checks LoreMotion's UI/dashboard state and only reports setup success when the saved profile appears authenticated.

The project does not include CAPTCHA solvers, password automation, MFA bypasses, ad bypasses, anti-detection patches, queue bypasses, or rate-limit workarounds.

## If the profile is exposed

1. Sign out of LoreMotion/Google sessions associated with the automation account.
2. Revoke the relevant Google session/device if appropriate.
3. Delete `.loremotion-profile/` locally.
4. Run `npm run login` to create a fresh authenticated profile.

## Deployment

Keep the MCP transport local (stdio) unless you add your own authenticated network boundary. Do not expose this server directly to the public internet.
