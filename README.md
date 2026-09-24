# LoreMotion MCP — Hermes / Headless Linux

A GitHub-ready MCP server that drives **LoreMotion.com** with Playwright and a persistent LoreMotion browser profile. This version is designed for an automated agent such as **Hermes** running on a **headless Linux VPS**, including arm64 systems where the only available browser is Playwright's Chromium headless shell.

The five MCP tool names and schemas are unchanged:

- `loremotion_auth_status`
- `loremotion_generate_video`
- `loremotion_list_history`
- `loremotion_download_video`
- `loremotion_probe_ui`

The selector-override system and soak-test harness are retained.

## Recommended headless authentication workflow

Google OAuth/MFA should **not** be automated on the VPS. The recommended headless flow is:

```text
Authenticate once on an interactive desktop
                 ↓
Dedicated Chromium user-data/profile directory
                 ↓
Securely copy/archive that profile to the VPS
                 ↓
npm run import-profile -- <profile-dir-or-archive>
                 ↓
Importer validates structure + verifies LoreMotion auth
                 ↓
Hermes starts scripts/hermes-mcp.js
                 ↓
Persistent headless LoreMotion MCP session
```

**Never put a Google password, OAuth token, MFA secret, recovery code, or raw cookie string in `.env`, source code, Git, an MCP configuration, or an agent prompt.** The persistent profile directory is the credential.

> Chromium profile portability can vary across operating systems/browser builds because some browser state may be OS-protected. The importer therefore never assumes that a copied profile is usable: it launches the configured headless browser and verifies the copied profile with the same `loremotion_auth_status` logic used by the MCP server. If the imported profile does not authenticate on the server, the import fails and the previous server profile is restored.

## Requirements

- Node.js 20+
- npm dependencies installed with `npm install`
- Network access to LoreMotion
- A Playwright-compatible Chromium executable
- For the target headless VPS: no X server, Xvfb, Chrome channel, or desktop GUI is required

The server supports either:

1. `LOREMOTION_EXECUTABLE_PATH=/absolute/path/to/headless_shell`, or
2. the existing `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` environment variable.

`LOREMOTION_EXECUTABLE_PATH` takes precedence over `LOREMOTION_BROWSER_CHANNEL`.

## 1. Create an authenticated profile on a desktop

On a desktop machine with a normal GUI browser available:

```bash
npm install
cp .env.example .env
```

For the interactive desktop login, set:

```dotenv
LOREMOTION_SESSION_MODE=persistent
LOREMOTION_PROFILE_DIR=.loremotion-profile
LOREMOTION_HEADLESS=false
LOREMOTION_EXECUTABLE_PATH=
LOREMOTION_BROWSER_CHANNEL=chrome
```

Then run:

```bash
npm run login
```

Complete LoreMotion's normal **Sign in with Google** flow and MFA in the visible browser. The script verifies that LoreMotion is signed in before accepting the profile.

`npm run login` is intentionally interactive. If stdin/stdout is not a TTY, it exits non-zero immediately and points to the profile-import workflow instead of blocking forever.

### Archive the profile for transfer

After the login script closes the browser, copy the entire dedicated profile directory. For example:

```bash
tar -czf loremotion-profile.tgz .loremotion-profile
```

Transfer the profile/archive to the VPS using your normal secure file-transfer mechanism. Do not place it in Git.

## 2. Configure the headless VPS

Create `.env`:

```bash
cp .env.example .env
```

A typical headless configuration is:

```dotenv
LOREMOTION_SESSION_MODE=persistent
LOREMOTION_PROFILE_DIR=/opt/loremotion-mcp/.loremotion-profile
LOREMOTION_DOWNLOAD_DIR=/opt/loremotion-mcp/downloads
LOREMOTION_HEADLESS=true
LOREMOTION_BROWSER_CHANNEL=
LOREMOTION_EXECUTABLE_PATH=/opt/ms-playwright/chromium_headless_shell/chrome-linux/headless_shell
LOREMOTION_LAUNCH_ARGS=--no-sandbox,--disable-dev-shm-usage,--disable-gpu
```

If your VPS already exports Playwright variables, this also works:

```bash
export PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright
export PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/opt/ms-playwright/chromium_headless_shell/chrome-linux/headless_shell
```

When `LOREMOTION_EXECUTABLE_PATH` is blank, the code automatically uses `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` when present.

Install dependencies:

```bash
npm install
```

You do **not** need `npm run install-browser` if the headless-shell binary already exists and `LOREMOTION_EXECUTABLE_PATH` or `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` points to it.

## 3. Import the authenticated profile

### Directory

```bash
npm run import-profile -- /secure/path/.loremotion-profile
```

### Zip archive

```bash
npm run import-profile -- /secure/path/loremotion-profile.zip
```

### Tar archive

```bash
npm run import-profile -- /secure/path/loremotion-profile.tgz
```

Supported archive forms are `.zip`, `.tar`, `.tar.gz`, and `.tgz`.

The importer:

1. locates the Chromium user-data root;
2. checks for `Local State`, a `Default`/`Profile N` directory, `Preferences`, and browser session state;
3. removes stale Chromium lock files during the copy;
4. stages the import beside `LOREMOTION_PROFILE_DIR`;
5. preserves the current server profile as a temporary backup;
6. installs the staged profile;
7. launches the configured headless browser;
8. verifies LoreMotion with the existing auth-status logic;
9. keeps the new profile only when `signedIn:true` is confirmed; otherwise it restores the previous profile.

### Scripted import

Instead of a CLI argument, set:

```dotenv
LOREMOTION_PROFILE_IMPORT_PATH=/secure/path/loremotion-profile.tgz
```

Then either run:

```bash
npm run import-profile
```

or let the Hermes bootstrap import it automatically when no valid session exists.

After a successful one-time import, you may clear `LOREMOTION_PROFILE_IMPORT_PATH` if you do not want Hermes to reuse that source automatically.

## 4. Hermes MCP entrypoint

For Hermes, use this as the MCP command:

```bash
node /opt/loremotion-mcp/scripts/hermes-mcp.js
```

The bootstrap performs this sequence:

```text
check existing persistent profile
        ↓
if signed in → start MCP
        ↓
if signed out and LOREMOTION_PROFILE_IMPORT_PATH exists
        ↓
import profile → verify signedIn:true
        ↓
start MCP
```

If no valid authenticated profile is available, it exits non-zero with an actionable message. It does not attempt Google password entry or MFA automation.

All pre-MCP bootstrap messages are written to **stderr**. Stdout remains clean for MCP stdio framing.

Example configuration is in `examples/mcp-config.json`.

## Headless setup helper

`setup-google-login.sh` now supports both modes.

On the VPS:

```bash
./setup-google-login.sh /secure/path/loremotion-profile.tgz
```

or:

```bash
export LOREMOTION_PROFILE_IMPORT_PATH=/secure/path/loremotion-profile.tgz
./setup-google-login.sh
```

In a non-TTY environment with no profile import path, the script exits immediately instead of invoking interactive login.

On an interactive desktop, with no import path, it retains the existing browser-install + `npm run login` flow.

## Browser launch configuration

### `LOREMOTION_EXECUTABLE_PATH`

Optional absolute path to a Chromium/Chrome executable. When set, it wins over `LOREMOTION_BROWSER_CHANNEL`.

If unset, `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` is used automatically when available.

### `LOREMOTION_BROWSER_CHANNEL`

Desktop fallback such as `chrome`. Leave it empty on a VPS that only has a bare Playwright headless-shell binary.

### `LOREMOTION_LAUNCH_ARGS`

Comma-separated arguments passed to **both** `chromium.launch()` and `chromium.launchPersistentContext()`.

Default:

```text
--no-sandbox,--disable-dev-shm-usage,--disable-gpu
```

These defaults are intended for common headless/container/VPS deployments. Override them only when your environment requires different Chromium flags.

## Duration slider handling

The live LoreMotion generator exposes duration as `input[type=range]` rather than a select.

The server now:

1. finds the most likely duration range input;
2. reads its current `min` and `max`;
3. rejects a requested duration above the live maximum with a clear error;
4. writes the value using `HTMLInputElement.prototype.value`'s native setter;
5. dispatches bubbling `input` and `change` events so React observes the update;
6. re-reads `inputValue()` and verifies the requested value stuck.

Legacy select/text fallbacks remain in place for future UI variations.

Before generating, Hermes can call:

```text
loremotion_probe_ui
```

The response includes `durationSliders` and `durationSliderMax`, allowing the agent to choose a legal duration for the selected model/account tier.

## Prompt field handling

The live prompt textarea has a placeholder but no reliable accessible name. `fillPrompt` therefore prefers placeholder-based textarea matching first and only then uses generic/configured fallbacks.

## Cloudflare Turnstile behavior

The generator includes `cf-turnstile-response`. The automation does not solve or bypass Cloudflare.

If an unsolved visible Turnstile/challenge is detected before generation, after clicking Generate, or while waiting for the result, generation fails quickly with:

```text
Cloudflare challenge present; a signed-in profile or different egress is required
```

This prevents Hermes from wasting the full generation timeout on a blocked datacenter session.

## Verify the imported login

```bash
npm run verify-login
```

Expected shape:

```json
{
  "signedIn": true,
  "sessionMode": "persistent",
  "profileDir": "/opt/loremotion-mcp/.loremotion-profile"
}
```

## Start without Hermes bootstrap

If the profile is already verified, the original server entrypoint remains valid:

```bash
node src/server.js
```

## MCP tool check

After dependencies are installed:

```bash
npm run check-tools
```

This boots the server over stdio, calls `tools/list`, and asserts that exactly these five tools are present:

```text
loremotion_auth_status
loremotion_generate_video
loremotion_list_history
loremotion_download_video
loremotion_probe_ui
```

## Probe the live UI

```bash
npm run probe
```

`probe` now respects the configured headless mode instead of forcing a visible browser. It reports inputs, duration range metadata, Turnstile presence/state, links, buttons, and a screenshot path.

Selector overrides remain available:

```dotenv
LOREMOTION_SELECTORS_JSON={"prompt":["textarea[name=prompt]"],"generate":["button[data-testid=generate]"]}
```

## Soak test

The existing harness is retained:

```bash
npm run soak-test -- --ltx-runs 10 --ltx-duration 5 --h3-runs 10 --h3-duration 5 --aspect 16:9 --timeout-ms 600000 --verify-history true
```

Use `loremotion_probe_ui` first and set durations no higher than the live `durationSliderMax`. The soak harness no longer forces headed mode into its child MCP process, so `.env`/VPS headless settings are respected.

To download successful outputs as part of the test:

```bash
npm run soak-test -- --ltx-runs 10 --h3-runs 10 --download true
```

Reports are written under `reports/soak-<timestamp>/`.

## Environment variables

| Variable | Purpose |
| --- | --- |
| `LOREMOTION_BASE_URL` | LoreMotion base URL. |
| `LOREMOTION_SESSION_MODE` | `persistent` for signed-in operation; `anonymous` remains available for diagnostics. |
| `LOREMOTION_PROFILE_DIR` | Persistent Chromium user-data directory. Treat it as a credential. |
| `LOREMOTION_PROFILE_IMPORT_PATH` | Optional directory/archive used by scripted import and Hermes bootstrap. Never a cookie/password/token. |
| `LOREMOTION_DOWNLOAD_DIR` | Downloads, screenshots, and error artifacts. |
| `LOREMOTION_HEADLESS` | `true` on the VPS; `false` for interactive desktop login. |
| `LOREMOTION_EXECUTABLE_PATH` | Bare browser executable path; takes precedence over channel. Falls back to `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH`. |
| `LOREMOTION_BROWSER_CHANNEL` | Optional named Playwright browser channel such as `chrome`; leave empty for headless shell. |
| `LOREMOTION_LAUNCH_ARGS` | Comma-separated launch args. Defaults to `--no-sandbox,--disable-dev-shm-usage,--disable-gpu`. |
| `LOREMOTION_TIMEOUT_MS` | Normal Playwright action timeout. |
| `LOREMOTION_GENERATION_TIMEOUT_MS` | Video generation wait timeout. |
| `LOREMOTION_SLOW_MO_MS` | Optional Playwright slow motion. |
| `LOREMOTION_LTX_DEFAULT_DURATION` | Default requested LTX duration; live slider max remains authoritative. |
| `LOREMOTION_H3_DEFAULT_DURATION` | Default requested H3 duration; live slider max remains authoritative. |
| `LOREMOTION_SELECTORS_JSON` | Optional selector override JSON. |

`PLAYWRIGHT_BROWSERS_PATH` and `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` may also be provided externally by your VPS deployment.

## Security

Never commit or share:

```text
.env
.loremotion-profile/
```

Do not expose this stdio MCP server directly to the public internet. See `SECURITY.md` for profile-handling guidance.

## License

MIT. Independent integration; not affiliated with LoreMotion.
