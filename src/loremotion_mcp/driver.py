"""LoreMotion driver — Google-authenticated HTTP API.

How the site works (reverse-engineered from the production bundles):

* Anonymous users must solve a Cloudflare Turnstile captcha and watch a Google
  rewarded ad before every job. Both gates are unusable in headless Chrome —
  Turnstile withholds its challenge iframe and Google rejects the OAuth flow.
* **Logged-in users skip both.** The Generator bundle builds the job payload as
  ``captchaToken: isloggedIn ? null : token`` and the ad gate only applies to
  non-premium anonymous sessions.

So the flow is: log in once with Google (through a browser Google trusts — a
real profile that has been used interactively), persist the Supabase session,
then drive everything else over plain HTTP. The access token expires hourly but
the refresh token is long-lived, so a single login lasts indefinitely.

No credentials are read from the environment. The session blob lives in a file
the user controls; the driver only reads it.
"""

from __future__ import annotations

import asyncio
import base64
import json
import os
import time
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

# ---------------------------------------------------------------- defaults

API_BASE = os.environ.get("LOREMOTION_API_BASE", "https://loremotion.com")
VIDEO_HOST = os.environ.get("LOREMOTION_VIDEO_HOST", "https://videos.loremotion.com")
# The Supabase project backing the site. The anon key is public — it is shipped
# in the site's own JS bundle — so keeping it here is not a secret leak.
SUPABASE_URL = os.environ.get(
    "LOREMOTION_SUPABASE_URL", "https://fimkggchtjzudtarfqai.supabase.co"
)
SESSION_FILE = Path(
    os.environ.get(
        "LOREMOTION_SESSION_FILE",
        str(Path.home() / ".loremotion" / "session.json"),
    )
)
DEFAULT_OUTPUT_DIR = Path(
    os.environ.get("LOREMOTION_OUTPUT_DIR", str(Path.cwd() / "loremotion-output"))
)
DEFAULT_TIMEOUT_MS = int(os.environ.get("LOREMOTION_TIMEOUT_MS", "600000"))
DEFAULT_POLL_MS = int(os.environ.get("LOREMOTION_POLL_MS", "4000"))

# Cloudflare returns error code 1010 to anything without a browser User-Agent.
BROWSER_UA = os.environ.get(
    "LOREMOTION_UA",
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/153.0.0.0 Safari/537.36",
)

MODES = ("t2v", "i2v", "t2i", "i2i")
ASPECTS = ("16:9", "9:16", "1:1", "4:3")
RESOLUTIONS = (480, 720, 1024, 1080, 2048, 4096)
# The free, zero-credit models. Premium ones are accepted but need paid credits.
FREE_MODELS = ("ltx-2.3", "ltx-2.3-motion", "ltx-2.3-continue", "minimax-h3")
ALL_MODELS = FREE_MODELS + (
    "veo-3.1-fast", "veo-3.1-lite", "grok-3", "grok-lower", "kling-2.5", "kling-3",
)

ERROR_NO_SESSION = "no_authenticated_session"
ERROR_NO_CREDITS = "insufficient_credits"
ERROR_AUTH_EXPIRED = "auth_expired"


# ---------------------------------------------------------------- helpers


class LoreMotionError(RuntimeError):
    """Surface error with a machine-readable code."""

    def __init__(self, message: str, code: str | None = None):
        super().__init__(message)
        self.code = code


@dataclass
class Job:
    id: str
    status: str
    prompt: str
    mode: str
    model: str | None = None
    resolution: int | None = None
    aspect_ratio: str | None = None
    duration: int | None = None
    video_url: str | None = None
    image_url: str | None = None
    created_at: str | None = None
    error: str | None = None
    local_path: str | None = None
    raw: dict = field(default_factory=dict)

    @property
    def done(self) -> bool:
        return self.status in ("done", "failed", "error", "cancelled")

    @classmethod
    def from_api(cls, data: dict) -> "Job":
        # the discover feed omits status — a published video is done
        status = str(data.get("status") or ("done" if data.get("video_url") else "unknown"))
        return cls(
            id=str(data.get("id", "")),
            status=status,
            prompt=str(data.get("prompt", "")),
            mode=str(data.get("mode", "")),
            model=data.get("model"),
            resolution=data.get("resolution"),
            aspect_ratio=data.get("aspect_ratio") or data.get("aspect"),
            duration=data.get("duration"),
            video_url=data.get("video_url"),
            image_url=data.get("image_url"),
            created_at=data.get("created_at"),
            error=data.get("error") or data.get("error_message"),
            raw=data,
        )


def _headers(token: str | None = None, extra: dict | None = None) -> dict:
    """Every request needs a browser UA or Cloudflare answers 1010."""
    h = {
        "User-Agent": BROWSER_UA,
        "Accept": "application/json",
        "Content-Type": "application/json",
        "Referer": f"{API_BASE}/generate",
        "Origin": API_BASE,
    }
    if token:
        h["Authorization"] = f"Bearer {token}"
    if extra:
        h.update(extra)
    return h


def _request(
    url: str,
    token: str | None = None,
    method: str = "GET",
    body: Any = None,
    timeout: float = 30.0,
) -> tuple[int, Any]:
    data = None
    if body is not None:
        data = json.dumps(body).encode()
    req = urllib.request.Request(
        url, data=data, headers=_headers(token), method=method
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            raw = r.read()
            try:
                return r.status, json.loads(raw)
            except json.JSONDecodeError:
                return r.status, raw.decode(errors="replace")[:500]
    except urllib.error.HTTPError as e:
        raw = e.read()
        try:
            return e.code, json.loads(raw)
        except json.JSONDecodeError:
            return e.code, raw.decode(errors="replace")[:500]


async def _async(fn, *a, **kw):
    loop = asyncio.get_event_loop()
    return await loop.run_in_executor(None, lambda: fn(*a, **kw))


async def _download(url: str, dest: Path, timeout: float = 300.0) -> Path:
    dest.parent.mkdir(parents=True, exist_ok=True)

    def _get() -> Path:
        req = urllib.request.Request(url, headers={"User-Agent": BROWSER_UA})
        with urllib.request.urlopen(req, timeout=timeout) as r, open(dest, "wb") as f:
            while chunk := r.read(1 << 20):
                f.write(chunk)
        return dest

    return await _async(_get)


def _guess_mime(path: Path) -> str:
    suf = path.suffix.lower()
    return {
        ".png": "image/png",
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".webp": "image/webp",
    }.get(suf, "application/octet-stream")


# ---------------------------------------------------------------- driver


class LoreMotionDriver:
    """Talks to the LoreMotion API as a logged-in Google user.

    Requires a one-time Google login performed in a real browser (see
    ``login_instructions`` / the README). After that the refresh token keeps
    the session alive indefinitely and no browser is needed.
    """

    def __init__(
        self,
        session_file: str | Path = SESSION_FILE,
        output_dir: str | Path = DEFAULT_OUTPUT_DIR,
        timeout_ms: int = DEFAULT_TIMEOUT_MS,
        poll_ms: int = DEFAULT_POLL_MS,
    ):
        self.session_file = Path(session_file)
        self.output_dir = Path(output_dir)
        self.timeout_ms = timeout_ms
        self.poll_ms = poll_ms
        self._session: dict | None = None

    # -- session ----------------------------------------------------------

    def _load_session(self) -> dict:
        if self._session:
            return self._session
        if not self.session_file.is_file():
            raise LoreMotionError(
                "No LoreMotion session found. Log in once with Google — see the "
                "README's Authentication section. Expected a session file at "
                f"{self.session_file} with the Supabase auth token.",
                ERROR_NO_SESSION,
            )
        try:
            data = json.loads(self.session_file.read_text())
        except json.JSONDecodeError as ex:
            raise LoreMotionError(
                f"session file {self.session_file} is not valid JSON: {ex}",
                ERROR_NO_SESSION,
            ) from ex
        if not data.get("access_token") or not data.get("refresh_token"):
            raise LoreMotionError(
                "session file is missing access_token / refresh_token. "
                "Re-run the Google login.",
                ERROR_NO_SESSION,
            )
        self._session = data
        return data

    def _save_session(self, data: dict) -> None:
        self._session = data
        self.session_file.parent.mkdir(parents=True, exist_ok=True)
        self.session_file.write_text(json.dumps(data, indent=2))

    def _refresh(self) -> str:
        """Exchange the refresh token for a fresh access token (1h lifetime).

        Returns a valid access token, refreshing first when needed.
        """
        s = self._load_session()
        now = int(time.time())
        # 5 minute safety margin
        if s.get("expires_at") and now < int(s["expires_at"]) - 300:
            return s["access_token"]

        anon_key = s.get("supabase_anon_key") or _ANON_KEY
        status, body = _refresh_request(s["refresh_token"], anon_key)
        if status != 200 or not isinstance(body, dict):
            raise LoreMotionError(
                f"could not refresh the LoreMotion session ({status}): "
                f"{str(body)[:200]}. Log in with Google again.",
                ERROR_AUTH_EXPIRED,
            )
        merged = dict(s)
        merged.update(
            {
                "access_token": body["access_token"],
                "refresh_token": body["refresh_token"],
                "expires_at": now + int(body.get("expires_in", 3600)),
            }
        )
        self._save_session(merged)
        return merged["access_token"]

    async def token(self) -> str:
        return await _async(self._refresh)

    # -- account ----------------------------------------------------------

    async def whoami(self) -> dict:
        tok = await self.token()
        status, me = await _async(_request, f"{API_BASE}/api/me", tok)
        if status != 200:
            raise LoreMotionError(
                f"/api/me failed ({status}): {str(me)[:200]}", "api_error"
            )
        return {
            "user_id": me.get("user_id"),
            "email": me.get("email"),
            "plan": me.get("plan"),
            "credits_balance": me.get("credits_balance"),
            "pack_credits_balance": me.get("pack_credits_balance"),
            "authenticated": bool(me.get("user_id")),
            "note": (
                "logged in via Google — unlimited generations, no captcha"
                if me.get("user_id")
                else "anonymous — captcha + ads required, not supported"
            ),
        }

    # -- generation -------------------------------------------------------

    async def create_job(
        self,
        prompt: str,
        mode: str = "t2v",
        model: str | None = None,
        resolution: int = 720,
        aspect_ratio: str = "16:9",
        duration: int = 5,
        reference_image: str | None = None,
        negative_prompt: str | None = None,
    ) -> Job:
        """Submit a generation job. Logged-in users bypass captcha and ads."""
        if mode not in MODES:
            raise LoreMotionError(f"mode must be one of {MODES}", "bad_args")
        if aspect_ratio not in ASPECTS:
            raise LoreMotionError(f"aspect_ratio must be one of {ASPECTS}", "bad_args")
        if resolution not in RESOLUTIONS:
            raise LoreMotionError(
                f"resolution must be one of {RESOLUTIONS}", "bad_args"
            )
        if mode in ("i2v", "i2i") and not reference_image:
            raise LoreMotionError(f"mode {mode} requires reference_image", "bad_args")

        model = model or "ltx-2.3"
        tok = await self.token()

        body: dict[str, Any] = {
            "mode": mode,
            "prompt": prompt,
            "resolution": resolution,
            "aspect_ratio": aspect_ratio,
            "duration": duration,
            "model": model,
        }
        if negative_prompt:
            body["negative_prompt"] = negative_prompt
        if reference_image:
            p = Path(reference_image)
            if p.is_file():
                body["image"] = "data:" + _guess_mime(p) + ";base64," + base64.b64encode(
                    p.read_bytes()
                ).decode()
            elif reference_image.startswith(("http://", "https://")):
                body["ref_image_url"] = reference_image
            else:
                raise LoreMotionError(
                    f"reference_image must be a local file or URL, got {reference_image!r}",
                    "bad_args",
                )

        status, resp = await _async(_request, f"{API_BASE}/api/jobs", tok, "POST", body, 60.0)
        if status not in (200, 201):
            err = (resp or {}).get("error") if isinstance(resp, dict) else str(resp)
            code = (resp or {}).get("code") if isinstance(resp, dict) else ""
            if code == "captcha_failed" or "captcha" in str(err).lower():
                raise LoreMotionError(
                    "LoreMotion asked for a captcha, which means the session is "
                    "no longer recognised as logged in. Re-run the Google login.",
                    "captcha_failed",
                )
            if "credit" in str(err).lower():
                raise LoreMotionError(
                    f"not enough credits for model {model}: {err}", ERROR_NO_CREDITS
                )
            raise LoreMotionError(f"job submit failed ({status}): {err}", "submit_failed")

        data = resp if isinstance(resp, dict) else {"id": resp}
        return Job.from_api(data)

    async def get_job(self, job_id: str) -> Job:
        tok = await self.token()
        status, data = await _async(_request, f"{API_BASE}/api/jobs/{job_id}", tok)
        if status == 200 and isinstance(data, dict):
            return Job.from_api(data)
        # public fallback: finished jobs are listed on the discover feed
        status, data = await _async(
            _request, f"{API_BASE}/api/discover?limit=50", tok
        )
        items = (data or {}).get("items", []) if isinstance(data, dict) else []
        for it in items:
            if it.get("id") == job_id:
                return Job.from_api(it)
        raise LoreMotionError(f"job {job_id} not found", "not_found")

    async def list_jobs(self, limit: int = 20) -> dict:
        """List jobs.

        The app has no "list my jobs" endpoint — the dashboard tracks a single
        active job in localStorage (`novaframe_active_job`) and fetches it
        directly, and the public feed omits ownership. So we return the
        discover feed as-is (recent videos across the site), which is what the
        dashboard's history view actually shows.
        """
        tok = await self.token()
        status, data = await _async(
            _request, f"{API_BASE}/api/discover?limit={max(limit, 50)}", tok
        )
        if status != 200 or not isinstance(data, dict):
            raise LoreMotionError(
                f"could not list jobs ({status}): {str(data)[:200]}", "list_failed"
            )
        jobs = [Job.from_api(j) for j in data.get("items", [])]
        return {
            "count": len(jobs),
            "jobs": [_job_summary(j) for j in jobs[:limit]],
        }

    async def discover(self, limit: int = 10) -> dict:
        tok = await self.token()
        status, data = await _async(
            _request, f"{API_BASE}/api/discover?limit={limit}", tok
        )
        items = (data or {}).get("items", []) if isinstance(data, dict) else []
        return {
            "count": len(items),
            "items": [
                {
                    "id": i.get("id"),
                    "prompt": (i.get("prompt") or "")[:200],
                    "video_url": i.get("video_url"),
                    "resolution": i.get("resolution"),
                    "duration": i.get("duration"),
                }
                for i in items
            ],
        }

    # -- polling ----------------------------------------------------------

    async def wait_for_job(self, job_id: str, timeout_ms: int | None = None) -> Job:
        timeout_ms = timeout_ms or self.timeout_ms
        deadline = time.monotonic() + timeout_ms / 1000
        last: Job | None = None
        while time.monotonic() < deadline:
            try:
                job = await self.get_job(job_id)
            except LoreMotionError as ex:
                if ex.code == "not_found" and last is None:
                    await asyncio.sleep(self.poll_ms / 1000)
                    continue
                raise
            last = job
            if job.done:
                return job
            await asyncio.sleep(self.poll_ms / 1000)
        if last:
            return last
        raise LoreMotionError(f"timed out waiting for job {job_id}", "timeout")

    async def download(self, job: Job, filename: str | None = None) -> Path:
        url = job.video_url or job.image_url
        if not url:
            raise LoreMotionError("job has no output URL yet", "not_ready")
        if not url.lower().endswith((".mp4", ".webm", ".jpg", ".png", ".webp")):
            url = url + ".mp4"
        if not url.startswith("http"):
            url = f"{VIDEO_HOST}/videos/{url}.mp4"
        name = filename or (f"{job.id}.mp4" if job.video_url else f"{job.id}.png")
        return await _download(url, self.output_dir / name)

    # -- convenience ------------------------------------------------------

    async def generate(
        self,
        prompt: str,
        mode: str = "t2v",
        model: str | None = None,
        resolution: int = 720,
        aspect_ratio: str = "16:9",
        duration: int = 5,
        reference_image: str | None = None,
        negative_prompt: str | None = None,
        download: bool = True,
        timeout_ms: int | None = None,
    ) -> dict:
        """Submit a job, wait for it, and (optionally) download the result."""
        job = await self.create_job(
            prompt=prompt,
            mode=mode,
            model=model,
            resolution=resolution,
            aspect_ratio=aspect_ratio,
            duration=duration,
            reference_image=reference_image,
            negative_prompt=negative_prompt,
        )
        job = await self.wait_for_job(job.id, timeout_ms=timeout_ms)
        out: dict[str, Any] = {
            "id": job.id,
            "status": job.status,
            "model": job.model,
            "resolution": job.resolution,
            "aspect_ratio": job.aspect_ratio,
            "duration": job.duration,
            "prompt": job.prompt,
            "video_url": job.video_url,
            "image_url": job.image_url,
            "error": job.error,
        }
        if download and job.status == "done":
            path = await self.download(job)
            out["local_path"] = str(path)
        return out


# The Supabase anon key is published in LoreMotion's own JS bundle; it only
# identifies the frontend app, it grants no user data by itself.
_ANON_KEY = os.environ.get(
    "LOREMOTION_SUPABASE_ANON_KEY",
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZpbWtnZ2NodGp6dWR0YXJmcWFpIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzcyMjMwNjMsImV4cCI6MjA5Mjc5OTA2M30.3ixvgKDf85HVSBYA-53iqoFibihV6F-QlYcNeIG3APM",
)


def _refresh_request(refresh_token: str, anon_key: str) -> tuple[int, Any]:
    """The GoTrue refresh endpoint wants an apikey header, not a Bearer."""
    payload = json.dumps({"refresh_token": refresh_token}).encode()
    req = urllib.request.Request(
        f"{SUPABASE_URL}/auth/v1/token?grant_type=refresh_token",
        data=payload,
        headers={
            "apikey": anon_key,
            "Content-Type": "application/json",
            "User-Agent": BROWSER_UA,
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=25) as r:
            return r.status, json.loads(r.read())
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read())
        except json.JSONDecodeError:
            return e.code, e.read().decode(errors="replace")[:300]


def _job_summary(job: Job) -> dict:
    return {
        "id": job.id,
        "status": job.status,
        "model": job.model,
        "resolution": job.resolution,
        "aspect_ratio": job.aspect_ratio,
        "duration": job.duration,
        "prompt": (job.prompt or "")[:120],
        "video_url": job.video_url,
        "error": job.error,
    }


# ---------------------------------------------------------------- login


def login_instructions() -> dict:
    """Step-by-step Google login. Only needed once per account."""
    return {
        "why": (
            "LoreMotion requires a Cloudflare Turnstile captcha and a Google "
            "rewarded ad for anonymous users. Both are unusable for automated "
            "clients. Logged-in users send no captcha token at all, so a single "
            "Google login unlocks unlimited free generations."
        ),
        "steps": [
            "Launch a real Chrome with a profile you have used interactively so "
            "Google trusts the session: "
            "chrome --remote-debugging-port=9222 "
            "--user-data-dir=<your-profile> about:blank",
            "In that Chrome open https://loremotion.com/auth and click "
            "'Continue with Google', then complete the sign-in.",
            "After the redirect back to loremotion.com, copy the Supabase "
            "session out of the profile's localStorage. The key is "
            "'sb-fimkggchtjzudtarfqai-auth-token' under "
            "<profile>/Default/Local Storage/leveldb/.",
            "Save it as JSON to the session file "
            f"({SESSION_FILE}) with the fields: access_token, refresh_token, "
            "expires_at. The driver refreshes the access token automatically "
            "and never needs the browser again.",
        ],
        "note": (
            "Google rejects OAuth flows started from a pristine headless profile "
            "('This browser or app may not be secure'), so the login has to "
            "happen in a profile with an established Google session."
        ),
    }
