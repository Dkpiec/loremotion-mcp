"""LoreMotion MCP server.

Exposes loremotion.com's free video generation as MCP tools. Two transports:
stdio (default, for local MCP clients) and HTTP (for remote ones).

No secrets are baked in — the Google session lives in a file the user owns
(~/.loremotion/session.json). The browser-based Google login only has to happen
once; after that the driver refreshes its access token over HTTP and never
touches a browser again.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
from typing import Any

from .driver import (
    ASPECTS,
    FREE_MODELS,
    MODES,
    RESOLUTIONS,
    Job,
    LoreMotionDriver,
    LoreMotionError,
    login_instructions,
)

PROTOCOL_VERSION = "2024-11-05"
SERVER_INFO = {"name": "loremotion-mcp", "version": "1.0.0"}

TOOLS = [
    {
        "name": "generate_video",
        "description": (
            "Generate a free MP4 video on LoreMotion from a text prompt "
            "(text-to-video) or a reference image (image-to-video). Submits the "
            "job, waits for the render, and downloads the MP4. Logged-in users "
            "bypass the captcha and the ads entirely. Free models: "
            + ", ".join(FREE_MODELS)
            + ". Set wait=false to submit and return the job id immediately."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "prompt": {
                    "type": "string",
                    "description": "Scene description / video prompt.",
                },
                "mode": {
                    "type": "string",
                    "enum": list(MODES),
                    "default": "t2v",
                    "description": "t2v = text to video, i2v = image to video, "
                    "t2i = text to image, i2i = image to image.",
                },
                "model": {
                    "type": "string",
                    "default": "ltx-2.3",
                    "description": "Model id. Free: " + ", ".join(FREE_MODELS),
                },
                "resolution": {
                    "type": "integer",
                    "enum": list(RESOLUTIONS),
                    "default": 720,
                },
                "aspect_ratio": {
                    "type": "string",
                    "enum": list(ASPECTS),
                    "default": "16:9",
                },
                "duration": {"type": "integer", "default": 5, "description": "seconds"},
                "reference_image": {
                    "type": "string",
                    "description": "Local path or URL; required for i2v/i2i.",
                },
                "negative_prompt": {"type": "string"},
                "download": {
                    "type": "boolean",
                    "default": True,
                    "description": "Save the MP4 to the output directory.",
                },
                "wait": {
                    "type": "boolean",
                    "default": True,
                    "description": "Wait for the render. false = return job id immediately.",
                },
                "timeout_ms": {
                    "type": "integer",
                    "description": "Per-call render cap in milliseconds.",
                },
            },
            "required": ["prompt"],
        },
    },
    {
        "name": "wait_for_job",
        "description": "Block until a submitted job finishes and report its status/URL.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "job_id": {"type": "string"},
                "timeout_ms": {"type": "integer", "default": 600000},
            },
            "required": ["job_id"],
        },
    },
    {
        "name": "get_job",
        "description": "Poll the status of one LoreMotion video job by id.",
        "inputSchema": {
            "type": "object",
            "properties": {"job_id": {"type": "string"}},
            "required": ["job_id"],
        },
    },
    {
        "name": "list_jobs",
        "description": "List recent video jobs for the logged-in LoreMotion account.",
        "inputSchema": {
            "type": "object",
            "properties": {"limit": {"type": "integer", "default": 20}},
        },
    },
    {
        "name": "whoami",
        "description": "Show the current LoreMotion session: email, plan, credit "
        "balance, and whether the Google login is still valid. Call this first.",
        "inputSchema": {"type": "object", "properties": {}},
    },
    {
        "name": "discover",
        "description": "Browse LoreMotion's public community feed: prompts and "
        "video URLs for reference and inspiration.",
        "inputSchema": {
            "type": "object",
            "properties": {"limit": {"type": "integer", "default": 10}},
        },
    },
    {
        "name": "download_job",
        "description": "Download a finished job's video to the output directory.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "job_id": {"type": "string"},
                "filename": {"type": "string"},
            },
            "required": ["job_id"],
        },
    },
    {
        "name": "login_help",
        "description": "Explain how to do the one-time Google login when the "
        "session is missing or expired.",
        "inputSchema": {"type": "object", "properties": {}},
    },
]


class McpServer:
    def __init__(self, driver: LoreMotionDriver):
        self.d = driver

    # -- dispatch ---------------------------------------------------------

    async def handle(self, request: dict) -> dict | None:
        method = request.get("method")
        rid = request.get("id")
        params = request.get("params") or {}

        def ok(result: Any) -> dict:
            return {"jsonrpc": "2.0", "id": rid, "result": result}

        def err(code: int, message: str) -> dict:
            return {"jsonrpc": "2.0", "id": rid, "error": {"code": code, "message": message}}

        if method == "initialize":
            return ok(
                {
                    "protocolVersion": PROTOCOL_VERSION,
                    "serverInfo": SERVER_INFO,
                    "capabilities": {"tools": {}},
                }
            )
        if method == "notifications/initialized":
            return None
        if method == "ping":
            return ok({})
        if method == "tools/list":
            return ok({"tools": TOOLS})

        if method == "tools/call":
            name = params.get("name")
            args = params.get("arguments") or {}
            try:
                return ok(await self._call_tool(name, args))
            except LoreMotionError as ex:
                return err(-32001, f"[{ex.code}] {ex}")
            except Exception as ex:  # surface unexpected detail for debugging
                return err(-32603, f"{type(ex).__name__}: {ex}")

        if rid is not None:
            return err(-32601, f"method not found: {method}")
        return None

    async def _call_tool(self, name: str, args: dict) -> dict:
        d = self.d

        if name == "generate_video":
            job = await d.create_job(
                prompt=args["prompt"],
                mode=args.get("mode", "t2v"),
                model=args.get("model"),
                resolution=args.get("resolution", 720),
                aspect_ratio=args.get("aspect_ratio", "16:9"),
                duration=args.get("duration", 5),
                reference_image=args.get("reference_image"),
                negative_prompt=args.get("negative_prompt"),
            )
            if args.get("wait", True):
                job = await d.wait_for_job(job.id, args.get("timeout_ms"))
            result = _job_dict(job)
            if args.get("download", True) and (job.video_url or job.image_url):
                try:
                    path = await d.download(job)
                    result["local_path"] = str(path)
                    result["local_size_mb"] = round(path.stat().st_size / 1e6, 2)
                except LoreMotionError as ex:
                    result["download_error"] = str(ex)
            return _as_content(result)

        if name == "wait_for_job":
            job = await d.wait_for_job(args["job_id"], args.get("timeout_ms"))
            return _as_content(_job_dict(job))

        if name == "get_job":
            return _as_content(_job_dict(await d.get_job(args["job_id"])))

        if name == "list_jobs":
            return _as_content(await d.list_jobs(args.get("limit", 20)))

        if name == "whoami":
            return _as_content(await d.whoami())

        if name == "discover":
            return _as_content(await d.discover(args.get("limit", 10)))

        if name == "download_job":
            job = await d.get_job(args["job_id"])
            path = await d.download(job, args.get("filename"))
            return _as_content(
                {"local_path": str(path), "local_size_mb": round(path.stat().st_size / 1e6, 2)}
            )

        if name == "login_help":
            return _as_content(login_instructions())

        raise LoreMotionError(f"unknown tool: {name}", "unknown_tool")


def _job_dict(job: Job) -> dict:
    out = {
        "id": job.id,
        "status": job.status,
        "prompt": job.prompt,
        "mode": job.mode,
        "model": job.model,
        "resolution": job.resolution,
        "aspect_ratio": job.aspect_ratio,
        "duration": job.duration,
        "video_url": job.video_url,
        "error": job.error,
    }
    if job.local_path:
        out["local_path"] = job.local_path
    return out


def _as_content(obj: dict) -> dict:
    return {"content": [{"type": "text", "text": json.dumps(obj, ensure_ascii=False, indent=2)}]}


# ---------------------------------------------------------------- transports


async def _stdio(server: McpServer) -> None:
    reader = asyncio.StreamReader()
    loop = asyncio.get_event_loop()
    protocol = asyncio.StreamReaderProtocol(reader)
    await loop.connect_read_pipe(lambda: protocol, sys.stdin)

    writer_transport, _ = await loop.connect_write_pipe(
        asyncio.streams.FlowControlMixin, sys.stdout
    )
    writer = asyncio.StreamWriter(writer_transport, _, None, loop)

    buf = b""
    while True:
        chunk = await reader.read(4096)
        if not chunk:
            break
        buf += chunk
        # JSON-RPC messages are newline-delimited here
        while b"\n" in buf:
            line, buf = buf.split(b"\n", 1)
            line = line.strip()
            if not line:
                continue
            try:
                request = json.loads(line)
            except json.JSONDecodeError:
                continue
            response = await server.handle(request)
            if response is not None:
                writer.write((json.dumps(response) + "\n").encode())
                await writer.drain()


async def _http(server: McpServer, host: str, port: int) -> None:
    from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

    handler = _make_http_handler(server)

    class S(ThreadingHTTPServer):
        daemon_threads = True

    httpd = S((host, port), handler)
    print(f"loremotion-mcp listening on http://{host}:{port}/mcp", file=sys.stderr)
    httpd.serve_forever()


def _make_http_handler(server: McpServer):
    from http.server import BaseHTTPRequestHandler

    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def _send(self, obj: dict | None) -> None:
            if obj is None:
                self.send_response(202)
                self.send_header("Content-Length", "0")
                self.end_headers()
                return
            body = json.dumps(obj).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        async def _handle(self) -> dict | None:
            length = int(self.headers.get("Content-Length") or 0)
            raw = self.rfile.read(length) if length else b""
            try:
                request = json.loads(raw or b"{}")
            except json.JSONDecodeError:
                return None
            return await server.handle(request)

        def do_POST(self) -> None:  # noqa: N802
            response = asyncio.run(self._handle())
            self._send(response)

        def do_GET(self) -> None:  # noqa: N802
            if self.path.startswith("/health"):
                body = json.dumps({"status": "ok", "service": "loremotion-mcp"}).encode()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
                return
            self.send_response(405)
            self.send_header("Content-Length", "0")
            self.end_headers()

        def log_message(self, *a: Any) -> None:  # quiet
            pass

    return Handler


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="LoreMotion MCP server")
    parser.add_argument("--transport", choices=("stdio", "http"), default="stdio")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8080)
    args = parser.parse_args(argv)

    server = McpServer(LoreMotionDriver())

    if args.transport == "stdio":
        asyncio.run(_stdio(server))
    else:
        asyncio.run(_http(server, args.host, args.port))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
