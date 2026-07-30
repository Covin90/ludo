#!/usr/bin/env python3
"""Desktop HTTP backend for the Ludo UI.

The desktop app has no Decky, so the React bundle (served here as static files)
can't reach the Python engine through Decky's `callable` IPC. This server is the
bridge the @decky/api shim's `callable` targets: it imports the plugin's Plugin
class UNMODIFIED and dispatches POST /api/<method> onto its coroutine methods.

  browser  --POST /api/get_status {args:[...]}-->  this server
                                                      -> await plugin.get_status(*args)
                                                   <-- {"result": ...}

The engine (sync_core, watchdog, the RomM client) is the same code the plugin
runs. Only the transport differs: HTTP here, Decky IPC there.
"""
import asyncio
import inspect
import io
import json
import logging
import mimetypes
import os
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlparse

# ── Import the plugin engine ────────────────────────────────────────────────
#
# The vendored decky_plugin/py_modules ships Deck-only binary builds (PIL etc.
# compiled for cpython-311). main.py prepends py_modules to sys.path at import
# time, so those would shadow our environment's working builds. Pre-importing
# the good copies caches them in sys.modules, and the late path insertion then
# resolves them from cache. The engine itself is pure Python and
# imports from the installed romm_sync_engine package.
for _dep in ("PIL.Image", "requests", "watchdog", "psutil"):
    try:
        __import__(_dep)
    except Exception:
        pass  # surfaced later if a method actually needs it

REPO_ROOT = Path(__file__).resolve().parents[2]
PLUGIN_DIR = REPO_ROOT / "decky_plugin"

# The engine is a real package now (pip install -e engine/); only the plugin
# itself still needs a path entry so `import main` resolves.
sys.path.insert(0, str(PLUGIN_DIR))

# Decky injected these; supply equivalents so main.py's module-level reads work.
os.environ.setdefault("DECKY_PLUGIN_RUNTIME_DIR",
                      str(Path.home() / ".config" / "ludo"))
if not os.environ.get("DECKY_PLUGIN_VERSION"):
    try:
        pkg = json.loads((PLUGIN_DIR / "package.json").read_text())
        os.environ["DECKY_PLUGIN_VERSION"] = pkg.get("version", "0.0.0")
    except Exception:
        pass

import main as plugin_module  # noqa: E402  (path setup must precede this)

# Both frontends share one GitHub release and differ only in which asset they
# want: Decky Loader unpacks a zip, the desktop swaps a single AppImage file.
plugin_module.set_asset_suffix("-x86_64.AppImage")

# Version comes from desktop/package.json, not the plugin's, so update
# comparisons use the number this build actually ships as.
try:
    _dpkg = json.loads((Path(__file__).resolve().parents[1] / "package.json").read_text())
    if _dpkg.get("version"):
        plugin_module.PLUGIN_VERSION = _dpkg["version"]
except Exception:
    pass

STATIC_ROOT = Path(__file__).resolve().parent.parent / "dist"

# ── Deck UI sounds ──────────────────────────────────────────────────────────
#
# The plugin plays Steam's own navigation .wav files, which Steam serves to its
# embedded browser from https://steamloopback.host/sounds/. That host doesn't
# exist outside Steam, so the desktop app serves the same files from the local
# Steam install instead (see the UI's playSteamSound). We deliberately don't
# ship copies: these are Valve's assets, and an install without Steam simply
# stays silent — playSteamSound swallows the 404.
#
# Every packaging of Steam keeps its client files somewhere different, and each
# one hides the same steamui/sounds under a different prefix:
#
#   native            ~/.local/share/Steam        (~/.steam/steam symlinks here)
#   Flatpak           ~/.var/app/com.valvesoftware.Steam/{data,.local/share}/Steam
#   Snap              ~/snap/steam/common/.local/share/Steam
#
# Relative to a home directory, because Ludo itself may be sandboxed: inside a
# Flatpak the real home is /run/host/home/<user>, so each candidate is tried
# under every plausible home (see steam_homes).
STEAM_SUBPATHS = [
    ".local/share/Steam",
    ".steam/steam",
    ".steam/root",
    # Flatpak Steam. Older releases put the client under data/, current ones
    # under the sandboxed XDG data dir; both still occur in the wild.
    ".var/app/com.valvesoftware.Steam/data/Steam",
    ".var/app/com.valvesoftware.Steam/.local/share/Steam",
    # Snap Steam. `common` survives refreshes (`current` is a symlink into the
    # active revision), so prefer it — but accept either.
    "snap/steam/common/.local/share/Steam",
    "snap/steam/current/.local/share/Steam",
]
# Prefix-less installs, tried after the per-home ones.
STEAM_SYSTEM_DIRS = [
    Path("/usr/share/steam"),
    Path("/usr/lib/steam"),
]


def steam_homes() -> list[Path]:
    """Home directories that might hold a Steam install.

    $HOME first. If Ludo is running sandboxed, the user's real home is exposed
    at /run/host/home/<user> (Flatpak) — where Steam actually lives, whichever
    way Steam itself was packaged.
    """
    homes = [Path.home()]
    host_home = Path("/run/host/home") / Path.home().name
    if host_home.is_dir():
        homes.append(host_home)
    # A sandboxed Ludo may also see the whole host root mounted at /run/host.
    homes.append(Path("/run/host") / Path.home().relative_to("/"))
    return homes


def steam_sound_dirs() -> list[Path]:
    dirs = [h / sub / "steamui/sounds" for h in steam_homes() for sub in STEAM_SUBPATHS]
    dirs += [d / "steamui/sounds" for d in STEAM_SYSTEM_DIRS]
    dirs += [Path("/run/host") / str(d).lstrip("/") / "steamui/sounds"
             for d in STEAM_SYSTEM_DIRS]
    return dirs


_SOUND_DIR: Path | None = None
_SOUND_DIR_RESOLVED = False


def sound_dir() -> Path | None:
    """First existing Steam sounds directory, resolved once per run."""
    global _SOUND_DIR, _SOUND_DIR_RESOLVED
    if not _SOUND_DIR_RESOLVED:
        _SOUND_DIR_RESOLVED = True
        for d in steam_sound_dirs():
            # Several candidates are symlinks into each other (~/.steam/steam →
            # ~/.local/share/Steam); resolve so the log names the real location.
            try:
                if d.is_dir():
                    _SOUND_DIR = d.resolve()
                    break
            except OSError:
                continue  # unreadable sandbox mount — just try the next one
        logging.info(f"[sounds] {_SOUND_DIR or 'no Steam install found — silent'}")
    return _SOUND_DIR


# ── Async engine on a background loop ───────────────────────────────────────

class Engine:
    """Owns the Plugin instance and the asyncio loop its coroutines run on.

    The loop runs in its own thread; HTTP handler threads submit coroutines to
    it with run_coroutine_threadsafe and block on the result. This keeps every
    plugin method — and the sync threads they spawn — on one consistent loop.
    """

    def __init__(self):
        self.loop = asyncio.new_event_loop()
        self.plugin = plugin_module.Plugin()
        self._ready = threading.Event()
        self._thread = threading.Thread(target=self._run, name="engine-loop",
                                         daemon=True)

    def _run(self):
        asyncio.set_event_loop(self.loop)
        # _main() constructs the sync managers and starts the watchdog threads,
        # exactly as Decky's load path does.
        self.loop.run_until_complete(self.plugin._main())
        self._ready.set()
        self.loop.run_forever()

    def start(self, timeout=60):
        self._thread.start()
        if not self._ready.wait(timeout):
            raise RuntimeError("engine _main() did not complete in time")

    def call(self, method: str, args: list):
        fn = getattr(self.plugin, method, None)
        # Only public coroutine methods are reachable — never dunders, private
        # helpers, or plain attributes.
        if (method.startswith("_") or fn is None
                or not inspect.iscoroutinefunction(fn)):
            raise LookupError(method)
        fut = asyncio.run_coroutine_threadsafe(fn(*args), self.loop)
        return fut.result()

    def stop(self):
        try:
            fut = asyncio.run_coroutine_threadsafe(self.plugin._unload(),
                                                   self.loop)
            fut.result(timeout=10)
        except Exception:
            pass
        self.loop.call_soon_threadsafe(self.loop.stop)


ENGINE: Engine | None = None


# ── Non-plugin RPC: filesystem listing for the file picker ──────────────────

def shim_list_dir(path: str, include_files: bool = False) -> dict:
    """Backs the shim's openFilePicker — a browser can't enumerate the FS."""
    p = Path(path).expanduser()
    if not p.is_dir():
        p = Path.home()
    entries = []
    try:
        for child in sorted(p.iterdir(),
                            key=lambda c: (not c.is_dir(), c.name.lower())):
            is_dir = child.is_dir()
            if not is_dir and not include_files:
                continue
            if child.name.startswith("."):
                continue
            entries.append({"name": child.name, "path": str(child),
                            "isdir": is_dir})
    except PermissionError:
        pass
    parent = str(p.parent) if p.parent != p else None
    return {"path": str(p), "parent": parent, "entries": entries}


ASSETS_DIR = (PLUGIN_DIR / "assets").resolve()
_ASSET_URI_CACHE: dict = {}


def _rasterize_svg(data: bytes):
    """Render an SVG to PNG bytes via librsvg + cairo.

    WebKit re-rasterizes an SVG used as a CSS background on every repaint of the
    (fullscreen, zoomed) layer — and auth_background.svg carries @keyframes and
    masked blob paths, so on the software compositing path (DMABUF disabled for
    Wayland) it makes the whole wizard crawl. Rasterizing once to a PNG lets
    WebKit cache and blit a bitmap instead; the 28px backdrop blur hides any
    loss from rasterizing at the SVG's own pixel size.
    """
    import cairo
    import gi
    gi.require_version("Rsvg", "2.0")
    from gi.repository import Rsvg
    h = Rsvg.Handle.new_from_data(data)
    ok, w, ht = h.get_intrinsic_size_in_pixels()
    if not ok or not w or not ht:
        dim = h.get_dimensions()
        w, ht = dim.width, dim.height
    w, ht = int(w), int(ht)
    surf = cairo.ImageSurface(cairo.FORMAT_ARGB32, w, ht)
    ctx = cairo.Context(surf)
    vp = Rsvg.Rectangle()
    vp.x, vp.y, vp.width, vp.height = 0, 0, w, ht
    h.render_document(ctx, vp)
    buf = io.BytesIO()
    surf.write_to_png(buf)
    return buf.getvalue()


def get_image(path: str = ""):
    """Serve bundled /assets/* images locally, delegate the rest to the engine.

    The plugin's get_image fetches every path over the authenticated RomM
    session and returns nothing when there's no connection (main.py: `if not
    self._romm_client.authenticated: return`). On the Deck the plugin is always
    connected, so V2Bg's default background art (`/assets/auth_background.svg`)
    loads. On desktop — and especially in the setup wizard, which runs BEFORE
    any connection exists — that fetch fails and the wizard falls back to a flat
    colour. Those /assets/* files are shipped in the plugin bundle, so serve
    them straight off disk (no connection needed); anything else falls through
    to the engine's get_image exactly as before. SVGs are rasterized to PNG so
    WebKit can cache a bitmap rather than re-rasterizing the vector every paint.
    """
    if path.startswith("/assets/"):
        f = (ASSETS_DIR / path[len("/assets/"):]).resolve()
        if ASSETS_DIR in f.parents and f.is_file():
            import base64
            key = (str(f), f.stat().st_mtime_ns)
            uri = _ASSET_URI_CACHE.get(key)
            if uri is None:
                raw = f.read_bytes()
                mime = mimetypes.guess_type(str(f))[0] or "application/octet-stream"
                if f.suffix.lower() == ".svg":
                    try:
                        raw, mime = _rasterize_svg(raw), "image/png"
                    except Exception as e:
                        logging.warning(f"svg rasterize failed for {f.name}: {e}")
                uri = f"data:{mime};base64,{base64.b64encode(raw).decode()}"
                _ASSET_URI_CACHE.clear()  # only ever a handful of assets
                _ASSET_URI_CACHE[key] = uri
            return {"success": True, "data_uri": uri}
    return ENGINE.call("get_image", [path])


LOCAL_RPC = {"shim_list_dir": shim_list_dir, "get_image": get_image}


# ── HTTP ────────────────────────────────────────────────────────────────────

class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):  # quieter default logging
        pass

    def _json(self, code: int, payload: dict):
        body = json.dumps(payload).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        parsed = urlparse(self.path)
        if not parsed.path.startswith("/api/"):
            self._json(404, {"error": "not found"})
            return
        method = unquote(parsed.path[len("/api/"):])
        try:
            length = int(self.headers.get("Content-Length") or 0)
            raw = self.rfile.read(length) if length else b"{}"
            args = (json.loads(raw or b"{}") or {}).get("args", [])
        except Exception as e:
            self._json(400, {"error": f"bad request: {e}"})
            return

        try:
            if method in LOCAL_RPC:
                result = LOCAL_RPC[method](*args)
            else:
                result = ENGINE.call(method, args)
            self._json(200, {"result": result})
        except LookupError:
            self._json(404, {"error": f"unknown method: {method}"})
        except Exception as e:
            # Mirror the plugin convention: surface the error to the UI rather
            # than 500ing, so call sites' try/catch can present it.
            self._json(200, {"error": str(e)})

    def _sound(self, name: str):
        """Serve one Steam UI .wav by bare filename.

        Name-only (no separators, .wav only) keeps this from becoming a read
        primitive for the whole filesystem. A missing file or no Steam install
        is a plain 404: the UI treats every sound as optional.
        """
        d = sound_dir()
        if d is None or "/" in name or "\\" in name or not name.endswith(".wav"):
            self.send_error(404)
            return
        f = d / name
        if not f.is_file():
            self.send_error(404)
            return
        data = f.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", "audio/wav")
        self.send_header("Content-Length", str(len(data)))
        # These never change under us; let the renderer keep them in its cache
        # rather than re-fetching a click sound on every navigation.
        self.send_header("Cache-Control", "public, max-age=604800")
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        parsed = urlparse(self.path)
        if parsed.path.startswith("/sounds/"):
            self._sound(unquote(parsed.path[len("/sounds/"):]))
            return
        rel = unquote(parsed.path.lstrip("/")) or "index.html"
        target = (STATIC_ROOT / rel).resolve()
        # SPA + traversal guard: anything outside dist/, or any unknown path,
        # falls back to index.html so client-side routes resolve.
        if STATIC_ROOT not in target.parents and target != STATIC_ROOT:
            target = STATIC_ROOT / "index.html"
        if not target.is_file():
            target = STATIC_ROOT / "index.html"
        if not target.is_file():
            self._json(404, {"error": "no built UI — run `npm run build`"})
            return
        ctype = mimetypes.guess_type(str(target))[0] or "application/octet-stream"
        data = target.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


def serve(host="127.0.0.1", port=8723):
    """Start the engine + HTTP server and return (httpd, engine).

    Blocks until the engine is ready and the socket is bound, then returns
    without serving — the caller drives serve_forever() (in a thread for the
    desktop shell, or directly for the CLI). This lets the window shell run the
    backend in-process and know exactly when the UI can be loaded.
    """
    global ENGINE
    ENGINE = Engine()
    print("[server] starting engine…", flush=True)
    ENGINE.start()
    print("[server] engine ready", flush=True)

    httpd = ThreadingHTTPServer((host, port), Handler)
    print(f"[server] listening on http://{host}:{port}", flush=True)
    return httpd, ENGINE


def main():
    host = os.environ.get("ROMM_HOST", "127.0.0.1")
    port = int(os.environ.get("ROMM_PORT", "8723"))
    httpd, engine = serve(host, port)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        engine.stop()


if __name__ == "__main__":
    main()
