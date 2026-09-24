# LoreMotion MCP

An [MCP](https://modelcontextprotocol.io) server that drives
[loremotion.com](https://loremotion.com) for **free, watermark-free video
generation** — text-to-video and image-to-video — from any MCP client.

No API key from LoreMotion is needed. The only setup is a **one-time Google
login**; after that the server refreshes its own session and never touches a
browser again.

## Why the Google login

LoreMotion's free tier is gated for anonymous users:

| | Anonymous | Logged in (Google) |
|---|---|---|
| Captcha | Cloudflare Turnstile on every job | **none** |
| Ads | Google rewarded ad before every job | **none** |
| Generations | 1 per profile | unlimited (free credits refill) |

The site's own bundle makes this explicit — the job payload is built as
`captchaToken: isloggedIn ? null : turnstileToken`. Turnstile deliberately
withholds its challenge iframe from headless browsers, so an automated client
cannot pass it. A single Google login removes the captcha *and* the ads
entirely, which is why this server is auth-first.

## Setup

### 1. One-time Google login (5 minutes, done once)

The login must happen in a browser profile that Google already trusts — a
pristine headless profile gets rejected with *"This browser or app may not be
secure."* Any Chrome you use day-to-day works.

```bash
# Launch Chrome with remote debugging, using your everyday profile
chrome --remote-debugging-port=9222 \
       --user-data-dir=~/.config/google-chrome/Default \
       about:blank
```

Then either:

**Option A — let the server guide you.** From an MCP client, call the
`login_help` tool and follow the steps.

**Option B — manually.** In that Chrome, open `https://loremotion.com/auth`,
click **Continue with Google**, and finish the sign-in. Then save the session:

```bash
mkdir -p ~/.loremotion
python - <<'PY'
import glob, json, os, re

# Path to the profile you just logged in with
profile = os.path.expanduser("~/.config/google-chrome/Default")
log = sorted(
    glob.glob(profile + "/Local Storage/leveldb/*.log"),
    key=os.path.getmtime, reverse=True,
)[0]
data = open(log, "rb").read()

i = data.find(b'sb-fimkggchtjzudtarfqai-auth-token')
tok = json.loads(
    re.search(rb'\{.*\}', data[data.find(b'{"provider_token"', i) : i + 20000]).group(0)
)

out = {
    "access_token": tok["access_token"],
    "refresh_token": tok["refresh_token"],
    "expires_at": tok.get("expires_at"),
    "email": tok["user"]["email"],
    "user_id": tok["user"]["id"],
}
dest = os.path.expanduser("~/.loremotion/session.json")
os.makedirs(os.path.dirname(dest), exist_ok=True)
open(dest, "w").write(json.dumps(out, indent=2))
os.chmod(dest, 0o600)
print("saved", dest, "for", out["email"])
PY
```

The access token expires after an hour, but the **refresh token is
long-lived** — the server renews it automatically and the login lasts
indefinitely. Nothing but the session file is written to disk.

### 2. Run the server

```bash
pip install -e .
loremotion-mcp                                # stdio transport (default)
loremotion-mcp --transport http --port 8080   # HTTP transport
```

### 3. Point your MCP client at it

```json
{
  "mcpServers": {
    "loremotion": {
      "command": "loremotion-mcp"
    }
  }
}
```

Or over HTTP:

```json
{
  "mcpServers": {
    "loremotion": {
      "url": "http://localhost:8080/mcp"
    }
  }
}
```

## Tools

| Tool | What it does |
|---|---|
| `generate_video` | Generate from a prompt, wait for the render, download the MP4. The main tool. |
| `wait_for_job` | Block until a submitted job finishes. |
| `get_job` | Poll one job's status. |
| `list_jobs` | List your recent jobs. |
| `whoami` | Show email, plan and remaining credits. |
| `discover` | Browse the public feed of generated videos. |
| `download_job` | Download a finished job's video. |
| `login_help` | Step-by-step login instructions. |

### `generate_video` parameters

| Param | Type | Default | Notes |
|---|---|---|---|
| `prompt` | string | *(required)* | Scene description |
| `mode` | `t2v` \| `i2v` \| `t2i` \| `i2i` | `t2v` | `i2v`/`i2i` require `reference_image` |
| `model` | string | `ltx-2.3` | See list below |
| `resolution` | int | `720` | 480/720/1024/1080/2048/4096 |
| `aspect_ratio` | string | `16:9` | `16:9`,`9:16`,`1:1`,`4:3` |
| `duration` | int | `5` | seconds |
| `reference_image` | string | — | local path or public URL |
| `negative_prompt` | string | — | what to avoid |
| `download` | bool | `true` | save the MP4 to `output_dir` |
| `wait` | bool | `true` | `false` = return the job id immediately |
| `timeout_ms` | int | `600000` | per-call render cap |

### Example

```
generate_video(
  prompt="A drone shot over a misty pine forest at dawn, sunlight breaking
         through the trees, cinematic",
  mode="t2v",
  model="ltx-2.3",
  resolution=720,
  aspect_ratio="16:9",
  duration=5,
)
```

Returns a job id, the CDN URL, and the local path of the downloaded MP4.

**Free models:** `ltx-2.3`, `ltx-2.3-motion`, `ltx-2.3-continue`,
`minimax-h3`. Premium models (`veo-3.1-fast`, `kling-3`, …) are accepted but
need paid credits.

Set `wait=false` on `generate_video` to submit a batch of prompts and collect
them later with `wait_for_job`.

## Configuration (all optional)

| Env var | Default | Meaning |
|---|---|---|
| `LOREMOTION_SESSION_FILE` | `~/.loremotion/session.json` | Where the Google session lives |
| `LOREMOTION_OUTPUT_DIR` | `./loremotion-output` | Where MP4s are downloaded |
| `LOREMOTION_API_BASE` | `https://loremotion.com` | API base |
| `LOREMOTION_TIMEOUT_MS` | `600000` | Render wait cap |

## Security notes

- **No secrets are committed.** The only credential is your own session file,
  which you create during login. The repo contains none.
- The Supabase *anon key* embedded in `driver.py` is published in LoreMotion's
  own JavaScript bundle; it identifies the frontend app and grants no user data
  on its own. Your `access_token` / `refresh_token` never enter the repo.
- The session file is written `chmod 600`. Keep it out of version control.

## How it works

1. Reads the Supabase session (access + refresh token) from the session file.
2. Refreshes the access token via GoTrue when it is within 5 minutes of
   expiring — no browser involved.
3. `POST /api/jobs` with `Authorization: Bearer <access_token>` and a browser
   User-Agent (Cloudflare answers `1010` to anything else).
4. Polls `/api/jobs/:id` until the render finishes, then downloads the MP4
   from the CDN.

The captcha bypass is not a hack — the site simply does not require logged-in
users to solve it.

## License

MIT
