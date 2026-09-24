# Security

This repository authenticates LoreMotion by reusing a dedicated persistent Chromium profile. The profile directory is the credential.

## Never store account secrets in configuration

Do **not** put any of the following in `.env`, Git, source code, MCP configuration, shell history, or agent prompts:

- Google passwords
- OAuth access/refresh tokens
- raw browser cookie strings
- MFA/TOTP seeds
- recovery codes

The code intentionally has no field for a Google password, OAuth token, or raw cookie string.

## Persistent profile

`LOREMOTION_PROFILE_DIR` defaults to `.loremotion-profile/` and may contain cookies, local storage, IndexedDB, and other browser state that provides access to the LoreMotion session.

- `.loremotion-profile/` is ignored by Git.
- Store imported profile archives outside the repository.
- Restrict filesystem permissions on both the profile and any transfer archive.
- Delete transfer archives after import if you no longer need them.
- Prefer a dedicated Google/LoreMotion account with the minimum required access.

## Headless profile import

`npm run import-profile -- <path>` accepts only a filesystem path to a profile directory or supported archive. It does not accept credentials as strings.

The importer stages the copy, checks profile completeness, removes stale Chromium lock files, installs it temporarily, and verifies the resulting LoreMotion session with the normal auth-status logic. If verification fails, the importer restores the previous profile.

Profile portability can vary across operating systems/browser builds. A structurally complete profile that does not authenticate on the VPS is rejected.

## Interactive login

`npm run login` remains available for desktop users. It requires TTY stdin/stdout and a visible browser. On a non-interactive/headless driver it exits non-zero immediately and directs the operator to profile import.

## Cloudflare

This project does not solve or bypass CAPTCHAs or Cloudflare Turnstile. A visible unsolved challenge causes generation to stop with an explicit error.

## Browser launch flags

The default headless launch flags include:

```text
--no-sandbox
--disable-dev-shm-usage
--disable-gpu
```

`--no-sandbox` weakens Chromium's process sandbox and is commonly required in some containers/VPS environments. If your deployment supports Chromium sandboxing, override `LOREMOTION_LAUNCH_ARGS` and remove that flag.

## If the profile is exposed

1. Stop Hermes/MCP processes using the profile.
2. Sign out/revoke the relevant LoreMotion/Google session or device.
3. Delete the compromised profile and transferred archives.
4. Create a fresh dedicated profile on an interactive trusted machine.
5. Transfer and import the replacement profile securely.

## Transport

The server uses MCP stdio. Keep it local to the agent process unless you add a separately authenticated network boundary. Do not expose the raw MCP process directly to the public internet.
