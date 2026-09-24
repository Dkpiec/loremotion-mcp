# LoreMotion MCP — Google Logged-In Setup

A GitHub-ready local MCP server that drives **LoreMotion.com** with Playwright while reusing a dedicated browser profile that you authenticate once through LoreMotion's normal **Sign in with Google** flow.

The intended workflow is:

```text
one-time visible Google login
        ↓
.loremotion-profile/ saved locally
        ↓
MCP server reuses that profile
        ↓
agent generates LTX 2.5 / MiniMax H3 videos
        ↓
LoreMotion signed-in history remains available
```

The browser profile is the session credential. **Google passwords, cookies, and OAuth tokens are not stored in source code or `.env`.**

## MCP tools

- `loremotion_auth_status` — confirms whether the persistent LoreMotion session appears signed in.
- `loremotion_generate_video` — text-to-video or image-to-video with `ltx-2.5` or `minimax-h3`.
- `loremotion_list_history` — reads recent signed-in dashboard/history items.
- `loremotion_download_video` — downloads a generated MP4.
- `loremotion_probe_ui` — captures the current UI structure and a screenshot for selector maintenance.

The automation uses the public website UI. It does not attempt to bypass ads, queues, CAPTCHAs, account limits, or other site controls.

## Requirements

- Node.js 20+
- Chrome recommended
- A Google account that can sign in to LoreMotion
- An interactive desktop for the one-time login

## Fast setup — Windows

Open PowerShell in the repository folder:

```powershell
Set-ExecutionPolicy -Scope Process Bypass
.\setup-google-login.ps1
```

The script will:

1. create `.env` from `.env.example` if needed;
2. run `npm install`;
3. install Playwright Chromium as a fallback browser;
4. open a visible browser for LoreMotion Google sign-in;
5. verify that LoreMotion appears signed in;
6. close the browser while retaining `.loremotion-profile/`;
7. reopen the saved profile and verify it again.

## Fast setup — macOS/Linux

```bash
chmod +x setup-google-login.sh
./setup-google-login.sh
```

## Manual setup

```bash
npm install
cp .env.example .env
npm run install-browser
npm run login
npm run verify-login
```

During `npm run login`, a visible browser opens. Use LoreMotion's ordinary **Sign in with Google** button and complete Google's normal authentication/MFA flow yourself. Return to the terminal and press Enter; the script verifies that the LoreMotion session is authenticated before accepting the setup.

The saved profile defaults to:

```text
.loremotion-profile/
```

That directory is deliberately ignored by Git.

## Start the MCP server

```bash
npm start
```

The server communicates over MCP stdio.

## MCP host configuration

Copy `examples/mcp-config.json` and replace `/ABSOLUTE/PATH/TO/loremotion-mcp` with the real path on the machine that owns the Google-authenticated profile.

Example:

```json
{
  "mcpServers": {
    "loremotion": {
      "command": "node",
      "args": ["C:/agents/loremotion-mcp/src/server.js"],
      "env": {
        "LOREMOTION_SESSION_MODE": "persistent",
        "LOREMOTION_PROFILE_DIR": "C:/agents/loremotion-mcp/.loremotion-profile",
        "LOREMOTION_DOWNLOAD_DIR": "C:/agents/loremotion-mcp/downloads",
        "LOREMOTION_HEADLESS": "false",
        "LOREMOTION_BROWSER_CHANNEL": "chrome"
      }
    }
  }
}
```

Use forward slashes in JSON paths on Windows, or escape backslashes.

## Verify login at any time

```bash
npm run verify-login
```

A successful result looks conceptually like:

```json
{
  "signedIn": true,
  "sessionMode": "persistent",
  "profileDir": ".../.loremotion-profile"
}
```

If the Google/LoreMotion session expires:

```bash
npm run login
```

This refreshes the same dedicated profile.

## Agent call examples

### LTX 2.5

```json
{
  "prompt": "Cinematic drone fly-through of a modern residential tower at sunrise, realistic architectural materials, smooth forward camera movement, natural ambient city sound",
  "model": "ltx-2.5",
  "aspectRatio": "16:9",
  "durationSeconds": 10,
  "wait": true
}
```

### MiniMax H3

```json
{
  "prompt": "Slow cinematic camera movement through a luxury apartment lobby, realistic reflections, people walking naturally, soft ambient lighting",
  "model": "minimax-h3",
  "aspectRatio": "9:16",
  "durationSeconds": 5,
  "wait": true
}
```

### Image-to-video

```json
{
  "prompt": "Slow dolly forward, subtle tree movement, realistic reflections, preserve the building architecture exactly",
  "model": "ltx-2.5",
  "aspectRatio": "16:9",
  "durationSeconds": 10,
  "imagePath": "C:/assets/building-render.jpg",
  "wait": true
}
```

## 20-run signed-in consistency test

After Google login is verified:

```bash
npm run soak-test -- --ltx-runs 10 --ltx-duration 10 --h3-runs 10 --h3-duration 5 --aspect 16:9 --timeout-ms 600000 --verify-history true
```

To also download every successful MP4:

```bash
npm run soak-test -- --ltx-runs 10 --ltx-duration 10 --h3-runs 10 --h3-duration 5 --download true
```

Reports are written under `reports/soak-<timestamp>/` as CSV, JSONL, and JSON summary files.

The soak test checks the saved login before generating anything. It does not automatically retry failed generations, so failures remain visible in the reliability result.

## Configuration

The important defaults in `.env` are:

```dotenv
LOREMOTION_SESSION_MODE=persistent
LOREMOTION_PROFILE_DIR=.loremotion-profile
LOREMOTION_HEADLESS=false
LOREMOTION_BROWSER_CHANNEL=chrome
LOREMOTION_GENERATION_TIMEOUT_MS=600000
LOREMOTION_LTX_DEFAULT_DURATION=10
LOREMOTION_H3_DEFAULT_DURATION=5
```

Keep `LOREMOTION_HEADLESS=false` initially. A visible browser is the safer default for interactive Google sign-in and the site's normal ad-supported generation path.

## If LoreMotion changes its UI

Run:

```bash
npm run probe
```

It saves a screenshot to `downloads/` and reports current buttons, inputs, and links. You can override selectors in `.env` without changing source code:

```dotenv
LOREMOTION_SELECTORS_JSON={"prompt":["textarea[name=prompt]"],"generate":["button[data-testid=generate]"]}
```

## Security

Never commit or share:

```text
.env
.loremotion-profile/
```

Possession of the persistent browser profile can provide access to the signed-in LoreMotion session. If the profile is exposed, sign out/revoke the session and create a new profile.

For stronger isolation, use a dedicated Google/LoreMotion account rather than your primary personal Google account.

## Optional anonymous mode

The code still supports `LOREMOTION_SESSION_MODE=anonymous` for diagnostics, but **persistent Google-authenticated mode is the primary setup in this repository**. Anonymous mode has no account history and is not used by the signed-in soak test.

## License

MIT. Independent integration; not affiliated with LoreMotion.
