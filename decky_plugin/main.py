import asyncio
import base64
import hashlib
import json
import logging
import mimetypes
import re
import sys
import threading
import time
import subprocess
import shutil
import os
import ctypes
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urljoin

# Add py_modules to path so the vendored engine is importable
sys.path.insert(0, str(Path(__file__).parent / "py_modules"))

# Claim our app identity before anything reads or writes engine state. Ludo
# keeps ~/.config/ludo; it shares nothing with the GTK app.
from romm_sync_engine import paths as _paths  # noqa: E402
_paths.set_app_id("ludo")
_paths.set_client_name("Ludo")
# Downloads, covers and generated icons go under ~/Ludo rather than the GTK
# app's ~/RomMSync — but only for someone who has no ~/RomMSync already, so
# renaming the app never strands a library that is on disk (see paths.library_dir).
_paths.set_library_dir_name("Ludo")


def _default_roms_dir() -> str:
    """Fallback ROM folder for the many settings reads below."""
    return str(_paths.library_dir() / 'roms')


CONFIG_DIR = _paths.config_dir()

# Preload Pillow shared libraries for bundled wheel
# This is needed because the .so files in the wheel need to find their dependencies
pillow_libs_dir = Path(__file__).parent / "py_modules" / "pillow.libs"
if pillow_libs_dir.exists():
    try:
        # Preload all shared libraries from pillow.libs
        for lib_file in sorted(pillow_libs_dir.glob("*.so*")):
            try:
                ctypes.CDLL(str(lib_file))
                logging.debug(f"[PIL] Preloaded library: {lib_file.name}")
            except Exception as e:
                logging.debug(f"[PIL] Could not preload {lib_file.name}: {e}")
    except Exception as e:
        logging.warning(f"[PIL] Error preloading pillow libraries: {e}")

# Import PIL early to ensure C extensions are loaded correctly
# This must be done before sync_core imports it at module level
try:
    from PIL import Image
    PIL_AVAILABLE = True
    logging.info(f"[PIL] PIL imported successfully from: {Image.__file__}")
except ImportError as e:
    PIL_AVAILABLE = False
    logging.error(f"[PIL] PIL import failed: {e}")

try:
    from romm_sync_engine.sync_core import (
        SettingsManager, RomMClient, RetroArchInterface,
        AutoSyncManager, CollectionSyncManager,
        BiosTrackingManager, ROM_TRIM_FIELDS, LIBRARY_PAGE_SIZE,
        SteamShortcutManager, CoverArtManager,
        build_sync_status, is_path_validly_downloaded, detect_retrodeck,
        flatpak_app_installed,
        _extract_archive, _archive_member_names,
        get_desktop_tile_status, add_desktop_tile, remove_desktop_tile,
    )
    SYNC_CORE_AVAILABLE = True
except ImportError as e:
    logging.warning(f"sync_core not available: {e}")
    SYNC_CORE_AVAILABLE = False

try:
    from romm_sync_engine import activity_log
except Exception:
    activity_log = None


def _record_activity(kind, title, detail='', rom_id=None):
    """Append to the Settings ▸ Recent Activity feed (no-op if unavailable).

    rom_id is optional and only passed on when set — the engine is shared with
    romm-retroarch-sync, which may be running an activity_log whose record()
    predates the argument.
    """
    if activity_log:
        try:
            if rom_id is None:
                activity_log.record(kind, title, detail)
            else:
                activity_log.record(kind, title, detail, rom_id=rom_id)
        except TypeError:
            activity_log.record(kind, title, detail)
        except Exception:
            pass

# ---------------------------------------------------------------------------
# Logging setup
# ---------------------------------------------------------------------------
log_file = CONFIG_DIR / 'debug.log'
log_file.parent.mkdir(parents=True, exist_ok=True)

# Was 'decky_debug.log' back when this only ran as a Decky plugin. Carry an
# existing log over rather than orphaning it beside the new one, so a user who
# hits a bug right after updating still has the history that led up to it.
try:
    _old_log = CONFIG_DIR / 'decky_debug.log'
    if _old_log.exists() and not log_file.exists():
        _old_log.rename(log_file)
except Exception:
    pass
settings_file = CONFIG_DIR / 'decky_settings.json'

# Persisted library snapshot — the last successful fetch of games + collections +
# platform mappings. Hydrated on cold start so the Game Browser populates offline,
# overwritten (write-through) after every successful fetch. schema-versioned and
# tagged with the server_url so a server switch invalidates it. See _persist_snapshot /
# _load_snapshot. SCHEMA bumps when the persisted game/collection shape changes.
snapshot_file = CONFIG_DIR / 'library_snapshot.json'
SNAPSHOT_SCHEMA = 1

# Partial-fetch checkpoint. A full library fetch is ~6 minutes at 80k ROMs, and
# anything that interrupts it — suspend, a network blip, a Decky reload — used to
# throw away every page already paid for. Pages are appended here as they arrive
# and replayed on the next attempt.
#
# NDJSON, one line per page, because rewriting a single JSON document after every
# page is quadratic in a library's size: at 80 pages that is 80 rewrites of a
# file that ends up hundreds of MB. Appending is O(1) per page.
#
# First line is a manifest; each later line is {"offset": N, "rows": [...]}.
# Deleted on success, so its presence means the last attempt did not finish.
resume_file = CONFIG_DIR / 'library_resume.ndjson'
RESUME_SCHEMA = 1
# Same 24h bound Argosy puts on its sync-resume generation: past that, the
# library has probably moved on and replaying stale pages is worse than refetching.
RESUME_TTL_SECONDS = 24 * 3600


def _platform_label(rom):
    """Human platform name off a RomM ROM row, or 'Unknown'.

    RomM 5.1.0 has no `platform_name` field — it is platform_display_name
    (already resolved to the custom name when the user set one) with
    platform_custom_name alongside it. So the old rom.get('platform_name',
    'Unknown') returned the default for every ROM, and because 'Unknown' is
    truthy it also dead-ended the `or r.get('platform_name')` fallbacks downstream. Most
    surfaces hid this behind _platform_name_for's slug->name map; the game
    detail header did not, and showed "Unknown" whenever the detail fetch hadn't
    landed. platform_name is kept last for older servers that do send it.
    """
    return (rom.get('platform_custom_name') or rom.get('platform_display_name')
            or rom.get('platform_name') or 'Unknown')


def _variant_count(game):
    """How many of RomM's ROMs a single library entry stands for.

    We collapse regional variants of a game into one browsable entry
    (_group_sibling_roms), so len(_available_games) is smaller than the ROM
    count RomM reports — 2,440 vs 3,083 on a 3k library. Stats that claim to
    describe the library have to use this, or they contradict the server the
    user is looking at in another tab.

    Counted at ingest into 'variant_count' because grouping prunes the pieces
    afterwards: for a folder ROM (a multi-disc game or a bundle of regional
    files) the file-members are removed from BOTH sibling_roms and
    _sibling_files, and survive only in _region_save_siblings, which the plugin
    doesn't keep. Recomputing here from what's left would undercount exactly
    those groups. Snapshots written before this existed have no field, so fall
    back to the best reconstruction available.
    """
    n = game.get('variant_count')
    if isinstance(n, int) and n > 0:
        return n
    return 1 + len(game.get('sibling_roms') or [])


def load_decky_settings():
    try:
        if settings_file.exists():
            with open(settings_file, 'r') as f:
                return json.load(f)
    except Exception as e:
        print(f"Failed to load decky settings: {e}")
    return {'logging_enabled': True}


def save_decky_settings(settings):
    try:
        settings_file.parent.mkdir(parents=True, exist_ok=True)
        with open(settings_file, 'w') as f:
            json.dump(settings, f, indent=2)
        return True
    except Exception as e:
        print(f"Failed to save decky settings: {e}")
        return False


decky_settings = load_decky_settings()
logging_enabled = decky_settings.get('logging_enabled', True)

_root_logger = logging.getLogger()
_file_handler = None

if logging_enabled:
    _file_handler = logging.FileHandler(str(log_file))
    _file_handler.setLevel(logging.DEBUG)
    _file_handler.setFormatter(logging.Formatter('%(asctime)s - %(levelname)s - %(message)s'))
    _root_logger.addHandler(_file_handler)
    _root_logger.setLevel(logging.DEBUG)

# Suppress noisy third-party loggers
logging.getLogger('watchdog').setLevel(logging.WARNING)
logging.getLogger('urllib3').setLevel(logging.WARNING)
# PIL logs a line per PNG chunk ("STREAM b'IHDR'…", "STREAM b'IDAT'…") at DEBUG.
# Every cover thumbnail we decode emits several, which buries the log we actually
# read in thousands of lines of chunk headers.
logging.getLogger('PIL').setLevel(logging.WARNING)

# File extensions considered launchable discs — must match Plugin._LAUNCHABLE_DISC_EXTS.
_LAUNCHABLE_DISC_EXTS = ('.m3u', '.chd', '.cue', '.iso', '.pbp',
                          '.ccd', '.gdi', '.cdi', '.nrg')

# Auxiliary (non-game) files that may sit alongside ROMs inside a download
# folder: playlists, cover art, saves/states, and metadata. Used to isolate the
# actual standalone game files when classifying a multi-FILE ROM (regional
# variants) — must match Plugin._NON_GAME_EXTS.
_NON_GAME_EXTS = (
    '.m3u', '.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp',
    '.srm', '.sav', '.dsv', '.mcr', '.eep', '.fla', '.mpk', '.sra',
    '.state', '.auto', '.txt', '.nfo', '.xml', '.dat', '.json', '.cue',
)


def _list_standalone_games(folder):
    """Return the standalone game files inside a folder (regional/multi-file ROM).

    A RomM multi-FILE ROM (e.g. one entry whose member files are per-region
    cartridge dumps like .nds) extracts to a folder containing the game files
    plus a RomM-generated .m3u. Those files are NOT discs — each is a complete,
    independently bootable game — so the .m3u must never be launched (it would
    hand the emulator two full games as "discs"). This isolates the real games:
    every file that is not auxiliary (playlist/cover/save/metadata) and not a
    disc image. Returns a name-sorted list of Path objects.
    """
    games = []
    for f in folder.rglob('*'):
        if not f.is_file():
            continue
        ext = f.suffix.lower()
        if ext in _NON_GAME_EXTS or ext in _LAUNCHABLE_DISC_EXTS:
            continue
        # State slots are ".state", ".state1", ".state.auto", etc.
        if ext.startswith('.state'):
            continue
        games.append(f)
    return sorted(games, key=lambda x: x.name.lower())


def _resolve_download_path(download_dir, platform_slug, file_name):
    """Return (local_path, is_downloaded) for a ROM, recognizing extractions.

    A single-file .zip/.7z download whose content needs it is unpacked into a
    sibling folder named for the archive stem and the archive is deleted (see
    Plugin._maybe_unzip_download). So when the literal <file_name> is gone, also
    accept that extracted folder before declaring the game not downloaded —
    otherwise a restart re-scans for the now-deleted archive and reports every
    unpacked game as missing.
    """
    base = Path(download_dir) / platform_slug / file_name
    if is_path_validly_downloaded(base):
        return base, True
    if Path(file_name).suffix.lower() in ('.zip', '.7z'):
        stem = Path(file_name).stem
        for cand in (Path(download_dir) / platform_slug / stem,
                     Path(download_dir) / platform_slug / (stem + '__extracted')):
            if is_path_validly_downloaded(cand):
                return cand, True
    return base, False


def _detect_multi_disc(local_path, is_downloaded):
    """Return (is_multi_disc, disc_count) for the downloaded game.

    Covers both flavours of "multiple bootable files in one folder":
      - true multi-DISC games (disc images / an .m3u playlist), and
      - multi-FILE ROMs whose members are regional cartridge variants.
    Both are surfaced through the same picker; region-vs-disc labelling is
    resolved later from the on-disk entries (see get_local_discs).
    """
    if not is_downloaded:
        return False, 0
    p = Path(local_path)
    if not p.exists():
        return False, 0
    if p.is_dir():
        launchable = [f for f in p.rglob('*')
                      if f.is_file() and f.suffix.lower() in _LAUNCHABLE_DISC_EXTS]
        if len(launchable) > 1:
            return True, len(launchable)
        # No disc set — fall back to standalone game files (regional variants).
        games = _list_standalone_games(p)
        return len(games) > 1, len(games)
    return False, 0


# ---------------------------------------------------------------------------
# Version + auto-update
# ---------------------------------------------------------------------------
GITHUB_OWNER = "Covin90"
GITHUB_REPO = "ludo"
GITHUB_API = f"https://api.github.com/repos/{GITHUB_OWNER}/{GITHUB_REPO}"

# The release asset the updater downloads (see DEPLOYMENT.md naming convention).
# Both frontends share one release; they differ only in which asset they want.
# The desktop shell overrides this at startup via set_asset_suffix().
UPDATE_ASSET_SUFFIX = "-decky.zip"


def set_asset_suffix(suffix: str) -> None:
    """Choose which release asset this frontend updates from.

    Decky keeps the default zip; the desktop shell sets the AppImage suffix.
    Callers must not rely on the module constant after this — read
    asset_suffix() instead, since the default is resolved per call.
    """
    global UPDATE_ASSET_SUFFIX
    UPDATE_ASSET_SUFFIX = suffix


def asset_suffix() -> str:
    return UPDATE_ASSET_SUFFIX

# Update channels exposed in the UI.
VALID_CHANNELS = ("stable", "beta")


def _read_plugin_version():
    """Single source of truth for the plugin version.

    Prefers Decky's DECKY_PLUGIN_VERSION env (injected from package.json at load
    time), falling back to reading package.json directly. This removes the old
    hardcoded version literals that used to drift between files.
    """
    v = os.environ.get('DECKY_PLUGIN_VERSION')
    if v:
        return v.lstrip('v')
    try:
        with open(Path(__file__).parent / 'package.json') as f:
            return str(json.load(f).get('version', '0.0.0'))
    except Exception:
        return '0.0.0'


PLUGIN_VERSION = _read_plugin_version()


def _version_key(v):
    """Comparable semver key with pre-release ordering.

    Follows semver precedence: 1.7.0 > 1.7.0-beta.2 > 1.7.0-beta.1 > 1.6.1.
    A final release outranks any pre-release of the same core version, and
    pre-release identifiers compare numerically/lexically per the spec. Handles
    a leading 'v' and drops build metadata after '+'.
    """
    v = (v or '').lstrip('vV').strip().split('+', 1)[0]
    core, _, pre = v.partition('-')
    nums = [int(n) for n in re.findall(r'\d+', core)][:3]
    core_t = tuple(nums) + (0,) * (3 - len(nums))
    if not pre:
        # No pre-release → sorts ABOVE any pre-release of the same core.
        return (core_t, (1,))
    ids = []
    for x in re.split(r'[.]', pre):
        if x.isdigit():
            ids.append((0, int(x), ''))   # numeric identifiers rank below alnum
        else:
            ids.append((1, 0, x))
    return (core_t, (0, tuple(ids)))


def _release_asset(rel, suffix):
    """First asset on `rel` whose name ends with `suffix`, or None."""
    return next((a for a in (rel.get('assets') or [])
                 if (a.get('name') or '').endswith(suffix)), None)


def _iter_releases(max_pages=5, per_page=100):
    """Yield non-draft releases, newest pages first.

    Paginated because a fast beta cadence can push the newest *stable* release
    well past the first page — a single per_page=50 fetch could return nothing
    but prereleases and miss it entirely. Bounded so we never walk the whole
    history of the repo.
    """
    import requests
    headers = {'Accept': 'application/vnd.github+json'}
    for page in range(1, max_pages + 1):
        resp = requests.get(f"{GITHUB_API}/releases", headers=headers,
                            params={'per_page': per_page, 'page': page}, timeout=15)
        if resp.status_code == 404:
            # No releases published yet, or the repo is private (GitHub answers
            # 404 rather than 403 to unauthenticated reads). Neither is an
            # error worth a traceback on every startup — there is simply
            # nothing to update to.
            logging.info("[UPDATE] no releases available (repo private or "
                         "nothing published yet)")
            return
        resp.raise_for_status()
        batch = resp.json()
        if not batch:
            return
        for r in batch:
            if not r.get('draft'):
                yield r
        if len(batch) < per_page:
            return


def select_release(channel: str, asset_suffix: str):
    """Newest release on `channel` that actually carries `asset_suffix`.

    Releases lacking the asset are skipped during selection rather than picked
    and then rejected. Otherwise publishing an artifact-only release (say an
    AppImage build with no -decky.zip) would outrank every older release that
    does have one, and updates would silently report "none available".

    Suffix is a parameter so other front-ends can reuse this with their own
    artifact naming.
    """
    import requests
    if channel == 'stable':
        # Fast path: GitHub's "latest" is correct whenever it carries the asset.
        try:
            resp = requests.get(f"{GITHUB_API}/releases/latest",
                                headers={'Accept': 'application/vnd.github+json'},
                                timeout=15)
            resp.raise_for_status()
            rel = resp.json()
            if _release_asset(rel, asset_suffix):
                return rel
            logging.info("[UPDATE] /releases/latest lacks "
                         f"{asset_suffix}; enumerating releases")
        except Exception as e:
            if getattr(getattr(e, 'response', None), 'status_code', None) == 404:
                logging.info("[UPDATE] no published 'latest' release; enumerating")
            else:
                logging.warning(f"[UPDATE] /releases/latest failed ({e}); enumerating")

    candidates = [r for r in _iter_releases()
                  if (channel == 'beta' or not r.get('prerelease'))
                  and _release_asset(r, asset_suffix)]
    # GitHub's /releases order is NOT newest-first by version — tags sort
    # roughly lexicographically, so v1.7.0-beta.10 lists BELOW beta.9
    # ("1" < "9"). Never trust the API order; pick the semver max ourselves.
    if not candidates:
        return None
    return max(candidates,
               key=lambda r: _version_key(r.get('tag_name') or r.get('name') or ''))


# ---------------------------------------------------------------------------
# Plugin
# ---------------------------------------------------------------------------

class Plugin:
    # Sync objects — owned directly
    _settings: 'SettingsManager' = None
    _retroarch = None
    _romm_client = None
    _auto_sync = None
    _collection_sync = None
    _available_games: list = None

    # Live state of an in-progress emulator install (see install_emulator).
    # Class-level default so emulator_install_state() answers before one starts.
    _emu_install: dict = {'active': False, 'phase': '', 'pct': None,
                          'detail': '', 'error': None, 'installed': False,
                          'repaired': []}

    # Background retry thread (reconnect + collection-list refresh every 5 min)
    _stop_event: threading.Event = None
    _retry_thread: threading.Thread = None
    _reach_thread: threading.Thread = None

    # Cached collection list — refreshed on connect and every 5 min in _retry_loop.
    # Passed to build_sync_status so get_service_status() makes zero API calls.
    _romm_collections: list = None

    # Cached virtual (autogenerated) collections — browse/download only, never
    # auto-synced. Keyed by their opaque base64 `id`.
    _romm_virtual_collections: list = None

    # True once the first _connect_to_romm() attempt has completed (even on failure),
    # used by get_service_status() to distinguish "still starting" from "failed".
    _connection_attempted: bool = False

    # True when the last pass through _connect_to_romm() returned WITHOUT talking
    # to the server — auto-connect off, or credentials/pairing not in place yet.
    # That is not an outage, and get_service_status must not describe it as one:
    # the sync restart that follows an emulator install re-enters this path
    # mid-wizard, which reported 'server_unreachable' and toasted "Can't reach
    # RomM server" about a server nothing had contacted.
    _connect_blocked: bool = False

    # Snapshot of ROM counts for collections that have been disabled.
    # Keyed by collection name; value is the total count from the cache at disable time.
    # Cleared when deletion completes or the collection is re-enabled.
    _disabled_collection_counts: dict = {}

    # Platform mapping (slug -> name)
    _platform_slug_to_name: dict = None  # {'psx': 'Sony - PlayStation', ...}

    # Timestamp for efficient polling with updated_after parameter
    _last_full_fetch_time: str = None  # ISO 8601 datetime of last full data fetch

    # ISO 8601 fetched_at of the data currently in memory, sourced either from the
    # persisted snapshot (cold start) or the last live fetch. Drives the "library
    # from N ago" copy in the offline banner. None until hydrated/fetched.
    _snapshot_fetched_at: str = None

    # Server-side ROM count matching the library in memory. NOT len(_available_games):
    # the fetch groups regional variants under a parent (3,083 rows came back as
    # 2,440 entries on a real instance), so the grouped list can never be compared
    # to a server count directly. This is the ungrouped figure get_roms returns
    # alongside the games, and it is what the connect-time count probe compares
    # against. None until fetched, or when hydrated from a pre-existing snapshot
    # that predates this field — in which case connect just fetches as before.
    _library_server_total: int = None

    # {'loaded': N, 'total': M} while a full fetch is running, else None. The
    # fetch is ~12s on a 3k library and the connecting banner otherwise says the
    # same thing at second 1 and second 12, which is what makes a busy plugin
    # look hung. Written from the fetch's worker threads and read by the status
    # poll; a dict rebind is atomic under the GIL, so no lock — never mutate it
    # in place.
    _library_progress: dict = None

    # Open append handle for the partial-fetch checkpoint, and the lock guarding
    # it — pages are written from the fetch's worker threads, and a torn line
    # would cost every page after it on the next resume.
    _resume_handle = None
    _resume_lock = threading.Lock()

    # One-shot toast request for the frontend: {'kind': 'ready', 'games': N} or
    # {'kind': 'failed'}, else None. Only ever set for the FIRST library load on
    # this device; the frontend calls ack_library_announcement() once it has
    # shown it, which persists the fact so a plugin reload doesn't re-toast.
    _announce_library: dict = None

    # Reachability latch, distinct from RomMClient.authenticated (which is sticky).
    # True while the server is responding; flipped False on any connected-branch
    # failure. A False→True transition triggers an offline save flush. Starts None
    # so the first successful probe doesn't count as a "reconnect".
    _online: bool = None

    # Device-level network state, reported by the frontend's navigator
    # online/offline events. Distinct from _online (server reachability): lets us
    # tell "the Deck has no internet" (no_network) from "the Deck is online but
    # the RomM server isn't responding" (server_unreachable). None = unknown.
    _device_online: bool = None

    # Consecutive failed reachability probes. A single failure is not enough to
    # go offline: the probe shares the connection with whatever else is running,
    # and a large download (or a server that is merely busy) makes one 6s GET
    # time out routinely. Latching on the first miss made the library flip to
    # downloaded-only mid-session — the platform list would collapse to just the
    # platforms the user had grabbed something from. See _reachability_loop.
    _probe_fail_streak: int = 0

    # Coalescing state for _persist_snapshot_throttled.
    _snapshot_timer_lock = threading.Lock()
    _snapshot_timer: 'threading.Timer' = None
    _snapshot_last_write: float = 0.0

    _bios_tracking: 'BiosTrackingManager' = None
    _steam_manager: 'SteamShortcutManager' = None

    # Collections currently running a Steam shortcut sync (add/remove in progress)
    _syncing_steam_collections: set = None

    # Game Browser: base64 cover-art cache {(rom_id, large): data_uri} and a
    # rom_id -> cover_path map for games not in _available_games (collection view).
    _cover_cache: dict = {}
    _cover_paths: dict = {}

    # Live per-game download progress {rom_id: {percent, downloaded, total, speed,
    # eta, state}} populated by download_game's progress_callback and polled by the
    # frontend via get_download_progress() for the cover/button fill UI.
    _download_progress: dict = {}

    # -----------------------------------------------------------------------
    # Lifecycle
    # -----------------------------------------------------------------------

    async def _main(self):
        self._available_games = []
        self._romm_collections = None
        self._romm_virtual_collections = None
        self._connection_attempted = False
        self._platform_slug_to_name = {}
        self._syncing_steam_collections = set()
        logging.info("Ludo starting...")
        self._start_sync()
        return await self.get_service_status()

    async def _unload(self):
        logging.info("Ludo unloading...")
        self._stop_sync()

    # -----------------------------------------------------------------------
    # Internal sync management
    # -----------------------------------------------------------------------

    def _start_sync(self):
        if not SYNC_CORE_AVAILABLE:
            logging.error("sync_core not available, cannot start sync")
            return
        if self._retry_thread and self._retry_thread.is_alive():
            return

        self._settings = SettingsManager()
        self._retroarch = RetroArchInterface()
        self._steam_manager = SteamShortcutManager(
            retroarch_interface=self._retroarch,
            settings=self._settings,
            log_callback=lambda msg: logging.info(f"[STEAM] {msg}"),
            cover_manager=None  # Will be set after romm_client is created
        )
        logging.info(f"Steam shortcut manager created, available: {self._steam_manager.is_available()}")
        logging.info(f"RetroArch interface created, has bios_manager: {hasattr(self._retroarch, 'bios_manager')}")
        if hasattr(self._retroarch, 'bios_manager'):
            logging.info(f"bios_manager value: {self._retroarch.bios_manager}")
        if self._available_games is None:
            self._available_games = []
        self._connection_attempted = False

        # Cold-start hydration: seed the library from the last persisted snapshot
        # so the Game Browser is populated immediately — before the retry thread
        # connects, and even if it never does (offline). A successful fetch later
        # overwrites this in place.
        if not self._available_games:
            self._hydrate_from_snapshot()

        self._stop_event = threading.Event()
        self._retry_thread = threading.Thread(
            target=self._retry_loop,
            daemon=True,
            name="romm-sync-retry",
        )
        self._retry_thread.start()

        # Fast reachability probe: actively checks the server every ~25s and
        # flips the connection state, so offline/online is detected in seconds
        # WITHOUT relying on the frontend's navigator events (gamescope often
        # doesn't emit them). The 5-min retry loop remains the heavier
        # reconnect/refresh worker.
        self._reach_thread = threading.Thread(
            target=self._reachability_loop,
            daemon=True,
            name="romm-reachability",
        )
        self._reach_thread.start()

        logging.info("Sync started (retry + reachability threads; managers start on connect)")

    def _stop_sync(self):
        if self._stop_event:
            self._stop_event.set()
        if self._retry_thread:
            self._retry_thread.join(timeout=5)
        if self._reach_thread:
            self._reach_thread.join(timeout=5)
            self._reach_thread = None

        # Stop managers
        if self._bios_tracking:
            # No explicit stop needed (downloads run to completion)
            self._bios_tracking = None

        if self._auto_sync and self._auto_sync.enabled:
            try:
                self._auto_sync.stop_auto_sync()
            except Exception:
                pass
        if self._collection_sync:
            try:
                self._collection_sync.stop()
            except Exception:
                pass

        self._retry_thread = None
        self._stop_event = None
        self._romm_client = None
        self._auto_sync = None
        self._collection_sync = None
        self._romm_collections = None
        self._romm_virtual_collections = None
        self._connection_attempted = False
        self._disabled_collection_counts.clear()

        logging.info("Sync stopped")

    # -----------------------------------------------------------------------
    # Library snapshot (offline-first persistence)
    # -----------------------------------------------------------------------

    def _note_reachable(self):
        """Mark the server reachable. On an offline→online edge (was False),
        flush any save changes made while offline. No-op on the first-ever probe
        (was None) so startup doesn't masquerade as a reconnect."""
        was = self._online
        self._online = True
        self._probe_fail_streak = 0
        # The server answering proves the device has network too.
        self._device_online = True
        if was is False and self._auto_sync:
            try:
                logging.info("Server reachable again — flushing offline save changes")
                self._auto_sync.flush_after_reconnect()
            except Exception as e:
                logging.warning(f"Reconnect save flush failed: {e}")

    # Consecutive failed probes needed to declare the server unreachable. At the
    # loop's 25s cadence this is ~75s of silence — long enough to ride out a
    # download saturating the link, short enough that a real disconnect is
    # noticed before the user tries to browse.
    _PROBE_FAILS_TO_OFFLINE = 3

    def _reachability_loop(self):
        """Actively probe the server every ~25s and flip the connection state.

        This is the dependable offline/online detector: it does not rely on the
        frontend's navigator events (gamescope's embedded browser frequently
        doesn't emit them). Only runs the probe once we have an authenticated
        client — the retry loop owns (re)connecting from a cold/disconnected
        state. _note_reachable() handles the offline→online save flush.

        Going offline takes _PROBE_FAILS_TO_OFFLINE consecutive misses, not one.
        The probe competes with active downloads for the connection, so an
        isolated timeout says nothing about the server being down — and treating
        it as authoritative filtered the library to downloaded-only, which reads
        to the user as platforms vanishing at random.
        """
        while not self._stop_event.wait(25):
            try:
                if not (self._romm_client and self._romm_client.authenticated):
                    continue
                if self._romm_client.is_reachable():
                    self._note_reachable()
                elif self._online is not False:
                    self._probe_fail_streak += 1
                    if self._probe_fail_streak >= self._PROBE_FAILS_TO_OFFLINE:
                        self._online = False
                        logging.info(
                            f"Reachability probe failed {self._probe_fail_streak}× "
                            f"in a row — server unreachable, going offline")
                    else:
                        logging.debug(
                            f"Reachability probe failed "
                            f"({self._probe_fail_streak}/{self._PROBE_FAILS_TO_OFFLINE}) "
                            f"— staying online for now")
            except Exception as e:
                logging.debug(f"reachability loop error: {e}")

    def _probe_now(self):
        """One-shot reachability check, run off the 5-minute retry cadence.

        Triggered when the device's own network state changes (the frontend
        forwards navigator's online event) so recovery is near-instant instead
        of waiting for the next retry-loop tick. Reconnects if we were never
        authenticated, else does a cheap GET; _note_reachable() handles the
        offline→online flush. A failure latches _online False.
        """
        try:
            if self._romm_client and self._romm_client.authenticated:
                self._romm_client.get_collections(updated_after=self._last_full_fetch_time)
                self._note_reachable()
            elif self._connect_to_romm():
                self._note_reachable()
        except Exception as e:
            # Same debounce as _reachability_loop: a spurious navigator 'online'
            # event mid-session must not be able to knock a working session
            # offline on one failed request.
            self._probe_fail_streak += 1
            if self._probe_fail_streak >= self._PROBE_FAILS_TO_OFFLINE:
                self._online = False
                logging.info(f"Network probe failed, staying offline: {e}")
            else:
                logging.info(
                    f"Network probe failed "
                    f"({self._probe_fail_streak}/{self._PROBE_FAILS_TO_OFFLINE}), "
                    f"not latching offline yet: {e}")

    async def notify_network_state(self, online: bool):
        """Frontend bridge for the device's OS-level connectivity (navigator
        online/offline events). 'offline' is authoritative and instant — no
        network means the server is unreachable, so latch offline right away.
        'online' only means the LAN/internet is back, NOT that RomM is up, so we
        kick a background probe rather than assuming reachability.
        """
        try:
            self._device_online = bool(online)
            if not online:
                # No network on the device ⇒ the server is definitionally
                # unreachable too. Latch both.
                self._online = False
                logging.info("Device reports offline — latching offline (no_network)")
            else:
                logging.info("Device reports online — probing RomM")
                threading.Thread(target=self._probe_now, daemon=True,
                                 name="romm-net-probe").start()
            return {'success': True}
        except Exception as e:
            logging.debug(f"notify_network_state error: {e}")
            return {'success': False}

    # Cache the last rfkill probe so a 1.5s status poll while offline doesn't
    # spawn a subprocess on every tick. (result, monotonic_ts).
    _radio_probe_cache: tuple = (None, 0.0)

    def _wifi_radio_blocked(self):
        """Best-effort: is the wifi radio switched OFF (airplane mode / radio
        soft-or-hard block) as opposed to on-but-not-associated?

        Returns True if blocked, False if the radio is up, None if we can't
        tell (no tooling, parse failure). Only meaningful when the device is
        already known to be offline — it separates 'airplane_mode' from a
        'no_network' where wifi is on but joined to nothing. Cached ~3s.

        Shared by the Deck plugin (always Linux) and the desktop app (Linux via
        rfkill, Windows via netsh), so it dispatches on the platform.
        """
        cached, ts = Plugin._radio_probe_cache
        if time.monotonic() - ts < 3.0:
            return cached
        try:
            if sys.platform.startswith('win'):
                result = self._wifi_radio_blocked_windows()
            else:
                result = self._wifi_radio_blocked_rfkill()
        except Exception as e:
            logging.debug(f"radio probe failed: {e}")
            result = None
        Plugin._radio_probe_cache = (result, time.monotonic())
        return result

    def _wifi_radio_blocked_rfkill(self):
        """Linux radio state via rfkill. See _wifi_radio_blocked."""
        # -r raw, -n no headings: "<type> <soft> <hard>" per line.
        out = subprocess.run(
            ['rfkill', '--output', 'TYPE,SOFT,HARD', '-rn'],
            capture_output=True, text=True, timeout=2,
        )
        if out.returncode != 0:
            return None
        for line in out.stdout.splitlines():
            parts = line.split()
            if len(parts) >= 3 and parts[0] in ('wlan', 'wifi'):
                # Blocked if either soft or hard block is engaged.
                return 'blocked' in (parts[1], parts[2])
        return None

    def _wifi_radio_blocked_windows(self):
        """Windows radio state, locale-independent.

        Primary signal is the registry value Windows itself uses to track the
        airplane-mode master switch:

            HKLM\\SYSTEM\\CurrentControlSet\\Control\\RadioManagement
                \\SystemRadioState

        a REG_BINARY that is 0 when radios are enabled and non-zero when
        airplane mode is on. Reading it via the stdlib `winreg` needs no native
        dependency, no subprocess, and — crucially — no parsing of localized
        text, so it works the same on every Windows language. A non-zero value
        ⇒ blocked (True); zero ⇒ up (False); if the key is missing or
        unreadable we return None and the caller falls back to 'no_network'.
        """
        try:
            import winreg
        except Exception:
            return None
        try:
            with winreg.OpenKey(
                winreg.HKEY_LOCAL_MACHINE,
                r"SYSTEM\CurrentControlSet\Control\RadioManagement\SystemRadioState",
            ) as key:
                val, _ = winreg.QueryValueEx(key, "")  # default value
        except FileNotFoundError:
            return None
        except OSError as e:
            logging.debug(f"SystemRadioState read failed: {e}")
            return None
        # REG_BINARY comes back as bytes; older/edge cases may return an int.
        if isinstance(val, (bytes, bytearray)):
            return any(val)
        try:
            return bool(int(val))
        except (TypeError, ValueError):
            return None

    def _resume_begin(self, total, page_size):
        """Open a checkpoint for a fetch about to start, replaying any usable one.

        Returns {offset: rows} for pages an interrupted attempt already fetched.
        A checkpoint is only reused when it describes the same server, the same
        ROM count and the same page size — if any of those moved, the offsets no
        longer point at the same rows and replaying them would silently build a
        library out of two different servers or two different orderings.
        """
        url = self._settings.get('RomM', 'url') if self._settings else ''
        resumed = {}
        try:
            if resume_file.exists():
                with open(resume_file, 'r', encoding='utf-8') as f:
                    manifest = json.loads(f.readline() or '{}')
                age = time.time() - (manifest.get('started_at') or 0)
                usable = (manifest.get('schema') == RESUME_SCHEMA
                          and manifest.get('server_url') == url
                          and manifest.get('total') == total
                          and manifest.get('page_size') == page_size
                          and age < RESUME_TTL_SECONDS)
                if usable:
                    with open(resume_file, 'r', encoding='utf-8') as f:
                        f.readline()
                        for line in f:
                            line = line.strip()
                            if not line:
                                continue
                            try:
                                page = json.loads(line)
                            except json.JSONDecodeError:
                                # A line torn by a hard kill mid-append. Every
                                # page before it is still good, so stop here
                                # rather than discard the whole checkpoint.
                                logging.info("Resume checkpoint truncated; keeping "
                                             f"the {len(resumed)} complete pages")
                                break
                            if isinstance(page.get('rows'), list):
                                resumed[page['offset']] = page['rows']
                    if resumed:
                        logging.info(f"Resuming fetch: {len(resumed)} of "
                                     f"{-(-total // page_size)} pages already on disk")
                        self._resume_handle = open(resume_file, 'a', encoding='utf-8')
                        return resumed
                else:
                    logging.info("Resume checkpoint doesn't match this fetch; starting over")
        except Exception as e:
            logging.warning(f"Couldn't read resume checkpoint: {e}")
            resumed = {}

        try:
            resume_file.parent.mkdir(parents=True, exist_ok=True)
            handle = open(resume_file, 'w', encoding='utf-8')
            handle.write(json.dumps({'schema': RESUME_SCHEMA, 'server_url': url,
                                     'total': total, 'page_size': page_size,
                                     'started_at': time.time()}) + '\n')
            handle.flush()
            self._resume_handle = handle
        except Exception as e:
            logging.warning(f"Couldn't open resume checkpoint: {e}")
            self._resume_handle = None
        return {}

    def _resume_write_page(self, offset, rows):
        """Append one fetched page. Called from the fetch's worker threads."""
        handle = self._resume_handle
        if not handle:
            return
        line = json.dumps({'offset': offset, 'rows': rows}, separators=(',', ':')) + '\n'
        with self._resume_lock:
            handle.write(line)
            # Flushed per page: an unflushed buffer is exactly what a suspend or
            # a kill would take with it, which is the case this exists for.
            handle.flush()

    def _resume_finish(self):
        """Close and delete the checkpoint. Safe to call when there isn't one."""
        handle, self._resume_handle = self._resume_handle, None
        try:
            if handle:
                handle.close()
        except Exception:
            pass
        try:
            resume_file.unlink(missing_ok=True)
        except Exception as e:
            logging.warning(f"Couldn't remove resume checkpoint: {e}")

    def _clear_library_cache(self):
        """Drop every trace of the previous account's library, on disk and in
        memory, so the next login refetches from scratch.

        Without this, logging in as a different user on the same server hydrates
        the old user's games (the snapshot is keyed on server_url, not account)
        and — worse — the count probe in _connect_to_romm can match the stale
        server_total and skip the fetch entirely, pinning the wrong library.
        Best-effort: logout must succeed even if a file can't be removed."""
        self._resume_finish()
        try:
            snapshot_file.unlink(missing_ok=True)
        except Exception as e:
            logging.warning(f"Couldn't remove library snapshot: {e}")

        self._available_games = []
        self._romm_collections = None
        self._romm_virtual_collections = None
        self._platform_slug_to_name = {}
        self._server_firmware_cache = None
        self._snapshot_fetched_at = None
        self._library_server_total = None
        self._last_full_fetch_time = None
        self._library_progress = None
        self._announce_library = None
        # Signing in again means a first fetch again — a ~12s (or minutes) wait
        # the user will likely wander off during, which is exactly what the
        # one-shot announcement exists for. Re-arm it.
        try:
            if self._settings:
                self._settings.set('UI', 'library_announced', 'false')
        except Exception as e:
            logging.warning(f"Couldn't re-arm the library announcement: {e}")
        logging.info("Cleared cached library state")

    # Subfields any consumer actually reads off a rom's `files` entries and its
    # `_sibling_files` entries. Everything else RomM returns for them —
    # archive_members (31% of the files payload on its own), md5/sha1/crc
    # hashes, created_at/updated_at/last_modified, track_meta, full_path, plus
    # each sibling's own nested files/sibling_roms/rom_user/cover paths — is
    # never read and only inflates the snapshot, which is parsed in one gulp on
    # every cold start.
    #
    # These are PROJECTED, not dropped: both lists are searched library-wide by
    # the save-matching code in sync_core (which attributes a save to a rom by
    # matching disc/member filenames, and falls back destructively when it finds
    # nothing), so they must stay present and complete for every game.
    _SNAPSHOT_FILE_KEYS = ('file_name', 'fs_name', 'file_size_bytes', 'size_bytes')
    _SNAPSHOT_SIBLING_KEYS = ('id', 'name', 'fs_name', 'fs_name_no_ext', 'fs_extension')

    @staticmethod
    def _project(entries, keys):
        """Copy `entries`, keeping only `keys`. Non-dict entries pass through."""
        out = []
        for e in entries or []:
            if isinstance(e, dict):
                out.append({k: e[k] for k in keys if k in e})
            else:
                out.append(e)
        return out

    def _slim_for_snapshot(self, games):
        """Shallow-copy each game with its two fat lists projected down.

        Copies rather than mutating: `self._available_games` is the live
        library every RPC reads, and trimming it in place would strip fields
        out from under a session that is working perfectly well."""
        slim = []
        for g in games or []:
            if not isinstance(g, dict):
                slim.append(g)
                continue
            g2 = dict(g)
            rd = g2.get('romm_data')
            if isinstance(rd, dict) and rd.get('files'):
                rd = dict(rd)
                rd['files'] = self._project(rd['files'], self._SNAPSHOT_FILE_KEYS)
                g2['romm_data'] = rd
            if g2.get('_sibling_files'):
                g2['_sibling_files'] = self._project(
                    g2['_sibling_files'], self._SNAPSHOT_SIBLING_KEYS)
            slim.append(g2)
        return slim

    def _persist_snapshot(self):
        """Write-through the live library to disk so a cold start can hydrate it
        offline. Called after every successful fetch. Best-effort: never raises
        into the caller (a failed snapshot must not break a working session)."""
        try:
            url = self._settings.get('RomM', 'url') if self._settings else ''
            data = {
                'schema': SNAPSHOT_SCHEMA,
                'fetched_at': datetime.now(timezone.utc).isoformat(),
                'server_url': url,
                'games': self._slim_for_snapshot(self._available_games),
                # Ungrouped server count for the next connect's count probe.
                # Absent in snapshots written before this existed; hydrate reads
                # it as None and that connect simply fetches.
                'server_total': self._library_server_total,
                'collections': self._romm_collections or [],
                'virtual_collections': self._romm_virtual_collections or [],
                'platform_slug_to_name': self._platform_slug_to_name or {},
            }
            tmp = snapshot_file.with_suffix('.tmp')
            tmp.parent.mkdir(parents=True, exist_ok=True)
            with open(tmp, 'w', encoding='utf-8') as f:
                json.dump(data, f, separators=(',', ':'))
            tmp.rename(snapshot_file)
            logging.info(f"Persisted library snapshot ({len(data['games'])} games)")
        except Exception as e:
            logging.warning(f"Failed to persist library snapshot: {e}")

    # Coalescing window for _persist_snapshot_throttled, seconds.
    _SNAPSHOT_THROTTLE_S = 20

    def _persist_snapshot_throttled(self):
        """_persist_snapshot, but at most once per _SNAPSHOT_THROTTLE_S, with a
        trailing write so the last change is never lost.

        A collection sync finishes hundreds of downloads back to back and the
        snapshot is the whole library serialised — writing it per ROM would mean
        multi-megabyte rewrites in a tight loop. Coalescing keeps the disk quiet
        while still bounding how stale the file can get to one window.
        """
        with self._snapshot_timer_lock:
            now = time.monotonic()
            due = self._snapshot_last_write + self._SNAPSHOT_THROTTLE_S
            if now >= due:
                self._snapshot_last_write = now
                self._persist_snapshot()
                return
            # Inside the window: make sure a trailing write is pending so the
            # final download in a burst still reaches disk.
            if self._snapshot_timer is None or not self._snapshot_timer.is_alive():
                def _flush():
                    with self._snapshot_timer_lock:
                        self._snapshot_last_write = time.monotonic()
                        self._snapshot_timer = None
                    self._persist_snapshot()
                self._snapshot_timer = threading.Timer(max(0.0, due - now), _flush)
                self._snapshot_timer.daemon = True
                self._snapshot_timer.start()

    def _hydrate_from_snapshot(self):
        """Load the persisted snapshot into live state on cold start so the Game
        Browser populates before (or without) a network connection. Discards a
        snapshot from a different server or an incompatible schema. Returns the
        ISO fetched_at timestamp on success, else None."""
        try:
            if not snapshot_file.exists():
                return None
            with open(snapshot_file, 'r', encoding='utf-8') as f:
                data = json.load(f)
            if data.get('schema') != SNAPSHOT_SCHEMA:
                logging.info("Library snapshot schema mismatch; ignoring")
                return None
            configured_url = self._settings.get('RomM', 'url') if self._settings else ''
            if configured_url and data.get('server_url') and data['server_url'] != configured_url:
                logging.info("Library snapshot is for a different server; ignoring")
                return None
            self._available_games = data.get('games') or []
            # The snapshot's is_downloaded/local_path are only as fresh as the
            # last fetch that wrote it, and downloads land between fetches. A
            # stale 'false' made every game grabbed since the last fetch come
            # back un-downloaded after a restart — the user's files were still on
            # disk, but the app offered to download them again. The filesystem is
            # the authority here, so re-derive both on the way in. This also
            # picks up ROMs deleted outside the app.
            # Before reconciling: a snapshot written by an older build can hold
            # regional/disc variants as entries of their own, which is what put
            # the same game on screen twice. Fold them into their parent first so
            # the reconcile below runs over a clean library.
            self._absorb_variant_entries(self._available_games)
            self._reconcile_downloads(self._available_games)
            self._romm_collections = data.get('collections') or None
            self._romm_virtual_collections = data.get('virtual_collections') or None
            self._platform_slug_to_name = data.get('platform_slug_to_name') or {}
            self._snapshot_fetched_at = data.get('fetched_at')
            self._library_server_total = data.get('server_total')
            logging.info(f"Hydrated {len(self._available_games)} games from snapshot "
                         f"(fetched {self._snapshot_fetched_at})")
            return self._snapshot_fetched_at
        except Exception as e:
            logging.warning(f"Failed to hydrate library snapshot: {e}")
            return None

    def _reconcile_downloads(self, games):
        """Re-derive is_downloaded / local_path / local_size / disc info for
        `games` from what is actually on disk, in place.

        The library's download state is written by whichever fetch last ran, but
        downloads (and manual deletions) happen between fetches. Anything that
        restores a game list from a previous session has to re-check the disk or
        it will contradict it. Best-effort per game: an unreadable path just
        leaves that entry marked not-downloaded.
        """
        try:
            download_dir = Path(self._settings.get('Download', 'rom_directory',
                                                   _default_roms_dir())).expanduser()
        except Exception as e:
            logging.warning(f"Can't resolve download dir, skipping reconcile: {e}")
            return
        found = 0
        for g in (games or []):
            try:
                platform_slug = (g.get('platform_slug')
                                 or (g.get('romm_data') or {}).get('platform_slug')
                                 or 'Unknown')
                file_name = (g.get('file_name')
                             or (g.get('romm_data') or {}).get('fs_name'))
                if not file_name:
                    continue
                local_path, is_downloaded = _resolve_download_path(
                    download_dir, platform_slug, file_name)
                local_size = 0
                if is_downloaded and local_path.exists():
                    if local_path.is_dir():
                        local_size = sum(f.stat().st_size
                                         for f in local_path.rglob('*') if f.is_file())
                    else:
                        local_size = local_path.stat().st_size
                is_md, dc = _detect_multi_disc(local_path, is_downloaded)
                g['is_downloaded'] = is_downloaded
                g['local_path'] = str(local_path) if is_downloaded else None
                g['local_size'] = local_size
                g['is_multi_disc'] = is_md
                g['disc_count'] = dc
                # A game can be on the device under one of its other regions
                # rather than its own file. Re-check those against the disk too:
                # dropping them here would mark the game not-downloaded and
                # offer to fetch a region the user already has.
                variants = self._variant_downloads(g)
                if variants:
                    live = {str(vid): v for vid, v in variants.items()
                            if v.get('local_path')
                            and is_path_validly_downloaded(Path(v['local_path']))}
                    if live:
                        g['_variant_downloads'] = live
                        if not is_downloaded:
                            first = next(iter(live.values()))
                            g['is_downloaded'] = True
                            g['local_path'] = first['local_path']
                            is_downloaded = True
                    else:
                        g.pop('_variant_downloads', None)
                if is_downloaded:
                    found += 1
            except Exception as e:
                logging.debug(f"reconcile skipped {g.get('name')}: {e}")
        logging.info(f"Reconciled download state against disk: {found} downloaded")

    def _init_bios_tracking(self):
        """Stand up BIOS tracking against the current library.

        Shared by both connect paths — a fresh fetch and a snapshot the count
        probes proved still current — because either way we now hold the real
        library and the BIOS scan is driven off it.
        """
        # Without this the scan below logs "No RomM client or not authenticated"
        # once per platform and reports 0/0 ready, because BiosManager is built
        # before any client exists and nothing hands it one until a download.
        self._bios_manager()
        self._bios_tracking = BiosTrackingManager(
            retroarch=self._retroarch,
            romm_client=self._romm_client,
            collection_sync=self._collection_sync,  # May be None initially
            available_games_list=self._available_games,
            platform_slug_to_name=self._platform_slug_to_name,
            log_callback=lambda msg: logging.info(f"[BIOS] {msg}"),
        )
        # Returns immediately — it runs the scan on its own thread.
        self._bios_tracking.scan_library_bios()

    # Serializes connect attempts. The retry thread and the "device reports
    # online" probe both call _connect_to_romm(), and at startup both see an
    # unauthenticated client and go at once: two full logins, two library /
    # platform / collection fetches, two BIOS scans, and — worst — the second
    # REPLACES self._romm_client out from under the first. Observed cost was a
    # 4.6s connect where a single pass takes 0.15s.
    _connect_lock = threading.Lock()

    def _connect_to_romm(self):
        """Connect to RomM, load game list, and start AutoSyncManager.

        Serialized: a caller arriving while a connect is in flight waits for it
        and then reports that result instead of starting a second one."""
        with self._connect_lock:
            # The wait may itself have been the connect this caller wanted.
            if self._romm_client and self._romm_client.authenticated:
                return True
            return self._connect_to_romm_locked()

    def _connect_to_romm_locked(self):
        url      = self._settings.get('RomM', 'url')
        username = self._settings.get('RomM', 'username')
        password = self._settings.get('RomM', 'password')
        client_token = self._settings.get('RomM', 'client_token', '')
        remember     = self._settings.get('RomM', 'remember_credentials') == 'true'
        auto_connect = self._settings.get('RomM', 'auto_connect') == 'true'

        # A paired Client API Token is sufficient on its own (RomM's recommended
        # companion-app auth); otherwise fall back to stored username/password.
        if not (url and auto_connect and (client_token or (username and password and remember))):
            logging.info("Auto-connect disabled or credentials missing")
            self._connect_blocked = True
            return False

        self._connect_blocked = False
        try:
            logging.info(f"Connecting to RomM at {url}...")
            self._romm_client = RomMClient(url, username, password, client_token=client_token or None)
            if not self._romm_client.authenticated:
                logging.error("RomM authentication failed")
                return False

            # Initialize cover art manager for Steam grid images
            self._romm_client.cover_manager = CoverArtManager(self._settings, self._romm_client)

            # Update steam manager with cover manager
            if self._steam_manager:
                self._steam_manager.cover_manager = self._romm_client.cover_manager

            logging.info("Connected to RomM successfully")

            # Fetch and cache platform mappings (slug -> name)
            try:
                platforms = self._romm_client.get_platforms()
                self._platform_slug_to_name.clear()
                for platform in platforms:
                    slug = platform.get('slug')
                    name = platform.get('name')
                    if slug and name:
                        self._platform_slug_to_name[slug] = name
                logging.info(f"Cached {len(self._platform_slug_to_name)} platform mappings")
            except Exception as e:
                logging.warning(f"Failed to fetch platforms: {e}")

            # Cache collection list for zero-latency heartbeat rebuilds
            self._romm_collections = self._romm_client.get_collections()
            logging.info(f"Cached {len(self._romm_collections)} collections")

            # Virtual collections (autogenerated, browse/download only).
            try:
                self._romm_virtual_collections = self._romm_client.get_virtual_collections()
                logging.info(f"Cached {len(self._romm_virtual_collections)} virtual collections")
            except Exception as e:
                logging.warning(f"Failed to fetch virtual collections: {e}")
                self._romm_virtual_collections = []

            # Fetch ROM counts for already-disabled collections in background so
            # get_service_status() can show "X / Y ROMs locally" even after restart.
            threading.Thread(target=self._fetch_disabled_counts,
                             daemon=True, name="romm-disabled-counts").start()

            # Register this device with RomM so save-sync (the /negotiate engine)
            # has a device_id. Without it the session sync can't run and battery
            # saves never sync. Mirrors the GTK app's initialize_device().
            # Ahead of the library fetch on purpose: registration is one small
            # request, while the fetch below runs for minutes on a large library
            # — behind it, save-sync stays dead for that whole stretch.
            self._ensure_device_registered()

            # Load game list — unless the server provably still holds exactly
            # what we hydrated from the snapshot.
            #
            # A full fetch is ~3.0s per 500 ROMs and that cost is almost all
            # server-side response building: `fields` is ignored (RomM 5.1.0),
            # dropping file expansion saves 4%, deep offsets don't degrade, and
            # four workers only buy 1.27x before the server itself becomes the
            # contended resource. So there is no fetch strategy that makes a
            # 3k-ROM library cost less than ~15s, and a 30k one is minutes.
            # The only real win is not fetching.
            #
            # Two probes decide it, ~0.25s together:
            #   total unchanged      — catches adds and deletes
            #   0 rows since fetch   — catches an add+delete that nets to the
            #                          same total, and any in-place edit
            # Either probe returning None means the question is unanswered, and
            # we fetch. Manual refresh (force_full_refresh) bypasses all of this.
            skip_fetch = False
            total = None   # server ROM count, when the skip check happened to ask
            if (self._available_games and self._snapshot_fetched_at
                    and self._library_server_total is not None):
                total = self._romm_client.count_roms()
                if total is not None and total == self._library_server_total:
                    changed = self._romm_client.count_roms(
                        updated_after=self._snapshot_fetched_at)
                    skip_fetch = (changed == 0)

            if skip_fetch:
                logging.info(f"Library unchanged since {self._snapshot_fetched_at} "
                             f"({len(self._available_games)} games); skipping fetch")
                # The hydrated snapshot IS the current server state, so it counts
                # as a completed fetch — get_service_status reports library_ready
                # from this, and refresh_library uses it as its incremental base.
                self._last_full_fetch_time = self._snapshot_fetched_at
                self._init_bios_tracking()

            def _on_fetch_progress(kind, payload):
                if kind == 'loaded' and isinstance(payload, dict):
                    self._library_progress = payload

            if skip_fetch:
                roms_result = None
            else:
                try:
                    # Seed the total BEFORE fetching. Pages arrive whole and in
                    # parallel, so the count itself barely moves until they land
                    # — the number that actually helps from second zero is how
                    # big the job is. A count probe is ~0.05s, and `total` is
                    # already in hand when the skip check ran.
                    known_total = total if total is not None else self._romm_client.count_roms()
                    self._library_progress = {'loaded': 0, 'total': known_total or 0}
                    # Replay whatever an interrupted attempt already fetched. The
                    # page size has to match what _fetch_all_games_chunked will
                    # use, or the checkpoint is correctly rejected as mismatched.
                    resumed = (self._resume_begin(known_total, LIBRARY_PAGE_SIZE)
                               if known_total else {})
                    roms_result = self._romm_client.get_roms(
                        progress_callback=_on_fetch_progress,
                        trim_fields=ROM_TRIM_FIELDS,
                        resumed_pages=resumed,
                        page_sink=self._resume_write_page)
                    if not getattr(self._romm_client, 'last_fetch_incomplete', False):
                        # Only a whole library retires the checkpoint. An
                        # incomplete fetch keeps it, so the next attempt starts
                        # from the pages that did land.
                        self._resume_finish()
                finally:
                    # Always clear, including on failure: a stuck count is worse
                    # than no count, since the banner would claim progress that
                    # stopped happening.
                    self._library_progress = None
            if roms_result and len(roms_result) == 2:
                raw_games, server_total = roms_result
                # Ungrouped server count — see _library_server_total. A fetch
                # that dropped pages must NOT record it: the count would still
                # match the server on the next connect and nothing would have
                # been updated since, so the skip check would fire and pin a
                # short library in place permanently. None forces a real fetch
                # next time, which is the safe direction to be wrong in.
                incomplete = getattr(self._romm_client, 'last_fetch_incomplete', False)
                if incomplete:
                    logging.warning("Library fetch was incomplete — not caching the "
                                    "server count, so the next connect refetches")
                self._library_server_total = None if incomplete else server_total
                self._available_games.clear()
                download_dir = Path(self._settings.get('Download', 'rom_directory',
                                                        _default_roms_dir())).expanduser()
                for rom in raw_games:
                    platform_slug = rom.get('platform_slug', 'Unknown')
                    file_name     = rom.get('fs_name') or f"{rom.get('name', 'unknown')}.rom"
                    local_path, is_downloaded = _resolve_download_path(
                        download_dir, platform_slug, file_name)
                    local_size    = 0
                    if is_downloaded and local_path.exists():
                        if local_path.is_dir():
                            local_size = sum(f.stat().st_size
                                             for f in local_path.rglob('*') if f.is_file())
                        else:
                            local_size = local_path.stat().st_size
                    is_md = _detect_multi_disc(local_path, is_downloaded)
                    self._available_games.append({
                        'name':            Path(file_name).stem if file_name else rom.get('name', 'Unknown'),
                        # RomM's metadata title (e.g. "Mario Party 7") — used for
                        # display; 'name' stays the filename stem because the
                        # save-sync/local matching keys on it.
                        'display_name':    rom.get('name'),
                        'rom_id':          rom.get('id'),
                        'platform':        _platform_label(rom),
                        'platform_slug':   platform_slug,
                        'file_name':       file_name,
                        'is_downloaded':   is_downloaded,
                        'is_multi_disc':   is_md[0],
                        'disc_count':      is_md[1],
                        'local_path':      str(local_path) if is_downloaded else None,
                        'local_size':      local_size,
                        'cover_path': rom.get('path_cover_small'),
                        'cover_path_large': rom.get('path_cover_large'),
                        'created_at':      rom.get('created_at'),
                        # See _variant_count — must be taken here, while the
                        # grouped-away pieces are still on the row.
                        'variant_count':   (1 + len(rom.get('sibling_roms') or [])
                                            + len(rom.get('_region_save_siblings') or [])),
                        '_sibling_files':  rom.get('_sibling_files', []),
                        'sibling_roms':    rom.get('sibling_roms', []),
                        # Ids only — the pieces grouping dropped from
                        # sibling_roms (folder members / per-region ROMs). Kept
                        # so raw server rows can be folded back onto this entry;
                        # see _variant_parent_index.
                        '_region_variant_ids': [s.get('id') for s
                                                in (rom.get('_region_save_siblings') or [])
                                                if s.get('id')],
                        'romm_data': {
                            'fs_name':         rom.get('fs_name'),
                            'fs_name_no_ext':  rom.get('fs_name_no_ext'),
                            'fs_size_bytes':   rom.get('fs_size_bytes', 0),
                            'platform_id':     rom.get('platform_id'),
                            'platform_slug':   rom.get('platform_slug'),
                            # Member files (multi-disc / multi-FILE regional ROMs);
                            # the save-sync matcher maps a launched member back to
                            # this parent ROM. Requires with_files=true in get_roms.
                            'files':           rom.get('files', []),
                        },
                    })
                logging.info(f"Loaded {len(self._available_games)} games")

                # First successful library load ever gets a toast, because the
                # user very likely wandered out of the plugin during the ~12s
                # wait and nothing else would tell them it finished. Every load
                # after this one is silent: reconnects happen on every wake from
                # sleep, and a toast each time is noise that teaches people to
                # ignore the toasts that matter.
                if (self._settings.get('UI', 'library_announced', '') != 'true'
                        and not incomplete):
                    # Never announce a short library as ready — the count in the
                    # toast would be wrong and the user has no way to know.
                    # 'files' is the server's ungrouped ROM count, which is what
                    # the toast reports — it matches what RomM itself shows the
                    # user. Our own entry count is smaller because regional
                    # variants of a game collapse into one entry
                    # (_group_sibling_roms), and a completion toast quoting the
                    # smaller number just reads as games having gone missing.
                    self._announce_library = {'kind': 'ready',
                                              'games': len(self._available_games),
                                              'files': server_total}

                self._last_full_fetch_time = datetime.now(timezone.utc).isoformat()
                self._snapshot_fetched_at = self._last_full_fetch_time
                self._persist_snapshot()
                # Library is fetched on connect and on manual refresh (the reference
                # client's on-demand model) — no background polling.

                self._init_bios_tracking()

            # AutoSyncManager (save/state sync)
            if self._auto_sync is None:
                self._auto_sync = AutoSyncManager(
                    romm_client=self._romm_client,
                    retroarch=self._retroarch,
                    settings=self._settings,
                    log_callback=lambda msg: logging.info(f"[AUTO-SYNC] {msg}"),
                    get_games_callback=lambda: self._available_games,
                    parent_window=None,
                )
            else:
                self._auto_sync.romm_client = self._romm_client

            if self._settings.get('AutoSync', 'auto_enable_on_connect') == 'true':
                self._auto_sync.upload_enabled   = True
                self._auto_sync.download_enabled = True
                try:
                    upload_delay = int(self._settings.get('AutoSync', 'sync_delay', '3'))
                except (ValueError, TypeError):
                    upload_delay = 3
                self._auto_sync.upload_delay = upload_delay
                self._auto_sync.start_auto_sync()
                logging.info("Auto-sync (saves/states) enabled")
                # Collection sync runs in its own thread
                threading.Thread(target=self._init_collection_sync,
                                 daemon=True, name="romm-collection-init").start()

            return True

        except Exception as e:
            logging.error(f"Connection error: {e}", exc_info=True)
            return False

    def _init_collection_sync(self):
        """Create and start CollectionSyncManager from current settings."""
        if not (self._romm_client and self._romm_client.authenticated):
            return

        selected_str = self._settings.get('Collections', 'actively_syncing', '')
        if not selected_str:
            selected_str = self._settings.get('Collections', 'selected_for_sync', '')
        auto_sync_enabled = self._settings.get('Collections', 'auto_sync_enabled', 'false') == 'true'

        if not (selected_str and auto_sync_enabled):
            return

        try:
            sync_interval = int(self._settings.get('Collections', 'sync_interval', '120'))
        except (ValueError, TypeError):
            sync_interval = 120

        selected_collections = {c for c in selected_str.split('|') if c}
        logging.info(f"Starting collection sync for: {selected_collections}")
        self._collection_sync = CollectionSyncManager(
            romm_client=self._romm_client,
            settings=self._settings,
            selected_collections=selected_collections,
            sync_interval=sync_interval,
            available_games=self._available_games,
            log_callback=lambda msg: logging.info(f"[COLLECTION-SYNC] {msg}"),
            steam_manager=self._steam_manager,
        )
        self._collection_sync.start()

        # Update BIOS tracking manager's collection_sync reference
        if self._bios_tracking:
            self._bios_tracking.collection_sync = self._collection_sync

    def _fetch_disabled_counts(self):
        """Fetch ROM counts for collections that are not currently being auto-synced.

        Called once in a background thread on connect so that get_service_status()
        can show "X / Y ROMs locally" for disabled collections even after a restart.
        Only fetches collections not already in _disabled_collection_counts (avoids
        redundant calls if this runs more than once due to reconnect).
        """
        try:
            actively_syncing_str = self._settings.get('Collections', 'actively_syncing', '')
            actively_syncing = {c for c in actively_syncing_str.split('|') if c}

            for collection in (self._romm_collections or []):
                name   = collection.get('name', '')
                col_id = collection.get('id')
                if not (name and col_id):
                    continue
                if name in actively_syncing:
                    continue  # enabled — count comes from CollectionSyncManager cache
                if name in self._disabled_collection_counts:
                    continue  # already populated (e.g. from a live toggle this session)
                roms = self._romm_client.get_collection_roms(col_id)
                rom_ids = {r.get('id') for r in roms if r.get('id')}
                from romm_sync_engine.sync_core import CollectionSyncManager
                file_count = CollectionSyncManager._count_rom_files(roms)
                self._disabled_collection_counts[name] = {'rom_ids': rom_ids, 'total': file_count}
                logging.debug(f"Fetched disabled count for '{name}': {file_count} files ({len(roms)} ROMs)")
        except Exception as e:
            logging.error(f"_fetch_disabled_counts error: {e}", exc_info=True)

    def _retry_loop(self):
        """Connect on startup, then every 5 minutes refresh the collection list
        or retry the connection if disconnected. Uses updated_after for efficiency.

        On initial startup, retries every 15s until connected (handles DNS not
        ready after boot). Once connected, switches to 5-minute refresh interval.
        """
        connected = self._connect_to_romm()
        self._connection_attempted = True
        if connected:
            self._note_reachable()

        # If initial connection failed, retry quickly (DNS may not be ready yet)
        if not connected:
            for attempt in range(24):  # up to ~2 minutes of retries
                self._stop_event.wait(5)
                if self._stop_event.is_set():
                    break
                logging.info(f"Startup retry {attempt + 1}/24: attempting to connect...")
                if self._connect_to_romm():
                    logging.info("Startup retry succeeded")
                    break
            else:
                # Two minutes of retries and still nothing to show. Worth a toast
                # even though success after the first load isn't: an empty plugin
                # with no explanation is the case where the user has no idea
                # whether to wait, retry, or go check their server.
                if (not self._available_games
                        and self._settings.get('UI', 'library_announced', '') != 'true'):
                    self._announce_library = {'kind': 'failed'}

        while not self._stop_event.is_set():
            self._stop_event.wait(300)  # sleep 5 minutes (or until _stop_sync wakes us)
            if self._stop_event.is_set():
                break
            try:
                if self._romm_client and self._romm_client.authenticated:
                    # Use updated_after for efficient collection refresh if we have a timestamp
                    updated_after = self._last_full_fetch_time
                    # This GET is also our reachability probe: RomMClient.authenticated
                    # is sticky (a network drop never flips it), so a raised exception
                    # here is how we learn the server went away, and a success after a
                    # failure is how we learn it came back.
                    new_collections = self._romm_client.get_collections(updated_after=updated_after)
                    self._note_reachable()

                    if updated_after and new_collections:
                        # Merge updated collections with existing ones
                        existing_map = {c['id']: c for c in (self._romm_collections or [])}
                        for col in new_collections:
                            existing_map[col['id']] = col
                        self._romm_collections = list(existing_map.values())
                        logging.debug(f"5-min poll: merged {len(new_collections)} updated collections")
                    elif new_collections or not updated_after:
                        # Full refresh or first fetch
                        self._romm_collections = new_collections
                        logging.debug(f"5-min poll: loaded {len(new_collections)} collections")
                else:
                    logging.info("Attempting to reconnect to RomM...")
                    if self._connect_to_romm():
                        logging.info("Reconnected successfully")
                        self._note_reachable()
            except Exception as e:
                # Treat any failure in the connected branch as a reachability loss
                # so the next success triggers an offline→online flush.
                self._online = False
                logging.error(f"Retry loop error: {e}", exc_info=True)

        logging.info("Retry loop exited")

    # -----------------------------------------------------------------------
    # Public callables
    # -----------------------------------------------------------------------

    def _count_pending_saves(self):
        """Local save/state changes not yet reconciled with the server.

        Drives the offline sync-queue indicator ("N saves waiting to sync").
        Best-effort: 0 when auto-sync isn't up or anything goes wrong.
        """
        try:
            if self._auto_sync and hasattr(self._auto_sync, 'count_pending_saves'):
                return self._auto_sync.count_pending_saves()
        except Exception as e:
            logging.debug(f"_count_pending_saves failed: {e}")
        return 0

    async def get_pending_uploads(self):
        """Itemized list of local saves/states waiting to upload on reconnect.

        Backs the Downloads page's read-only upload queue. Groups by game, so it
        lines up with the pending_saves count in get_service_status. Best-effort:
        empty list when auto-sync isn't up or anything goes wrong.
        """
        try:
            if self._auto_sync and hasattr(self._auto_sync, 'list_pending_saves'):
                return self._auto_sync.list_pending_saves()
        except Exception as e:
            logging.debug(f"get_pending_uploads failed: {e}")
        return []

    async def get_service_status(self):
        """Build and return current sync status directly from live object state."""
        try:
            if not (self._retry_thread and self._retry_thread.is_alive()):
                return {
                    'status':           'stopped',
                    'message':          "Service stopped",
                    'details':          {},
                    'collections':      [],
                    'collection_count': 0,
                }

            # RomMClient.authenticated is sticky — a network drop never flips it —
            # so also consult the reachability latch (_online). When it has
            # explicitly latched False (the retry loop saw the server go away),
            # treat the session as not-connected so the offline-aware branch below
            # reports 'offline_cached' instead of a false 'online'. _online is None
            # until the first probe, which must NOT demote a healthy connection.
            connected = bool(self._romm_client and self._romm_client.authenticated
                             and self._online is not False)

            if not connected:
                # _connection_attempted becomes True once _connect_to_romm() finishes.
                # Before that we're still starting; after that we genuinely failed.
                # The frontend uses details.last_update to decide whether to show
                # the "not connected / retry" warning (same key as before).
                details = {'last_update': time.time()} if self._connection_attempted else {}
                # Tri-state for the offline-aware UI: if we have a hydrated/cached
                # library the user can still browse + launch downloaded games
                # ('offline_cached'); with nothing to show it's a true cold
                # 'disconnected'. Before the first attempt completes we're still
                # 'connecting'. 'connection' is additive — legacy keys unchanged.
                # Cause of the outage, so the UI can say "you're offline" vs
                # "can't reach the server". If the device itself reported no
                # network it's 'no_network'; otherwise the device has a network
                # but the RomM server isn't answering ('server_unreachable').
                if self._device_online is False:
                    # No connectivity — split "radio off (airplane / wifi
                    # disabled)" from "radio on but joined to no network" so
                    # the UI can tell the user what to actually toggle.
                    reason = 'airplane_mode' if self._wifi_radio_blocked() else 'no_network'
                else:
                    reason = 'server_unreachable'
                has_library = bool(self._available_games)
                if not self._connection_attempted or self._connect_blocked:
                    # Either the first attempt hasn't finished, or we deliberately
                    # made none (auto-connect off / not paired yet). Both are
                    # "not connected yet", never "the server is down" — the
                    # frontend suppresses lost-connection toasts on 'connecting'.
                    conn_state = 'connecting'
                    msg = "Connecting to RomM..."
                    reason = None
                elif has_library:
                    conn_state = 'offline_cached'
                    msg = ("Airplane mode is on" if reason == 'airplane_mode'
                           else "No internet connection" if reason == 'no_network'
                           else "Can't reach your RomM server")
                else:
                    conn_state = 'disconnected'
                    msg = ("Airplane mode is on" if reason == 'airplane_mode'
                           else "No internet connection" if reason == 'no_network'
                           else "Can't reach your RomM server")
                return {
                    'status':                  'running',
                    'connection':              conn_state,
                    'unreachable_reason':      reason,
                    # Present only while a full fetch is in flight, so the
                    # connecting banner can count up instead of repeating itself.
                    'library_progress':        self._library_progress,
                    'library_announcement':    self._announce_library,
                    'snapshot_fetched_at':     self._snapshot_fetched_at,
                    'pending_saves':           self._count_pending_saves(),
                    'message':                 msg,
                    'details':                 details,
                    'collections':             [],
                    'collection_count':        0,
                    'actively_syncing_count':  0,
                }

            # Auto-enable RetroArch settings if disabled (Option B: always-on approach)
            if self._retroarch:
                try:
                    network_ok, _ = self._retroarch.check_network_commands_config()
                    if not network_ok:
                        # Only claim it when it worked: this fails by design
                        # until RetroArch has written a retroarch.cfg, and the
                        # log said "Auto-enabled" on every poll regardless,
                        # which hid the fact that it never took. Launches carry
                        # the setting themselves via --appendconfig anyway.
                        ok, why = self._retroarch.enable_retroarch_setting('network_commands')
                        logging.info("Auto-enabled network commands" if ok
                                     else f"Network commands not enabled yet: {why}")

                    thumbnail_ok, _ = self._retroarch.check_savestate_thumbnail_config()
                    if not thumbnail_ok:
                        self._retroarch.enable_retroarch_setting('savestate_thumbnails')
                        logging.info("Auto-enabled save state thumbnails")
                except Exception as e:
                    logging.debug(f"Auto-enable settings error: {e}")

            # Build status directly from live in-memory objects — zero API calls,
            # always up-to-date, no race condition with a background thread.
            status = build_sync_status(
                romm_client=self._romm_client,
                collection_sync=self._collection_sync,
                auto_sync=self._auto_sync,
                available_games=self._available_games or [],
                known_collections=self._romm_collections,
                disabled_collection_counts=self._disabled_collection_counts,
                retroarch=self._retroarch,
                bios_tracking=self._bios_tracking,
                steam_manager=self._steam_manager,
            )

            game_count             = status.get('game_count', 0)
            collections            = status.get('collections', [])
            collection_count       = status.get('collection_count', 0)
            actively_syncing_count = status.get('actively_syncing_count', 0)
            bios_status            = status.get('bios_status', {})

            syncing_set = self._syncing_steam_collections or set()
            for col in collections:
                col['is_syncing_steam'] = col.get('name') in syncing_set

            # Show "Fetching games..." until initial fetch completes
            if self._last_full_fetch_time is None:
                message = "Fetching games..."
            else:
                message = f"{game_count} games, {collection_count} collections"

            return {
                'status':                  'connected',
                'connection':              'online',
                'unreachable_reason':      None,
                # True once the initial full library fetch has completed — the
                # frontend gates the post-update "reopen Home" on this so covers
                # don't fetch against a still-initializing backend.
                'library_ready':           self._last_full_fetch_time is not None,
                # Present only while a full fetch is in flight. It belongs in THIS
                # branch, not just the not-connected one: RomMClient authenticates
                # in its constructor, so we report 'online' from the first second
                # of a connect while the library fetch still has ~12s (much more on
                # a big library) to run. That window is exactly when the user needs
                # a number, and it used to have none.
                'library_progress':        self._library_progress,
                # One-shot; see _announce_library. Cleared via ack_library_announcement.
                'library_announcement':    self._announce_library,
                'game_count':              game_count,
                'snapshot_fetched_at':     self._snapshot_fetched_at,
                'pending_saves':           self._count_pending_saves(),
                'message':                 message,
                'details':                 status,
                'collections':             collections,
                'collection_count':        collection_count,
                'actively_syncing_count':  actively_syncing_count,
                'bios_status':             bios_status,
                'steam_available':         status.get('steam_available', False),
            }

        except Exception as e:
            logging.error(f"Status check error: {e}", exc_info=True)
            return {
                'status':           'error',
                'message':          f"Error: {str(e)[:50]}",
                'details':          {},
                'collections':      [],
                'collection_count': 0,
            }

    async def drain_notifications(self):
        """Return and clear queued notification events from the sync engine.

        The frontend polls this on its status tick and toasts each event
        verbatim. Events are produced at the exact moment a sync/removal
        happens (see CollectionSyncManager.push_notification), so there's no
        frontend-side diffing or transition inference.
        """
        try:
            if self._collection_sync:
                return {'events': self._collection_sync.drain_notifications()}
        except Exception as e:
            logging.debug(f"drain_notifications error: {e}")
        return {'events': []}

    async def get_recent_activity(self, limit: int = 10):
        """Recent plugin activity (downloads, syncs, save events) newest-first
        for the Settings ▸ Recent Activity feed. Persisted across restarts.

        'update' events are no longer recorded — the updater reports its own
        progress inline in Settings, so a "Restart to apply" row here just
        repeated it. Older logs may still hold some, so they are filtered out
        on read rather than left to age out."""
        try:
            if activity_log:
                # Over-fetch so dropping stale 'update' rows doesn't shorten the feed.
                events = [e for e in activity_log.get_recent(limit * 2)
                          if e.get('kind') != 'update']
                return {'events': events[:limit]}
        except Exception as e:
            logging.debug(f"get_recent_activity error: {e}")
        return {'events': []}

    async def clear_recent_activity(self):
        """Clear the persisted Recent Activity feed."""
        try:
            if activity_log:
                activity_log.clear()
            return {'success': True}
        except Exception as e:
            logging.debug(f"clear_recent_activity error: {e}")
            return {'success': False}

    async def refresh_from_romm(self, force_full_refresh: bool = False):
        """Refresh data from RomM server (collections and games).

        Uses updated_after parameter for efficient incremental updates unless
        force_full_refresh is True.

        Args:
            force_full_refresh: If True, fetch all data regardless of timestamps

        Returns:
            dict with status and updated game/collection info
        """
        try:
            if not (self._romm_client and self._romm_client.authenticated):
                return {
                    'success': False,
                    'message': 'Not connected to RomM',
                    'status': await self.get_service_status()
                }

            # Get current timestamp in ISO 8601 format with timezone
            current_time = datetime.now(timezone.utc).isoformat()

            # Determine whether to do incremental or full refresh
            use_incremental = (
                not force_full_refresh and
                self._last_full_fetch_time is not None
            )

            updated_after = self._last_full_fetch_time if use_incremental else None

            logging.info(f"Refreshing from RomM (incremental={use_incremental}, "
                        f"updated_after={updated_after})")

            # Fetch collections (with updated_after if available)
            new_collections = self._romm_client.get_collections(updated_after=updated_after)

            if use_incremental and new_collections:
                # Merge new collections with existing ones
                existing_map = {c['id']: c for c in (self._romm_collections or [])}
                for col in new_collections:
                    existing_map[col['id']] = col
                self._romm_collections = list(existing_map.values())
                logging.info(f"Incremental: merged {len(new_collections)} updated collections")
            elif new_collections or not use_incremental:
                # Full refresh or first fetch
                self._romm_collections = new_collections
                logging.info(f"Full refresh: loaded {len(new_collections)} collections")

            # Fetch ROMs
            if use_incremental:
                # Incremental fetch - only get updated ROMs
                new_roms_data = self._romm_client.get_roms(
                    limit=10000,  # High limit for incremental updates
                    offset=0,
                    updated_after=updated_after,
                    trim_fields=ROM_TRIM_FIELDS
                )

                if new_roms_data and len(new_roms_data) == 2:
                    new_roms, _ = new_roms_data

                    if new_roms:
                        # Update existing games list
                        download_dir = Path(self._settings.get('Download', 'rom_directory',
                                                                _default_roms_dir())).expanduser()

                        # Create a map for fast lookup by rom_id
                        existing_games_map = {g['rom_id']: g for g in self._available_games if 'rom_id' in g}

                        for rom in new_roms:
                            rom_id = rom.get('id')
                            platform_slug = rom.get('platform_slug', 'Unknown')
                            file_name = rom.get('fs_name') or f"{rom.get('name', 'unknown')}.rom"
                            local_path, is_downloaded = _resolve_download_path(
                                download_dir, platform_slug, file_name)
                            local_size = 0

                            if is_downloaded and local_path.exists():
                                if local_path.is_dir():
                                    local_size = sum(f.stat().st_size
                                                   for f in local_path.rglob('*') if f.is_file())
                                else:
                                    local_size = local_path.stat().st_size

                            game_data = {
                                'name': Path(file_name).stem if file_name else rom.get('name', 'Unknown'),
                                'display_name': rom.get('name'),
                                'rom_id': rom_id,
                                'platform': _platform_label(rom),
                                'platform_slug': platform_slug,
                                'file_name': file_name,
                                'is_downloaded': is_downloaded,
                                'local_path': str(local_path) if is_downloaded else None,
                                'local_size': local_size,
                                'cover_path': rom.get('path_cover_small'),
                                'cover_path_large': rom.get('path_cover_large'),
                                'romm_data': {
                                    'fs_name': rom.get('fs_name'),
                                    'fs_name_no_ext': rom.get('fs_name_no_ext'),
                                    'fs_size_bytes': rom.get('fs_size_bytes', 0),
                                    'platform_id': rom.get('platform_id'),
                                    'platform_slug': rom.get('platform_slug'),
                                    'files': rom.get('files', []),
                                },
                            }

                            # Update or add the game
                            existing_games_map[rom_id] = game_data

                        self._available_games = list(existing_games_map.values())
                        logging.info(f"Incremental: processed {len(new_roms)} updated ROMs, "
                                   f"total games: {len(self._available_games)}")
                    else:
                        logging.info("Incremental: no new/updated ROMs found")
            else:
                # Full refresh - fetch all games
                roms_result = self._romm_client.get_roms(trim_fields=ROM_TRIM_FIELDS)
                if roms_result and len(roms_result) == 2:
                    raw_games, server_total = roms_result
                    # Keep the count probe's baseline in step with what we just
                    # loaded, or the next connect compares against a stale total.
                    # None on an incomplete fetch, for the same reason as in
                    # _connect_to_romm: a cached count that matches the server
                    # while the library is short pins the short one forever.
                    self._library_server_total = (
                        None if getattr(self._romm_client, 'last_fetch_incomplete', False)
                        else server_total)
                    self._available_games.clear()
                    download_dir = Path(self._settings.get('Download', 'rom_directory',
                                                            _default_roms_dir())).expanduser()

                    for rom in raw_games:
                        platform_slug = rom.get('platform_slug', 'Unknown')
                        file_name = rom.get('fs_name') or f"{rom.get('name', 'unknown')}.rom"
                        local_path, is_downloaded = _resolve_download_path(
                            download_dir, platform_slug, file_name)
                        local_size = 0

                        if is_downloaded and local_path.exists():
                            if local_path.is_dir():
                                local_size = sum(f.stat().st_size
                                               for f in local_path.rglob('*') if f.is_file())
                            else:
                                local_size = local_path.stat().st_size

                        is_md = _detect_multi_disc(local_path, is_downloaded)

                        self._available_games.append({
                            'name':            Path(file_name).stem if file_name else rom.get('name', 'Unknown'),
                            'display_name':    rom.get('name'),
                            'rom_id':          rom.get('id'),
                            'platform':        _platform_label(rom),
                            'platform_slug':   platform_slug,
                            'file_name':       file_name,
                            'is_downloaded':   is_downloaded,
                            'is_multi_disc':   is_md[0],
                            'disc_count':      is_md[1],
                            'local_path':      str(local_path) if is_downloaded else None,
                            'local_size':      local_size,
                            'cover_path': rom.get('path_cover_small'),
                            'cover_path_large': rom.get('path_cover_large'),
                            '_sibling_files':  rom.get('_sibling_files', []),
                            'sibling_roms':    rom.get('sibling_roms', []),
                            '_region_variant_ids': [s.get('id') for s
                                                    in (rom.get('_region_save_siblings') or [])
                                                    if s.get('id')],
                            'romm_data': {
                                'fs_name': rom.get('fs_name'),
                                'fs_name_no_ext': rom.get('fs_name_no_ext'),
                                'fs_size_bytes': rom.get('fs_size_bytes', 0),
                                'platform_id': rom.get('platform_id'),
                                'platform_slug': rom.get('platform_slug'),
                                'files': rom.get('files', []),
                            },
                        })
                    logging.info(f"Full refresh: loaded {len(self._available_games)} games")

            if use_incremental:
                # An incremental merge never learns the server's total (the
                # response's `total` counts only the updated slice), and a stale
                # baseline would stop the next connect's probe from ever matching.
                # One extra probe is ~0.05s.
                probed = self._romm_client.count_roms()
                if probed is not None:
                    self._library_server_total = probed

            self._last_full_fetch_time = current_time
            self._snapshot_fetched_at = current_time
            # Write-through the freshly merged library so a later cold start /
            # offline session sees this data.
            self._persist_snapshot()

            # Get updated status
            status = await self.get_service_status()

            return {
                'success': True,
                'message': f"Refreshed: {status.get('message', '')}",
                'incremental': use_incremental,
                'status': status
            }

        except Exception as e:
            # Passive reachability latch: a real server call just failed, so the
            # server is unreachable even though authenticated is still sticky-true.
            # Catches the "on Wi-Fi but RomM is down" case the OS can't see.
            self._online = False
            logging.error(f"refresh_from_romm error: {e}", exc_info=True)
            return {
                'success': False,
                'message': f'Refresh failed: {str(e)[:100]}',
                'status': await self.get_service_status()
            }

    async def toggle_collection_sync(self, collection_name: str, enabled: bool):
        """Enable or disable auto-sync for a specific collection."""
        try:
            import configparser
            ini_path = CONFIG_DIR / 'settings.ini'
            if not ini_path.exists():
                logging.error("Settings file not found")
                return False

            config = configparser.ConfigParser()
            config.read(ini_path)
            if not config.has_section('Collections'):
                config.add_section('Collections')

            actively_syncing = config.get('Collections', 'actively_syncing', fallback='')
            sync_set = {c for c in actively_syncing.split('|') if c}

            if enabled:
                sync_set.add(collection_name)
                logging.info(f"Enabling auto-sync for: {collection_name}")
                # Clear any stale disabled-count so build_sync_status uses live cache
                self._disabled_collection_counts.pop(collection_name, None)

                # Trigger BIOS downloads for this collection's platforms
                if self._bios_tracking:
                    self._bios_tracking.download_for_collection(collection_name)
            else:
                sync_set.discard(collection_name)
                logging.info(f"Disabling auto-sync for: {collection_name}")
                # Snapshot rom_ids from cache so build_sync_status can compute
                # downloaded dynamically (stays accurate as _available_games updates)
                if self._collection_sync:
                    rom_ids = self._collection_sync.collection_caches.get(collection_name, set())
                    file_counts = getattr(self._collection_sync, 'collection_file_counts', {})
                    self._disabled_collection_counts[collection_name] = {
                        'rom_ids': set(rom_ids),
                        'total':   file_counts.get(collection_name, len(rom_ids)),
                    }

            config.set('Collections', 'actively_syncing',  '|'.join(sorted(sync_set)))
            config.set('Collections', 'selected_for_sync', '|'.join(sorted(sync_set)))
            config.set('Collections', 'auto_sync_enabled', 'true' if sync_set else 'false')

            with open(ini_path, 'w') as f:
                config.write(f)

            # Update in-memory settings so the heartbeat sees the change immediately
            if self._settings:
                self._settings.load_settings()

            # When disabling collection sync, also disable Steam sync if it was active
            if not enabled and self._steam_manager and self._steam_manager.is_available():
                steam_collections = self._steam_manager.get_steam_sync_collections()
                if collection_name in steam_collections:
                    import asyncio
                    try:
                        asyncio.create_task(
                            self.toggle_collection_steam_sync(collection_name, False)
                        )
                        logging.info(f"Steam sync disabled for: {collection_name} (collection sync turned off)")
                    except Exception as e:
                        logging.warning(f"Could not disable Steam sync: {e}")

            # Update collection sync directly — no trigger file needed
            if self._collection_sync:
                if sync_set:
                    self._collection_sync.update_collections(sync_set)
                else:
                    # Detach immediately so get_service_status() sees no active sync,
                    # then stop the worker thread in the background (avoids blocking
                    # on join while check_for_changes() finishes its API call).
                    old_sync = self._collection_sync
                    self._collection_sync = None
                    # Update BIOS tracking manager's collection_sync reference
                    if self._bios_tracking:
                        self._bios_tracking.collection_sync = None
                    threading.Thread(
                        target=old_sync.stop,
                        daemon=True,
                        name="romm-collection-stop",
                    ).start()
            elif enabled and self._romm_client and self._romm_client.authenticated:
                # First collection enabled — create CollectionSyncManager now
                threading.Thread(target=self._init_collection_sync,
                                 daemon=True, name="romm-collection-init").start()

            # No status patching needed — get_service_status() builds status
            # on-demand from live objects, so the next frontend poll is always fresh.
            return True

        except Exception as e:
            logging.error(f"toggle_collection_sync error: {e}", exc_info=True)
            return False

    async def delete_collection_roms(self, collection_name: str, mode: str = 'collection'):
        """Delete all local ROM files for a group (collection or platform).

        Local-only: removes downloaded files under the download dir. It never
        touches the RomM server. toggle_collection_sync already handled
        settings + sync object updates before this is called (collections
        only), so this method only does the file deletion. Uses the existing
        authenticated client and in-memory caches to avoid redundant API calls.
        """
        try:
            import shutil
            logging.info(f"Starting ROM deletion for {mode}: {collection_name}")

            download_dir = Path(self._settings.get('Download', 'rom_directory',
                                                    _default_roms_dir())).expanduser()
            if not download_dir.exists():
                logging.info(f"Download directory not found, nothing to delete: {download_dir}")
                return True

            # Platform groups aren't tracked by CollectionSyncManager — delete
            # straight from the in-memory game list (keyed by resolved platform
            # name, matching get_library_games).
            if mode == 'platform':
                deleted_count = 0
                for game in (self._available_games or []):
                    if self._platform_name_for(game) != collection_name:
                        continue
                    if not game.get('is_downloaded') or not game.get('local_path'):
                        continue
                    rom_path = Path(game['local_path'])
                    if rom_path.exists():
                        try:
                            if rom_path.is_file():
                                rom_path.unlink()
                            else:
                                shutil.rmtree(rom_path)
                            deleted_count += 1
                            logging.info(f"  Deleted: {rom_path}")
                        except Exception as e:
                            logging.error(f"  Failed to delete {rom_path}: {e}")
                    game['is_downloaded'] = False
                    game['local_path'] = None
                logging.info(f"Deleted {deleted_count} ROM(s) from platform '{collection_name}'")
                return True

            # Use the already-authenticated client — no new login needed
            client = self._romm_client
            if not client or not client.authenticated:
                logging.error("RomM client not available for ROM deletion")
                return False

            # Get collection ID from cached collection list
            collection_id = None
            for col in (self._romm_collections or []):
                if col.get('name') == collection_name:
                    collection_id = col.get('id')
                    break

            if collection_id is None:
                logging.error(f"Collection '{collection_name}' not found in status")
                return False

            # Fetch ROM list for this collection (need fs_name / platform_slug for paths)
            collection_roms = client.get_collection_roms(collection_id)
            logging.info(f"Fetched {len(collection_roms)} ROMs for '{collection_name}'")

            # Protect ROMs shared with other still-synced collections.
            # Use collection_caches (in-memory) — no extra API calls needed.
            protected_rom_ids: set = set()
            if self._collection_sync:
                for other_name, rom_ids in self._collection_sync.collection_caches.items():
                    if other_name != collection_name:
                        protected_rom_ids.update(rom_ids)
                        logging.info(f"  Protecting {len(rom_ids)} ROM(s) from '{other_name}'")

            deleted_count = 0
            skipped_count = 0
            deleted_rom_ids: set = set()
            for rom in collection_roms:
                rom_id        = rom.get('id')
                platform_slug = rom.get('platform_slug', '')
                file_name     = rom.get('fs_name') or rom.get('file_name', '')
                if not (platform_slug and file_name):
                    continue
                if rom_id and rom_id in protected_rom_ids:
                    skipped_count += 1
                    continue
                rom_path = download_dir / platform_slug / file_name
                if rom_path.exists():
                    try:
                        if rom_path.is_file():
                            rom_path.unlink()
                        else:
                            shutil.rmtree(rom_path)
                        deleted_count += 1
                        if rom_id:
                            deleted_rom_ids.add(rom_id)
                        logging.info(f"  Deleted: {rom_path}")
                    except Exception as e:
                        logging.error(f"  Failed to delete {rom_path}: {e}")

            # Mark deleted ROMs as not downloaded in available_games so the
            # dynamic count in build_sync_status drops to 0 immediately.
            # We keep the _disabled_collection_counts entry so the UI shows
            # "0 / N ROMs locally" rather than "Auto-sync disabled".
            if deleted_rom_ids and self._available_games:
                for game in self._available_games:
                    if game.get('rom_id') in deleted_rom_ids:
                        game['is_downloaded'] = False
                        game['local_path']    = None

            logging.info(f"Deleted {deleted_count} ROM(s) from '{collection_name}' "
                         f"({skipped_count} skipped, shared with other collections)")
            return True

        except Exception as e:
            logging.error(f"delete_collection_roms error: {e}", exc_info=True)
            return False

    async def get_config(self):
        """Get current RomM configuration (never returns the raw password)."""
        try:
            if not SYNC_CORE_AVAILABLE:
                return {'configured': False, 'error': 'sync_core not available'}
            settings = SettingsManager()
            url      = settings.get('RomM', 'url')
            username = settings.get('RomM', 'username')
            has_password = bool(settings.get('RomM', 'password'))
            has_token = bool(settings.get('RomM', 'client_token'))  # set by pair_device

            rom_directory  = settings.get('Download', 'rom_directory')
            save_directory = settings.get('Download', 'save_directory')
            bios_directory = settings.get('BIOS', 'custom_path', '')

            _default_rom  = _default_roms_dir()
            _default_save = str(_paths.library_dir() / 'saves')
            retrodeck  = detect_retrodeck()
            needs_save = False
            if retrodeck:
                if not rom_directory or rom_directory == _default_rom:
                    rom_directory = retrodeck['rom_directory']
                    needs_save    = True
                if not save_directory or save_directory == _default_save:
                    save_directory = retrodeck['save_directory']
                    needs_save     = True
                if not bios_directory:
                    bios_directory = str(Path.home() / 'retrodeck' / 'bios')
                    settings.set('BIOS', 'custom_path', bios_directory)
                    needs_save = True
            if needs_save:
                settings.set('Download', 'rom_directory',  rom_directory)
                settings.set('Download', 'save_directory', save_directory)
                logging.info(f"Auto-configured RetroDECK paths: ROMs={rom_directory}, "
                             f"saves={save_directory}, BIOS={bios_directory}")

            # Still no BIOS path (no custom setting, no RetroDECK): fall back to
            # RetroArch's own system/BIOS directory. bios_manager already probed
            # every common install layout (native, Flatpak, Steam, Snap, AppImage)
            # at startup, so reuse that result. RetroDECK above takes priority.
            # Just a suggestion for the wizard — not persisted; save_config writes
            # whatever the user confirms.
            if not bios_directory and self._retroarch \
                    and getattr(self._retroarch, 'bios_manager', None) \
                    and self._retroarch.bios_manager.system_dir:
                bios_directory = str(self._retroarch.bios_manager.system_dir)

            # Last resort: where the detected emulator WILL look, existing yet or
            # not. bios_manager only reports directories already on disk, so a
            # freshly installed RetroArch (nothing has run, no system/ dir) answers
            # "nowhere" — and the setup wizard then showed an empty BIOS field and
            # saved '' for it, while Settings showed the right path because it reads
            # expected_paths from emulator_status. Same source, same answer.
            if not bios_directory and self._retroarch \
                    and hasattr(self._retroarch, 'expected_bios_dir'):
                try:
                    bios_directory = self._retroarch.expected_bios_dir() or ''
                except Exception as e:
                    logging.debug(f"expected_bios_dir: {e}")

            import socket
            try:
                hostname = socket.gethostname() or 'SteamOS'
            except Exception:
                hostname = 'SteamOS'

            ds = load_decky_settings()
            needs_onboarding = ds.get('needs_onboarding', False)

            # Self-heal: once we have working credentials (password auth or a
            # paired token), onboarding is complete. Clear a stale flag so the
            # setup wizard can never trap the user on the "Get Started" panel.
            has_creds = bool(url and ((username and has_password) or has_token))
            if has_creds and needs_onboarding:
                ds.pop('needs_onboarding', None)
                save_decky_settings(ds)
                needs_onboarding = False

            return {
                'url':                url,
                'username':           username,
                'has_password':       has_password,
                'rom_directory':      rom_directory,
                'save_directory':     save_directory,
                'bios_directory':     bios_directory,
                'device_name':        settings.get('Device', 'device_name'),
                'device_name_default': hostname,
                # Configured if we have either password auth OR a paired client
                # token — pairing stores only a token (no username/password), so
                # requiring a password would wrongly keep the setup wizard
                # re-opening after a successful pair.
                'configured':         bool(url and ((username and has_password) or has_token)) and not needs_onboarding,
                'retrodeck_detected': retrodeck is not None,
            }
        except Exception as e:
            logging.error(f"get_config error: {e}", exc_info=True)
            return {'configured': False, 'error': str(e)}

    async def save_config(self, url: str, username: str, password: str,
                          rom_directory: str, save_directory: str, device_name: str,
                          bios_directory: str = ''):
        """Save RomM configuration and restart sync to pick up new settings."""
        try:
            if not SYNC_CORE_AVAILABLE:
                return {'success': False, 'error': 'sync_core not available'}
            settings = SettingsManager()
            settings.set('RomM', 'url',      url.strip().rstrip('/'))
            settings.set('RomM', 'username', username.strip())
            if password:
                settings.set('RomM', 'password', password)
            settings.set('RomM', 'remember_credentials', 'true')
            settings.set('RomM', 'auto_connect',         'true')
            if rom_directory:
                settings.set('Download', 'rom_directory',  rom_directory.strip())
            if save_directory:
                settings.set('Download', 'save_directory', save_directory.strip())
            if device_name:
                settings.set('Device', 'device_name', device_name.strip())
            settings.set('BIOS', 'custom_path', bios_directory.strip() if bios_directory else '')

            ds = load_decky_settings()
            ds.pop('needs_onboarding', None)
            save_decky_settings(ds)

            self._stop_sync()
            time.sleep(0.5)
            self._start_sync()
            _record_activity('account', 'Signed in', url.strip().rstrip('/'))
            return {'success': True}
        except Exception as e:
            logging.error(f"save_config error: {e}", exc_info=True)
            return {'success': False, 'error': str(e)}

    async def set_library_paths(self, rom_directory: str = None,
                                save_directory: str = None,
                                bios_directory: str = None,
                                emulator_path: str = None):
        """Change one or more library folders, without touching anything else.

        save_config() is the wizard's method: it rewrites credentials, clears the
        onboarding flag and records a "Signed in" activity event. Editing a single
        folder from Settings must do none of that, hence a setter of its own. Only
        arguments that are not None are written, so '' is a meaningful value —
        it clears an override and restores auto-detection.
        """
        try:
            if not SYNC_CORE_AVAILABLE:
                return {'success': False, 'message': 'sync_core not available'}
            fields = (
                ('Download', 'rom_directory', rom_directory),
                ('Download', 'save_directory', save_directory),
                ('BIOS', 'custom_path', bios_directory),
                ('RetroArch', 'custom_path', emulator_path),
            )
            changed = []
            for section, key, value in fields:
                if value is None:
                    continue
                value = value.strip()
                if self._settings.get(section, key, '') == value:
                    continue
                self._settings.set(section, key, value)
                changed.append(f'{section}.{key}')
            if not changed:
                status = self._retroarch.emulator_status() if self._retroarch else {}
                return {'success': True, 'changed': [], **status}

            logging.info(f"Library paths changed: {changed}")   # set() persists
            # Save/state watchers were bound to the old directories, and cores /
            # BIOS discovery ran against the old emulator path — the same restart
            # save_config and repair_emulator_paths do after touching these.
            self._stop_sync()
            time.sleep(0.5)
            self._start_sync()
            # _start_sync normally rebuilds _retroarch with a fresh
            # SettingsManager, but it early-returns if the retry thread is still
            # alive — and a RetroArchInterface caches its own settings instance,
            # so the status we return would then still describe the OLD paths.
            # Re-read explicitly rather than depending on that path.
            ra = self._retroarch
            status = {}
            if ra:
                try:
                    ra.settings.load_settings()
                except Exception:
                    pass
                # A save folder is only half a decision — RetroArch has to be
                # told, or it keeps writing next to the ROM.
                if save_directory is not None:
                    try:
                        ra.align_retroarch_config()
                    except Exception as e:
                        logging.warning(f"could not point RetroArch at the save folder: {e}")
                status = ra.refresh_installation()
            return {'success': True, 'changed': changed, **status}
        except Exception as e:
            logging.error(f"set_library_paths error: {e}", exc_info=True)
            return {'success': False, 'message': str(e)}

    async def test_connection(self, url: str, username: str, password: str):
        """Test connection to RomM with the given credentials."""
        try:
            if not SYNC_CORE_AVAILABLE:
                return {'success': False, 'message': 'sync_core not available'}

            actual_password = password
            if not actual_password:
                settings        = SettingsManager()
                actual_password = settings.get('RomM', 'password')
            if not actual_password:
                return {'success': False, 'message': 'Password is required to test the connection.'}

            client = RomMClient(url.strip().rstrip('/'), username.strip(), actual_password)
            if client.authenticated:
                collections = client.get_collections()
                return {
                    'success':     True,
                    'message':     f'Connected! Found {len(collections)} collection(s).',
                    'collections': [{'id': c.get('id'), 'name': c.get('name', '')}
                                    for c in collections],
                }
            else:
                return {'success': False,
                        'message': 'Authentication failed — check URL, username and password.'}
        except Exception as e:
            logging.error(f"test_connection error: {e}", exc_info=True)
            return {'success': False, 'message': f'Connection error: {str(e)[:150]}'}

    async def get_account_username(self):
        """Return the human-readable RomM account name for the connected user,
        fetched live from /api/users/me. Used by the in-app Settings page so it
        never displays a stored credential/token. Empty string when offline.

        'connected' separates "there is no account to show" from "we can't
        answer yet". On a cold launch this RPC can land before
        _connect_to_romm() has finished its login round-trip, and the old
        unconditional {'username': ''} made the caller read that as signed out
        — it painted "Guest"/"G" and threw away the cached identity, which is
        what made the *next* launch slow too. Only connected:True licenses the
        caller to treat an empty username as a real signed-out state."""
        try:
            client = self._romm_client
            if client is None or not getattr(client, 'authenticated', False):
                # _connect_blocked means auto-connect is off or credentials are
                # missing: nobody is coming, so this genuinely is signed out.
                return {'username': '', 'connected': bool(self._connect_blocked)}
            user = client.get_current_user() or {}
            name = user.get('username') or user.get('display_name') or ''
            return {
                'username': name,
                'role': user.get('role') or '',
                'avatar_path': user.get('avatar_path') or '',
                'updated_at': user.get('updated_at') or '',
                'connected': True,
            }
        except Exception as e:
            logging.error(f"get_account_username error: {e}")
            return {'username': '', 'connected': False}

    async def get_avatar(self):
        """Return the connected user's RomM avatar as a base64 data URI, or
        {'data_uri': None} when the user has none / offline.

        Fetched raw (NOT through get_image's thumbnailing pipeline): avatars are
        small and may be transparent PNGs, and re-encoding them to JPEG would
        strip alpha and add artifacts.

        RomM 5.0's v2 UI serves user avatars at /api/users/<id>/avatar (see
        frontend/src/v2/utils/userAvatar.ts), cache-busted by updated_at — NOT
        the legacy /api/raw/assets/<avatar_path> static mount, which returns a
        blank/404 on 5.x and was why the avatar silently fell back to the
        initial. Logs the HTTP status on miss so a wrong path is diagnosable."""
        return await asyncio.to_thread(self._get_avatar_blocking)

    def _get_avatar_blocking(self):
        try:
            import base64
            client = self._romm_client
            if client is None or not getattr(client, 'authenticated', False):
                return {'data_uri': None}
            user = client.get_current_user() or {}
            uid = user.get('id')
            ap = (user.get('avatar_path') or '').strip()
            # RomM returns the default avatar when avatar_path is empty; skip the
            # round-trip and let the frontend draw its own initial fallback.
            if not uid or not ap:
                return {'data_uri': None}
            ts = user.get('updated_at') or ''
            ck = ('avatar', uid, ap, ts)
            hit = self._cover_cache_get(ck)
            if hit is not None:
                return {'data_uri': hit}
            url = urljoin(client.base_url, f"/api/users/{uid}/avatar")
            params = {'ts': ts} if ts else None
            resp = client.session.get(url, params=params, timeout=15)
            if resp.status_code != 200 or not resp.content:
                logging.warning(f"get_avatar: {url} -> {resp.status_code} "
                                f"({len(resp.content or b'')} bytes)")
                return {'data_uri': None}
            mime = resp.headers.get('content-type') or \
                mimetypes.guess_type(ap)[0] or 'image/png'
            uri = f"data:{mime};base64,{base64.b64encode(resp.content).decode('ascii')}"
            self._cover_cache_put(ck, uri)
            return {'data_uri': uri}
        except Exception as e:
            logging.error(f"get_avatar error: {e}", exc_info=True)
            return {'data_uri': None}

    async def get_plugin_stats(self):
        """Plugin-local stats for the user-menu Stats page. Computed live from
        in-memory state (no API calls): library size, what's downloaded on this
        device, disk usage, platforms, and collection sync state."""
        try:
            games = self._available_games or []
            downloaded = [g for g in games if g.get('is_downloaded')]
            size_on_disk = sum(int(g.get('local_size') or 0) for g in downloaded)
            platforms = {g.get('platform_slug') for g in games if g.get('platform_slug')}

            # Per-platform breakdown for the Platforms section. rom_count is the
            # library total for the platform; fs_size_bytes is the on-disk size of
            # its downloaded games, so the bars/percentages reflect disk usage
            # (consistent with the Size-on-disk summary total).
            plat_map = {}
            for g in games:
                slug = (g.get('platform_slug')
                        or (g.get('romm_data') or {}).get('platform_slug')
                        or 'unknown')
                p = plat_map.setdefault(slug, {
                    'slug': slug,
                    'fs_slug': slug,
                    'name': self._platform_name_for(g),
                    'rom_count': 0,
                    'downloaded': 0,
                    'fs_size_bytes': 0,
                })
                p['rom_count'] += _variant_count(g)
                if g.get('is_downloaded'):
                    p['downloaded'] += 1
                    p['fs_size_bytes'] += int(g.get('local_size') or 0)
            platforms_breakdown = sorted(
                plat_map.values(), key=lambda p: p['fs_size_bytes'], reverse=True)

            collections_total = 0
            collections_synced = 0
            try:
                if self._romm_client and self._romm_client.authenticated:
                    status = build_sync_status(
                        romm_client=self._romm_client,
                        collection_sync=self._collection_sync,
                        auto_sync=self._auto_sync,
                        available_games=games,
                        known_collections=self._romm_collections,
                        disabled_collection_counts=self._disabled_collection_counts,
                        retroarch=self._retroarch,
                        bios_tracking=self._bios_tracking,
                        steam_manager=self._steam_manager,
                    )
                    cols = status.get('collections', [])
                    collections_total = len(cols)
                    collections_synced = sum(
                        1 for c in cols
                        if c.get('auto_sync') or c.get('sync_state') == 'synced'
                    )
            except Exception as e:
                logging.debug(f"get_plugin_stats collections error: {e}")

            return {
                # ROM count, matching what RomM reports — not our collapsed
                # entry count. games_downloaded stays an entry count on purpose:
                # a grouped folder ROM is one thing on disk, and counting its
                # members would make "downloaded" exceed what was downloaded.
                'games_total':         sum(_variant_count(g) for g in games),
                'games_downloaded':    len(downloaded),
                'size_on_disk':        size_on_disk,
                'platforms':           len(platforms),
                'collections_total':   collections_total,
                'collections_synced':  collections_synced,
                'platforms_breakdown': platforms_breakdown,
            }
        except Exception as e:
            logging.error(f"get_plugin_stats error: {e}", exc_info=True)
            return {
                'games_total': 0, 'games_downloaded': 0, 'size_on_disk': 0,
                'platforms': 0, 'collections_total': 0, 'collections_synced': 0,
                'platforms_breakdown': [],
            }

    async def get_logging_enabled(self):
        try:
            return load_decky_settings().get('logging_enabled', True)
        except Exception as e:
            logging.error(f"get_logging_enabled error: {e}")
            return True

    async def get_retrodeck_button_enabled(self):
        """Whether the Game Browser shows the 'Launch RetroDECK' header button.
        Defaults off; only meaningful when RetroDECK is actually installed."""
        try:
            return load_decky_settings().get('retrodeck_button_enabled', False)
        except Exception as e:
            logging.error(f"get_retrodeck_button_enabled error: {e}")
            return False

    async def set_retrodeck_button_enabled(self, enabled: bool):
        try:
            settings = load_decky_settings()
            settings['retrodeck_button_enabled'] = bool(enabled)
            return save_decky_settings(settings)
        except Exception as e:
            logging.error(f"set_retrodeck_button_enabled error: {e}")
            return False

    # Disc-image extensions whose presence in an archive means RetroArch can't
    # boot it compressed: a .cue references sibling .bins, disc sets are
    # multi-file, and .chd/.iso/etc. are what disc cores expect on disk. This is
    # the real "needs extraction" signal — it's a property of the CONTENT, not
    # the core (block_extract lives inside the core binary, not any readable
    # metadata), so peeking the archive is both simpler and more accurate than
    # maintaining a core/platform table.
    _DISC_IMAGE_EXTS = ('.cue', '.bin', '.iso', '.chd', '.gdi', '.cdi',
                        '.mdf', '.nrg', '.ccd', '.img', '.pbp')

    def _archive_needs_extract(self, archive_path: Path) -> bool:
        """True when this archive must be unpacked for RetroArch to launch it.

        RetroArch's built-in zip loading only handles a SINGLE member with a
        core-supported extension; it can't follow a .cue to its .bins or pick
        one file out of a disc set. So we extract when the archive holds a
        disc-image file, or more than one launchable file — and leave a lone
        cartridge ROM (.nes/.sfc/.gb/…) compressed, which RetroArch reads
        natively. Unreadable/empty listing → be safe and extract.
        """
        members = [m for m in _archive_member_names(archive_path)
                   if m and not m.endswith('/')]
        if not members:
            return True
        exts = [Path(m).suffix.lower() for m in members]
        if any(e in self._DISC_IMAGE_EXTS for e in exts):
            return True
        launchable = [e for e in exts if e not in _NON_GAME_EXTS]
        return len(launchable) > 1

    def _maybe_unzip_download(self, dest: Path, rom_id: int = None) -> Path:
        """Extract a freshly-downloaded archive when its content needs it.

        A .zip/.7z whose members require extraction (disc image / multi-file —
        see _archive_needs_extract) is unpacked into a sibling folder named for
        the archive, the archive is deleted, and the boot target is repointed:
        a real disc set / .m3u resolves through the folder; a lone game file is
        returned directly. A single cartridge ROM is left compressed (RetroArch
        loads it natively, keeping the download small). Any failure (extractor
        missing, bad archive) leaves the original archive untouched — callers
        keep working exactly as before. Returns the local_path to use.
        """
        try:
            if not dest.is_file() or dest.suffix.lower() not in ('.zip', '.7z'):
                return dest
            if not self._archive_needs_extract(dest):
                return dest
            # Surface an "Extracting… N%" state so the UI doesn't sit at a silent
            # 100% while a large disc archive unpacks (can take many seconds). The
            # extractor streams a real percentage via this callback.
            def _on_extract(pct):
                if rom_id is not None:
                    self._download_progress[rom_id] = {
                        'percent': pct, 'downloaded': 0, 'total': 0, 'speed': 0,
                        'eta': 0, 'state': 'extracting', 'message': 'Extracting…',
                    }
            _on_extract(0)
            folder = dest.with_suffix('')
            # Avoid clobbering an existing same-named folder (e.g. a prior
            # extraction); extract into a fresh sibling if it's taken.
            if folder.exists():
                folder = dest.parent / (dest.stem + '__extracted')
            if not _extract_archive(dest, folder, _on_extract):
                logging.info(f"unzip skipped (no extractor / unsupported): {dest.name}")
                return dest
            try:
                dest.unlink()
            except Exception as e:
                logging.warning(f"could not remove archive after extract: {e}")
            # Always hand back the FOLDER: _resolve_launch_path/_list_local_discs
            # turn it into the right .cue/.m3u/region file at launch, and it's the
            # same value _resolve_download_path reconstructs on the next startup,
            # so "is downloaded" survives a restart. (We only reach here for disc
            # or multi-file content — see _archive_needs_extract — so the folder
            # always resolves to something launchable.)
            return folder
        except Exception as e:
            logging.warning(f"_maybe_unzip_download error (keeping archive): {e}")
            return dest

    async def get_emulator_status(self, refresh: bool = False):
        """What emulator Ludo will use, and whether anything about it is broken.

        The single source the UI reads for the emulator banner, so a missing or
        just-uninstalled emulator is one clear state instead of an error string on
        whichever action the user happened to try. `refresh` re-runs detection,
        which is what makes an emulator installed or removed while Ludo was
        running visible without a restart.
        """
        try:
            ra = self._retroarch
            if not ra:
                return {'success': False, 'installed': False,
                        'message': 'RetroArch interface unavailable'}
            loop = asyncio.get_event_loop()
            # Detection touches the filesystem and may shell out to `flatpak
            # info`, so keep it off the event loop.
            status = await loop.run_in_executor(
                None, ra.refresh_installation if refresh else ra.emulator_status)
            return {'success': True, **status}
        except Exception as e:
            logging.error(f"get_emulator_status error: {e}", exc_info=True)
            return {'success': False, 'installed': False, 'message': str(e)}

    async def repair_emulator_paths(self, keys: list = None):
        """Point stale ROM/save/BIOS/emulator paths back at the live install (or
        clear them so they auto-detect again), then re-detect."""
        try:
            ra = self._retroarch
            if not ra:
                return {'success': False, 'message': 'RetroArch interface unavailable'}
            loop = asyncio.get_event_loop()
            repaired, status = await loop.run_in_executor(
                None, ra.repair_emulator_paths, keys)
            if repaired:
                logging.info(f"Repaired stale emulator paths: "
                             f"{[r['key'] for r in repaired]}")
                # Save/state watchers were started against the OLD directories,
                # so the repair only takes effect once sync restarts — the same
                # thing save_config does after changing these paths.
                #
                # Guarded separately: the settings are already written by now, so
                # a failure restarting sync must not be reported as "could not
                # update" — that leaves the UI showing a warning for a path it
                # has in fact fixed, which is indistinguishable from the repair
                # silently doing nothing.
                try:
                    if any(r.get('kind') == 'saves' for r in repaired):
                        self._retroarch.align_retroarch_config()
                    self._stop_sync()
                    time.sleep(0.5)
                    self._start_sync()
                    if self._retroarch:
                        status = self._retroarch.emulator_status()
                except Exception as e:
                    logging.error(f"repair applied but sync restart failed: {e}",
                                  exc_info=True)
                    status = {**status, 'restart_failed': str(e)}
            return {'success': True, 'repaired': repaired, **status}
        except Exception as e:
            logging.error(f"repair_emulator_paths error: {e}", exc_info=True)
            return {'success': False, 'message': str(e)}

    async def install_emulator(self):
        """Start installing RetroArch (per-user flatpak) in the background.

        Returns as soon as the work is queued; the UI polls
        emulator_install_state() for progress. Blocking here instead would hold
        the IPC channel for the length of a ~300 MB download.
        """
        try:
            ra = self._retroarch
            if not ra:
                return {'success': False, 'message': 'RetroArch interface unavailable'}
            if self._emu_install.get('active'):
                return {'success': True, 'message': 'Install already running'}

            support = ra.emulator_install_support()
            if not support['available']:
                return {'success': False, 'message': support['reason']}

            self._emu_install = {'active': True, 'phase': 'Starting…',
                                 'pct': None, 'detail': '', 'error': None,
                                 'installed': False, 'repaired': [],
                                 'bytes_done': None, 'bytes_total': None}

            def progress(phase, pct, detail='', done=None, total=None):
                # Never let the reported percentage go backwards: flatpak
                # restarts its own counter per component, and a bar that jumps
                # back reads as a failed retry.
                prev = self._emu_install.get('pct')
                if pct is None:
                    # Lines like "Installation complete." carry no number. Hold
                    # the last one rather than dropping the bar back to
                    # indeterminate right as the install finishes.
                    pct = prev
                elif prev is not None and pct < prev:
                    pct = prev
                self._emu_install['phase'] = phase
                self._emu_install['pct'] = pct
                self._emu_install['detail'] = detail or ''
                # Same one-way rule for the byte counter, and for the same
                # reason: it sits next to the bar, so the two must agree.
                if total:
                    self._emu_install['bytes_total'] = total
                if done is not None:
                    prev_done = self._emu_install.get('bytes_done')
                    self._emu_install['bytes_done'] = (
                        done if prev_done is None else max(prev_done, done))

            def run():
                try:
                    r = ra.install_emulator(progress_callback=progress)
                    self._emu_install['installed'] = bool(r.get('success'))
                    self._emu_install['error'] = None if r.get('success') else r.get('message')
                    if r.get('success'):
                        # Point the folders at the emulator that now exists.
                        # Normally a stale path is only ever suggested, never
                        # applied — but this is the one moment where there is no
                        # ambiguity: the user just asked us to install an
                        # emulator, and a save or BIOS folder still aimed at a
                        # removed one has no defensible reading. Greeting someone
                        # with a warning immediately after a successful install
                        # is the worse outcome. Before the restart, so the
                        # watchers come up on the corrected directories.
                        try:
                            repaired, _ = self._retroarch.repair_emulator_paths()
                            # And the save folder if it is still Ludo's
                            # no-emulator fallback, which no staleness rule
                            # covers but the emulator will never read.
                            moved = self._retroarch.align_saves_with_emulator()
                            if moved:
                                repaired = list(repaired) + [moved]
                            # And the other half of it: RetroArch writes saves
                            # next to the ROM unless told otherwise, so watching
                            # our folder is useless until its config agrees.
                            # Create the save folders now so the watcher has
                            # something to watch during the very first session,
                            # rather than only catching up when it ends.
                            self._retroarch.ensure_save_dirs_exist()
                            self._retroarch.align_retroarch_config()
                            self._emu_install['repaired'] = [
                                x.get('label') or x.get('key') for x in repaired]
                            if repaired:
                                logging.info(f"Install repaired stale paths: "
                                             f"{self._emu_install['repaired']}")
                        except Exception as e:
                            logging.error(f"repair after emulator install: {e}",
                                          exc_info=True)

                        # Sync was started against "no emulator": no cores dir,
                        # no save dirs to watch. Restart it against the real one.
                        try:
                            self._stop_sync()
                            time.sleep(0.5)
                            self._start_sync()
                        except Exception as e:
                            logging.error(f"restart after emulator install: {e}", exc_info=True)
                except Exception as e:
                    logging.error(f"install_emulator error: {e}", exc_info=True)
                    self._emu_install['error'] = str(e)
                finally:
                    self._emu_install['active'] = False
                    # Leave pct alone: on success it is 100, and the poll reads
                    # this same dict one last time before hiding the bar —
                    # blanking it made the bar flick to indeterminate on the
                    # final frame. On failure the error is what gets shown.
                    self._emu_install['detail'] = ''

            threading.Thread(target=run, daemon=True,
                             name='emulator-install').start()
            return {'success': True, 'started': True}
        except Exception as e:
            logging.error(f"install_emulator error: {e}", exc_info=True)
            self._emu_install = {'active': False, 'phase': '', 'pct': None,
                                 'error': str(e), 'installed': False}
            return {'success': False, 'message': str(e)}

    async def emulator_install_state(self):
        """Progress of the install started by install_emulator(). `pct` is None
        while flatpak reports nothing parseable — show it as indeterminate."""
        return {'success': True, **self._emu_install}

    async def get_core_mappings(self):
        """For the core-mapping settings page: one row per platform in the
        user's library, showing how the launch core resolves and the options
        available to override it.

        Returns {success, available_cores: [...], mappings: [
          {slug, platform_name, resolved_core, source, override,
           retrodeck_default, retrodeck_choices: [...]}
        ]}.
        """
        try:
            ra = self._retroarch
            if not ra:
                return {'success': False, 'mappings': [], 'available_cores': [],
                        'message': 'RetroArch interface unavailable'}
            available = sorted(ra.get_available_cores().keys())
            # Unique platforms (slug + label) that have at least one DOWNLOADED
            # game — the core choice only matters for games you can actually
            # launch locally, so platforms with nothing downloaded are hidden.
            seen, rows = set(), []
            for g in (self._available_games or []):
                if not g.get('is_downloaded'):
                    continue
                slug = g.get('platform_slug') or (g.get('romm_data') or {}).get('platform_slug')
                if not slug or slug in seen:
                    continue
                seen.add(slug)
                label = self._platform_name_for(g)
                info = ra.describe_core_resolution(label, system_slug=slug)
                info.update({'slug': slug, 'platform_name': label})
                rows.append(info)
            rows.sort(key=lambda r: (r['platform_name'] or '').lower())
            support = ra.core_download_support()
            return {'success': True, 'available_cores': available, 'mappings': rows,
                    'can_download_cores': support['available'],
                    'download_unavailable_reason': support['reason'],
                    'download_unavailable_kind': support.get('kind') or ''}
        except Exception as e:
            logging.error(f"get_core_mappings error: {e}", exc_info=True)
            return {'success': False, 'mappings': [], 'available_cores': [], 'message': str(e)}

    async def download_core(self, core: str):
        """Install one core from the libretro buildbot (RetroArch's own core
        source). Blocking network + unzip, so it runs off the event loop."""
        try:
            ra = self._retroarch
            if not ra:
                return {'success': False, 'message': 'RetroArch interface unavailable'}
            result = await asyncio.get_event_loop().run_in_executor(
                None, ra.download_core, core)
            if result.get('success'):
                logging.info(f"Installed emulator core: {core}")
            return result
        except Exception as e:
            logging.error(f"download_core error: {e}", exc_info=True)
            return {'success': False, 'core': core, 'message': str(e)}

    async def get_downloadable_cores(self, refresh: bool = False):
        """Every core the buildbot ships for this OS/arch, with an installed
        flag — backs the "add a core" section of the core picker."""
        try:
            ra = self._retroarch
            if not ra:
                return {'success': False, 'cores': [],
                        'message': 'RetroArch interface unavailable'}
            support = ra.core_download_support()
            if not support['available']:
                return {'success': True, 'cores': [], 'writable_dir': None,
                        'can_download': False, 'message': support['reason']}
            index = await asyncio.get_event_loop().run_in_executor(
                None, ra.list_downloadable_cores, bool(refresh))
            installed = ra.get_available_cores()
            dest = ra.find_writable_cores_directory()
            return {
                'success': True,
                'can_download': True,
                'writable_dir': str(dest) if dest else None,
                'cores': sorted(
                    ({'name': name, 'installed': name in installed,
                      'date': meta.get('date')} for name, meta in index.items()),
                    key=lambda c: c['name']),
            }
        except Exception as e:
            logging.error(f"get_downloadable_cores error: {e}", exc_info=True)
            return {'success': False, 'cores': [], 'message': str(e)}

    async def set_core_override(self, slug: str, core: str = ''):
        """Pin (core non-empty) or clear (core empty) the launch core for a
        platform slug. Returns the refreshed resolution for that row."""
        try:
            ra = self._retroarch
            if not ra:
                return {'success': False, 'message': 'RetroArch interface unavailable'}
            ra.set_core_override(slug, core or '')
            # Recompute so the UI reflects the new source/resolved core.
            label = slug
            for g in (self._available_games or []):
                if (g.get('platform_slug') or (g.get('romm_data') or {}).get('platform_slug')) == slug:
                    label = self._platform_name_for(g)
                    break
            info = ra.describe_core_resolution(label, system_slug=slug)
            info.update({'slug': slug, 'platform_name': label})
            return {'success': True, 'mapping': info}
        except Exception as e:
            logging.error(f"set_core_override error: {e}", exc_info=True)
            return {'success': False, 'message': str(e)}

    # -----------------------------------------------------------------------
    # Auto-update
    # -----------------------------------------------------------------------
    async def get_plugin_version(self):
        """Current installed version — single source of truth (package.json)."""
        return PLUGIN_VERSION

    async def get_update_channel(self):
        return load_decky_settings().get('update_channel', 'stable')

    async def set_update_channel(self, channel: str):
        channel = channel if channel in VALID_CHANNELS else 'stable'
        settings = load_decky_settings()
        settings['update_channel'] = channel
        save_decky_settings(settings)
        logging.info(f"[UPDATE] channel set to {channel}")
        return channel

    async def get_check_on_startup(self):
        return bool(load_decky_settings().get('check_on_startup', True))

    async def set_check_on_startup(self, enabled: bool):
        settings = load_decky_settings()
        settings['check_on_startup'] = bool(enabled)
        save_decky_settings(settings)
        logging.info(f"[UPDATE] check_on_startup set to {bool(enabled)}")
        return bool(enabled)

    def _select_release(self, channel: str, asset_suffix: str = None):
        """Return the GitHub release dict for the given channel, or None.

        stable → newest non-prerelease carrying the asset. beta → newest release
        overall carrying it (prerelease or stable, whichever is more recent), so
        beta testers always track the leading edge.
        """
        return select_release(channel, asset_suffix or globals()['UPDATE_ASSET_SUFFIX'])

    async def check_for_update(self, channel: str = None,
                               asset_suffix: str = None):
        """Query GitHub for a newer release on the selected channel.

        Returns dict: {success, available, current, latest, channel, prerelease,
        notes, url, asset_name}. `available` is only True when a newer version
        AND a downloadable asset both exist.
        """
        import requests
        try:
            asset_suffix = asset_suffix or globals()['UPDATE_ASSET_SUFFIX']
            channel = channel if channel in VALID_CHANNELS else \
                load_decky_settings().get('update_channel', 'stable')
            rel = self._select_release(channel, asset_suffix)
            if not rel:
                return {'success': True, 'available': False, 'current': PLUGIN_VERSION,
                        'latest': PLUGIN_VERSION, 'channel': channel,
                        'notes': '', 'url': None,
                        'message': f'No {asset_suffix} release found for this channel'}

            asset = _release_asset(rel, asset_suffix)
            latest = (rel.get('tag_name') or rel.get('name') or '').lstrip('v')
            newer = _version_key(latest) > _version_key(PLUGIN_VERSION)
            available = bool(newer and asset)
            logging.info(
                f"[UPDATE] check channel={channel} current={PLUGIN_VERSION} "
                f"latest={latest} prerelease={bool(rel.get('prerelease'))} "
                f"asset={'yes' if asset else 'MISSING'} available={available}")

            return {
                'success': True,
                'available': available,
                'current': PLUGIN_VERSION,
                'latest': latest,
                'channel': channel,
                'prerelease': bool(rel.get('prerelease')),
                'notes': rel.get('body') or '',
                'url': asset.get('browser_download_url') if asset else None,
                'asset_name': asset.get('name') if asset else None,
            }
        except (requests.ConnectionError, requests.Timeout):
            # Offline, captive portal, or GitHub unreachable. Routine on a
            # handheld that suspends and roams between networks — one line,
            # no traceback.
            logging.info("[UPDATE] check skipped: GitHub unreachable")
            return {'success': False, 'available': False,
                    'current': PLUGIN_VERSION,
                    'message': "Couldn't reach GitHub — check your connection"}
        except Exception as e:
            logging.error(f"[UPDATE] check_for_update error: {e}", exc_info=True)
            return {'success': False, 'available': False,
                    'current': PLUGIN_VERSION, 'message': str(e)}

    async def download_update(self, url: str):
        """Download a release zip into the plugin runtime dir. Returns its path."""
        try:
            import requests
            if not url:
                return {'success': False, 'message': 'No download URL provided'}
            dest_dir = Path(os.environ.get('DECKY_PLUGIN_RUNTIME_DIR',
                                           str(Path(__file__).parent / 'updates')))
            dest_dir.mkdir(parents=True, exist_ok=True)
            name = url.split('/')[-1] or 'update.zip'
            dest = dest_dir / name
            logging.info(f"[UPDATE] downloading {url} -> {dest}")
            with requests.get(url, stream=True, timeout=120) as r:
                r.raise_for_status()
                with open(dest, 'wb') as f:
                    for chunk in r.iter_content(chunk_size=1 << 16):
                        if chunk:
                            f.write(chunk)
            logging.info(f"[UPDATE] downloaded {dest.stat().st_size} bytes")
            return {'success': True, 'path': str(dest), 'name': name}
        except Exception as e:
            logging.error(f"[UPDATE] download_update error: {e}", exc_info=True)
            return {'success': False, 'message': str(e)}

    async def apply_appimage_update(self, path: str):
        """Replace the running AppImage with a freshly downloaded one.

        Desktop-only. The Decky plugin updates through Decky Loader's
        install_plugin instead, which unpacks a zip; an AppImage is a single
        executable file, so updating it means swapping that file.

        Returns {'success', 'restart_required'}. The caller is responsible for
        relaunching: the swap only takes effect on the next start.
        """
        try:
            target = os.environ.get('APPIMAGE')
            if not target:
                # Running from source (npm run electron) or as an unpacked
                # build — there is no single file to replace.
                return {'success': False,
                        'message': 'Not running as an AppImage; update manually'}

            target = Path(target)
            src = Path(path)
            if not src.is_file():
                return {'success': False, 'message': f'Downloaded file missing: {src}'}

            # Writing into a running executable fails with ETXTBSY, but renaming
            # over it is fine: this process keeps the old inode until it exits.
            # The temp file must share a filesystem with the target for
            # os.replace to be atomic.
            if not os.access(target.parent, os.W_OK):
                return {'success': False,
                        'message': f'No write permission for {target.parent}; '
                                   'move the AppImage somewhere writable '
                                   '(e.g. ~/Applications) and retry'}

            # Sanity-check before clobbering a working install: an AppImage is
            # an ELF binary, and a truncated download or an HTML error page
            # would leave the app unlaunchable.
            with open(src, 'rb') as f:
                if f.read(4) != b'\x7fELF':
                    return {'success': False,
                            'message': 'Downloaded file is not a valid AppImage'}
            os.chmod(src, 0o755)

            # Move the download onto the target rather than copying it: the
            # image is ~170MB, so a copy would briefly need three times the
            # size on disk and leave the download behind afterwards.
            try:
                os.replace(src, target)
            except OSError:
                # Different filesystems — fall back to staging a copy beside
                # the target (os.replace is only atomic within one fs), then
                # drop the download so it does not accumulate in the config
                # directory on every update.
                staged = target.with_suffix(target.suffix + '.new')
                shutil.copy2(src, staged)
                os.chmod(staged, 0o755)
                os.replace(staged, target)
                try:
                    src.unlink()
                except OSError:
                    logging.warning(f"[UPDATE] could not remove {src}")
            logging.info(f"[UPDATE] replaced {target} ({target.stat().st_size} bytes)")
            return {'success': True, 'restart_required': True, 'path': str(target)}
        except Exception as e:
            logging.error(f"[UPDATE] apply_appimage_update error: {e}", exc_info=True)
            return {'success': False, 'message': str(e)}

    async def reset_all_settings(self):
        """Delete all downloaded ROMs from ALL collections, delete downloaded
        BIOS files, and reset sync state.  Credentials are preserved."""
        import configparser, shutil
        config_dir   = CONFIG_DIR
        ini_path     = config_dir / 'settings.ini'

        try:
            # Grab BIOS system_dir before stopping sync (needs retroarch ref)
            bios_system_dir = None
            if self._retroarch and hasattr(self._retroarch, 'bios_manager') and self._retroarch.bios_manager:
                bios_system_dir = self._retroarch.bios_manager.system_dir

            self._stop_sync()
            logging.info("Reset: sync stopped")

            config = configparser.ConfigParser()
            config.read(ini_path)

            download_dir = Path(config.get('Download', 'rom_directory',
                                           fallback=_default_roms_dir())).expanduser()

            # Delete every ROM we downloaded, off the live library rather than the
            # server.
            #
            # This used to open a NEW RomMClient from username/password and walk
            # every collection's ROMs. It deleted nothing at all for anyone paired
            # with a Client API Token (the recommended path — no password is
            # stored, so the all([url, username, password]) guard skipped the
            # whole block in silence), and even when it did run it could only
            # delete games that happen to belong to a collection. A user who
            # picked "delete my games" got a success toast and kept their games.
            #
            # _available_games is the same list the Downloaded row is built from,
            # already carries the resolved local_path, and needs no network — so
            # what we delete is exactly what we showed as downloaded.
            deleted_roms = 0
            for g in (self._available_games or []):
                if not g.get('is_downloaded'):
                    continue
                lp = g.get('local_path')
                if not lp:
                    # Downloaded but unresolved: reconstruct the standard layout.
                    slug = g.get('platform_slug') or (g.get('romm_data') or {}).get('platform_slug')
                    fn = g.get('file_name')
                    if not (slug and fn):
                        continue
                    lp = download_dir / slug / fn
                rom_path = Path(lp)
                try:
                    if rom_path.is_dir():
                        shutil.rmtree(rom_path)   # multi-disc / multi-file ROM
                        deleted_roms += 1
                    elif rom_path.exists():
                        rom_path.unlink()
                        deleted_roms += 1
                    # Clear the flag even when the file was already gone: the
                    # entry is stale either way, and leaving it set keeps a
                    # phantom in the Downloaded row with nothing behind it.
                    g['is_downloaded'] = False
                    g['local_path'] = None
                    g['local_size'] = 0
                except Exception as e:
                    logging.error(f"Reset: failed to delete {rom_path}: {e}")
            logging.info(f"Reset: deleted {deleted_roms} ROM file(s)")

            # Delete downloaded BIOS files from the system directory
            deleted_bios = 0
            if bios_system_dir and bios_system_dir.exists():
                try:
                    from romm_sync_engine.bios_manager import BIOS_DATABASE
                    known_bios_files = set()
                    for platform_info in BIOS_DATABASE.values():
                        for bios_entry in platform_info.get('bios_files', []):
                            fname = bios_entry.get('file')
                            if fname:
                                known_bios_files.add(fname)

                    for bios_file in known_bios_files:
                        bios_path = bios_system_dir / bios_file
                        if bios_path.exists():
                            try:
                                bios_path.unlink()
                                deleted_bios += 1
                                logging.info(f"Reset: deleted BIOS file {bios_file}")
                            except Exception as e:
                                logging.error(f"Reset: failed to delete BIOS {bios_file}: {e}")

                    logging.info(f"Reset: deleted {deleted_bios} BIOS file(s)")
                except ImportError:
                    logging.warning("Reset: bios_manager module not available, skipping BIOS deletion")
                except Exception as e:
                    logging.error(f"Reset: BIOS deletion error: {e}", exc_info=True)

            # Clear all collection settings (disable all sync collections)
            if config.has_section('Collections'):
                config.set('Collections', 'actively_syncing',  '')
                config.set('Collections', 'selected_for_sync', '')
                config.set('Collections', 'auto_sync_enabled', 'false')
                with open(ini_path, 'w') as f:
                    config.write(f)

            self._romm_collections = None
            self._romm_virtual_collections = None

            cache_dir = config_dir / 'cache'
            if cache_dir.exists():
                shutil.rmtree(cache_dir)

            ds = load_decky_settings()
            ds['needs_onboarding'] = True
            save_decky_settings(ds)

            logging.info(f"Reset complete: {deleted_roms} ROM(s), {deleted_bios} BIOS file(s) deleted")
            return {'success': True, 'deleted_roms': deleted_roms, 'deleted_bios': deleted_bios}

        except Exception as e:
            logging.error(f"reset_all_settings error: {e}", exc_info=True)
            return {'success': False, 'error': str(e)}

    async def logout(self, wipe_data: bool = False):
        """Log out of RomM. Always clears stored credentials and stops sync so
        get_config() reports unconfigured and the setup wizard takes over.

        When wipe_data is True, also deletes downloaded ROMs/BIOS and clears
        sync state first (the old "reset to new user" behaviour). When False,
        downloaded files are kept so logging back in is non-destructive.
        """
        try:
            if not SYNC_CORE_AVAILABLE:
                return {'success': False, 'error': 'sync_core not available'}

            result = {'success': True, 'deleted_roms': 0, 'deleted_bios': 0}
            if wipe_data:
                # reset_all_settings deletes ROMs/BIOS, clears sync state, and
                # sets needs_onboarding; it also stops sync.
                result = await self.reset_all_settings()
            else:
                self._stop_sync()

            # Clear credentials so configured == False. Keep url/username so the
            # wizard can pre-fill the server for a quick log back in.
            settings = SettingsManager()
            settings.set('RomM', 'password', '')
            settings.set('RomM', 'client_token', '')
            settings.set('RomM', 'auto_connect', 'false')

            self._romm_client = None
            self._clear_library_cache()

            ds = load_decky_settings()
            ds['needs_onboarding'] = True
            save_decky_settings(ds)

            logging.info(f"Logged out of RomM (wipe_data={wipe_data})")
            _record_activity('account', 'Logged out',
                             'Downloads deleted' if wipe_data else 'Downloads kept')
            result['success'] = True
            return result
        except Exception as e:
            logging.error(f"logout error: {e}", exc_info=True)
            return {'success': False, 'error': str(e)}

    def _push_device_name(self, device_id, remote=None):
        """Tell RomM what this device is called. Blocking; call off the loop.

        Without this the device shows in RomM under socket.gethostname() for
        good, because register_device only ever sends a name once. RomM's own
        Android client does the same PUT for the same reason.

        `remote` is the name the server currently has, when the caller already
        knows it — passing it skips the PUT when nothing changed.
        """
        if not (self._romm_client and self._romm_client.authenticated and device_id):
            return False
        try:
            import socket as _socket
            name = (self._settings.get('Device', 'device_name', '') or '').strip()
            if not name or name == _socket.gethostname():
                return False  # nothing the server doesn't already assume
            if remote is not None and remote == name:
                return False
            if self._romm_client.update_device(device_id, {'name': name}):
                logging.info(f"[DEVICE] renamed on server: {name}")
                return True
            logging.warning(f"[DEVICE] rename to {name!r} rejected by server")
            return False
        except Exception as e:
            logging.error(f"[DEVICE] rename error: {e}", exc_info=True)
            return False

    def _ensure_device_registered(self):
        """Ensure this device is registered with RomM and device_id is stored.

        Save-sync (/negotiate) needs a device_id; without it the session sync
        can't run and battery saves never sync. Mirrors the GTK app's
        initialize_device(): reuse an existing valid registration, else register
        a new device. New devices default to sync_enabled on the server.
        """
        if not (self._romm_client and self._romm_client.authenticated and self._settings):
            return None
        try:
            existing = self._settings.get('Device', 'device_id', '')
            if existing:
                device = self._romm_client.get_device(existing)
                if device:
                    logging.info(f"[DEVICE] verified on server: {existing}")
                    # Reconcile a rename made while offline. set_device_name
                    # pushes immediately when it can, but the wizard often runs
                    # before the first connect, so the server would otherwise
                    # keep showing the hostname forever.
                    self._push_device_name(existing, remote=device.get('name'))
                    return existing

            import socket as _socket
            device_id = self._romm_client.register_device(
                device_name=self._settings.get('Device', 'device_name', _socket.gethostname()),
                platform=self._settings.get('Device', 'device_platform', 'SteamOS'),
                client=self._settings.get('Device', 'client', 'Ludo-Decky'),
                client_version=PLUGIN_VERSION,
            )
            if device_id:
                self._settings.set('Device', 'device_id', device_id)
                logging.info(f"[DEVICE] registered: {device_id}")
                return device_id
            logging.warning("[DEVICE] registration failed; save-sync will be disabled")
            return None
        except Exception as e:
            logging.error(f"[DEVICE] registration error: {e}", exc_info=True)
            return None

    async def pair_device(self, url: str, code: str):
        """Pair with RomM using an 8-digit Client API Token code (no password).

        Exchanges the code for a token, stores it, and connects. This is RomM's
        recommended companion-app auth — far better UX on a Steam Deck than
        typing a username/password.
        """
        try:
            url = (url or self._settings.get('RomM', 'url', '')).strip().rstrip('/')
            if not url:
                return {'success': False, 'message': 'RomM URL is required'}
            if not code or not str(code).strip():
                return {'success': False, 'message': 'Pairing code is required'}

            token = RomMClient(url).exchange_pair_code(str(code).strip())
            if not token:
                return {'success': False, 'message': 'Invalid or expired pairing code'}

            self._settings.set('RomM', 'url', url)
            self._settings.set('RomM', 'client_token', token)
            self._settings.set('RomM', 'auto_connect', 'true')
            # Clear the onboarding flag so get_config() reports configured — pairing
            # is a complete setup path (save_config does the same for password auth).
            ds = load_decky_settings()
            ds.pop('needs_onboarding', None)
            save_decky_settings(ds)
            logging.info("Paired with RomM via Client API Token")

            # Hand the connect to the retry thread instead of running it here.
            # _connect_to_romm() fetches the WHOLE library, and this is an async
            # callable — doing it inline blocks Decky's event loop, so on a large
            # library every other callable (status polls included) stalls for
            # minutes and the wizard looks hung. save_config takes exactly this
            # route for password auth; pairing was the odd one out.
            self._stop_sync()
            await asyncio.sleep(0.5)
            self._start_sync()
            _record_activity('account', 'Signed in', url)
            # 'paired' is reported separately from 'success' because the two mean
            # different things to a caller deciding whether to retry: the code is
            # single-use and is spent by the time we get here, so a retry after a
            # merely-failed CONNECTION would come back "invalid or expired" and
            # strand a device that is, in fact, paired.
            return {'success': True,
                    'paired': True,
                    'connecting': True,
                    'message': 'Paired'}
        except Exception as e:
            logging.error(f"pair_device error: {e}", exc_info=True)
            return {'success': False, 'message': str(e)}

    async def set_device_name(self, name: str = ''):
        """Rename this device for save syncing, without touching anything else.

        The counterpart to set_library_paths, and needed for the same reason:
        save_config is the wizard's password-auth method and rewrites
        credentials, so a paired device (which has no password to rewrite) has no
        way to persist the name the wizard collected.
        """
        try:
            if not SYNC_CORE_AVAILABLE:
                return {'success': False, 'message': 'sync_core not available'}
            SettingsManager().set('Device', 'device_name', (name or '').strip())
            # Settings are the source of truth, so the local write stands even if
            # the server is unreachable — _ensure_device_registered pushes the
            # name on the next connect. to_thread because update_device is a
            # blocking HTTP call and this is a Decky callable: doing it inline
            # would stall every other callable, which is exactly what made
            # pairing look hung.
            device_id = self._settings.get('Device', 'device_id', '') if self._settings else ''
            if device_id:
                await asyncio.to_thread(self._push_device_name, device_id)
            return {'success': True}
        except Exception as e:
            logging.error(f"set_device_name error: {e}", exc_info=True)
            return {'success': False, 'message': str(e)}

    async def ack_library_announcement(self):
        """The frontend has shown the first-load toast; never show it again.

        Persisted rather than kept in memory because the frontend remounts far
        more often than the backend restarts, and a flag that resets on remount
        would re-toast at the worst moments.
        """
        try:
            self._announce_library = None
            if self._settings:
                self._settings.set('UI', 'library_announced', 'true')
            return {'success': True}
        except Exception as e:
            logging.error(f"ack_library_announcement error: {e}", exc_info=True)
            return {'success': False, 'message': str(e)}

    async def delete_device(self):
        """Unregister the current device from the server and clear local device ID."""
        try:
            device_id = self._settings.get('Device', 'device_id', '') if self._settings else ''
            if not device_id:
                return {'success': False, 'message': 'No device registered'}

            if not self._romm_client or not self._romm_client.authenticated:
                return {'success': False, 'message': 'Not connected to RomM'}

            if self._romm_client.delete_device(device_id):
                self._settings.set('Device', 'device_id', '')
                logging.info(f"Device {device_id} unregistered")
                return {'success': True, 'message': f'Device {device_id} deleted'}
            else:
                return {'success': False, 'message': 'Server rejected device deletion'}

        except Exception as e:
            logging.error(f"delete_device error: {e}", exc_info=True)
            return {'success': False, 'message': str(e)}

    async def set_logging_enabled(self, enabled: bool):
        try:
            settings = load_decky_settings()
            settings['logging_enabled'] = enabled
            result = save_decky_settings(settings)

            if result:
                global _file_handler
                root = logging.getLogger()
                if enabled:
                    if _file_handler is None:
                        _file_handler = logging.FileHandler(str(log_file))
                        _file_handler.setLevel(logging.DEBUG)
                        _file_handler.setFormatter(
                            logging.Formatter('%(asctime)s - %(levelname)s - %(message)s'))
                        root.addHandler(_file_handler)
                    root.setLevel(logging.DEBUG)
                    logging.info("Logging enabled")
                else:
                    logging.info("Logging disabled")
                    if _file_handler is not None:
                        root.removeHandler(_file_handler)
                        _file_handler.close()
                        _file_handler = None

            return result
        except Exception as e:
            logging.error(f"set_logging_enabled error: {e}")
            return False

    async def enable_retroarch_setting(self, setting_type: str):
        """Enable a RetroArch setting (network_commands or savestate_thumbnails)."""
        try:
            if not SYNC_CORE_AVAILABLE:
                return {'success': False, 'message': 'sync_core not available'}

            if not self._retroarch:
                return {'success': False, 'message': 'RetroArch interface not initialized'}

            success, message = self._retroarch.enable_retroarch_setting(setting_type)
            logging.info(f"enable_retroarch_setting({setting_type}): {message}")
            return {'success': success, 'message': message}

        except Exception as e:
            logging.error(f"enable_retroarch_setting error: {e}", exc_info=True)
            return {'success': False, 'message': f'Error: {str(e)}'}

    # -----------------------------------------------------------------------
    # Save History (browse / restore server save & state versions)
    # -----------------------------------------------------------------------

    async def get_downloaded_games(self):
        """Return the list of locally-downloaded games (for the history picker)."""
        try:
            slug_map = self._platform_slug_to_name or {}

            def _platform(g):
                p = g.get('platform')
                if p and p != 'Unknown':
                    return p
                slug = g.get('platform_slug') or (g.get('romm_data') or {}).get('platform_slug')
                if slug:
                    return slug_map.get(slug) or slug
                return 'Unknown'

            games = [
                {
                    'rom_id':   g.get('rom_id'),
                    'name':     g.get('display_name') or g.get('name'),
                    'platform': _platform(g),
                }
                for g in (self._available_games or [])
                if g.get('is_downloaded') and g.get('rom_id')
            ]
            games.sort(key=lambda g: (g.get('platform') or '', (g.get('name') or '').lower()))
            return {'success': True, 'games': games}
        except Exception as e:
            logging.error(f"get_downloaded_games error: {e}", exc_info=True)
            return {'success': False, 'games': [], 'message': str(e)}

    @staticmethod
    def _serialize_history_entry(entry, save_type):
        """Flatten a RomM save/state version into a frontend-friendly dict."""
        ds = entry.get('device_syncs') or entry.get('deviceSyncs')
        device = None
        if isinstance(ds, list) and ds and isinstance(ds[0], dict):
            device = ds[0].get('device_name') or ds[0].get('name')
        return {
            'id':            entry.get('id'),
            'slot':          entry.get('slot'),
            'save_type':     save_type,
            'file_name':     entry.get('file_name', ''),
            'updated_at':    entry.get('updated_at') or entry.get('created_at'),
            'size_bytes':    entry.get('size_bytes') or entry.get('file_size_bytes'),
            'device':        device,
            'has_screenshot': bool(entry.get('screenshot')),
        }

    async def get_save_history(self, rom_id: int):
        """Return all server save/state versions for a ROM (newest first)."""
        try:
            if not (self._romm_client and self._romm_client.authenticated):
                return {'success': False, 'message': 'Not connected to RomM',
                        'saves': [], 'states': []}
            saves, states = self._romm_client.get_save_history(rom_id)

            def _key(e):
                return e.get('updated_at') or e.get('created_at') or ''
            saves = sorted(saves, key=_key, reverse=True)
            states = sorted(states, key=_key, reverse=True)
            return {
                'success': True,
                'saves':  [self._serialize_history_entry(e, 'saves') for e in saves],
                'states': [self._serialize_history_entry(e, 'states') for e in states],
            }
        except Exception as e:
            logging.error(f"get_save_history error: {e}", exc_info=True)
            return {'success': False, 'message': str(e), 'saves': [], 'states': []}

    async def get_save_screenshot(self, rom_id: int, save_id: int, save_type: str):
        """Return a base64 data URI for a state's screenshot, or None.

        The frontend <img> cannot authenticate to RomM, so the backend (which
        holds the session) fetches the bytes and inlines them. Re-fetches the
        ROM history to obtain the entry's full screenshot metadata (the list
        endpoint may not embed download_path), falling back to the per-entry
        detail endpoint inside fetch_screenshot_bytes.
        """
        try:
            if not (self._romm_client and self._romm_client.authenticated):
                return {'success': False, 'data_uri': None}
            saves, states = self._romm_client.get_save_history(rom_id)
            pool = states if save_type == 'states' else saves
            entry = next((e for e in pool if e.get('id') == save_id), {'id': save_id})
            sd = entry.get('screenshot')
            logging.info(f"get_save_screenshot rom={rom_id} {save_type} id={save_id} "
                         f"screenshot_meta={'yes' if sd else 'no'}")
            data = self._romm_client.fetch_screenshot_bytes(entry, save_type)
            if not data:
                logging.info(f"get_save_screenshot id={save_id}: no image bytes returned")
                return {'success': True, 'data_uri': None}
            import base64
            b64 = base64.b64encode(data).decode('ascii')
            return {'success': True, 'data_uri': f'data:image/png;base64,{b64}'}
        except Exception as e:
            logging.error(f"get_save_screenshot error: {e}", exc_info=True)
            return {'success': False, 'data_uri': None, 'message': str(e)}

    # rom_ids whose thumbnail lookup came back empty, with the time it did.
    # Only the *negative* answer needs a clock: a hit is fingerprinted by the
    # file it came from, but "this game has no state" is proved by a directory
    # scan plus (for games not downloaded here) a RomM round-trip, and repeating
    # that for every rom on every visit to Home is the one cost with nothing to
    # show for it.
    _state_thumb_miss: dict = {}
    _STATE_MISS_TTL = 300.0

    def _state_thumb_blocking(self, rom_id: int):
        """Data URI of the newest save state's screenshot, or None. Sync.

        Local first: RetroArch writes a .png beside each state it saves, which
        is both the freshest picture of where the player actually is and free
        to read. Only when there is no local state (a game played on another
        device, and not downloaded here) does this fall back to the server's
        copy, which costs a RomM round-trip.

        Everything is routed through the same two caches the cover art uses —
        memory, then the on-disk thumbnail cache — and downscaled by
        _store_thumb on the way in. A raw savestate PNG inlined as base64 is
        several hundred KB crossing the websocket for a card 176px tall.
        """
        ck = ('state', rom_id)
        hit = self._cover_cache_get(ck)
        if hit is not None:
            return hit
        miss_at = self._state_thumb_miss.get(rom_id)
        if miss_at is not None and (time.time() - miss_at) < self._STATE_MISS_TTL:
            return None

        def _finish(fp, raw, mime):
            tkey = f"statet:{rom_id}:{fp}"
            disk = self._disk_cover_get(tkey)
            if disk:
                self._cover_cache_put(ck, disk)
                return disk
            if raw is None:
                return None
            return self._store_thumb(ck, tkey, raw, mime, False)

        g = self._games_index().get(rom_id)
        if g:
            core = None
            try:
                ra = self._retroarch
                if ra:
                    slug = (g.get('platform_slug')
                            or (g.get('romm_data') or {}).get('platform_slug'))
                    core, _ = ra.suggest_core_for_platform(
                        self._platform_name_for(g), system_slug=slug)
            except Exception:
                pass
            auto = self._auto_sync
            state = None
            if auto is not None:
                try:
                    _, state = auto.latest_state_slot(g, core)
                except Exception:
                    state = None
            if state is not None and self._retroarch:
                thumb = self._retroarch.find_thumbnail_for_save_state(state)
                if thumb:
                    thumb = Path(thumb)
                    # The mtime alone identifies the picture: a new state in the
                    # same slot rewrites this exact file.
                    fp = f"l{int(thumb.stat().st_mtime)}"
                    # The disk-cache probe inside _finish means the bytes are
                    # only read (and re-encoded) when the thumbnail is new.
                    if self._disk_cover_get(f"statet:{rom_id}:{fp}"):
                        return _finish(fp, None, None)
                    return _finish(fp, thumb.read_bytes(), 'image/png')

        # No local state (or no thumbnail beside it) — ask the server.
        if not (self._romm_client and self._romm_client.authenticated):
            return None
        _, states = self._romm_client.get_save_history(rom_id)
        states = [s for s in (states or []) if s.get('screenshot')]
        if not states:
            self._state_thumb_miss[rom_id] = time.time()
            return None
        entry = max(states, key=lambda e: (e.get('updated_at')
                                           or e.get('created_at') or ''))
        fp = f"s{entry.get('id')}-{entry.get('updated_at') or ''}".replace(':', '')
        if self._disk_cover_get(f"statet:{rom_id}:{fp}"):
            return _finish(fp, None, None)
        data = self._romm_client.fetch_screenshot_bytes(entry, 'states')
        if not data:
            self._state_thumb_miss[rom_id] = time.time()
            return None
        return _finish(fp, data, 'image/png')

    async def get_state_thumbnail(self, rom_id: int):
        """One game's save-state screenshot (see _state_thumb_blocking)."""
        try:
            uri = await asyncio.to_thread(self._state_thumb_blocking, rom_id)
            return {'success': True, 'data_uri': uri}
        except Exception as e:
            logging.error(f"get_state_thumbnail error: {e}", exc_info=True)
            return {'success': False, 'data_uri': None, 'message': str(e)}

    async def get_state_thumbnails(self, rom_ids: list):
        """Save-state screenshots for a whole row, in one call.

        The Continue playing row wants up to fifteen of these at once. Asked one
        at a time they serialise into fifteen round-trips over the websocket, and
        the ones that fall through to the server serialise fifteen RomM requests
        behind them — which is what made the row take seconds to fill in. Here
        the misses overlap on a small pool (they are IO, not CPU) and the whole
        row comes back as a single message.

        Returns {'thumbs': {'<rom_id>': data_uri|None}}. Keys are strings
        because this crosses JSON.
        """
        try:
            ids = [int(r) for r in (rom_ids or [])][:40]
            if not ids:
                return {'success': True, 'thumbs': {}}

            def _all():
                from concurrent.futures import ThreadPoolExecutor
                out = {}
                with ThreadPoolExecutor(max_workers=6) as pool:
                    futs = {pool.submit(self._state_thumb_blocking, r): r
                            for r in ids}
                    for f in futs:
                        r = futs[f]
                        try:
                            out[str(r)] = f.result()
                        except Exception as e:
                            logging.warning(f"state thumb {r} failed: {e}")
                            out[str(r)] = None
                return out
            return {'success': True, 'thumbs': await asyncio.to_thread(_all)}
        except Exception as e:
            logging.error(f"get_state_thumbnails error: {e}", exc_info=True)
            return {'success': False, 'thumbs': {}, 'message': str(e)}

    async def restore_save_version(self, rom_id: int, save_id: int,
                                   save_type: str, as_copy: bool = False):
        """Restore a server save/state version to local disk.

        Re-fetches the ROM's history and looks up the entry by id (so we use the
        authoritative server metadata, not stale frontend data), then delegates
        to the shared RetroArchInterface.restore_save_version. The running file
        watcher auto-uploads the restored file as a new server version.
        """
        try:
            if not (self._romm_client and self._romm_client.authenticated):
                return {'success': False, 'message': 'Not connected to RomM'}
            if not self._retroarch:
                return {'success': False, 'message': 'RetroArch interface not initialized'}

            saves, states = self._romm_client.get_save_history(rom_id)
            pool = states if save_type == 'states' else saves
            entry = next((e for e in pool if e.get('id') == save_id), None)
            if entry is None:
                return {'success': False, 'message': f'Version {save_id} not found'}

            result = self._retroarch.restore_save_version(
                self._romm_client, None, entry, save_type, as_copy,
                log=lambda m: logging.info(m))
            if result.get('success'):
                _record_activity('save',
                                 'State restored' if save_type == 'states' else 'Save restored',
                                 result.get('tgt_name') or '')
            return {
                'success':  result.get('success', False),
                'message':  result.get('error') or 'Restored',
                'tgt_name': result.get('tgt_name'),
            }
        except Exception as e:
            logging.error(f"restore_save_version error: {e}", exc_info=True)
            return {'success': False, 'message': str(e)}

    # -----------------------------------------------------------------------
    # Game Browser (controller-first library: browse platforms/collections,
    # per-game cover/detail/download/delete). Styled in RomM v2 on the frontend.
    # -----------------------------------------------------------------------

    def _games_index(self):
        """rom_id -> game dict, from the in-memory library."""
        return {g.get('rom_id'): g for g in (self._available_games or []) if g.get('rom_id')}

    def _variant_parent_index(self, games=None):
        """variant rom_id -> parent rom_id, from the grouped in-memory library.

        The library we browse is grouped (_group_sibling_roms), but the server's
        /api/roms responses are not: a multi-region or multi-disc game comes back
        as one row per variant. Anything that renders raw server rows next to the
        library must fold those rows onto the entry the user already knows, or
        the same game appears several times (see search_games).
        """
        out = {}
        for g in (self._available_games if games is None else games) or []:
            pid = g.get('rom_id')
            if not pid:
                continue
            for key in ('sibling_roms', '_sibling_files'):
                for s in (g.get(key) or []):
                    if not isinstance(s, dict):
                        continue
                    sid = s.get('id') or s.get('rom_id')
                    if sid and sid != pid:
                        out[sid] = pid
            # Folder members / per-region ROMs grouping pruned off sibling_roms.
            # Snapshots written before this field existed simply have none, and
            # those groups keep the pre-fix behaviour until the next fetch.
            for sid in (g.get('_region_variant_ids') or []):
                if sid and sid != pid:
                    out[sid] = pid
        return out

    @staticmethod
    def _variant_downloads(game: dict) -> dict:
        """{variant_rom_id: {file_name, local_path, name}} recorded on a parent.

        Int keys, rebuilt on every read: the map round-trips through the JSON
        snapshot, which turns every key into a string.
        """
        out = {}
        for k, v in ((game or {}).get('_variant_downloads') or {}).items():
            if not isinstance(v, dict):
                continue
            try:
                out[int(k)] = v
            except (TypeError, ValueError):
                continue
        return out

    def _record_variant_download(self, parent: dict, variant_id: int, *,
                                 name=None, file_name=None, local_path=None):
        """Note that a regional/disc variant of `parent` is on disk.

        A variant is NOT a library entry of its own — grouping folded it into
        the parent on purpose, and appending it back (which is what downloading
        or launching a region used to do) puts the same game on screen twice,
        in the grid, in Recently Downloaded, and in every collection it belongs
        to. It also persists into the snapshot, so the duplicate survives
        restarts. Recording it against the parent keeps launch/delete working
        without giving the variant a tile.
        """
        if not parent or not variant_id:
            return
        vd = dict(parent.get('_variant_downloads') or {})
        entry = dict(vd.get(str(variant_id)) or {})
        if name:
            entry['name'] = name
        if file_name:
            entry['file_name'] = file_name
        if local_path:
            entry['local_path'] = str(local_path)
        vd[str(variant_id)] = entry
        parent['_variant_downloads'] = vd
        # The game IS on the device now, just under one of its other regions.
        # Without this the parent tile still offers Download and the user has no
        # way back to what they just fetched.
        if entry.get('local_path') and not parent.get('is_downloaded'):
            parent['is_downloaded'] = True
            parent['local_path'] = entry['local_path']

    def _variant_game(self, idx: dict, rom_id: int, variant_id: int):
        """A launchable game dict for a regional/disc variant of `rom_id`, or
        None. The variant has no library entry by design (see
        _record_variant_download), so build one from the parent plus the file
        the parent recorded — parent metadata, variant path.
        """
        if not variant_id or variant_id == rom_id:
            return None
        parent = idx.get(rom_id) or {}
        v = self._variant_downloads(parent).get(variant_id) or {}
        path = v.get('local_path')
        if not path or not is_path_validly_downloaded(Path(path)):
            return None
        is_md, dc = _detect_multi_disc(path, True)
        return dict(parent, rom_id=variant_id,
                    name=v.get('name') or parent.get('name'),
                    file_name=v.get('file_name') or parent.get('file_name'),
                    is_downloaded=True, local_path=path,
                    is_multi_disc=is_md, disc_count=dc)

    def _absorb_variant_entries(self, games: list):
        """Fold variant entries a previous version appended back into their
        parent, in place. Heals snapshots that already carry the duplicates.
        """
        try:
            parents = {}
            for g in games or []:
                pid = g.get('rom_id')
                if not pid:
                    continue
                parents[pid] = g
            variant_of = self._variant_parent_index(games)
            if not variant_of:
                return
            keep, absorbed = [], 0
            for g in games or []:
                pid = variant_of.get(g.get('rom_id'))
                parent = parents.get(pid) if pid else None
                if parent is None or parent is g:
                    keep.append(g)
                    continue
                if g.get('is_downloaded'):
                    self._record_variant_download(
                        parent, g.get('rom_id'), name=g.get('name'),
                        file_name=g.get('file_name'), local_path=g.get('local_path'))
                absorbed += 1
            if absorbed:
                games[:] = keep
                logging.info(f"Folded {absorbed} duplicate regional/disc variant "
                             f"entries back into their parent games")
        except Exception as e:
            logging.warning(f"Could not fold variant entries: {e}")

    def _is_offline(self):
        """True when the server isn't reachable. Mirrors get_service_status:
        RomMClient.authenticated is sticky, so the reachability latch (_online)
        must also be consulted. When offline the library is filtered to
        downloaded-only — everything shown is actually playable."""
        return not (self._romm_client and self._romm_client.authenticated
                    and self._online is not False)

    # File types RetroArch can boot directly. .m3u is the multi-disc playlist
    # (RomM generates one inside the download zip); listing it lets the user
    # launch "all discs" with in-game disc swapping. .bin is intentionally
    # excluded because it is paired with a .cue (we launch the .cue).
    _LAUNCHABLE_DISC_EXTS = ('.m3u', '.chd', '.cue', '.iso', '.pbp',
                             '.ccd', '.gdi', '.cdi', '.nrg')

    # Auxiliary (non-game) extensions — must match module-level _NON_GAME_EXTS.
    _NON_GAME_EXTS = _NON_GAME_EXTS

    def _list_local_discs(self, local_path):
        """Return launchable entries inside a downloaded multi-file folder.

        Each entry: {name, path, is_m3u, is_region}. Returns [] for a single-file
        ROM or when nothing launchable is found.

        Two folder shapes are handled:
          - true multi-DISC games: disc images + an .m3u playlist. The .m3u sorts
            first so it reads as the natural "all discs" default, and is_region is
            False on every entry.
          - multi-FILE regional ROMs: standalone game files (e.g. per-region
            .nds). Here the .m3u is a RomM artefact that would mis-boot the
            emulator, so it is excluded entirely and each game is a region entry
            (is_region True). The caller boots one variant, never a playlist.
        """
        try:
            p = Path(local_path)
            if not p.is_dir():
                return []
            discs = []
            for f in sorted(p.rglob('*'), key=lambda x: x.name.lower()):
                if f.is_file() and f.suffix.lower() in self._LAUNCHABLE_DISC_EXTS:
                    discs.append({'name': f.name, 'path': str(f),
                                  'is_m3u': f.suffix.lower() == '.m3u',
                                  'is_region': False})
            # A real disc set has 2+ disc images (the .m3u doesn't count). When
            # there is no such set, treat the folder as a regional multi-file ROM
            # and surface the standalone game files instead of the stray .m3u.
            disc_images = [d for d in discs if not d['is_m3u']]
            if len(disc_images) < 2:
                games = _list_standalone_games(p)
                if len(games) > 1:
                    return [{'name': f.name, 'path': str(f),
                             'is_m3u': False, 'is_region': True} for f in games]
            # Float the .m3u to the top so it is the default "all discs" entry.
            discs.sort(key=lambda d: (not d['is_m3u'], d['name'].lower()))
            return discs
        except Exception as e:
            logging.warning(f"_list_local_discs error: {e}")
            return []

    def _resolve_launch_path(self, local_path, disc=None):
        """Resolve a game's local_path (file or folder) to the file to boot.

        - Single-file ROM: returns local_path unchanged.
        - Folder + explicit `disc` filename: returns that disc/region's path.
        - Folder, no disc: for a true disc set, prefers the .m3u playlist
          (in-game swap); for a regional multi-file ROM, the first variant
          (there is no playlist — booting it would mis-launch).
        Returns None when nothing launchable is present.
        """
        p = Path(local_path)
        if p.is_file():
            return str(p)
        discs = self._list_local_discs(local_path)
        if not discs:
            return None
        if disc:
            for d in discs:
                if d['name'] == disc:
                    return d['path']
            return None
        return discs[0]['path']  # .m3u sorts first, else first disc

    def _get_last_disc(self, rom_id):
        """Remembered disc filename for a ROM, or '' if none/invalid."""
        try:
            return self._settings.get('LastDisc', str(rom_id), '') if self._settings else ''
        except Exception:
            return ''

    async def get_local_discs(self, rom_id: int):
        """Disc list for the Play-button picker (downloaded multi-disc games).

        Also returns `last` — the remembered disc filename (what a plain Play
        will boot), so the UI can mark the current choice.
        """
        try:
            g = self._games_index().get(rom_id)
            if not g or not g.get('is_downloaded') or not g.get('local_path'):
                return {'success': True, 'discs': [], 'last': ''}
            discs = self._list_local_discs(g['local_path'])
            last = self._get_last_disc(rom_id)
            # Drop a stale remembered name if that disc no longer exists.
            if last and not any(d['name'] == last for d in discs):
                last = ''
            # Regional multi-file ROM (variants, no playlist) vs true disc set:
            # lets the UI title the picker "region" and skip "all discs".
            is_region = bool(discs) and all(d.get('is_region') for d in discs)
            return {'success': True, 'discs': discs, 'last': last,
                    'is_region': is_region}
        except Exception as e:
            logging.error(f"get_local_discs error: {e}", exc_info=True)
            return {'success': False, 'discs': [], 'last': '', 'message': str(e)}

    async def get_sibling_roms(self, rom_id: int):
        """Return regional variants for a ROM."""
        try:
            if not (self._romm_client and self._romm_client.authenticated):
                return {'success': False, 'siblings': [], 'message': 'Not connected to RomM'}
            r = self._romm_client.session.get(
                urljoin(self._romm_client.base_url, f'/api/roms/{rom_id}'), timeout=15)
            if r.status_code != 200:
                return {'success': False, 'siblings': [], 'message': f'HTTP {r.status_code}'}
            d = r.json()
            raw = d.get('sibling_roms') or []
            siblings = [
                {'rom_id': s.get('id'), 'name': s.get('name') or s.get('fs_name_no_ext') or 'Variant',
                 'fs_name': s.get('fs_name'), 'regions': s.get('regions', [])}
                for s in raw
            ]
            return {'success': True, 'siblings': siblings}
        except Exception as e:
            logging.error(f"get_sibling_roms error: {e}", exc_info=True)
            return {'success': False, 'siblings': [], 'message': str(e)}

    async def get_local_siblings(self, rom_id: int):
        """Return which siblings of a ROM are downloaded locally."""
        try:
            idx = self._games_index()
            g = idx.get(rom_id)
            if not g:
                return {'success': True, 'downloaded_ids': []}
            sibling_roms = g.get('sibling_roms', [])
            ids = [rom_id] + [s.get('id') for s in sibling_roms if s.get('id')]
            downloaded = [rid for rid in ids if idx.get(rid, {}).get('is_downloaded')]
            # Variants have no entry in the index (they're folded into this
            # game), so the region picker learns which ones are already on disk
            # from what the parent recorded.
            for vid, v in self._variant_downloads(g).items():
                if vid not in downloaded and v.get('local_path'):
                    downloaded.append(vid)
            return {'success': True, 'downloaded_ids': downloaded}
        except Exception as e:
            logging.error(f"get_local_siblings error: {e}", exc_info=True)
            return {'success': False, 'downloaded_ids': [], 'message': str(e)}

    def _platform_name_for(self, g):
        p = g.get('platform')
        if p and p != 'Unknown':
            return p
        slug = g.get('platform_slug') or (g.get('romm_data') or {}).get('platform_slug')
        if slug:
            return (self._platform_slug_to_name or {}).get(slug) or slug
        return 'Unknown'

    async def get_library_groups(self, mode: str = 'platform'):
        """Return library entry groups for the chosen mode ('platform'|'collection').

        Each group: {key, label, count, downloaded}. 'key' is what to pass back to
        get_library_games.
        """
        try:
            # Readiness is per-mode, and deliberately so. Collections are fetched
            # early in connect — one small request each — while the ROM fetch that
            # feeds the platform index runs for seconds or minutes behind them.
            # Gating both on the ROM fetch held the Collections rows back for the
            # whole wait with the data already in hand.
            if mode == 'collection':
                ready = self._romm_collections is not None
            else:
                ready = self._last_full_fetch_time is not None
            if mode == 'collection':
                # Offline: collection contents are fetched live per-open, so they
                # can't be browsed without the server. Show none rather than
                # tiles that error on open — the platform view (downloaded-only)
                # is the offline browse path.
                if self._is_offline():
                    return {'success': True, 'mode': mode, 'groups': [],
                            'library_ready': ready}
                actively = (self._settings.get('Collections', 'actively_syncing', '')
                            if self._settings else '')
                synced_set = {c for c in actively.split('|') if c}
                groups = []
                for col in (self._romm_collections or []):
                    name = col.get('name')
                    if not name:
                        continue
                    count = col.get('rom_count')
                    if count is None:
                        count = len(col.get('roms') or col.get('rom_ids') or [])
                    # Kind drives the badge (favorite/smart/virtual) and section,
                    # mirroring RomM's collection index.
                    if col.get('is_favorite'):
                        kind = 'favorite'
                    elif col.get('is_smart'):
                        kind = 'smart'
                    elif col.get('is_virtual'):
                        kind = 'virtual'
                    else:
                        kind = 'collection'
                    # Up to 4 sample cover paths for the 2×2 mosaic tile.
                    covers = (col.get('path_covers_small')
                              or col.get('path_covers_large') or [])[:4]
                    groups.append({'key': name, 'label': name,
                                   'count': count, 'downloaded': None,
                                   'kind': kind, 'covers': covers,
                                   'synced': name in synced_set})
                groups.sort(key=lambda x: (x['label'] or '').lower())

                # Virtual (autogenerated) collections render as their own
                # section. Keyed by their opaque base64 id; browse/download
                # only (no auto-sync), so the frontend disables the Y toggle.
                vgroups = []
                for col in (self._romm_virtual_collections or []):
                    name = col.get('name')
                    vid = col.get('id')
                    if not name or not vid:
                        continue
                    count = col.get('rom_count')
                    if count is None:
                        count = len(col.get('rom_ids') or [])
                    covers = (col.get('path_covers_small')
                              or col.get('path_covers_large') or [])[:4]
                    vgroups.append({'key': vid, 'label': name,
                                    'count': count, 'downloaded': None,
                                    'kind': 'virtual', 'covers': covers,
                                    'virtual': True, 'synced': False})
                vgroups.sort(key=lambda x: (x['label'] or '').lower())
                groups.extend(vgroups)
                return {'success': True, 'mode': mode, 'groups': groups,
                        'library_ready': ready}

            # default: platform
            # Offline: only downloaded games are playable, so restrict the index
            # to them — platforms with nothing downloaded drop out entirely.
            offline = self._is_offline()
            agg = {}
            for g in (self._available_games or []):
                if offline and not g.get('is_downloaded'):
                    continue
                label = self._platform_name_for(g)
                slug = g.get('platform_slug') or (g.get('romm_data') or {}).get('platform_slug')
                a = agg.setdefault(label, {'key': label, 'label': label, 'count': 0,
                                           'downloaded': 0, 'slug': slug, 'fs_slug': slug})
                a['count'] += 1
                if not a.get('slug') and slug:
                    a['slug'] = slug; a['fs_slug'] = slug
                if g.get('is_downloaded'):
                    a['downloaded'] += 1
            groups = sorted(agg.values(), key=lambda x: (x['label'] or '').lower())
            return {'success': True, 'mode': 'platform', 'groups': groups,
                    'library_ready': ready}
        except Exception as e:
            logging.error(f"get_library_groups error: {e}", exc_info=True)
            return {'success': False, 'groups': [], 'message': str(e)}

    @staticmethod
    def _serialize_game(g, is_downloaded=None):
        dl = g.get('is_downloaded') if is_downloaded is None else is_downloaded
        s = {
            'rom_id':        g.get('rom_id') or g.get('id'),
            # Prefer RomM's metadata title over the filename-derived 'name'.
            'name':          g.get('display_name') or g.get('name') or g.get('fs_name_no_ext') or g.get('fs_name') or 'Unknown',
            'platform':      g.get('platform'),
            'is_downloaded': dl,
            'has_cover':     bool(g.get('cover_path') or g.get('path_cover_small')),
            'platform_slug': g.get('platform_slug') or (g.get('romm_data') or {}).get('platform_slug'),
        }
        if g.get('is_multi_disc'):
            s['is_multi_disc'] = True
            s['disc_count'] = g.get('disc_count', 0)
        if g.get('sibling_roms'):
            s['sibling_roms'] = [
                {'rom_id': sib.get('id'), 'name': sib.get('name') or sib.get('fs_name_no_ext') or 'Variant'}
                for sib in g['sibling_roms']
            ]
            s['region_count'] = len(g['sibling_roms']) + 1
        return s

    async def get_library_games(self, mode: str, key: str):
        """Return the games for a group (platform name or collection name)."""
        try:
            if mode == 'collection':
                col_id = None
                for col in (self._romm_collections or []):
                    if col.get('name') == key:
                        col_id = col.get('id'); break
                if col_id is not None:
                    roms = self._romm_client.get_collection_roms(col_id) or []
                else:
                    # Fall back to virtual collections (keyed by opaque base64 id).
                    is_virtual = any(c.get('id') == key
                                     for c in (self._romm_virtual_collections or []))
                    if not is_virtual:
                        return {'success': False, 'games': [], 'message': 'Collection not found'}
                    roms = self._romm_client.get_virtual_collection_roms(key) or []
                idx = self._games_index()
                download_dir = Path(self._settings.get('Download', 'rom_directory',
                                                       _default_roms_dir())).expanduser()
                games = []
                for r in roms:
                    rid = r.get('id')
                    local = idx.get(rid)
                    is_downloaded = bool(local and local.get('is_downloaded'))
                    if not local:
                        # Sibling variants are folded under their MAIN rom in the
                        # grouped index, so idx misses them by id — check the
                        # variant's actual file on disk instead. Without this a
                        # downloaded variant reads as missing here, overstating
                        # the collection's missing count and making batch sync
                        # re-request files that already exist.
                        fs = r.get('fs_name')
                        slug = r.get('platform_slug')
                        if fs and slug:
                            is_downloaded = is_path_validly_downloaded(download_dir / slug / fs)
                    entry = {
                        'rom_id': rid,
                        'name': r.get('name') or (local or {}).get('display_name') or (local or {}).get('name') or r.get('fs_name_no_ext') or 'Unknown',
                        'platform': (local or {}).get('platform') or r.get('platform_name'),
                        'is_downloaded': is_downloaded,
                        'has_cover': bool(r.get('path_cover_small') or (local or {}).get('cover_path')),
                        'platform_slug': (local or {}).get('platform_slug') or r.get('platform_slug'),
                    }
                    if local and local.get('is_downloaded') and local.get('local_path'):
                        is_md, dc = _detect_multi_disc(local['local_path'], True)
                        entry['is_multi_disc'] = is_md
                        entry['disc_count'] = dc
                    sibs = r.get('sibling_roms') or (local or {}).get('sibling_roms') or []
                    if sibs:
                        entry['sibling_roms'] = [
                            {'rom_id': s.get('id'), 'name': s.get('name') or 'Variant'}
                            for s in sibs
                        ]
                        entry['region_count'] = len(sibs) + 1
                    games.append(entry)
                    if rid and rid not in idx and r.get('path_cover_small'):
                        self._cover_paths[rid] = r.get('path_cover_small')
                games.sort(key=lambda x: (x.get('name') or '').lower())
                return {'success': True, 'games': games}

            # platform
            offline = self._is_offline()
            games = []
            for g in (self._available_games or []):
                if self._platform_name_for(g) != key:
                    continue
                if offline and not g.get('is_downloaded'):
                    continue  # offline: only show playable (downloaded) games
                sg = self._serialize_game(g)
                sg['platform'] = key  # resolved label, not the raw (maybe-Unknown) field
                games.append(sg)
            games.sort(key=lambda x: (x.get('name') or '').lower())
            return {'success': True, 'games': games}
        except Exception as e:
            logging.error(f"get_library_games error: {e}", exc_info=True)
            return {'success': False, 'games': [], 'message': str(e)}

    async def search_games(self, query: str):
        """Search the whole library, mirroring RomM's Search view.

        Uses the server's `search_term` (matches filename + metadata, not just
        the display name), then merges in local download state. Falls back to an
        in-memory name filter if the server query fails or the client is down.
        """
        q = (query or '').strip()
        offline = self._is_offline()
        if not q:
            # Mirror RomM's Search view: with no term, show the whole library
            # (downloaded-only while offline).
            try:
                out = []
                for g in (self._available_games or []):
                    if offline and not g.get('is_downloaded'):
                        continue
                    sg = self._serialize_game(g)
                    sg['platform'] = self._platform_name_for(g)
                    out.append(sg)
                out.sort(key=lambda x: (x.get('name') or '').lower())
                return {'success': True, 'games': out}
            except Exception as e:
                logging.error(f"search_games (browse) error: {e}", exc_info=True)
                return {'success': False, 'games': [], 'message': str(e)}
        try:
            roms = []
            if self._romm_client:
                try:
                    roms = self._romm_client.search_roms(q) or []
                except Exception as e:
                    logging.warning(f"server search failed, falling back: {e}")
                    roms = []
            if roms:
                # /api/roms is ungrouped: a multi-region or multi-disc game comes
                # back as one row per variant, so an unfiltered render showed the
                # same game two to a dozen times. Collapse it the way the browsed
                # library is collapsed — first within the result set itself (this
                # is all we have during the very first fetch, when there is no
                # library yet), then onto the parent entry the library already
                # holds, which also catches groups whose parent row didn't match
                # the search term.
                roms = self._romm_client._group_sibling_roms(roms)
                idx = self._games_index()
                parents = self._variant_parent_index()
                out = []
                seen = set()
                for r in roms:
                    rid = r.get('id')
                    pid = parents.get(rid)
                    if pid and pid != rid and pid in idx:
                        # Fold onto the library's entry for the group; the row we
                        # matched is one of its variants, not its own game.
                        parent = idx[pid]
                        r = dict(r, id=pid,
                                 name=(parent.get('display_name') or parent.get('name')
                                       or r.get('name')),
                                 path_cover_small=(parent.get('cover_path')
                                                   or r.get('path_cover_small')),
                                 sibling_roms=(parent.get('sibling_roms')
                                               or r.get('sibling_roms') or []))
                        rid = pid
                    if rid is not None:
                        if rid in seen:
                            continue
                        seen.add(rid)
                    local = idx.get(rid)
                    entry = {
                        'rom_id': rid,
                        'name': r.get('name') or (local or {}).get('display_name') or (local or {}).get('name') or r.get('fs_name_no_ext') or 'Unknown',
                        'platform': (local or {}).get('platform') or r.get('platform_name'),
                        'is_downloaded': bool(local and local.get('is_downloaded')),
                        'has_cover': bool(r.get('path_cover_small') or (local or {}).get('cover_path')),
                        'platform_slug': (local or {}).get('platform_slug') or r.get('platform_slug'),
                    }
                    if local and local.get('is_downloaded') and local.get('local_path'):
                        is_md, dc = _detect_multi_disc(local['local_path'], True)
                        entry['is_multi_disc'] = is_md
                        entry['disc_count'] = dc
                    sibs = r.get('sibling_roms') or (local or {}).get('sibling_roms') or []
                    if sibs:
                        entry['sibling_roms'] = [
                            {'rom_id': s.get('id'), 'name': s.get('name') or 'Variant'}
                            for s in sibs
                        ]
                        entry['region_count'] = len(sibs) + 1
                    out.append(entry)
                    if rid and rid not in idx and r.get('path_cover_small'):
                        self._cover_paths[rid] = r.get('path_cover_small')
                out.sort(key=lambda x: (x.get('name') or '').lower())
                return {'success': True, 'games': out}

            # Fallback: in-memory name filter (offline / search error). Offline
            # shows only downloaded games, matching the rest of the library.
            ql = q.lower()
            out = []
            for g in (self._available_games or []):
                if offline and not g.get('is_downloaded'):
                    continue
                if ql in (g.get('name') or '').lower():
                    sg = self._serialize_game(g)
                    sg['platform'] = self._platform_name_for(g)
                    out.append(sg)
            out.sort(key=lambda x: (x.get('name') or '').lower())
            return {'success': True, 'games': out[:200]}
        except Exception as e:
            logging.error(f"search_games error: {e}", exc_info=True)
            return {'success': False, 'games': [], 'message': str(e)}

    # -----------------------------------------------------------------------
    # Cover-art disk cache  (~/.config/ludo/cover_cache/)
    #
    # Persists decoded cover/screenshot bytes across plugin reloads so art is
    # never re-fetched from RomM after the first load — and is served even
    # before the RomM client re-authenticates. Stores RAW image bytes (compact);
    # the data URI is rebuilt on read. Keyed by sha1 of a stable string key.
    # -----------------------------------------------------------------------
    # Per-image timing+source to the plugin log — how we tell apart a slow
    # network fetch from a slow disk read, a big payload, or event-loop
    # contention when covers feel laggy. Off by default; set ROMM_COVER_TRACE=1
    # to re-enable. Only logs non-memory paths so volume stays low.
    _cover_trace = bool(os.environ.get('ROMM_COVER_TRACE'))

    def _trace_cover(self, kind: str, key, src: str, t0: float, nbytes: int = 0):
        if not self._cover_trace:
            return
        try:
            ms = (time.monotonic() - t0) * 1000.0
            logging.info(f"[cover] {kind} {key} src={src} {ms:.0f}ms "
                         f"{nbytes/1024:.0f}KB mem={len(self._cover_cache)}")
        except Exception:
            pass

    # Grid covers render at ~150px; serving the full ~200KB RomM art means
    # ~16MB of base64 hits the websocket + UI-thread JSON.parse in one burst
    # when a platform opens (the freeze). Downscale to a small JPEG thumbnail
    # (~15KB) before caching/serving. Width chosen for 2x retina of the cell.
    _THUMB_W = 360
    _THUMB_W_LARGE = 640  # detail-page hero uses a bigger cover

    _COVER_CACHE_MAX = 2000   # ~50MB of thumbnails; one Home page alone hit 600

    def _cover_cache_put(self, ck, uri):
        """Insert into the in-memory cache, enforcing a bound on EVERY insert
        (the old code only capped on the network path, so disk hits grew it
        unbounded — 800+ thumbnails ≈ hundreds of MB resident).

        Evicts the least-recently-used entry rather than clearing the whole
        dict: a flush at the bound sent every visible tile back to a disk read
        mid-scroll, so a big library got slower the longer you browsed. dicts
        preserve insertion order, so re-inserting on hit (see _cover_cache_get)
        makes the first key the LRU one."""
        self._cover_cache.pop(ck, None)
        self._cover_cache[ck] = uri
        while len(self._cover_cache) > self._COVER_CACHE_MAX:
            self._cover_cache.pop(next(iter(self._cover_cache)), None)

    def _cover_cache_get(self, ck):
        """Return a cached data URI (marking it most-recently-used), or None."""
        uri = self._cover_cache.get(ck)
        if uri is not None:
            # Re-insert at the end so this key is no longer the eviction target.
            self._cover_cache.pop(ck, None)
            self._cover_cache[ck] = uri
        return uri

    def _store_thumb(self, ck, thumb_key, raw, mime, large):
        """Downscale raw bytes → thumbnail, persist under thumb_key, mem-cache
        and return the data URI."""
        tb, tmime = self._make_thumb(raw, large)
        mime = tmime or mime or 'image/jpeg'
        uri = f"data:{mime};base64,{base64.b64encode(tb).decode('ascii')}"
        self._disk_cover_put(thumb_key, mime, tb)
        self._cover_cache_put(ck, uri)
        return uri

    def _make_thumb(self, content: bytes, large: bool = False):
        """Compact an image for grid display. Returns (bytes, mime).

        RomM 'small' covers are already ~small resolution but ship as ~200KB
        PNGs, so the real win is re-encoding to JPEG (≈30KB), not resizing.
        We downscale only when wider than the target, then always try a JPEG
        re-encode and keep it when it actually shrinks the payload. Small
        images with real transparency (platform icons) are left untouched so
        they don't get a black background. Falls back to the original bytes if
        PIL is missing or anything fails."""
        if not PIL_AVAILABLE:
            return content, None
        try:
            import io
            max_w = self._THUMB_W_LARGE if large else self._THUMB_W
            im = Image.open(io.BytesIO(content))
            # Preserve small transparent assets (icons) as-is.
            has_alpha = ('A' in im.getbands())
            if has_alpha and len(content) < 60_000:
                return content, None
            if im.width > max_w:
                h = round(im.height * (max_w / im.width))
                im = im.resize((max_w, h), Image.LANCZOS)
            out = io.BytesIO()
            im.convert('RGB').save(out, format='JPEG', quality=82, optimize=True)
            jpeg = out.getvalue()
            # Only adopt the JPEG if it's a real win (it nearly always is for
            # the big PNG covers; guards against bloating already-tiny art).
            if len(jpeg) < len(content):
                return jpeg, 'image/jpeg'
            return content, None
        except Exception as e:
            logging.debug(f"_make_thumb failed: {e}")
            return content, None

    # Bumped when a key scheme changes and makes existing files unreachable.
    # v3: cover-art keys dropped the ?ts= query and rom covers moved under
    # covt2:<rom_id>, orphaning every imgt2 file written before this.
    _COVER_CACHE_FORMAT = 3

    def _cover_dir(self):
        d = CONFIG_DIR / 'cover_cache'
        try:
            d.mkdir(parents=True, exist_ok=True)
            self._migrate_cover_dir(d)
        except Exception:
            pass
        return d

    _cover_fmt_checked = False
    # Held for the whole wipe. Cover fetches run on several worker threads at
    # once, so without this the first thread in would set the "done" flag, let
    # the others straight through, and then delete the covers they had just
    # written — silently, and only on the one launch after an upgrade.
    _cover_fmt_lock = threading.Lock()

    def _migrate_cover_dir(self, d):
        """Drop cache files stranded by a key-scheme change, once per upgrade.

        Safe by construction: this directory is a pure cache, so the worst case
        is refetching art. Without it the orphans would sit there occupying the
        prune budget and never be read again."""
        if self._cover_fmt_checked:
            return
        with self._cover_fmt_lock:
            if self._cover_fmt_checked:
                return
            self._migrate_cover_dir_locked(d)
            self.__class__._cover_fmt_checked = True

    def _migrate_cover_dir_locked(self, d):
        marker = d / '.format'
        try:
            have = int(marker.read_text().strip())
        except Exception:
            have = 0
        if have >= self._COVER_CACHE_FORMAT:
            return
        removed = 0
        for p in d.iterdir():
            if p.name == '.format':
                continue
            try:
                p.unlink()
                removed += 1
            except Exception:
                pass
        try:
            marker.write_text(str(self._COVER_CACHE_FORMAT))
        except Exception:
            pass
        if removed:
            logging.info(f"cover cache format v{have} -> v{self._COVER_CACHE_FORMAT}: "
                         f"cleared {removed} stranded files")

    def _disk_cover_get(self, key: str):
        """Return a data URI from disk for `key`, or None if not cached."""
        try:
            stem = hashlib.sha1(key.encode()).hexdigest()
            d = self._cover_dir()
            for f in d.glob(stem + '.*'):
                data = f.read_bytes()
                if not data:
                    return None
                mime = mimetypes.guess_type(f.name)[0] or 'image/jpeg'
                try:
                    os.utime(f, None)  # bump mtime → cheap LRU for pruning
                except Exception:
                    pass
                return f"data:{mime};base64,{base64.b64encode(data).decode('ascii')}"
        except Exception:
            pass
        return None

    def _disk_cover_get_bytes(self, key: str):
        """Return (raw_bytes, mime) from disk for `key`, or (None, None)."""
        try:
            stem = hashlib.sha1(key.encode()).hexdigest()
            for f in self._cover_dir().glob(stem + '.*'):
                data = f.read_bytes()
                if not data:
                    return None, None
                return data, (mimetypes.guess_type(f.name)[0] or 'image/jpeg')
        except Exception:
            pass
        return None, None

    def _disk_cover_put(self, key: str, mime: str, content: bytes):
        """Write raw cover bytes to disk for `key`; prune occasionally."""
        try:
            ext = mimetypes.guess_extension(mime) or '.jpg'
            if ext == '.jpe':
                ext = '.jpg'
            stem = hashlib.sha1(key.encode()).hexdigest()
            (self._cover_dir() / (stem + ext)).write_bytes(content)
            self._prune_cover_dir()
        except Exception:
            pass

    # Budget by bytes, not file count: thumbnails run ~10-30KB but screenshots
    # and alpha-preserved art don't, so a file cap bounded the wrong quantity.
    # 512MB holds ~20k thumbnails — a large library browsed end to end — and is
    # a rounding error against a ROM collection's own footprint.
    _COVER_DIR_MAX_BYTES = 512 * 1024 * 1024
    _COVER_DIR_MAX_FILES = 40000

    def _prune_cover_dir(self, cap: int = None):
        """Keep the cache bounded: when over budget, drop the least recently
        READ files (mtime is bumped on every disk hit) until 20% under it.
        Runs ~1 call in 40 (writes) to keep the stat cost negligible."""
        try:
            import random
            if random.randint(0, 39) != 0:
                return
            cap = cap or self._COVER_DIR_MAX_FILES
            entries = []
            total = 0
            for p in self._cover_dir().iterdir():
                if p.name == '.format':  # deleting it would re-trigger the wipe
                    continue
                try:
                    st = p.stat()
                except Exception:
                    continue
                entries.append((st.st_mtime, st.st_size, p))
                total += st.st_size
            if total <= self._COVER_DIR_MAX_BYTES and len(entries) <= cap:
                return
            # Evict oldest-first down to 80% of both budgets, so a prune buys a
            # long quiet stretch instead of re-running on the very next write.
            entries.sort(key=lambda e: e[0])
            want_bytes = int(self._COVER_DIR_MAX_BYTES * 0.8)
            want_files = int(cap * 0.8)
            nfiles = len(entries)
            removed = 0
            for _, size, p in entries:
                if total <= want_bytes and nfiles <= want_files:
                    break
                try:
                    p.unlink()
                    total -= size
                    nfiles -= 1
                    removed += 1
                except Exception:
                    pass
            if removed:
                logging.info(f"cover cache pruned {removed} files "
                             f"({total / 1048576:.0f}MB / {nfiles} left)")
        except Exception:
            pass

    async def clear_cover_cache(self):
        """Wipe the cover-art caches (memory + disk). Use after RomM art changes."""
        try:
            self._cover_cache = {}
            removed = 0
            d = self._cover_dir()
            for f in d.iterdir():
                try:
                    f.unlink()
                    removed += 1
                except Exception:
                    pass
            logging.info(f"Cleared cover cache ({removed} files)")
            return {'success': True, 'removed': removed}
        except Exception as e:
            logging.error(f"clear_cover_cache error: {e}", exc_info=True)
            return {'success': False, 'message': str(e)}

    async def get_game_cover(self, rom_id: int, large: bool = False):
        """Return a base64 data URI for a game's cover art (cached).

        The in-memory hit is served inline; disk reads + RomM HTTP fetches are
        blocking, so they run in a worker thread to avoid freezing the asyncio
        event loop (which would stall every other plugin RPC and the whole UI).
        """
        ck = (rom_id, large)
        hit = self._cover_cache_get(ck)
        if hit is not None:
            return {'success': True, 'data_uri': hit}
        return await asyncio.to_thread(self._get_game_cover_blocking, rom_id, large)

    def _get_game_cover_blocking(self, rom_id: int, large: bool = False):
        t0 = time.monotonic()
        try:
            ck = (rom_id, large)
            hit = self._cover_cache_get(ck)
            if hit is not None:
                return {'success': True, 'data_uri': hit}
            # Thumbnail disk cache (v2). The compact downscaled art.
            tkey = f"covt2:{rom_id}:{large}"
            disk = self._disk_cover_get(tkey)
            if disk:
                self._cover_cache_put(ck, disk)
                self._trace_cover('cover', rom_id, 'disk', t0, len(disk))
                return {'success': True, 'data_uri': disk}
            # Reuse a full-size cover already on disk (legacy v1 cache) →
            # downscale locally instead of re-downloading from RomM.
            raw, mime = self._disk_cover_get_bytes(f"cover:{rom_id}:{large}")
            if raw:
                uri = self._store_thumb(ck, tkey, raw, mime, large)
                self._trace_cover('cover', rom_id, 'disk-orig', t0, len(uri))
                return {'success': True, 'data_uri': uri}
            if not (self._romm_client and self._romm_client.authenticated):
                return {'success': False, 'data_uri': None}
            idx = self._games_index()
            g = idx.get(rom_id) or {}
            path = (g.get('cover_path_large') if large else g.get('cover_path')) \
                or g.get('cover_path') or self._cover_paths.get(rom_id)
            if not path:
                # fall back to the ROM detail endpoint
                r = self._romm_client.session.get(
                    urljoin(self._romm_client.base_url, f'/api/roms/{rom_id}'), timeout=10)
                if r.status_code == 200:
                    d = r.json()
                    path = (d.get('path_cover_large') if large else d.get('path_cover_small')) \
                        or d.get('path_cover_small') or d.get('path_cover_large')
                elif not path:
                    # Couldn't even ask where the art is — transient, so don't
                    # let it be cached as a permanent "no cover".
                    logging.warning(f"cover {rom_id}: detail lookup -> {r.status_code}")
                    return {'success': False, 'data_uri': None}
            # A genuine "this rom has no art" — safe (and desirable) to cache.
            if not path:
                return {'success': True, 'data_uri': None}
            resp = self._romm_client.session.get(
                urljoin(self._romm_client.base_url, path), timeout=20)
            if resp.status_code != 200 or not resp.content:
                # success=False, NOT a cached "no art". The frontend caches any
                # CONFIRMED result forever, so reporting a server hiccup as
                # "this game has no cover" left the tile permanently blank —
                # immune to leaving and re-entering the page, for the rest of
                # the session. Bursty loads (one Home page fired 719 image
                # requests in 70s) are exactly when a server starts refusing.
                logging.warning(f"cover {rom_id}: {path} -> {resp.status_code} "
                                f"({len(resp.content or b'')} bytes)")
                # 404 is the server answering definitively: the art isn't there.
                # Cache that. Anything else (5xx, a truncated body) is the
                # server struggling, and must stay refetchable.
                return {'success': resp.status_code == 404, 'data_uri': None}
            mime = resp.headers.get('content-type') or mimetypes.guess_type(path)[0] or 'image/jpeg'
            uri = self._store_thumb(ck, tkey, resp.content, mime, large)
            self._trace_cover('cover', rom_id, 'net', t0, len(uri))
            return {'success': True, 'data_uri': uri}
        except Exception as e:
            logging.error(f"get_game_cover error: {e}", exc_info=True)
            return {'success': False, 'data_uri': None}

    async def get_image(self, path: str):
        """Return a base64 data URI for an arbitrary RomM resource path (cached).

        Used by collection mosaic tiles, whose cover paths come from the
        collection object (path_covers_small) rather than a single rom_id.
        In-memory hit served inline; blocking disk/HTTP offloaded to a thread
        so the event loop (and the whole UI) never stalls on image I/O.
        """
        if not path:
            return {'success': True, 'data_uri': None}
        # A rom cover asked for by path is the same bytes get_game_cover already
        # caches by id — serve it from there instead of storing a second copy
        # under an unrelated key.
        rom = self._rom_cover_path(path)
        if rom:
            return await self.get_game_cover(rom[0], rom[1])
        ck = ('img', self._img_key(path))
        hit = self._cover_cache_get(ck)
        if hit is not None:
            return {'success': True, 'data_uri': hit}
        return await asyncio.to_thread(self._get_image_blocking, path)

    # RomM cache-busts resource URLs with ?ts=<updated_at>. That query belongs in
    # the HTTP request but NOT in the cache key: keyed with it, every touch of a
    # rom's updated_at orphaned its cached art forever and the next view was a
    # fresh download. (Measured on a 2.4k-game library: 3432 of 3598 cached files
    # were unreachable orphans.) The ts still reaches the server via the fetch
    # URL, so a genuinely changed image is still refetched — the disk entry is
    # simply overwritten in place rather than abandoned.
    @staticmethod
    def _img_key(path: str) -> str:
        return (path or '').split('?', 1)[0]

    # /assets/romm/resources/roms/<platform>/<rom_id>/cover/{small,big}.png
    _ROM_COVER_RE = re.compile(r'/roms/\d+/(\d+)/cover/(small|big)\b')

    @classmethod
    def _rom_cover_path(cls, path: str):
        """(rom_id, large) if `path` is a rom's own cover art, else None."""
        m = cls._ROM_COVER_RE.search(cls._img_key(path))
        return (int(m.group(1)), m.group(2) == 'big') if m else None

    def _get_image_blocking(self, path: str):
        t0 = time.monotonic()
        try:
            key = self._img_key(path)
            ck = ('img', key)
            hit = self._cover_cache_get(ck)
            if hit is not None:
                return {'success': True, 'data_uri': hit}
            tkey = f"imgt2:{key}"
            disk = self._disk_cover_get(tkey)
            if disk:
                self._cover_cache_put(ck, disk)
                self._trace_cover('img', path, 'disk', t0, len(disk))
                return {'success': True, 'data_uri': disk}
            # Downscale a full-size image already on disk (legacy v1) in place.
            raw, mime = self._disk_cover_get_bytes(f"img:{key}")
            if raw:
                uri = self._store_thumb(ck, tkey, raw, mime, False)
                self._trace_cover('img', path, 'disk-orig', t0, len(uri))
                return {'success': True, 'data_uri': uri}
            if not (self._romm_client and self._romm_client.authenticated):
                return {'success': False, 'data_uri': None}
            resp = self._romm_client.session.get(
                urljoin(self._romm_client.base_url, path), timeout=20)
            if resp.status_code != 200 or not resp.content:
                # Transient, not "no screenshot" — see get_game_cover above.
                logging.warning(f"image {path} -> {resp.status_code} "
                                f"({len(resp.content or b'')} bytes)")
                return {'success': resp.status_code == 404, 'data_uri': None}
            mime = resp.headers.get('content-type') or mimetypes.guess_type(path)[0] or 'image/png'
            uri = self._store_thumb(ck, tkey, resp.content, mime, False)
            self._trace_cover('img', path, 'net', t0, len(uri))
            return {'success': True, 'data_uri': uri}
        except Exception as e:
            logging.error(f"get_image error: {e}", exc_info=True)
            return {'success': False, 'data_uri': None}

    async def get_plugin_logo(self):
        """Return the plugin's bundled logo as a base64 data URI + raw base64.

        Used by the frontend to paint custom artwork on the optional 'RomM'
        Steam library shortcut (SteamClient.SetCustomArtworkForApp wants raw
        base64, while <img> wants a data URI).
        """
        try:
            import base64
            logo = Path(__file__).parent / "assets" / "logo.png"
            if not logo.exists():
                return {'success': False, 'b64': None, 'data_uri': None}
            raw = base64.b64encode(logo.read_bytes()).decode('ascii')
            return {'success': True, 'b64': raw, 'data_uri': f"data:image/png;base64,{raw}", 'ext': 'png'}
        except Exception as e:
            logging.error(f"get_plugin_logo error: {e}", exc_info=True)
            return {'success': False, 'b64': None, 'data_uri': None}

    async def get_romm_artwork(self):
        """Return RomM-branded Steam artwork for every asset type as raw base64.

        Keys are Steam's eAppArtworkAssetType values:
            0 grid (portrait), 1 hero, 2 logo (transparent), 3 header, 4 icon.
        The frontend paints these onto the optional 'RomM' library shortcut via
        SetCustomArtworkForApp. PNGs are pre-rendered (scripts/gen_romm_artwork.py)
        and bundled, so no SVG/PIL work happens at runtime.
        """
        try:
            import base64
            assets = Path(__file__).parent / "assets"
            files = {0: "romm-grid.png", 1: "romm-hero.png", 2: "romm-logo.png",
                     3: "romm-header.png", 4: "romm-icon.png"}
            out = {}
            for atype, fname in files.items():
                p = assets / fname
                if p.exists():
                    out[str(atype)] = base64.b64encode(p.read_bytes()).decode('ascii')
            return {'success': bool(out), 'art': out, 'ext': 'png'}
        except Exception as e:
            logging.error(f"get_romm_artwork error: {e}", exc_info=True)
            return {'success': False, 'art': {}}

    async def get_romm_logo(self):
        """Return RomM's bundled isotipo (brand mark) as an SVG data URI.

        Bundled in the plugin assets so the setup wizard can show the real RomM
        logo before any server connection exists (server assets need auth).
        """
        try:
            import base64
            iso = Path(__file__).parent / "assets" / "romm-isotipo.svg"
            if not iso.exists():
                return {'success': False, 'data_uri': None}
            raw = base64.b64encode(iso.read_bytes()).decode('ascii')
            return {'success': True, 'data_uri': f"data:image/svg+xml;base64,{raw}"}
        except Exception as e:
            logging.error(f"get_romm_logo error: {e}", exc_info=True)
            return {'success': False, 'data_uri': None}

    async def get_retrodeck_logo(self):
        """Return RetroDECK's bundled brand mark as an SVG data URI for the
        optional 'Launch RetroDECK' button in the top bar."""
        try:
            import base64
            svg = Path(__file__).parent / "assets" / "retrodeck.svg"
            if not svg.exists():
                return {'success': False, 'data_uri': None}
            raw = base64.b64encode(svg.read_bytes()).decode('ascii')
            return {'success': True, 'data_uri': f"data:image/svg+xml;base64,{raw}"}
        except Exception as e:
            logging.error(f"get_retrodeck_logo error: {e}", exc_info=True)
            return {'success': False, 'data_uri': None}

    async def get_steam_tile_status(self):
        """Whether the desktop shell's Steam library tile exists.

        Desktop-only: on the Deck the plugin owns its tile through SteamClient's
        live shortcut API, and never touches shortcuts.vdf. Returns
        {'available', 'installed', 'appid', 'steam_running', 'reason'}."""
        try:
            return get_desktop_tile_status()
        except Exception as e:
            logging.error(f"get_steam_tile_status error: {e}", exc_info=True)
            return {'available': False, 'installed': False, 'appid': None,
                    'steam_running': False, 'reason': str(e)}

    async def set_steam_tile(self, enabled: bool, exe: str = '', start_dir: str = '',
                             launch_options: str = ''):
        """Add or remove the RomM tile in Steam's shortcuts.vdf.

        `exe`/`start_dir`/`launch_options` describe how to relaunch THIS shell and
        come from the Electron main process (window.__rommDesktop.launchSpec) —
        the backend can't know whether it was started from an AppImage, a dev
        checkout or a packaged binary."""
        try:
            if not enabled:
                return remove_desktop_tile()
            if not exe:
                return {'success': False, 'message': 'No launch command supplied'}
            icon = Path(__file__).parent / "assets" / "romm-icon.png"
            return add_desktop_tile(
                exe, start_dir=start_dir, launch_options=launch_options,
                icon=str(icon) if icon.exists() else '',
                assets_dir=Path(__file__).parent / "assets",
            )
        except Exception as e:
            logging.error(f"set_steam_tile error: {e}", exc_info=True)
            return {'success': False, 'message': str(e)}

    async def launch_retrodeck(self):
        """Launch RetroDECK directly, without Steam.

        The Deck's Gaming Mode path goes through SteamClient.Apps.RunGame so the
        session is Steam-tracked, but there is no SteamClient in the Electron
        desktop shell — this is the fallback it calls instead. Tries the flatpak
        (how RetroDECK ships) and then a plain `retrodeck` on PATH.
        Returns {'ok': bool, 'reason': str|None}."""
        candidates = [
            ['flatpak', 'run', 'net.retrodeck.retrodeck'],
            ['retrodeck'],
        ]
        # ~/.var/app/<id> is the app's DATA dir, not proof of installation: it
        # survives an uninstall, and a system-wide install that has never been
        # launched doesn't have one at all. Ask the shared detector instead —
        # it checks the deployment dirs (including /run/host for sandboxed
        # shells) and only falls back to `flatpak info`.
        flatpak_installed = flatpak_app_installed('net.retrodeck.retrodeck')
        for argv in candidates:
            if not shutil.which(argv[0]):
                continue
            # `flatpak run` on a missing app exits non-zero after we've already
            # returned ok — only offer it when the app really is installed.
            if argv[0] == 'flatpak' and not flatpak_installed:
                continue
            try:
                subprocess.Popen(
                    argv, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                    start_new_session=True,
                )
                logging.info(f"Launched RetroDECK via {' '.join(argv)}")
                return {'ok': True, 'reason': None}
            except Exception as e:
                logging.error(f"launch_retrodeck {argv[0]} error: {e}")
        return {'ok': False, 'reason': 'RetroDECK not found on this system'}

    async def get_ra_earned(self, ra_id: int):
        """Earned achievement badge ids for a game's ra_id, fetched on its own so
        the game detail can render immediately and fill in earned state after.
        Returns {'earned': [badge_id, ...]}."""
        try:
            if not (ra_id and self._romm_client and self._romm_client.authenticated):
                return {'earned': []}
            mr = self._romm_client.session.get(
                urljoin(self._romm_client.base_url, '/api/users/me'), timeout=10)
            me = mr.json() if mr.status_code == 200 else {}
            for prog in ((me.get('ra_progression') or {}).get('results') or []):
                if prog.get('rom_ra_id') == ra_id:
                    return {'earned': [str(e.get('id'))
                                       for e in (prog.get('earned_achievements') or [])
                                       if e.get('id') is not None]}
        except Exception as e:
            logging.debug(f"get_ra_earned error: {e}")
        return {'earned': []}

    async def get_game_detail(self, rom_id: int):
        """Return IGDB-style metadata + files + local state for a game."""
        try:
            if not (self._romm_client and self._romm_client.authenticated):
                return {'success': False, 'message': 'Not connected to RomM'}
            r = self._romm_client.session.get(
                urljoin(self._romm_client.base_url, f'/api/roms/{rom_id}'), timeout=15)
            if r.status_code != 200:
                return {'success': False, 'message': f'HTTP {r.status_code}'}
            d = r.json()
            meta = d.get('metadatum') or d.get('igdb_metadata') or {}

            def _names(val):
                out = []
                for x in (val or []):
                    if isinstance(x, dict):
                        out.append(x.get('name') or x.get('slug'))
                    elif x:
                        out.append(str(x))
                return [x for x in out if x]

            local = self._games_index().get(rom_id) or {}
            files = []
            for f in (d.get('files') or []):
                files.append({'name': f.get('file_name') or f.get('fs_name'),
                              'size': f.get('file_size_bytes') or f.get('size_bytes')})

            # RetroAchievements — mirror RomM's GameDetails wiring: the rom's
            # merged_ra_metadata.achievements list, with each achievement marked
            # earned when its badge_id is in the user's progression set for this
            # game (located by rom_ra_id == rom.ra_id). Badge art uses the public
            # RetroAchievements CDN URLs so the frontend <img> can load directly.
            # Earned state is fetched separately (get_ra_earned) so this response
            # never blocks on the extra /api/users/me round-trip. Achievements
            # render immediately as not-earned; the frontend fills in earned after.
            achievements = []
            ra_id = d.get('ra_id')
            earned_ids = set()
            ra_meta = d.get('merged_ra_metadata') or {}
            raw_ach = sorted((ra_meta.get('achievements') or []),
                             key=lambda a: (a.get('display_order') if a.get('display_order') is not None else 1e9))
            for a in raw_ach:
                bid = a.get('badge_id')
                achievements.append({
                    'ra_id': a.get('ra_id'),
                    'title': a.get('title') or '',
                    'description': a.get('description') or '',
                    'points': a.get('points') or 0,
                    'type': a.get('type') or '',
                    'badge_id': str(bid) if bid is not None else None,
                    'badge_url': a.get('badge_url'),
                    'badge_url_lock': a.get('badge_url_lock'),
                    'earned': bool(bid is not None and str(bid) in earned_ids),
                })

            # ── HLTB durations (RomM HLTBStrip) ──────────────────────────────
            hltb_src = d.get('hltb_metadata') or meta.get('hltb_metadata') or {}
            hltb = {
                'main_story':            hltb_src.get('main_story'),
                'main_story_count':      hltb_src.get('main_story_count'),
                'main_plus_extra':       hltb_src.get('main_plus_extra'),
                'main_plus_extra_count': hltb_src.get('main_plus_extra_count'),
                'completionist':         hltb_src.get('completionist'),
                'completionist_count':   hltb_src.get('completionist_count'),
                'all_styles':            hltb_src.get('all_styles'),
                'all_styles_count':      hltb_src.get('all_styles_count'),
            } if hltb_src else None

            # ── Age ratings (RomM AgeRatingBadges) ───────────────────────────
            # Resolve each merged rating string to {category, rating, icon_url},
            # recovering the IGDB icon URL from the igdb/ss provider lists or by
            # the "CATEGORY:RATING" convention. Mirrors AgeRatingBadges.vue.
            _CAT_SLUG = {'ESRB': 'esrb', 'PEGI': 'pegi', 'CERO': 'cero', 'USK': 'usk',
                         'GRAC': 'grac', 'CLASS_IND': 'class_ind', 'ACB': 'acb'}
            def _igdb_icon(category, rating):
                slug = _CAT_SLUG.get((category or '').strip().upper())
                if not slug or not rating:
                    return None
                norm = str(rating).lower().replace('+', '')
                return f"https://www.igdb.com/icons/rating_icons/{slug}/{slug}_{norm}.png"
            igdb_meta = d.get('igdb_metadata') or {}
            ss_meta = d.get('ss_metadata') or {}
            _igdb_by = {str(r.get('rating')).strip(): r for r in (igdb_meta.get('age_ratings') or []) if isinstance(r, dict)}
            _ss_by = {str(r.get('rating')).strip(): r for r in (ss_meta.get('age_ratings') or []) if isinstance(r, dict)}
            age_ratings = []
            for entry in (meta.get('age_ratings') or []):
                if not isinstance(entry, str):
                    continue
                e = entry.strip()
                if ':' in e:
                    cat, _, rat = e.partition(':')
                    cat, rat = cat.strip(), rat.strip()
                    age_ratings.append({'category': cat, 'rating': rat, 'icon_url': _igdb_icon(cat, rat)})
                elif e in _igdb_by:
                    m = _igdb_by[e]
                    age_ratings.append({'category': m.get('category') or '', 'rating': m.get('rating') or e,
                                        'icon_url': m.get('rating_cover_url') or _igdb_icon(m.get('category'), m.get('rating'))})
                elif e in _ss_by:
                    m = _ss_by[e]
                    age_ratings.append({'category': m.get('category') or '', 'rating': m.get('rating') or e,
                                        'icon_url': _igdb_icon(m.get('category'), m.get('rating'))})
                else:
                    age_ratings.append({'category': '', 'rating': e, 'icon_url': None})

            # ── Related games (RomM RelatedGamesGrid) ────────────────────────
            def _related(key):
                out = []
                for g in (igdb_meta.get(key) or []):
                    if not isinstance(g, dict):
                        continue
                    out.append({'id': g.get('id'), 'name': g.get('name') or '',
                                'slug': g.get('slug'), 'cover_url': g.get('cover_url')})
                return out
            related = {
                'expansions': _related('expansions'),
                'dlcs':       _related('dlcs'),
                'remakes':    _related('remakes'),
                'remasters':  _related('remasters'),
                'similar':    _related('similar_games'),
            }

            # ── Provider ids + verification (RomM MetadataTab / providers.ts) ─
            providers = {k: d.get(k) for k in (
                'igdb_id', 'moby_id', 'ss_id', 'ra_id', 'sgdb_id',
                'launchbox_id', 'hasheous_id', 'flashpoint_id', 'hltb_id')}
            hashes = {'crc': d.get('crc_hash'), 'md5': d.get('md5_hash'),
                      'sha1': d.get('sha1_hash'), 'ra': d.get('ra_hash')}
            hh = d.get('hasheous_metadata') or {}
            verifications = [
                {'label': 'TOSEC',    'match': bool(hh.get('tosec_match'))},
                {'label': 'No-Intro', 'match': bool(hh.get('nointro_match'))},
                {'label': 'Redump',   'match': bool(hh.get('redump_match'))},
                {'label': 'FBNeo',    'match': bool(hh.get('fbneo_match'))},
                {'label': 'MAME',     'match': bool(hh.get('mame_arcade_match') or hh.get('mame_mess_match'))},
                {'label': 'RA',       'match': bool(d.get('ra_id'))},
            ]

            return {
                'success': True,
                'rom_id': rom_id,
                'name': d.get('name') or local.get('name') or 'Unknown',
                'fs_name': d.get('fs_name') or local.get('file_name'),
                'platform': (d.get('platform_display_name') or d.get('platform_custom_name')
                             or d.get('platform_name') or d.get('platform_slug') or local.get('platform')),
                'summary': d.get('summary') or meta.get('summary') or '',
                'genres': _names(d.get('genres') or meta.get('genres')),
                'franchises': _names(d.get('franchises') or meta.get('franchises')),
                'companies': _names(d.get('companies') or meta.get('companies')),
                'release_date': d.get('first_release_date') or meta.get('first_release_date'),
                'rating': meta.get('total_rating') or d.get('total_rating'),
                # Header chips + Overview extras (RomM GameHeader / OverviewTab).
                'regions':      _names(d.get('regions')),
                'languages':    _names(d.get('languages')),
                'tags':         _names(d.get('tags')),
                'collections':  _names(meta.get('collections')),  # IGDB series (metadatum)
                'user_collections': _names(d.get('user_collections')),  # RomM collections this ROM is in
                'player_count': (meta.get('player_count') or '').strip() if isinstance(meta.get('player_count'), str) else meta.get('player_count'),
                'last_played':  (d.get('rom_user') or {}).get('last_played'),
                'verified':     bool(d.get('crc_hash')),
                'hltb':         hltb,
                'age_ratings':  age_ratings,
                'related':      related,
                'providers':    providers,
                'hashes':       hashes,
                'verifications': verifications,
                'files': files,
                'screenshots': [s for s in (d.get('merged_screenshots') or []) if s],
                'achievements': achievements,
                'ra_id': ra_id,
                'fs_size_bytes': d.get('fs_size_bytes') or 0,
                'is_downloaded': bool(local.get('is_downloaded')),
                'has_cover': bool(d.get('path_cover_small') or local.get('cover_path')),
            }
        except Exception as e:
            logging.error(f"get_game_detail error: {e}", exc_info=True)
            return {'success': False, 'message': str(e)}

    async def download_game(self, rom_id: int):
        """Download a single ROM into the library (handles archive extraction)."""
        try:
            if not (self._romm_client and self._romm_client.authenticated):
                return {'success': False, 'message': 'Not connected to RomM'}
            idx = self._games_index()
            g = idx.get(rom_id)
            # Trigger trace: download_game is ONLY invoked by an explicit frontend
            # action (tile/detail/batch button) — nothing in the backend auto-calls
            # it. Logging the rom here so an unexpected download can be traced to a
            # real UI event instead of guessed at.
            logging.info(f"download_game RPC (user action): rom_id={rom_id} "
                         f"name={(g or {}).get('name', '?')}")
            download_dir = Path(self._settings.get('Download', 'rom_directory',
                                                   _default_roms_dir())).expanduser()
            if g:
                platform_slug = g.get('platform_slug') or (g.get('romm_data') or {}).get('platform_slug')
                file_name = g.get('file_name') or (g.get('romm_data') or {}).get('fs_name')
                name = g.get('name')
            else:
                r = self._romm_client.session.get(
                    urljoin(self._romm_client.base_url, f'/api/roms/{rom_id}'), timeout=15)
                d = r.json() if r.status_code == 200 else {}
                platform_slug = d.get('platform_slug', 'Unknown')
                file_name = d.get('fs_name') or f"{d.get('name', 'rom')}.rom"
                name = d.get('name')
            if not (platform_slug and file_name):
                return {'success': False, 'message': 'Could not resolve ROM path'}
            dest = download_dir / platform_slug / file_name

            # Decky serves RPC calls sequentially on one socket, so if this method
            # blocked until the download finished, the frontend's get_download_progress
            # polls would queue behind it and never update mid-download. Instead we
            # run the download in a background thread and return immediately; the
            # frontend polls get_download_progress() to drive the fill UI and to learn
            # when it finished (state done/error).
            cur = self._download_progress.get(rom_id)
            if cur and cur.get('state') == 'downloading':
                return {'success': True, 'started': True, 'message': 'Already downloading'}

            self._download_progress[rom_id] = {
                'percent': 0, 'downloaded': 0, 'total': 0,
                'speed': 0, 'eta': 0, 'state': 'downloading', 'message': '',
            }

            def _worker():
                def _on_progress(info):
                    try:
                        prog = info.get('progress')  # 0..1
                        self._download_progress[rom_id] = {
                            'percent': int(round((prog or 0) * 100)),
                            'downloaded': info.get('downloaded', 0),
                            'total': info.get('total', 0),
                            'speed': info.get('speed', 0),
                            'eta': info.get('eta', 0),
                            'state': 'downloading', 'message': '',
                        }
                    except Exception:
                        pass
                try:
                    ok, msg = self._romm_client.download_rom(rom_id, name, dest, _on_progress)
                    # grout-style: unpack a single-file .zip/.7z on arrival so
                    # disc cores get a real .cue/.m3u (no-op if disabled/plain ROM).
                    final = self._maybe_unzip_download(dest, rom_id) if ok else dest
                    # `g` was resolved before the download started, which can be
                    # minutes ago — long enough for the 5-minute library refresh
                    # to have replaced _available_games. Re-resolve now, or a rom
                    # that was missing at the start and arrived in the refresh
                    # gets appended a SECOND time: two identical, both-downloaded
                    # entries with the same rom_id, i.e. a doubled tile in Home's
                    # 'Downloaded' row until the next restart rebuilt the list
                    # from the (clean) snapshot.
                    # A refresh may also have left the captured `g` orphaned — no
                    # longer the dict the library holds — so mutating it would
                    # silently do nothing. The current index is the only thing
                    # worth trusting here.
                    idx = self._games_index() if ok else {}
                    live = idx.get(rom_id) if ok else None
                    parent = (idx.get(self._variant_parent_index().get(rom_id))
                              if ok and not live else None)
                    if ok and live:
                        live['is_downloaded'] = True
                        live['local_path'] = str(final)
                        is_md, dc = _detect_multi_disc(str(final), True)
                        live['is_multi_disc'] = is_md
                        live['disc_count'] = dc
                    elif ok and parent is not None:
                        # A regional/disc variant the user picked from the region
                        # picker. It has no tile of its own — the library folded
                        # it into its parent — so record it there. Appending it
                        # as a library entry (what this used to do) is exactly
                        # how the same game came to show up twice in the grid,
                        # in Recently Downloaded, and in its collections.
                        self._record_variant_download(
                            parent, rom_id, name=name, file_name=file_name,
                            local_path=final)
                        self._persist_snapshot_throttled()
                    elif ok:
                        # Genuinely not in the library and not a known variant —
                        # add it so launch_game can find it. Safe under CPython's
                        # GIL (same assumption as the mutations above).
                        is_md, dc = _detect_multi_disc(str(final), True)
                        self._available_games.append({
                            'name': name or 'Unknown',
                            'rom_id': rom_id,
                            'platform': platform_slug,
                            'platform_slug': platform_slug,
                            'file_name': file_name,
                            'is_downloaded': True,
                            'is_multi_disc': is_md,
                            'disc_count': dc,
                            'local_path': str(final),
                            'local_size': final.stat().st_size if final.exists() else 0,
                            'cover_path': None,
                            'cover_path_large': None,
                            '_sibling_files': [],
                            'sibling_roms': [],
                            'romm_data': {
                                'fs_name': file_name,
                                'fs_name_no_ext': Path(file_name).stem if file_name else None,
                                'fs_size_bytes': 0,
                                'platform_slug': platform_slug,
                            },
                        })
                    if ok:
                        # Write the new download state through to disk now. The
                        # snapshot is otherwise only rewritten by a fetch, so a
                        # user who grabbed games and then quit came back to a
                        # snapshot that still said not-downloaded — the games
                        # read as missing and had to be fetched again.
                        # _reconcile_downloads on hydrate covers the crash case;
                        # this keeps the common case cheap and correct.
                        self._persist_snapshot_throttled()
                        # Pull this platform's BIOS off RomM too. BIOS fetching
                        # was only ever wired to "enable auto-sync on a
                        # collection", so a user who downloaded games one at a
                        # time got the ROM and none of the firmware — the game
                        # then black-screens on any core without an HLE
                        # fallback. Cheap and idempotent: the tracker skips
                        # platforms it has already handled.
                        try:
                            if self._bios_tracking and platform_slug:
                                pname = (self._platform_slug_to_name or {}).get(
                                    platform_slug) or platform_slug
                                self._bios_tracking.trigger_downloads_for_games(
                                    [{'platform_slug': platform_slug,
                                      'platform_name': pname}])
                        except Exception as e:
                            logging.debug(f"BIOS fetch after download: {e}")
                    self._download_progress[rom_id] = {
                        'percent': 100 if ok else 0, 'downloaded': 0, 'total': 0,
                        'speed': 0, 'eta': 0, 'state': 'done' if ok else 'error',
                        'message': msg or ('Downloaded' if ok else 'Download failed'),
                    }
                    _record_activity('download' if ok else 'error',
                                     'Downloaded' if ok else 'Download failed',
                                     name or file_name or f'ROM {rom_id}',
                                     rom_id=rom_id)
                except Exception as e:
                    logging.error(f"download_game worker error: {e}", exc_info=True)
                    self._download_progress[rom_id] = {
                        'percent': 0, 'downloaded': 0, 'total': 0,
                        'speed': 0, 'eta': 0, 'state': 'error', 'message': str(e),
                    }

            threading.Thread(target=_worker, daemon=True, name=f"romm-dl-{rom_id}").start()
            return {'success': True, 'started': True, 'message': 'Download started'}
        except Exception as e:
            self._download_progress[rom_id] = {
                'percent': 0, 'downloaded': 0, 'total': 0,
                'speed': 0, 'eta': 0, 'state': 'error', 'message': str(e),
            }
            logging.error(f"download_game error: {e}", exc_info=True)
            return {'success': False, 'message': str(e)}

    async def get_download_progress(self, rom_id: int):
        """Live progress for an in-flight download (polled by the cover/button fill UI).

        Returns {percent 0..100, downloaded, total, speed, eta, state, message} where
        state is one of downloading|done|error, or state 'idle' when nothing is tracked.
        """
        p = self._download_progress.get(rom_id)
        if not p:
            return {'percent': 0, 'state': 'idle', 'message': ''}
        return p

    async def debug_log(self, msg: str):
        """Temporary bridge so frontend logs land in the backend log file."""
        logging.info(f"[FE] {msg}")
        return True

    async def delete_game(self, rom_id: int):
        """Delete a single game's local files."""
        try:
            import shutil
            idx = self._games_index()
            g = idx.get(rom_id)
            download_dir = Path(self._settings.get('Download', 'rom_directory',
                                                   _default_roms_dir())).expanduser()
            # Regional/disc variants of this game are on disk under the parent's
            # record, not as entries of their own — "delete from device" has to
            # take them too, or the files stay behind with nothing pointing at
            # them and the tile still reads as downloaded.
            variant_paths = [v.get('local_path')
                             for v in self._variant_downloads(g or {}).values()
                             if v.get('local_path')]
            target = None
            if g and g.get('local_path'):
                target = Path(g['local_path'])
            elif g:
                platform_slug = g.get('platform_slug') or (g.get('romm_data') or {}).get('platform_slug')
                file_name = g.get('file_name') or (g.get('romm_data') or {}).get('fs_name')
                if platform_slug and file_name:
                    target = download_dir / platform_slug / file_name
            removed = 0
            for p in variant_paths:
                try:
                    vp = Path(p)
                    if target is not None and vp == target:
                        continue      # handled below with the main target
                    if vp.is_file():
                        vp.unlink(); removed += 1
                    elif vp.is_dir():
                        shutil.rmtree(vp); removed += 1
                except Exception as e:
                    logging.warning(f"could not delete regional variant {p}: {e}")
            if g:
                g.pop('_variant_downloads', None)
            if not target or not target.exists():
                if g:
                    g['is_downloaded'] = False; g['local_path'] = None
                return {'success': True,
                        'message': 'Deleted' if removed else 'Nothing to delete'}
            if target.is_file():
                target.unlink()
            else:
                shutil.rmtree(target)
            if g:
                g['is_downloaded'] = False; g['local_path'] = None
            _record_activity('delete', 'Deleted from device',
                             (g or {}).get('name') or target.name)
            return {'success': True, 'message': 'Deleted'}
        except Exception as e:
            logging.error(f"delete_game error: {e}", exc_info=True)
            return {'success': False, 'message': str(e)}

    def _fetch_continue_playing(self, limit=15):
        """Continue-playing list straight from RomM (per-user, cross-device).

        RomM tracks play state server-side as rom_user.last_played, so we ask
        /api/roms ordered by it rather than guessing from local save mtimes.
        Returns serialized LibGames, enriched with local download state when the
        rom is in our index.

        Returns None — NOT [] — when the list couldn't be fetched (client not
        authenticated yet at boot, offline, HTTP error). The two are completely
        different to the caller: [] means "nothing played, hide the row", while
        None means "don't know", and blanking a good row on a transient failure
        is what made Continue playing vanish at random on launch.
        """
        client = self._romm_client
        if not client or not client.ensure_authenticated():
            logging.debug("continue-playing: client not ready yet")
            return None
        try:
            resp = client.session.get(
                urljoin(client.base_url, '/api/roms'),
                params={
                    'order_by': 'last_played', 'order_dir': 'desc',
                    'last_played': 'true',  # server-side filter to played roms only
                    'limit': limit, 'offset': 0,
                    # Only `items` is read, and /api/roms otherwise computes a
                    # count, a char_index, a rom_id_index and filter_values over
                    # the whole library for every request. Older servers ignore
                    # these params. See _fetch_pages_parallel in sync_core.
                    'with_total': 'false',
                    'with_rom_id_index': 'false',
                    'with_char_index': 'false',
                    'with_filter_values': 'false',
                    'fields': 'id,name,fs_name,platform_name,platform_slug,path_cover_small,merged_screenshots,rom_user',
                },
                timeout=30,
            )
            if resp.status_code != 200:
                logging.warning(f"continue-playing fetch HTTP {resp.status_code}")
                return None
            items = resp.json().get('items', [])
        except Exception as e:
            logging.warning(f"continue-playing fetch failed: {e}")
            return None

        idx = self._games_index()
        out = []
        for rom in items:
            # Only games actually played carry a last_played timestamp; the
            # ordering pushes null-played roms to the tail, so stop at the first.
            if not (rom.get('rom_user') or {}).get('last_played'):
                continue
            rid = rom.get('id')
            local = idx.get(rid)
            if local:
                item = self._serialize_game(local)
            else:
                item = {
                    'rom_id': rid,
                    'name': rom.get('name') or rom.get('fs_name') or 'Unknown',
                    'platform': _platform_label(rom),
                    'is_downloaded': False,
                    'has_cover': bool(rom.get('path_cover_small')),
                    'platform_slug': rom.get('platform_slug'),
                }
            # RomM's Home paints continue-playing cards with the game's
            # screenshot (landscape) and floats the box-art as a PIP. Carry the
            # first merged screenshot path so the frontend can do the same; the
            # frontend base64s it through get_image, like the screenshots tab.
            shots = [s for s in (rom.get('merged_screenshots') or []) if s]
            item['screenshot'] = shots[0] if shots else None
            out.append(item)
        return out

    async def get_home_data(self):
        """Home dashboard payload: library snapshot stats + a recently-added row.

        Modeled on RomM's v2 Home (WidgetBar + 'Continue playing' + 'Recently
        added' CardRows). Stats/recent come from the local library cache;
        continue-playing is pulled live from RomM (per-user, cross-device).
        """
        try:
            games = self._available_games or []
            # ROM count rather than collapsed-entry count, so the Home widget
            # and the Stats page agree with RomM. See _variant_count.
            total = sum(_variant_count(g) for g in games)
            downloaded = sum(1 for g in games if g.get('is_downloaded'))
            platforms = len({g.get('platform_slug') for g in games if g.get('platform_slug')})
            collections = len(self._romm_collections or [])
            # Recently added: newest created_at first; fall back to library order
            # (RomM returns roms newest-first) when timestamps are missing.
            def _key(g):
                return g.get('created_at') or ''
            has_dates = any(g.get('created_at') for g in games)
            ordered = sorted(games, key=_key, reverse=True) if has_dates else list(games)
            # Offline: the 'Recently added' row only shows downloaded (playable)
            # games, matching the filtered library.
            if self._is_offline():
                ordered = [g for g in ordered if g.get('is_downloaded')]
            recent = [self._serialize_game(g) for g in ordered[:15]]
            # Downloaded: locally-installed games, latest download first (local
            # file mtime — we don't persist a download timestamp anywhere else).
            def _dl_key(g):
                try:
                    lp = g.get('local_path')
                    return Path(lp).stat().st_mtime if lp else 0.0
                except Exception:
                    return 0.0
            dl_games = sorted((g for g in games if g.get('is_downloaded')),
                              key=_dl_key, reverse=True)
            downloaded_row = [self._serialize_game(g) for g in dl_games[:15]]
            continue_playing = await asyncio.to_thread(self._fetch_continue_playing, 15)
            return {
                'success': True,
                # False while the very first library fetch is still running. The
                # Home rows are built from _available_games, so a caller that
                # asks too early gets a legitimately-empty payload and would
                # cache it as the answer — see HomePanel's retry.
                'library_ready': self._last_full_fetch_time is not None,
                'stats': {
                    'games': total,
                    'downloaded': downloaded,
                    'platforms': platforms,
                    'collections': collections,
                },
                'recent': recent,
                'downloaded_games': downloaded_row,
                'continue_playing': continue_playing,
            }
        except Exception as e:
            logging.error(f"get_home_data error: {e}", exc_info=True)
            return {'success': False, 'stats': {}, 'recent': [], 'downloaded_games': [], 'continue_playing': None, 'message': str(e)}

    async def _pre_launch_sync(self, game: dict):
        """Pull this game's saves/states down before it starts.

        Waits briefly when sync is still connecting. Installing an emulator or a
        core restarts sync, and the connect runs on a background thread — a game
        launched in the seconds that follow used to skip the save download in
        silence, which reads as "my saves aren't there" and appears to fix itself
        only on the next app start. Never blocks the launch for long: five
        seconds, then go.

        Returns the core name the launch will use, or None — the caller needs it
        to find the states RetroArch is about to read (resume-from-state).
        """
        auto = self._auto_sync
        if auto is None and self._romm_client is not None:
            for _ in range(20):
                await asyncio.sleep(0.25)
                auto = self._auto_sync
                if auto is not None:
                    break
            logging.info("pre-launch sync waited for auto-sync: "
                         f"{'ready' if auto else 'not up, launching anyway'}")
        if auto is None:
            logging.warning("launching without a pre-launch save sync — "
                            "sync is not connected yet")
            return None
        try:
            # The emulator may have created its save tree since sync started
            # (first run after an install). Re-resolve BEFORE the session so the
            # watcher is armed for it, not after the game has already exited.
            await asyncio.to_thread(auto.refresh_save_dirs)
        except Exception as e:
            logging.warning(f"could not refresh save directories: {e}")
        # Resolve the launching core FIRST: it decides which per-core folder the
        # pre-launch download writes into, not just where reconcile tidies up
        # afterwards.
        core = None
        try:
            ra = self._retroarch
            if ra:
                slug = (game.get('platform_slug')
                        or (game.get('romm_data') or {}).get('platform_slug'))
                core, _ = ra.suggest_core_for_platform(
                    self._platform_name_for(game), system_slug=slug)
        except Exception as e:
            logging.warning(f"could not resolve launch core: {e}")
        try:
            await asyncio.to_thread(auto.sync_before_launch, game, core)
        except Exception as e:
            logging.warning(f"pre-launch sync failed (continuing): {e}")
        # Whatever just came down has to sit where RetroArch will look for it,
        # which depends on a config it has not written yet on a first run.
        try:
            await asyncio.to_thread(auto.reconcile_game_saves, game, core)
            # States are filed under the emulator RomM recorded, which is not
            # necessarily the core about to launch (Beetle PSX vs Beetle PSX HW).
            await asyncio.to_thread(auto.reconcile_game_states, game, core)
        except Exception as e:
            logging.warning(f"could not reconcile save locations: {e}")
        return core

    # -----------------------------------------------------------------------
    # Resume from the latest save state (Continue playing)
    # -----------------------------------------------------------------------

    async def get_resume_state_enabled(self):
        """Whether Continue playing resumes from the newest save state."""
        try:
            return bool(load_decky_settings().get('resume_state_from_continue', False))
        except Exception as e:
            logging.error(f"get_resume_state_enabled error: {e}")
            return False

    async def set_resume_state_enabled(self, enabled: bool):
        try:
            settings = load_decky_settings()
            settings['resume_state_from_continue'] = bool(enabled)
            save_decky_settings(settings)
            return bool(enabled)
        except Exception as e:
            logging.error(f"set_resume_state_enabled error: {e}")
            return False

    def _resume_entry_slot(self, game: dict, core: str = None):
        """RetroArch slot number to boot into for this game, or None.

        None whenever anything is missing — no sync manager, no state on disk —
        because --entryslot pointing at a file that isn't there aborts the
        launch, and a game that won't start at all is far worse than a game
        that starts at the title screen.
        """
        auto = self._auto_sync
        if auto is None:
            return None
        try:
            slot, path = auto.latest_state_slot(game, core)
            if path is None:
                logging.info(f"resume: no save state on disk for "
                             f"{game.get('name', 'this game')} — normal launch")
                return None
            logging.info(f"resume: booting into slot {slot} ({path})")
            return slot
        except Exception as e:
            logging.warning(f"could not resolve a state to resume: {e}")
            return None

    async def launch_game(self, rom_id: int, disc: str = None, sibling_rom_id: int = None,
                          resume: bool = False):
        """Launch a downloaded game in RetroArch (A button on a downloaded card).

        `disc` optionally names a specific disc file inside a multi-disc folder
        (from get_local_discs). When omitted, the last disc the user launched is
        resumed; absent that, the .m3u playlist is preferred (in-game swap),
        falling back to the first disc.
        `sibling_rom_id` optionally overrides the ROM to launch — used when the
        user picks a regional variant from the region picker.
        `resume` asks to boot straight into the newest save state (Continue
        playing, when the setting is on); it degrades to a normal launch
        whenever no state can be resolved.
        """
        try:
            idx = self._games_index()
            effective_rom_id = sibling_rom_id or rom_id
            g = idx.get(effective_rom_id)
            if not g or not g.get('is_downloaded') or not g.get('local_path'):
                g = self._variant_game(idx, rom_id, effective_rom_id) or g
            if not g or not g.get('is_downloaded') or not g.get('local_path'):
                # Fallback: sibling ROM may be on disk but not in the index (e.g.,
                # downloaded in a previous session). Try resolving from the API.
                download_dir = Path(self._settings.get('Download', 'rom_directory',
                                                        _default_roms_dir())).expanduser()
                try:
                    r = self._romm_client.session.get(
                        urljoin(self._romm_client.base_url, f'/api/roms/{effective_rom_id}'),
                        timeout=15)
                    if r.status_code == 200:
                        d = r.json()
                        slug = d.get('platform_slug', 'Unknown')
                        fn = d.get('fs_name') or f"{d.get('name', 'rom')}.rom"
                        candidate = download_dir / slug / fn
                        if is_path_validly_downloaded(candidate):
                            is_md, dc = _detect_multi_disc(str(candidate), True)
                            found = {
                                'rom_id': effective_rom_id,
                                'name': d.get('name') or 'Unknown',
                                'platform_slug': slug,
                                'file_name': fn,
                                'is_downloaded': True,
                                'local_path': str(candidate),
                                'is_multi_disc': is_md,
                                'disc_count': dc,
                                '_sibling_files': [],
                                'sibling_roms': [],
                            }
                            # Two cases reach here: the rom is genuinely absent
                            # from the index, or it IS there but stale (marked
                            # not-downloaded). Appending in the second case left
                            # two entries with the same rom_id — a doubled tile
                            # in the library grid and 'Recently added' (both list
                            # every game), a duplicate React key, and an inflated
                            # library total. Patch the existing entry instead, so
                            # covers/siblings/display_name survive as well.
                            if g is not None:
                                # Only the download facts — 'name' is the
                                # filename stem the save-sync matcher keys on
                                # (not the API title), and the sibling lists here
                                # are empty placeholders that would clobber real
                                # ones.
                                g.update({k: found[k] for k in (
                                    'is_downloaded', 'local_path',
                                    'is_multi_disc', 'disc_count')})
                            elif effective_rom_id != rom_id and rom_id in idx:
                                # A regional/disc variant: record it on the
                                # parent instead of appending, or the game gets
                                # a second tile everywhere it appears.
                                self._record_variant_download(
                                    idx[rom_id], effective_rom_id,
                                    name=found['name'], file_name=fn,
                                    local_path=candidate)
                                g = found
                            else:
                                g = found
                                self._available_games.append(g)
                except Exception:
                    pass
            if not g or not g.get('is_downloaded') or not g.get('local_path'):
                return {'success': False, 'message': 'Game not downloaded'}
            if not self._retroarch:
                return {'success': False, 'message': 'RetroArch not available'}
            # A bare Play resumes the remembered disc; an explicit pick overrides.
            effective_disc = disc or self._get_last_disc(effective_rom_id) or None
            launch_path = self._resolve_launch_path(g['local_path'], effective_disc)
            if not launch_path and effective_disc:
                # Remembered disc vanished — fall back to the default resolution.
                effective_disc = None
                launch_path = self._resolve_launch_path(g['local_path'], None)
            if not launch_path:
                return {'success': False, 'message': 'No launchable file found'}
            platform_name = self._platform_name_for(g)
            # Check for a missing core BEFORE syncing. The launch would fail on
            # it anyway, and the picker sends the user back here afterwards — so
            # syncing first means downloading everything twice, and the second
            # pass then reports "1 file" because the first already fetched the
            # rest, which reads as though most of the saves never arrived.
            gap = self._core_gap(g, platform_name)
            if gap.get('needs_core'):
                logging.info(f"No core for {platform_name} — offering the picker "
                             f"before syncing {g.get('name', 'this game')}")
                return {'success': False,
                        'message': f'No core installed for {platform_name}',
                        **gap}

            # Advisory only — resolved before the launch so it can be reported
            # either way. A core whose .info marks BIOS required (Beetle PSX,
            # DuckStation, PCSX2, Saturn…) fails with no visible reason when the
            # files are absent, which is indistinguishable from "the app is
            # broken". Cores with an HLE fallback (pcsx_rearmed, swanstation)
            # mark their BIOS optional and are correctly never flagged.
            bios = self._bios_gap(g, platform_name)
            if bios:
                logging.info(f"{platform_name} core '{bios['core']}' is missing "
                             f"required BIOS: {bios['missing_bios']}")

            # Pull down the latest saves/states from RomM before launching so the
            # session starts from the most recent progress (no-op if download is off).
            core = await self._pre_launch_sync(g)
            # Resolved AFTER the sync: the state to resume into may be the one
            # that just came down from the server, and reconcile has to have
            # filed it under the launching core first.
            entry_slot = self._resume_entry_slot(g, core) if resume else None
            ok, msg = self._retroarch.launch_game(Path(launch_path), platform_name,
                                                  entry_slot=entry_slot)
            # Remember an explicit disc choice so the next plain Play resumes it.
            if ok and disc:
                try:
                    self._settings.set('LastDisc', str(effective_rom_id), disc)
                except Exception as e:
                    logging.warning(f"could not persist last disc: {e}")
            out = {'success': bool(ok),
                   'message': msg or ('Launched' if ok else 'Launch failed')}
            if bios:
                # Attached on success too: RetroArch "launches" fine and then
                # sits on a black screen, so the warning is most useful exactly
                # when ok is True.
                out['bios_warning'] = bios
            if not ok:
                # A missing core is the one launch failure the user can fix on
                # the spot, so hand the UI what it needs to offer that instead of
                # a dead-end toast: which platform, and which cores would work.
                out.update(self._core_gap(g, platform_name))
            return out
        except Exception as e:
            logging.error(f"launch_game error: {e}", exc_info=True)
            return {'success': False, 'message': str(e)}

    def _core_gap(self, game: dict, platform_name: str) -> dict:
        """{needs_core, platform_name, platform_slug, candidates, installed_cores}
        when this platform resolves to no core, else {}."""
        try:
            ra = self._retroarch
            if not ra or not platform_name:
                return {}
            slug = (game.get('platform_slug')
                    or (game.get('romm_data') or {}).get('platform_slug') or None)
            info = ra.describe_core_resolution(platform_name, system_slug=slug)
            if info.get('resolved_core'):
                return {}          # a core WAS resolved; the failure is something else
            support = ra.core_download_support()
            return {
                'needs_core': True,
                'platform_name': platform_name,
                'platform_slug': slug or '',
                # Best guess first, already aliased to buildbot names, so each
                # can be passed straight to download_core().
                'candidates': info.get('download_candidates') or [],
                'installed_cores': sorted(ra.get_available_cores().keys()),
                'can_download': bool(support.get('available')),
                'download_reason': support.get('reason') or '',
            }
        except Exception as e:
            logging.warning(f"could not describe the core gap: {e}")
            return {}

    # Cached {core_name: [(path, desc), ...]} of REQUIRED firmware, parsed from
    # libretro .info files. Empty list = that core needs no BIOS.
    _core_firmware_cache: dict = None
    # {slug: {name, platform_id, files}} from one /api/platforms call.
    _server_firmware_cache: dict = None
    # True when the last _server_firmware call couldn't reach the server at all,
    # as opposed to being told there is no firmware. The BIOS page says very
    # different things about those two.
    _server_firmware_failed: bool = False

    @staticmethod
    def _parse_required_firmware(text: str):
        """Required firmware entries from a libretro .info file body.

        The .info format is the only per-core authority on this, and the
        distinction matters: 'PSX needs BIOS' is not a platform-level fact. Of
        the four PSX cores Ludo can pick, pcsx_rearmed and swanstation mark all
        BIOS optional (they have an HLE fallback and boot without one), while
        beetle/mednafen_psx and duckstation mark theirs required and will not
        boot at all. Only firmwareN_opt = "false" means genuinely required.
        """
        entries = {}
        for m in re.finditer(r'^\s*firmware(\d+)_(desc|path|opt)\s*=\s*"([^"]*)"',
                             text, re.MULTILINE):
            idx, field, val = m.group(1), m.group(2), m.group(3)
            entries.setdefault(idx, {})[field] = val
        out = []
        for e in entries.values():
            # Absent opt is treated as optional: the conservative direction,
            # since this only ever drives a warning.
            if e.get('opt', 'true').strip().lower() == 'false' and e.get('path'):
                out.append((e['path'], e.get('desc') or e['path']))
        return out

    def _info_dirs(self):
        """Directories that may hold libretro .info files, best first.

        The configured libretro_info_path is usually right but not always
        usable: the RetroArch flatpak writes its own *sandbox* path there
        (/app/share/libretro/info), which doesn't exist from outside the
        sandbox — where Ludo runs. So a literal read finds nothing and the BIOS
        check would silently never fire. Map any /app/... path onto the flatpak
        deployment tree the same way _bundled_cfg_setting does, then fall back
        to the usual system locations.
        """
        ra = self._retroarch
        app_id = getattr(ra, 'RETROARCH_APP_ID', None) or 'org.libretro.RetroArch'
        roots = [Path('/var/lib/flatpak/app'),
                 Path.home() / '.local/share/flatpak/app',
                 Path('/run/host/var/lib/flatpak/app'),
                 Path('/run/host') / str(Path.home()).lstrip('/') / '.local/share/flatpak/app']
        cands = []
        configured = ''
        try:
            configured = ra.get_retroarch_config_setting('libretro_info_path', '') or ''
        except Exception:
            pass
        if configured:
            cands.append(Path(configured).expanduser())
            # '/app/share/libretro/info' -> '<deploy>/files/share/libretro/info'
            if configured.startswith('/app/'):
                rel = configured[len('/app/'):]
                cands += [r / app_id / 'current/active/files' / rel for r in roots]
        try:
            cfg = ra.find_retroarch_config_dir()
            if cfg:
                cands.append(Path(cfg) / 'info')
        except Exception:
            pass
        cands += [r / app_id / 'current/active/files/share/libretro/info' for r in roots]
        cands += [Path('/usr/share/libretro/info'),
                  Path.home() / '.config/retroarch/info']
        seen, out = set(), []
        for c in cands:
            s = str(c)
            if s not in seen:
                seen.add(s)
                if c.is_dir():
                    out.append(c)
        return out

    def _required_firmware_for_core(self, core_name: str):
        """Required firmware for an installed core, or [] if none/unknown.

        Reads the .info file RetroArch already has on disk (install_core drops
        one next to the core via _fetch_core_info), falling back to the cached
        buildbot bundle. Never fetches — a launch must not wait on the network.
        """
        if self._core_firmware_cache is None:
            self._core_firmware_cache = {}
        if core_name in self._core_firmware_cache:
            return self._core_firmware_cache[core_name]
        result = []
        name = f'{core_name}_libretro.info'
        try:
            f = next((d / name for d in self._info_dirs() if (d / name).is_file()), None)
            if f:
                result = self._parse_required_firmware(
                    f.read_text(encoding='utf-8', errors='replace'))
            else:
                bundle = _paths.cache_dir() / 'libretro_info.zip'
                if bundle.exists():
                    import zipfile
                    with zipfile.ZipFile(bundle) as z:
                        member = next((m for m in z.namelist()
                                       if m.rsplit('/', 1)[-1] == name), None)
                        if member:
                            result = self._parse_required_firmware(
                                z.read(member).decode('utf-8', 'replace'))
        except Exception as e:
            logging.debug(f"could not read firmware info for {core_name}: {e}")
        self._core_firmware_cache[core_name] = result
        return result

    def _bios_manager(self):
        """RetroArch's BiosManager with a live RomM client attached, or None.

        RetroArchInterface builds the manager without a client, and the only
        code that ever sets one is BiosTrackingManager.download_bios_for_platform
        — so every other caller (this plugin's downloads, the startup library
        scan) sees "Not connected to RomM" while the plugin is perfectly
        connected. Attach it here rather than in sync_core, which is shared.
        """
        bm = getattr(self._retroarch, 'bios_manager', None) if self._retroarch else None
        if bm and self._romm_client and self._romm_client.authenticated:
            bm.romm_client = self._romm_client
        return bm

    def _bios_dir(self):
        """RetroArch's system/BIOS directory as a Path, or None."""
        bm = getattr(self._retroarch, 'bios_manager', None) if self._retroarch else None
        sysdir = getattr(bm, 'system_dir', None) if bm else None
        return Path(sysdir) if sysdir else None

    def _installed_bios_index(self):
        """(relative-paths, basenames) present under the system dir, lowercased.

        Two shapes of firmware path occur and both must match:
          "scph5501.bin"  — a loose file anywhere under system/
          "pcsx2/bios"    — a subdirectory (PCSX2 ships a whole tree)
        So index relative paths AND basenames, counting directories as present.
        Matching a nested path by basename alone would report PCSX2 as
        permanently missing BIOS. Comparisons are case-insensitive: RetroArch
        wants an exact name, but flagging a case mismatch as "missing" is a
        confusing false alarm on a case-sensitive filesystem.
        """
        rel, base = set(), set()
        sysdir = self._bios_dir()
        if not sysdir:
            return rel, base
        try:
            for p in sysdir.rglob('*'):
                try:
                    rel.add(p.relative_to(sysdir).as_posix().lower())
                    base.add(p.name.lower())
                except (OSError, ValueError):
                    continue
        except OSError as e:
            logging.debug(f"could not index the BIOS dir: {e}")
        return rel, base

    def _server_firmware(self, force: bool = False) -> dict:
        """{platform_slug: {'name', 'platform_id', 'files': [...]}} from RomM.

        One /api/platforms call covers every platform — the payload already
        embeds each platform's firmware list, which is exactly what RomM's own
        "Firmware" tab renders. Asking per platform (as bios_manager does) turns
        this into N+1 requests against a server we already know is the slow part.
        Cached for the session unless refreshed; returns {} when offline.

        Blocking — call it off the event loop.

        Retried, because the moment the BIOS page is most likely to be opened
        (right after connecting) is also when a library fetch has four workers
        on the same server, and /api/platforms builds every platform's firmware
        list. A single 15s attempt lost that race and the page then claimed the
        server holds no firmware at all. Sets _server_firmware_failed so the
        caller can tell "asked, got nothing" from "couldn't ask".
        """
        if not force and self._server_firmware_cache is not None:
            self._server_firmware_failed = False
            return self._server_firmware_cache
        self._server_firmware_failed = True
        out = {}
        try:
            c = self._romm_client
            if not (c and c.authenticated):
                return self._server_firmware_cache or {}
            from urllib.parse import urljoin
            url = urljoin(c.base_url, '/api/platforms')
            r = None
            for attempt, timeout in enumerate((20, 45)):
                try:
                    r = c.session.get(url, timeout=timeout)
                except Exception as e:
                    logging.debug(f"[BIOS] /api/platforms attempt {attempt + 1}: {e}")
                    r = None
                if r is not None and r.status_code == 200:
                    break
                if r is not None:
                    logging.debug(f"[BIOS] /api/platforms -> {r.status_code}")
                    # A real HTTP answer (401/404/500) won't change on a retry.
                    if r.status_code != 429 and r.status_code < 500:
                        return self._server_firmware_cache or {}
                time.sleep(1.0)
            if r is None or r.status_code != 200:
                return self._server_firmware_cache or {}
            for pl in (r.json() or []):
                if not isinstance(pl, dict):
                    continue
                fw = pl.get('firmware') or []
                if not fw:
                    continue
                slug = (pl.get('slug') or '').lower()
                out[slug] = {
                    'name': pl.get('name') or slug,
                    'platform_id': pl.get('id'),
                    'files': [{
                        'file_name': f.get('file_name') or '',
                        'size': f.get('file_size_bytes') or 0,
                        'md5': (f.get('md5_hash') or '').lower(),
                        'sha1': (f.get('sha1_hash') or '').lower(),
                        'verified': bool(f.get('is_verified')),
                    } for f in fw if f.get('file_name')],
                }
        except Exception as e:
            logging.warning(f"[BIOS] could not read server firmware: {e}")
            return self._server_firmware_cache or {}
        self._server_firmware_cache = out
        self._server_firmware_failed = False
        return out

    def _bios_gap(self, game: dict, platform_name: str) -> dict:
        """{missing_bios: [name, ...], core, severity} when BIOS files RomM holds
        for this game's platform aren't on disk, else {}.

        Anchored on the server's firmware list rather than the core's .info,
        because the core Ludo resolves is not necessarily the core that ends up
        running the game — the user can switch cores inside RetroArch, and then a
        check keyed on pcsx_rearmed ("BIOS optional") stays silent while every
        BIOS the platform needs is absent. What the server holds for the platform
        is true regardless of that choice.

        The core .info still decides *severity*: 'required' when the resolved
        core marks the firmware mandatory (it will not boot), 'optional' when it
        has an HLE fallback (it may run, worse).

        Advisory only — the caller warns and still launches. Detection can be
        wrong in the user's favour (a BIOS installed under a different filename),
        and refusing to start a game the user might be able to play is the worse
        failure.
        """
        try:
            ra = self._retroarch
            if not ra or not platform_name:
                return {}
            sysdir = self._bios_dir()
            if not sysdir:
                return {}          # can't tell where BIOS lives; stay quiet
            slug = (game.get('platform_slug')
                    or (game.get('romm_data') or {}).get('platform_slug') or '')
            core = ra.describe_core_resolution(
                platform_name, system_slug=slug or None).get('resolved_core')
            if not core:
                return {}          # no core at all — _core_gap owns that message
            entry = self._server_firmware().get(slug.lower()) or {}
            wanted = [f['file_name'] for f in entry.get('files') or []]
            required = self._required_firmware_for_core(core)
            if not wanted:
                # Nothing on the server to compare against (platform has no
                # firmware uploaded, or we're offline) — fall back to the core's
                # own required list so the check still works without RomM.
                wanted = [desc or path for path, desc in required]
            if not wanted:
                return {}
            rel, base = self._installed_bios_index()
            missing = []
            for w in wanted:
                key = w.replace('\\', '/').strip('/').lower()
                if key in rel or ('/' not in key and key in base):
                    continue
                missing.append(w)
            if not missing:
                return {}
            return {'missing_bios': missing, 'core': core,
                    'severity': 'required' if required else 'optional',
                    'platform_slug': slug,
                    'platform_name': platform_name,
                    'bios_dir': str(sysdir)}
        except Exception as e:
            logging.warning(f"could not describe the BIOS gap: {e}")
            return {}

    async def get_bios_inventory(self, refresh: bool = False):
        """Per-platform BIOS inventory for the BIOS page.

        Distinct from get_bios_status below, which reports the *progress* of
        BiosTrackingManager's background downloads. This one reports what the
        server holds versus what is on disk.

        {success, bios_dir, connected, unavailable, library_loading,
         platforms: [{slug, name, core, severity, missing_count,
         files: [{name, size, present, local_size, verified}]}]}

        Run off the event loop: it makes a network call and walks the BIOS dir,
        and doing that inline stalled every other RPC (cover loads, status
        polling) for as long as the busy server took to answer.
        """
        return await asyncio.to_thread(self._get_bios_inventory_blocking,
                                       bool(refresh))

    def _get_bios_inventory_blocking(self, refresh: bool = False):
        try:
            sysdir = self._bios_dir()
            server = self._server_firmware(force=bool(refresh))
            rel, base = self._installed_bios_index()
            names = self._platform_slug_to_name or {}
            out = []
            for slug, entry in sorted(server.items(),
                                      key=lambda kv: (kv[1].get('name') or kv[0]).lower()):
                pname = names.get(slug) or entry.get('name') or slug
                core = ''
                severity = 'optional'
                try:
                    core = (self._retroarch.describe_core_resolution(
                        pname, system_slug=slug).get('resolved_core') or '')
                    if core and self._required_firmware_for_core(core):
                        severity = 'required'
                except Exception as e:
                    logging.debug(f"[BIOS] core resolution for {slug}: {e}")
                files, missing = [], 0
                for f in entry.get('files') or []:
                    key = f['file_name'].lower()
                    present = key in rel or key in base
                    local_size = 0
                    if present and sysdir:
                        try:
                            local_size = (sysdir / f['file_name']).stat().st_size
                        except OSError:
                            local_size = 0
                    if not present:
                        missing += 1
                    files.append({'name': f['file_name'], 'size': f['size'],
                                  'present': present, 'local_size': local_size,
                                  'verified': f['verified']})
                out.append({'slug': slug, 'name': entry.get('name') or pname,
                            'platform_name': pname, 'core': core,
                            'severity': severity, 'missing_count': missing,
                            'files': files})
            return {'success': True, 'bios_dir': str(sysdir) if sysdir else '',
                    'connected': bool(self._romm_client
                                      and self._romm_client.authenticated),
                    # Distinguishes an empty list we believe from one we never
                    # got: with the server busy behind a library fetch, the old
                    # code returned [] and the page read "No firmware on the
                    # server", which is a false statement the user can't act on.
                    'unavailable': bool(self._server_firmware_failed and not out),
                    'library_loading': bool(self._library_progress),
                    'platforms': out}
        except Exception as e:
            logging.error(f"get_bios_status error: {e}", exc_info=True)
            return {'success': False, 'message': str(e), 'platforms': []}

    async def download_bios(self, platform_slug: str, file_name: str = ''):
        """Fetch one BIOS file, or every missing file for the platform when
        file_name is empty. Returns {success, downloaded: [...], failed: [...]}.
        """
        try:
            bm = self._bios_manager()
            if not bm:
                return {'success': False, 'message': 'No BIOS manager'}
            if not (self._romm_client and self._romm_client.authenticated):
                return {'success': False, 'message': 'Not connected to RomM'}
            slug = (platform_slug or '').lower()
            entry = self._server_firmware().get(slug) or {}
            if not entry:
                return {'success': False, 'message': 'No firmware on the server '
                                                     'for this platform'}
            # download_bios_from_romm matches on the *server's* platform name,
            # not our display name — pass what /api/platforms reported.
            pname = entry.get('name') or slug
            if file_name:
                wanted = [file_name]
            else:
                rel, base = self._installed_bios_index()
                wanted = [f['file_name'] for f in entry.get('files') or []
                          if f['file_name'].lower() not in rel
                          and f['file_name'].lower() not in base]
            done, failed = [], []
            for name in wanted:
                try:
                    ok = await asyncio.get_event_loop().run_in_executor(
                        None, bm.download_bios_from_romm, pname, name)
                except Exception as e:
                    logging.warning(f"[BIOS] {name}: {e}")
                    ok = False
                (done if ok else failed).append(name)
            if done:
                # The gap check reads the directory listing, so refresh the
                # manager's own cache too or its next scan still says missing.
                try:
                    bm.scan_installed_bios()
                except Exception as e:
                    logging.debug(f"[BIOS] rescan after download: {e}")
            return {'success': bool(done) and not failed,
                    'downloaded': done, 'failed': failed,
                    'message': (f"Downloaded {len(done)} file(s)" if done and not failed
                                else f"{len(failed)} file(s) failed" if failed
                                else 'Nothing to download')}
        except Exception as e:
            logging.error(f"download_bios error: {e}", exc_info=True)
            return {'success': False, 'message': str(e)}

    async def prepare_steam_launch(self, rom_id: int, disc: str = None,
                                   sibling_rom_id: int = None,
                                   resume: bool = False):
        """Resolve a game's emulator argv and write a launch-spec for the Steam
        session-host tile (Steam Deck Gaming Mode only).

        On gamescope the Steam overlay only renders over a game Steam itself
        launched. So instead of spawning the emulator from the Decky daemon, the
        frontend triggers SteamClient.Apps.RunGame on the "RomM" tile, whose exe
        is bin/romm-session-host. This method does everything launch_game does
        *except* the final spawn: it runs the pre-launch save-sync and resolves
        the exact argv, then writes it to the spec file the host reads and execs.

        Returns {success, message, steam_host: bool}. When steam_host is False
        the caller should fall back to launch_game (e.g. not under gamescope, or
        the spec couldn't be written).
        """
        try:
            if not (self._retroarch and self._retroarch._gamescope_running()):
                return {'success': False, 'steam_host': False,
                        'message': 'Not running under gamescope'}
            idx = self._games_index()
            effective_rom_id = sibling_rom_id or rom_id
            g = idx.get(effective_rom_id)
            if not g or not g.get('is_downloaded') or not g.get('local_path'):
                # Regional/disc variants live on their parent, not in the index.
                g = self._variant_game(idx, rom_id, effective_rom_id) or g
            if not g or not g.get('is_downloaded') or not g.get('local_path'):
                return {'success': False, 'steam_host': False,
                        'message': 'Game not downloaded'}
            effective_disc = disc or self._get_last_disc(effective_rom_id) or None
            launch_path = self._resolve_launch_path(g['local_path'], effective_disc)
            if not launch_path and effective_disc:
                effective_disc = None
                launch_path = self._resolve_launch_path(g['local_path'], None)
            if not launch_path:
                return {'success': False, 'steam_host': False,
                        'message': 'No launchable file found'}
            platform_name = self._platform_name_for(g)
            # Same order as launch_game: a missing core makes the sync wasted
            # work, since the picker sends the user back through here.
            gap = self._core_gap(g, platform_name)
            if gap.get('needs_core'):
                return {'success': False, 'steam_host': False,
                        'message': f'No core installed for {platform_name}', **gap}
            bios = self._bios_gap(g, platform_name)
            core = await self._pre_launch_sync(g)
            entry_slot = self._resume_entry_slot(g, core) if resume else None
            cmd, err = self._retroarch.build_launch_command(
                Path(launch_path), platform_name, entry_slot=entry_slot)
            if err or not cmd:
                return {'success': False, 'steam_host': False,
                        'message': err or 'Could not resolve launch command'}
            # The host runs under Steam, so it already has the correct display
            # (:1), session vars and the real overlay LD_PRELOAD. We deliberately
            # pass NO env — overriding it would clobber Steam's overlay preload.
            spec = {'argv': [str(c) for c in cmd], 'rom_name': g.get('name', ''),
                    'ts': time.time()}
            spec_path = (CONFIG_DIR
                         / 'session' / 'launch-spec.json')
            spec_path.parent.mkdir(parents=True, exist_ok=True)
            tmp = spec_path.with_suffix('.json.tmp')
            tmp.write_text(json.dumps(spec), encoding='utf-8')
            os.replace(tmp, spec_path)
            # Remember an explicit disc choice so the next plain Play resumes it.
            if disc:
                try:
                    self._settings.set('LastDisc', str(effective_rom_id), disc)
                except Exception as e:
                    logging.warning(f"could not persist last disc: {e}")
            logging.info(f"prepare_steam_launch: wrote spec for '{g.get('name')}' "
                         f"argv={cmd}")
            return {'success': True, 'steam_host': True, 'message': 'Spec ready',
                    **({'bios_warning': bios} if bios else {})}
        except Exception as e:
            logging.error(f"prepare_steam_launch error: {e}", exc_info=True)
            return {'success': False, 'steam_host': False, 'message': str(e)}

    async def get_session_host_path(self):
        """Absolute path to bin/romm-session-host — the exe the RomM Steam tile
        runs so the emulator launches as a child of a Steam-tracked game (overlay
        works). Returns {path} or {path: ''} if the script is missing.
        """
        try:
            host = Path(__file__).resolve().parent / 'bin' / 'romm-session-host'
            if host.is_file():
                try:
                    if not os.access(host, os.X_OK):
                        os.chmod(host, 0o755)
                except Exception:
                    pass
                return {'path': str(host)}
        except Exception as e:
            logging.error(f"get_session_host_path error: {e}")
        return {'path': ''}

    async def get_bios_status(self):
        """Get detailed BIOS download status for all platforms.

        Returns:
            dict with BIOS status including downloading, ready, and failed platforms
        """
        try:
            if self._bios_tracking:
                return self._bios_tracking.get_status()
            else:
                return {
                    'downloading_count': 0,
                    'ready_count': 0,
                    'failed_count': 0,
                    'downloading': [],
                    'ready': [],
                    'failures': {},
                    'platforms': {},
                    'total_platforms': 0,
                    'platforms_ready': 0,
                    'manual_platforms': 0,
                }
        except Exception as e:
            logging.error(f"get_bios_status error: {e}", exc_info=True)
            return {
                'downloading_count': 0,
                'ready_count': 0,
                'failed_count': 0,
                'downloading': [],
                'ready': [],
                'failures': {},
                'platforms': {},
                'total_platforms': 0,
                'platforms_ready': 0,
                'manual_platforms': 0,
                'error': str(e)
            }

    # -----------------------------------------------------------------------
    # Steam shortcut integration
    # -----------------------------------------------------------------------

    async def toggle_collection_steam_sync(self, collection_name: str, enabled: bool):
        """Enable or disable Steam shortcut sync for a specific collection.

        When enabled, creates Steam shortcuts for all downloaded ROMs in the
        collection. When disabled, removes the shortcuts. Auto-sync keeps
        shortcuts updated as ROMs are added/removed.
        """
        try:
            if not self._steam_manager:
                return {'success': False, 'message': 'Steam manager not available'}

            if not self._steam_manager.is_available():
                return {'success': False, 'message': 'Steam userdata not found'}

            # Update the settings
            steam_collections = self._steam_manager.get_steam_sync_collections()
            if enabled:
                steam_collections.add(collection_name)
            else:
                steam_collections.discard(collection_name)
            self._steam_manager.set_steam_sync_collections(steam_collections)

            if self._syncing_steam_collections is None:
                self._syncing_steam_collections = set()
            self._syncing_steam_collections.add(collection_name)
            try:
                if enabled:
                    # Find collection ID and fetch ROMs
                    collection_id = None
                    for col in (self._romm_collections or []):
                        if col.get('name') == collection_name:
                            collection_id = col.get('id')
                            break

                    if collection_id is None:
                        return {'success': False, 'message': f"Collection '{collection_name}' not found"}

                    client = self._romm_client
                    if not client or not client.authenticated:
                        return {'success': False, 'message': 'Not connected to RomM'}

                    collection_roms = client.get_collection_roms(collection_id)
                    download_dir = Path(self._settings.get('Download', 'rom_directory',
                                                            _default_roms_dir())).expanduser()

                    added, msg = self._steam_manager.add_collection_shortcuts(
                        collection_name, collection_roms, str(download_dir))
                    logging.info(f"Steam sync enabled for '{collection_name}': {msg}")
                    return {'success': True, 'message': msg, 'shortcuts_added': added}
                else:
                    removed, msg = self._steam_manager.remove_collection_shortcuts(collection_name)
                    logging.info(f"Steam sync disabled for '{collection_name}': {msg}")
                    return {'success': True, 'message': msg, 'shortcuts_removed': removed}
            finally:
                self._syncing_steam_collections.discard(collection_name)

        except Exception as e:
            logging.error(f"toggle_collection_steam_sync error: {e}", exc_info=True)
            return {'success': False, 'message': str(e)}

    async def toggle_steam_integration(self, enabled: bool):
        """Enable or disable Steam integration globally.

        When enabled, adds Steam shortcuts for all currently synced collections.
        When disabled, removes all Steam shortcuts for all synced collections.
        """
        try:
            import configparser
            ini_path = CONFIG_DIR / 'settings.ini'
            if not ini_path.exists():
                logging.error("Settings file not found")
                return {'success': False, 'message': 'Settings file not found'}

            config = configparser.ConfigParser()
            config.read(ini_path)
            if not config.has_section('Steam'):
                config.add_section('Steam')

            config.set('Steam', 'enabled', str(enabled).lower())

            total_added = 0
            total_removed = 0
            collections_count = 0

            if self._steam_manager and self._steam_manager.is_available():
                if enabled:
                    # When enabling, add Steam shortcuts for all currently synced collections
                    actively_syncing = config.get('Collections', 'actively_syncing', fallback='')
                    synced_collections = {c for c in actively_syncing.split('|') if c}

                    if synced_collections and self._romm_client and self._romm_client.authenticated:
                        for collection_name in synced_collections:
                            try:
                                # Enable Steam sync for this collection
                                steam_collections = self._steam_manager.get_steam_sync_collections()
                                steam_collections.add(collection_name)
                                self._steam_manager.set_steam_sync_collections(steam_collections)

                                # Find collection and add shortcuts
                                collection_id = None
                                for col in (self._romm_collections or []):
                                    if col.get('name') == collection_name:
                                        collection_id = col.get('id')
                                        break

                                if collection_id:
                                    collection_roms = self._romm_client.get_collection_roms(collection_id)
                                    download_dir = Path(self._settings.get('Download', 'rom_directory',
                                                                            _default_roms_dir())).expanduser()
                                    added, msg = self._steam_manager.add_collection_shortcuts(
                                        collection_name, collection_roms, str(download_dir))
                                    total_added += added
                                    collections_count += 1
                                    logging.info(f"Added {added} shortcuts for '{collection_name}'")
                            except Exception as e:
                                logging.warning(f"Error adding shortcuts for {collection_name}: {e}")
                else:
                    # When disabling, clean up all Steam shortcuts
                    steam_collections = self._steam_manager.get_steam_sync_collections().copy()
                    if steam_collections:
                        for collection_name in steam_collections:
                            try:
                                removed, msg = self._steam_manager.remove_collection_shortcuts(collection_name)
                                total_removed += removed
                                collections_count += 1
                                logging.info(f"Removed {removed} shortcuts for '{collection_name}'")
                            except Exception as e:
                                logging.warning(f"Error removing shortcuts for {collection_name}: {e}")

                        # Clear the Steam sync collections list
                        self._steam_manager.set_steam_sync_collections(set())

            with open(ini_path, 'w') as f:
                config.write(f)

            # Update in-memory settings
            if self._settings:
                self._settings.load_settings()

            if enabled:
                if collections_count > 0:
                    message = f"Steam integration enabled — added {total_added} shortcuts from {collections_count} synced collections"
                else:
                    message = "Steam integration enabled — no collections currently synced"
            else:
                if collections_count > 0:
                    message = f"Steam integration disabled — removed {total_removed} shortcuts from {collections_count} collections"
                else:
                    message = "Steam integration disabled"

            logging.info(message)
            return {'success': True, 'message': message}

        except Exception as e:
            logging.error(f"toggle_steam_integration error: {e}", exc_info=True)
            return {'success': False, 'message': str(e)}
