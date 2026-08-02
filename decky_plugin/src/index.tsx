import {
  ButtonItem,
  PanelSection,
  PanelSectionRow,
  TextField,
  Navigation,
  Router,
  staticClasses,
  DialogButton,
  Focusable,
  GamepadButton,
  showModal,
  ModalRoot,
  showContextMenu,
  Menu,
  MenuItem,
} from "@decky/ui";
import { callable, definePlugin, toaster, routerHook, openFilePicker, FileSelectionType } from "@decky/api";
import { useState, useEffect, useLayoutEffect, useRef, useMemo, forwardRef, memo, cloneElement, type Ref, type ChangeEvent } from "react";
import { FaSync, FaTrash, FaCog, FaGithub, FaBug, FaUndo, FaCopy, FaGamepad, FaBookmark, FaHome, FaSearch, FaTimes, FaTimesCircle, FaDownload, FaPlay, FaInfoCircle, FaRegClock, FaLayerGroup, FaChevronLeft, FaChevronRight, FaCheckCircle, FaUsers, FaExternalLinkAlt, FaPuzzlePiece, FaBoxOpen, FaClone, FaRedo, FaClock, FaCheck, FaEllipsisH, FaGlobe, FaChevronDown, FaChartBar, FaSave, FaUser, FaExclamationTriangle, FaHistory, FaPowerOff, FaCloudUploadAlt } from "react-icons/fa";
import { BsGearFill } from "react-icons/bs";
import { MdVerified } from "react-icons/md";

// Call backend methods
const getServiceStatus = callable<[], any>("get_service_status");
const ackLibraryAnnouncement = callable<[], any>("ack_library_announcement");
const notifyNetworkState = callable<[boolean], any>("notify_network_state");
const drainNotifications = callable<[], { events: Array<{ kind: string, title: string, body: string, timestamp: number }> }>("drain_notifications");
const refreshFromRomm = callable<[boolean], any>("refresh_from_romm");
// `rom_id` is present only on entries that name a single rom (downloads), and
// only on entries written since it was added — older persisted logs lack it.
const getRecentActivity = callable<[number], { events: Array<{ kind: string, title: string, detail: string, timestamp: number, rom_id?: number }> }>("get_recent_activity");
const clearRecentActivity = callable<[], any>("clear_recent_activity");
const getLoggingEnabled = callable<[], boolean>("get_logging_enabled");
const updateLoggingEnabled = callable<[boolean], boolean>("set_logging_enabled");
const getRetrodeckButtonEnabled = callable<[], boolean>("get_retrodeck_button_enabled");
const setRetrodeckButtonEnabled = callable<[boolean], boolean>("set_retrodeck_button_enabled");
const getRetrodeckLogo = callable<[], any>("get_retrodeck_logo");
const launchRetrodeckNative = callable<[], { ok: boolean; reason?: string }>("launch_retrodeck");
const getSteamTileStatus = callable<[], any>("get_steam_tile_status");
const setSteamTile = callable<[boolean, string, string, string], any>("set_steam_tile");
const getCoreMappings = callable<[], any>("get_core_mappings");
const setCoreOverride = callable<[string, string], any>("set_core_override");
const downloadCore = callable<[string], any>("download_core");
const getEmulatorStatus = callable<[boolean?], any>("get_emulator_status");
const repairEmulatorPaths = callable<[string[]?], any>("repair_emulator_paths");
const installEmulator = callable<[], any>("install_emulator");
const emulatorInstallState = callable<[], any>("emulator_install_state");
// Folder-only setter — save_config is the wizard's, and rewrites credentials.
const setLibraryPaths = callable<[string?, string?, string?, string?], any>("set_library_paths");
const getDownloadableCores = callable<[boolean], any>("get_downloadable_cores");
const getConfig = callable<[], any>("get_config");
const logout = callable<[boolean], any>("logout");
const getAccountUsername = callable<[], any>("get_account_username");
const getAvatar = callable<[], any>("get_avatar");
const getPluginStats = callable<[], any>("get_plugin_stats");
const saveConfig = callable<[string, string, string, string, string, string, string], any>("save_config");
const testRommConnection = callable<[string, string, string], any>("test_connection");
const pairDevice = callable<[string, string], any>("pair_device");
const setDeviceNameRpc = callable<[string], any>("set_device_name");
const getSaveHistory = callable<[number], any>("get_save_history");
const getPendingUploads = callable<[], any>("get_pending_uploads");
const getSaveScreenshot = callable<[number, number, string], any>("get_save_screenshot");
const restoreSaveVersion = callable<[number, number, string, boolean], any>("restore_save_version");
// Game Browser
const getLibraryGroups = callable<[string], any>("get_library_groups");
const getLibraryGames = callable<[string, string], any>("get_library_games");
const getGameCover = callable<[number, boolean], any>("get_game_cover");
const getImage = callable<[string], any>("get_image");
const clearCoverCache = callable<[], any>("clear_cover_cache");
const searchGames = callable<[string], any>("search_games");
const getGameDetail = callable<[number], any>("get_game_detail");
const getRaEarned = callable<[number], any>("get_ra_earned");
const downloadGame = callable<[number], any>("download_game");
const toggleCollectionSync = callable<[string, boolean], any>("toggle_collection_sync");
const deleteCollectionRoms = callable<[string, string], any>("delete_collection_roms");
const getDownloadProgress = callable<[number], any>("get_download_progress");
const deleteGame = callable<[number], any>("delete_game");
const launchGame = callable<[number, (string | null)?, (number | null)?], any>("launch_game");
// Steam Deck session-host launch: resolves argv + writes a launch-spec; the tile
// is then RunGame'd so the emulator is a child of a Steam-tracked game (overlay).
const prepareSteamLaunch = callable<[number, (string | null)?, (number | null)?], any>("prepare_steam_launch");
const getSessionHostPath = callable<[], any>("get_session_host_path");
const getLocalDiscs = callable<[number], any>("get_local_discs");
const getLocalSiblings = callable<[number], any>("get_local_siblings");
const getHomeData = callable<[], any>("get_home_data");
const getPluginLogo = callable<[], any>("get_plugin_logo");
const getRommArtwork = callable<[], any>("get_romm_artwork");
const getRommLogo = callable<[], any>("get_romm_logo");

// Shared image-fetch queue. The home page mounts dozens of tiles at once, each
// of which needs a base64 cover / screenshot / platform-icon over RPC. Firing
// them all in parallel slams the backend (it serves one image at a time) and
// stalls the whole grid. Instead we funnel every image RPC through a small
// concurrency-limited queue so tiles fill in progressively, FIFO (≈ left to
// right / top to bottom) — the same one-at-a-time backbone the Save Data page
// uses for its state screenshots.
function makeImageQueue(concurrency: number) {
  let active = 0;
  const pending: Array<() => void> = [];
  const pump = () => {
    while (active < concurrency && pending.length) {
      active++;
      pending.shift()!();
    }
  };
  return function enqueue<T>(job: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      pending.push(() => {
        job().then(resolve, reject).finally(() => { active--; pump(); });
      });
      pump();
    });
  };
}
const imageQueue = makeImageQueue(3);
const qGetImage = (path: string) => imageQueue(() => getImage(path));
const qGetGameCover = (romId: number, large: boolean) => imageQueue(() => getGameCover(romId, large));

// Resolved platform-icon cache: platformKey -> data URI (or null = no icon).
// Persisted to localStorage because there are only ~dozens of tiny icons and
// they're the same every session — so they paint instantly even after a reload
// instead of compositing in one-by-one on the Platforms tab.
const _platIconCache = new Map<string, string | null>();
const _LS_PLATICON = 'romm:platicons:v1';
function _platIconCacheSet(key: string, uri: string | null) {
  _platIconCache.set(key, uri);
  if (!_lsAvail) return;
  try {
    const obj: Record<string, string | null> = {};
    _platIconCache.forEach((v, k) => { obj[k] = v; });
    localStorage.setItem(_LS_PLATICON, JSON.stringify(obj));
  } catch { }
}

// Decoded-art cache (data URIs) so covers persist across tile remounts and can be
// prefetched for neighbouring groups — the grid then slides in fully painted
// instead of popping each cover in as its base64 fetch lands.
// Keys: `cover:${romId}:${large}` for ROM covers, `img:${path}` for screenshots.
const _coverCache = new Map<string, string | null>();   // resolved results only
const _coverInflight = new Map<string, Promise<string | null>>(); // dedup in-flight
// Sync peek: resolved URI (string | null) or undefined if not yet loaded.
const peekCover = (key: string): string | null | undefined =>
  _coverCache.has(key) ? _coverCache.get(key) : undefined;
// Deduped fetch into the cache; safe to call from many tiles / prefetch at once.
// Only CONFIRMED results are cached: the backend returns success:false while it
// is still connecting/authenticating (e.g. the window right after a self-update
// reload). Caching that null would poison the tile to black until a fresh module
// import (reopening the plugin). A soft failure is left uncached so the next
// mount retries; a genuine "no cover" (success:true, data_uri:null) is cached.
function awaitCover(key: string, fetcher: () => Promise<{ success?: boolean; data_uri?: string } | null>): Promise<string | null> {
  if (_coverCache.has(key)) return Promise.resolve(_coverCache.get(key)!);
  let p = _coverInflight.get(key);
  if (!p) {
    p = fetcher()
      .then((r) => {
        const u = r?.data_uri || null;
        if (r && r.success !== false) _coverCache.set(key, u);
        _coverInflight.delete(key);
        return u;
      })
      .catch(() => { _coverInflight.delete(key); return null; });
    _coverInflight.set(key, p);
  }
  return p;
}

// ---------------------------------------------------------------------------
// RomM v2 visual language (from rommapp/romm frontend/src/v2/styles/tokens.css).
// The Game Browser renders custom divs styled with these tokens instead of the
// Steam/Decky chrome; Focusable is used only for gamepad navigation.
// ---------------------------------------------------------------------------
const V2 = {
  bg: '#07070f',
  surface: 'rgba(255,255,255,0.07)',
  surfaceHover: 'rgba(255,255,255,0.12)',
  border: 'rgba(255,255,255,0.07)',
  borderStrong: 'rgba(255,255,255,0.15)',
  fg: '#ffffff',
  fg2: 'rgba(255,255,255,0.75)',
  fgMuted: 'rgba(255,255,255,0.45)',
  fgFaint: 'rgba(255,255,255,0.25)',
  bgElevated: 'rgba(255,255,255,0.045)',
  brand: '#8b74e8',
  brandHover: '#a18fff',
  brandPressed: '#6043c8',
  success: '#4ade80',
  warning: '#fbbf24',
  danger: '#ff5050',
  igdb: '#6366f1',
  ra: '#ef4444',
  coverPlaceholder: '#1a1a2e',
  radiusArt: '8px',
  radiusSm: '4px',
  radiusMd: '8px',
  radiusChip: '6px',
  radiusLg: '10px',
  radiusCard: '14px',
  radiusPill: '100px',
  elev2: '0 8px 24px rgba(0,0,0,.45)',
  font: '"Motiva Sans","Segoe UI",system-ui,-apple-system,sans-serif',
};

// RomM GameActionBtn round buttons: glassy scrim with blur (default), or the
// "emphasized" white look used by Play. Circular; size in px.
function roundBtn(size: number, variant: 'glass' | 'emphasized' | 'danger'): any {
  const base: any = {
    width: `${size}px`, height: `${size}px`, borderRadius: '50%',
    display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer',
    backdropFilter: 'blur(6px)', WebkitBackdropFilter: 'blur(6px)',
    transition: 'background 0.15s, color 0.15s, border-color 0.15s',
  };
  if (variant === 'emphasized') return { ...base, background: '#ffffff', border: '1px solid #ffffff', color: '#111117' };
  if (variant === 'danger') return { ...base, background: 'rgba(0,0,0,0.55)', border: '1px solid rgba(255,80,80,0.55)', color: V2.danger };
  return { ...base, background: 'rgba(0,0,0,0.55)', border: '1px solid rgba(255,255,255,0.12)', color: 'rgba(255,255,255,0.95)' };
}

interface LibGroup {
  key: string; label: string; count: number; downloaded: number | null;
  kind?: 'favorite' | 'smart' | 'virtual' | 'collection'; covers?: string[];
  slug?: string | null; fs_slug?: string | null;
  synced?: boolean; virtual?: boolean;
}
interface LibGame { rom_id: number; name: string; platform: string | null; is_downloaded: boolean; has_cover: boolean; screenshot?: string | null; platform_slug?: string | null; is_multi_disc?: boolean; disc_count?: number; sibling_roms?: { rom_id: number; name: string }[]; region_count?: number; }

function fmtBytes(n: number | null | undefined): string {
  if (!n || isNaN(n as any)) return '';
  let v = Number(n);
  for (const u of ['B', 'KB', 'MB', 'GB']) {
    if (v < 1024) return u === 'B' ? `${v.toFixed(0)} ${u}` : `${v.toFixed(1)} ${u}`;
    v /= 1024;
  }
  return `${v.toFixed(1)} TB`;
}

// Full release date "02 Jan 2024" — RomM GameHeader meta uses the localized
// day/short-month/year form rather than just the year.
function fmtReleaseDate(ts: number | null | undefined): string {
  if (!ts) return '';
  try {
    // RomM stores first_release_date as a Unix timestamp in milliseconds and
    // formats it directly (new Date(ms)); match that exactly.
    const d = new Date(Number(ts));
    if (isNaN(d.getTime())) return '';
    return d.toLocaleDateString(undefined, { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' });
  } catch { return ''; }
}

// Blurred full-bleed background art — the defining RomM v2 surface. The
// focused/first cover is painted behind everything, heavily blurred and dimmed,
// with a bg-coloured gradient scrim on top (recipe lifted verbatim from RomM's
// frontend/src/v2/styles/global.css: blur(28px) brightness(0.45), scale 1.08).
function V2Bg({ uri }: { uri: string | null }) {
  // RomM's BackgroundArt falls back to /assets/auth_background.svg when no cover
  // is set (platform/collection index pages). Fetch it once as the default.
  const [fallback, setFallback] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    (async () => {
      try { const r = await getImage('/assets/auth_background.svg'); if (alive) setFallback(r?.data_uri || null); }
      catch { /* ignore */ }
    })();
    return () => { alive = false; };
  }, []);
  const shown = uri || fallback;
  return (
    <>
      <div style={{
        position: 'fixed', inset: 0, zIndex: 0, pointerEvents: 'none',
        backgroundImage: shown ? `url('${shown}')` : 'none',
        backgroundColor: V2.bg,
        backgroundSize: 'cover', backgroundPosition: 'center 20%', backgroundRepeat: 'no-repeat',
        filter: 'blur(28px) brightness(0.45)', transform: 'scale(1.08)',
        transition: 'background-image 0.5s ease',
      }} />
      <div style={{
        position: 'fixed', inset: 0, zIndex: 1, pointerEvents: 'none',
        background:
          `linear-gradient(to right, rgba(7,7,15,0.72) 0%, rgba(7,7,15,0.30) 55%, rgba(7,7,15,0.55) 100%),` +
          `linear-gradient(to bottom, rgba(7,7,15,0.10) 0%, rgba(7,7,15,0) 35%, rgba(7,7,15,0.70) 72%, rgba(7,7,15,0.92) 100%)`,
      }} />
    </>
  );
}

// Lazy, cached cover art. Renders a placeholder until the base64 data URI
// arrives from the backend (the frontend <img> can't auth to RomM directly).
// `onLoaded` bubbles the URI up so a tile can feed the blurred background art.
function GameCover({ romId, hasCover, large = false, radius = V2.radiusArt, onLoaded }:
  { romId: number; hasCover: boolean; large?: boolean; radius?: string; onLoaded?: (uri: string | null) => void }) {
  const ck = `cover:${romId}:${large}`;
  const peek = peekCover(ck);
  const [uri, setUri] = useState<string | null>(peek ?? null);
  const [done, setDone] = useState(peek !== undefined);
  // Load on mount. We deliberately do NOT viewport-gate the fetch here:
  // IntersectionObserver doesn't fire on gamepad focus-scroll under gamescope
  // (only on touch swipe), so gating left dpad-scrolled covers blank. Instead
  // the parent grid bounds how many tiles are mounted (visN grows as focus
  // advances), so "load every mounted cover" already loads only what's reached.
  useEffect(() => {
    let alive = true;
    if (!hasCover) { setDone(true); onLoaded?.(null); return; }
    const p = peekCover(ck);
    if (p !== undefined) { setUri(p); setDone(true); onLoaded?.(p); return; }
    let attempts = 0;
    const load = async () => {
      const u = await awaitCover(ck, () => qGetGameCover(romId, large));
      if (!alive) return;
      // A null the cache DIDN'T keep is a soft failure (backend still connecting,
      // e.g. right after a self-update reload). Retry with backoff rather than
      // showing "No cover" until the user reopens the plugin. A confirmed result
      // (cached) — real cover or genuine no-cover — is accepted immediately.
      if (u === null && peekCover(ck) === undefined && attempts < 8) {
        attempts++;
        setTimeout(load, Math.min(500 * attempts, 3000));
        return;
      }
      setUri(u); onLoaded?.(u); setDone(true);
    };
    load();
    return () => { alive = false; };
  }, [romId, large]);
  return (
    <div style={{
      position: 'relative', width: '100%', aspectRatio: '3 / 4',
      background: V2.coverPlaceholder, borderRadius: radius, overflow: 'hidden',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
    }}>
      {uri ? (
        <img src={uri} style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
      ) : (
        <span style={{ color: V2.fgMuted, fontSize: '11px' }}>{done ? 'No cover' : '…'}</span>
      )}
    </div>
  );
}

// Landscape screenshot art (RomM continue-playing cover override). Fetches the
// screenshot path as base64 via get_image, fills the art box object-fit:cover.
// `onLoaded` bubbles the URI so the card can feed it to the background art.
function ScreenshotArt({ path, onLoaded, onRatio }:
  { path: string; onLoaded?: (uri: string | null) => void; onRatio?: (ratio: number) => void }) {
  const ik = `img:${path}`;
  const [uri, setUri] = useState<string | null>(peekCover(ik) ?? null);
  useEffect(() => {
    let alive = true;
    let attempts = 0;
    const load = async () => {
      const u = await awaitCover(ik, () => qGetImage(path));
      if (!alive) return;
      // Same soft-failure retry as GameCover (backend still connecting).
      if (u === null && peekCover(ik) === undefined && attempts < 8) {
        attempts++;
        setTimeout(load, Math.min(500 * attempts, 3000));
        return;
      }
      setUri(u); onLoaded?.(u);
    };
    load();
    return () => { alive = false; };
  }, [path]);
  return (
    <div style={{
      position: 'absolute', inset: 0, background: V2.coverPlaceholder,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
    }}>
      {uri && <img src={uri}
        onLoad={(e: any) => {
          const w = e.target?.naturalWidth, h = e.target?.naturalHeight;
          if (w && h) onRatio?.(w / h);
        }}
        style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />}
    </div>
  );
}

// Cover-art PIP — a small 2D box-art thumbnail floated bottom-right while a
// screenshot covers the rom's own art, so the game stays identifiable (RomM
// CoverArtPip). Fades out on focus so it never collides with the action row.
function CoverPip({ romId, hasCover, hidden }:
  { romId: number; hasCover: boolean; hidden: boolean }) {
  const ck = `cover:${romId}:false`;
  const [uri, setUri] = useState<string | null>(peekCover(ck) ?? null);
  useEffect(() => {
    let alive = true;
    if (!hasCover) return;
    const p = peekCover(ck);
    if (p !== undefined) { setUri(p); return; }
    (async () => {
      try { const u = await awaitCover(ck, () => qGetGameCover(romId, false)); if (alive) setUri(u); }
      catch { /* ignore */ }
    })();
    return () => { alive = false; };
  }, [romId]);
  if (!uri) return null;
  return (
    <div style={{
      position: 'absolute', right: '6px', bottom: '6px', width: '46px',
      aspectRatio: '3 / 4', zIndex: 2, borderRadius: V2.radiusSm, overflow: 'hidden',
      border: '1.5px solid rgba(255,255,255,0.12)',
      boxShadow: '0 2px 8px rgba(0,0,0,0.45)', pointerEvents: 'none',
      opacity: hidden ? 0 : 1, transition: 'opacity 0.12s ease',
    }}>
      <img src={uri} style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
    </div>
  );
}

// Box art for a toast's logo slot, so a "Downloaded" notification shows the
// game rather than just naming it. The cover is nearly always already in
// `_coverCache` — the tile the user pressed painted it — so this renders on the
// first frame; a cache miss loads in behind nothing rather than reserving an
// empty box, and a rom with no art renders nothing at all, which lets the host
// fall back to its own icon instead of showing a grey rectangle.
function ToastCover({ romId, hasCover }: { romId: number; hasCover: boolean }) {
  const ck = `cover:${romId}:false`;
  const [uri, setUri] = useState<string | null>(peekCover(ck) ?? null);
  useEffect(() => {
    if (!hasCover || peekCover(ck) !== undefined) return;
    let alive = true;
    awaitCover(ck, () => qGetGameCover(romId, false))
      .then((u) => { if (alive) setUri(u); })
      .catch(() => { /* no art, no logo */ });
    return () => { alive = false; };
  }, [romId]);
  if (!uri) return null;
  return (
    <img src={uri} style={{
      width: '32px', aspectRatio: '3 / 4', objectFit: 'cover', display: 'block',
      borderRadius: V2.radiusSm, border: '1px solid rgba(255,255,255,0.12)',
    }} />
  );
}

// A single library grid card: art-only with a centered, single-line label
// underneath (RomM's GameCard language). Focus/hover scales the art and paints
// the brand glow; activating it opens the game; gaining focus feeds the cover
// to the page's background art. When `game.screenshot` is set (continue-playing
// rail), the art is a landscape screenshot with the box-art floated as a PIP,
// matching RomM's Home — otherwise it's the portrait cover.
// Polls get_download_progress until the background download reaches a terminal
// state, resolving with the outcome. The download itself is kicked off by
// download_game (which returns immediately); this drives completion + the toast.
async function awaitDownload(romId: number): Promise<{ ok: boolean; message?: string }> {
  for (; ;) {
    let p: any;
    try { p = await getDownloadProgress(romId); }
    catch { await new Promise((r) => setTimeout(r, 500)); continue; }
    if (p?.state === 'done') return { ok: true };
    if (p?.state === 'error') return { ok: false, message: p.message };
    if (p?.state === 'idle') return { ok: false, message: 'Download did not start' };
    await new Promise((r) => setTimeout(r, 400));
  }
}

// Global registry of in-flight downloads (by rom_id) so EVERY surface showing a
// game (its cover tile + its details page) reflects the download — not just the
// one whose button was clicked. doDownload toggles membership; surfaces subscribe.
const _dlActive = new Set<number>();
// Display names for the registry (keyed by rom_id) so the account menu's
// Downloads section can label each in-flight download.
const _dlNames = new Map<number, string>();
// Batch items waiting for a worker slot (rom_id → name) — shown as "Queued" on
// the Downloads page. Seeded by downloadBatch, drained as each download starts.
const _dlQueue = new Map<number, string>();
// Roms whose download completed successfully this session, so a mounted tile
// can light its downloaded dot the moment its global download finishes (the
// games-list prop only updates on the next refetch).
const _dlSucceeded = new Set<number>();
const _dlListeners = new Set<() => void>();
function _notifyDl() { _dlListeners.forEach((l) => { try { l(); } catch { } }); }
function _setDlActive(romId: number, on: boolean, name?: string) {
  if (on) { _dlActive.add(romId); if (name) _dlNames.set(romId, name); }
  else { _dlActive.delete(romId); _dlNames.delete(romId); }
  _notifyDl();
}
// Downloads one game through the same path as the tile button: registers it in
// the global registry (so its cover tile shows the ring), kicks off the backend
// download, then polls to completion. Returns whether it succeeded.
async function downloadOne(romId: number, name?: string): Promise<boolean> {
  if (_dlActive.has(romId)) { // already downloading elsewhere — just wait it out
    return (await awaitDownload(romId)).ok;
  }
  _setDlActive(romId, true, name);
  try {
    const start = await downloadGame(romId);
    if (!start?.success) return false;
    const ok = (await awaitDownload(romId)).ok;
    if (ok) {
      // Reflect the new local copy everywhere immediately: cached group lists
      // (so a remounted grid seeds correct dots) and mounted tiles (via
      // _dlSucceeded + the registry notification from _setDlActive below).
      _dlSucceeded.add(romId);
      libCacheSetDownloaded(romId, true);
    }
    return ok;
  } catch { return false; }
  finally { _setDlActive(romId, false); }
}

// Runs a batch of downloads with bounded concurrency, reporting progress after
// each one finishes. Returns the count that succeeded.
async function downloadBatch(
  items: { id: number; name: string }[], concurrency: number, onProgress: (done: number, ok: number) => void,
): Promise<number> {
  for (const it of items) if (!_dlActive.has(it.id)) _dlQueue.set(it.id, it.name);
  _notifyDl();
  let done = 0, ok = 0, i = 0;
  const worker = async () => {
    while (i < items.length) {
      const it = items[i++];
      _dlQueue.delete(it.id); _notifyDl();
      if (await downloadOne(it.id, it.name)) ok++;
      done++;
      onProgress(done, ok);
    }
  };
  try {
    await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  } finally {
    for (const it of items) _dlQueue.delete(it.id);
    _notifyDl();
  }
  return ok;
}

// One-shot collection batch with MODULE-level job state, keyed by the group's
// cache key. The old per-page useState died on unmount, so leaving a syncing
// collection and coming back lost the header progress even though the batch
// kept running — this survives, and useBatchJob re-attaches any remount.
interface BatchJob { done: number; ok: number; total: number; ids: number[]; }
const _batchJobs = new Map<string, BatchJob>();
function useBatchJob(key: string | null): BatchJob | null {
  const [, force] = useState(0);
  useEffect(() => {
    const l = () => force((n) => n + 1);
    _dlListeners.add(l);
    return () => { _dlListeners.delete(l); };
  }, []);
  return key ? (_batchJobs.get(key) || null) : null;
}
// `onOpen` (optional) makes this batch's toasts clickable — it should navigate
// to the collection the batch belongs to. Passed in rather than derived from
// jobKey because only the caller knows the mode and the sibling groups the
// grid header pages through.
async function runCollectionBatch(jobKey: string, items: { id: number; name: string }[], onOpen?: () => void): Promise<void> {
  if (_batchJobs.has(jobKey) || items.length === 0) return;
  _batchJobs.set(jobKey, { done: 0, ok: 0, total: items.length, ids: items.map((i) => i.id) });
  _notifyDl();
  toaster.toast({ title: 'Syncing collection', body: `Downloading ${items.length} game${items.length === 1 ? '' : 's'}`, onClick: onOpen });
  let ok = 0;
  try {
    ok = await downloadBatch(items, 3, (done, okN) => {
      const j = _batchJobs.get(jobKey);
      if (j) { j.done = done; j.ok = okN; _notifyDl(); }
    });
  } finally {
    _batchJobs.delete(jobKey); _notifyDl();
  }
  toaster.toast({ title: 'Sync complete', body: `${ok} of ${items.length} downloaded`, onClick: onOpen });
  // Any mounted grid refetches its list so downloaded dots reflect the batch
  // even if the page that started it was unmounted meanwhile.
  _broadcastLibRefresh();
}

// Snapshot of every in-flight download (frontend-initiated), for the account
// menu's Downloads section. Re-renders on registry changes.
function useActiveDownloads(): { romId: number; name: string }[] {
  const snap = () => Array.from(_dlActive).map((id) => ({ romId: id, name: _dlNames.get(id) || `ROM ${id}` }));
  const [v, setV] = useState(snap);
  useEffect(() => {
    const l = () => setV(snap());
    _dlListeners.add(l); l();
    return () => { _dlListeners.delete(l); };
  }, []);
  return v;
}

// Batch items still waiting for a worker slot, for the Downloads page's Queued list.
function useQueuedDownloads(): { romId: number; name: string }[] {
  const snap = () => Array.from(_dlQueue, ([id, name]) => ({ romId: id, name }));
  const [v, setV] = useState(snap);
  useEffect(() => {
    const l = () => setV(snap());
    _dlListeners.add(l); l();
    return () => { _dlListeners.delete(l); };
  }, []);
  return v;
}

interface PendingUpload {
  game: string;
  type: 'saves' | 'states';
  emulator?: string | null;
  modified: number;
  files: { name: string; path: string; modified: number; size: number }[];
}

// The itemized upload queue for the Downloads page: local saves/states waiting
// to push on reconnect. Backed by get_pending_uploads (which groups by game,
// same drift test as the pending_saves count). Read-only — the sync engine
// flushes these automatically on connect; this only surfaces WHAT is waiting.
// Polls slowly, and only while there's actually something pending (the offline
// banner's pending_saves count tells us when to look), so an online, idle Deck
// never hits the backend for this.
function usePendingUploads(pendingCount: number): PendingUpload[] {
  const [items, setItems] = useState<PendingUpload[]>([]);
  useEffect(() => {
    if (!pendingCount) { setItems([]); return; }
    let alive = true;
    const load = async () => {
      try {
        const res = await getPendingUploads();
        if (alive && Array.isArray(res)) setItems(res as PendingUpload[]);
      } catch { /* transient */ }
    };
    load();
    const iv = setInterval(load, 5000);
    return () => { alive = false; clearInterval(iv); };
  }, [pendingCount]);
  return items;
}

// Lightweight aggregate for the top-bar glimpse (the user pill's avatar ring):
// how many downloads are running (per-game registry + backend collection
// auto-sync passes) and their mean percent. Polls only while something is active.
function useDownloadGlimpse(): { count: number; pct: number | null } {
  const [, force] = useState(0);
  useEffect(() => {
    const l = () => force((n) => n + 1);
    _dlListeners.add(l);
    const unsub = _subscribeStatus(l);
    return () => { _dlListeners.delete(l); unsub(); };
  }, []);
  const syncingCount = ((_lastStatus?.collections || []) as any[])
    .filter((c) => c.sync_state === 'syncing').length;
  // Queued batch items count toward the badge (total outstanding work); the
  // ring percent stays the mean of what's actually transferring.
  const count = _dlActive.size + _dlQueue.size + syncingCount;
  const [pct, setPct] = useState<number | null>(null);
  // Session ledger: every rom seen active/queued since the last idle moment.
  // Overall percent = (finished units + in-flight fractions) / all units, so a
  // download finishing contributes exactly 1.0 with no jump at the boundary
  // (the old per-active mean lurched when an item entered or left the set).
  // The value only drops when new work is genuinely added.
  const seenIds = useRef(new Set<number>());
  const on = count > 0;
  useEffect(() => {
    if (!on) { seenIds.current.clear(); setPct(null); return; }
    let alive = true;
    const tick = async () => {
      for (const id of _dlActive) seenIds.current.add(id);
      for (const id of _dlQueue.keys()) seenIds.current.add(id);
      let units = seenIds.current.size, done = 0;
      for (const id of seenIds.current) {
        if (!_dlActive.has(id) && !_dlQueue.has(id)) done += 1; // finished (or failed) unit
      }
      await Promise.all(Array.from(_dlActive).map(async (id) => {
        try {
          const p = await getDownloadProgress(id);
          if (typeof p?.percent === 'number') done += p.percent / 100;
        } catch { /* transient */ }
      }));
      for (const c of ((_lastStatus?.collections || []) as any[])) {
        if (c.sync_state === 'syncing' && typeof c.downloaded_pct === 'number') {
          units += 1; done += c.downloaded_pct / 100;
        }
      }
      if (alive) setPct(units > 0 ? Math.min(100, (done / units) * 100) : null);
    };
    tick();
    const iv = setInterval(tick, 600);
    return () => { alive = false; clearInterval(iv); };
  }, [on]);
  return { count, pct: on ? pct : null };
}

function useIsDownloading(romId: number): boolean {
  const [v, setV] = useState(_dlActive.has(romId));
  useEffect(() => {
    const l = () => setV(_dlActive.has(romId));
    _dlListeners.add(l); l();
    return () => { _dlListeners.delete(l); };
  }, [romId]);
  return v;
}

// Polls the backend for a game's live download progress (0..100) while a download
// is in flight, returning null when idle. Drives the cover download-ring and the
// GameDetails button fill. Activates on either the local `active` flag or the
// global registry, so progress is shared across the cover tile and details page.
interface DlProgress { percent: number; speed: number; eta: number; downloaded: number; total: number; state?: string; }
function useDownloadProgress(romId: number, active: boolean): DlProgress | null {
  const globalActive = useIsDownloading(romId);
  const on = active || globalActive;
  const [prog, setProg] = useState<DlProgress | null>(null);
  useEffect(() => {
    if (!on) { setProg(null); return; }
    let cancelled = false;
    const tick = async () => {
      try {
        const p = await getDownloadProgress(romId);
        if (!cancelled && p && typeof p.percent === 'number') {
          setProg({ percent: p.percent, speed: p.speed || 0, eta: p.eta || 0, downloaded: p.downloaded || 0, total: p.total || 0, state: p.state });
        }
      } catch { /* transient */ }
    };
    tick();
    const id = setInterval(tick, 400);
    return () => { cancelled = true; clearInterval(id); };
  }, [romId, on]);
  return prog;
}

// Eases a displayed integer toward a target so a stepwise percentage (updated
// every poll) counts up smoothly. Resets to 0 when inactive.
function useSmoothNumber(target: number | null, active: boolean): number {
  const [val, setVal] = useState(0);
  const cur = useRef(0);
  const raf = useRef<any>(null);
  useEffect(() => {
    if (!active) { cur.current = 0; setVal(0); return; }
    const t = target ?? 0;
    const step = () => {
      const diff = t - cur.current;
      if (Math.abs(diff) < 0.5) { cur.current = t; setVal(t); return; }
      cur.current += diff * 0.18;
      setVal(cur.current);
      raf.current = requestAnimationFrame(step);
    };
    cancelAnimationFrame(raf.current);
    raf.current = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf.current);
  }, [target, active]);
  return Math.round(val);
}

// Estimates remaining seconds from the velocity of a 0..100 percentage: anchors
// at the start of a run and divides the remaining percent by the average rate.
// Generic enough to drive a collection ETA whether the bytes come from the
// one-shot batch or the background sync worker. Returns 0 until it has a rate.
function useEtaFromPct(pct: number, active: boolean): number {
  const anchor = useRef<{ t: number; p: number } | null>(null);
  const [eta, setEta] = useState(0);
  useEffect(() => {
    if (!active) { anchor.current = null; setEta(0); return; }
    const now = Date.now();
    // (Re)anchor at run start or if progress resets (a new run).
    if (!anchor.current || pct < anchor.current.p) anchor.current = { t: now, p: pct };
    const dt = (now - anchor.current.t) / 1000;
    const dp = pct - anchor.current.p;
    if (dt > 2 && dp > 0.5) setEta(Math.max(0, ((100 - pct) / (dp / dt))));
  }, [pct, active]);
  return eta;
}

// "1m 23s" / "45s" — compact ETA from a seconds count (0 / unknown → '').
const formatEta = (secs: number): string => {
  if (!secs || secs <= 0 || !isFinite(secs)) return '';
  const s = Math.round(secs);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${s % 60}s`;
};

// Circular progress ring drawn around a centered glyph (used on the cover's
// download button). `pct` null renders an empty track.
function ProgressRing({ pct, size = 40, stroke = 3, glow = false, color = V2.brand, children }:
  { pct: number | null; size?: number; stroke?: number; glow?: boolean; color?: string; children?: any }) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const p = Math.max(0, Math.min(100, pct ?? 0));
  return (
    <div style={{ position: 'relative', width: size, height: size, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <svg width={size} height={size} style={{ position: 'absolute', top: 0, left: 0, transform: 'rotate(-90deg)', overflow: 'visible' }}>
        {/* `glow` mode draws only the blurred arc — it's rendered behind the
            opaque button so the inner half is masked and only the outer halo shows. */}
        {!glow && <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="rgba(0,0,0,0.22)" strokeWidth={stroke} />}
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={color} strokeWidth={stroke}
          strokeDasharray={c} strokeDashoffset={c * (1 - p / 100)} strokeLinecap="round"
          style={{
            transition: 'stroke-dashoffset 0.3s ease, stroke 0.3s ease',
            ...(glow ? { filter: `drop-shadow(0 0 5px ${color}) drop-shadow(0 0 3px ${color})` } : {})
          }} />
      </svg>
      {children}
    </div>
  );
}

// Returns a ref to attach to the FIRST selectable item on a screen; once `ready`
// flips true (content loaded), it drops gamepad focus onto that item with a few
// retries to beat Steam's default focus-acquisition — so a direction press moves
// straight into the grid instead of needing a DOWN press out of the header.
// Forcibly hand Steam's gamepad focus to `el`. Plain HTMLElement.focus() only
// works while the gamepad UI's focus context is already inside our tree; right
// after an emulator session ends it isn't, so we also locate the element's
// navigation node inside Steam's FocusNavController trees and take focus
// through the controller itself (BTakeFocus). All internals are undocumented,
// hence the fully defensive access — worst case this degrades to focus().
// Taking focus through the nav controller (BTakeFocus) sets Steam's gamepad
// focus + DOM activeElement, but does NOT emit a bubbling focus event — so
// React's onFocus never fires and our tiles' focused STATE stays false. The
// tile then highlights (CSS :focus-within) yet its focus-gated overlays (play
// button, download scrim, etc.) stay hidden. Fire a synthetic focusin on the
// newly-focused element so React updates its state, restoring the overlays.
let _focusMirrorStop: (() => void) | null = null;
// The element the mirror currently considers focused — module-level so a
// mirror RESTART (every forced focus) can flush the previous element's
// synthetic blur. Without this, tearing down the old observer before it
// processed the pending gpfocus change loses that focusout forever and the
// old element (e.g. a nav pill) keeps its React focused tint.
let _focusMirrorCur: any = null;
function _fireReactFocus(doc: any): void {
  try {
    const ae = doc?.activeElement;
    if (!ae) return;
    const FE = doc.defaultView?.FocusEvent || (window as any).FocusEvent;
    if (_focusMirrorCur && _focusMirrorCur !== ae) {
      try { _focusMirrorCur.dispatchEvent(new FE('focusout', { bubbles: true })); } catch { /* ignore */ }
    }
    // After the post-session restore, Steam moves its gpfocus WITHOUT emitting
    // DOM focus events at all — not just for the forced element but for every
    // subsequent dpad move (tiles highlight via CSS but their React onFocus
    // never fires, so focus-gated overlays only ever showed on the first one).
    // Mirror Steam's gpfocus marker into synthetic focusin/focusout pairs so
    // React state follows the cursor. Duplicate events on tiles whose native
    // handlers DO fire are harmless (state setters are idempotent).
    try { _focusMirrorStop?.(); } catch { /* ignore */ }
    let cur: any = ae;
    _focusMirrorCur = ae;
    cur.dispatchEvent(new FE('focusin', { bubbles: true }));
    // React to the class change itself, not on a timer: a polling mirror lags
    // behind fast dpad movement, leaving the previous tile lit (double
    // highlight) until the next tick. The observer fires in the same frame
    // Steam moves the gpfocus marker.
    const sync = () => {
      try {
        const next = doc.querySelector('.gpfocus');
        if (next === cur) return;
        if (cur) { try { cur.dispatchEvent(new FE('focusout', { bubbles: true })); } catch { /* ignore */ } }
        cur = next;
        _focusMirrorCur = cur;
        if (cur) cur.dispatchEvent(new FE('focusin', { bubbles: true }));
      } catch { /* ignore */ }
    };
    const MO = doc.defaultView?.MutationObserver || (window as any).MutationObserver;
    const obs = new MO(sync);
    obs.observe(doc.body, { subtree: true, attributes: true, attributeFilter: ['class'] });
    // Steam can flip the focus context back to inactive while it's still
    // healing (~5.5s after app exit); an inactive context swallows the next
    // button press to reactivate itself — the "press LB/RB twice to switch
    // tabs" bug. Keep re-asserting the context active through the healing
    // window so every press lands on the first try, like a fresh open.
    const ctxIv = setInterval(() => {
      try {
        const fnc: any = (window as any).FocusNavController;
        const ctx: any = fnc?.m_ActiveContext ?? fnc?.m_LastActiveContext ?? fnc?.m_rgAllContexts?.[0];
        if (ctx && !ctx.BIsActive?.()) ctx.SetActive?.(true);
      } catch { /* ignore */ }
    }, 300);
    setTimeout(() => clearInterval(ctxIv), 8000);
    const stop = () => {
      try { obs.disconnect(); } catch { /* ignore */ }
      try { clearInterval(ctxIv); } catch { /* ignore */ }
      if (_focusMirrorStop === stop) _focusMirrorStop = null;
    };
    _focusMirrorStop = stop;
    setTimeout(stop, 600000);   // leak guard
  } catch { /* ignore */ }
}

function _forceGamepadFocus(el: any): void {
  try { el?.focus?.(); } catch { /* ignore */ }
  // Fast path — healthy state only. The degraded state this function exists
  // for (post-emulator-session) is precisely characterized by the window
  // being OS-unfocused: gamescope never returns focus to Steam's window, so
  // document.hasFocus() stays false and focus() fires no DOM events. When the
  // window IS focused and the context is active, the plain focus() above
  // already landed gamepad focus natively — skip the full nav-tree DFS and
  // the focus-mirror restart, which burn main-thread ms on every tab switch
  // (×5: the pill bridge + 4 useAutoFocus retries), and more so now that all
  // tab panels stay mounted and the tree holds every hidden panel's nodes.
  try {
    const ctx0: any = (window as any).FocusNavController?.m_ActiveContext;
    if (ctx0?.BIsActive?.() && ctx0?.m_rootWindow?.document?.hasFocus?.()) return;
  } catch { /* ignore */ }
  try {
    const fnc: any = (window as any).FocusNavController;
    // Verified live on-device: after an emulator session ends, Steam leaves the
    // gamepad focus CONTEXT deactivated (m_ActiveContext === undefined) and no
    // nav tree active — BTakeFocus then "succeeds" but paints no highlight
    // (no .gpfocus class) and the user steers an invisible cursor. Reactivate
    // the context and re-declare the main page tree active before focusing.
    const ctx: any = fnc?.m_ActiveContext ?? fnc?.m_LastActiveContext ?? fnc?.m_rgAllContexts?.[0];
    try { if (ctx && !ctx.BIsActive?.()) ctx.SetActive?.(true); } catch { /* ignore */ }
    try {
      const mainTree = ctx?.m_rgGamepadNavigationTrees?.find?.((t: any) => t?.m_ID === 'GamepadUI_Full_Root');
      if (mainTree) ctx.SetActiveNavTree?.(mainTree);
    } catch { /* ignore */ }
    const doc: any = ctx?.m_rootWindow?.document;
    const ctxs: any[] = fnc?.m_rgAllContexts ?? (ctx ? [ctx] : []);
    let pageTree: any = null;
    for (const ctx of ctxs) {
      for (const t of (ctx?.m_rgGamepadNavigationTrees ?? [])) {
        if (t?.m_ID === 'GamepadUI_Full_Root') pageTree = t;
        const root = t?.m_Root;
        if (!root) continue;
        const stack: any[] = [root];
        while (stack.length) {
          const n = stack.pop();
          const nEl = n?.m_element;
          // Match by identity OR containment: the ref may point at a wrapper
          // whose actual focus-registered element is a descendant.
          if (nEl && el && (nEl === el || (typeof el.contains === 'function' && el.contains(nEl)))) {
            try { if (n.BTakeFocus?.(3)) { _fireReactFocus(doc); return; } } catch { /* ignore */ }
          }
          const kids = n?.m_rgChildren;
          if (Array.isArray(kids)) for (const k of kids) stack.push(k);
        }
      }
    }
    // No node matched the target element — put focus SOMEWHERE visible on the
    // gamepad-UI page tree so the user isn't stranded with an invisible cursor.
    try {
      pageTree?.m_Root?.BFocusFirstChild?.(3);
      _fireReactFocus(doc);
    } catch { /* ignore */ }
  } catch (e) { console.error('[RomM] forceGamepadFocus', e); }
}

// Summon Steam's virtual keyboard for an input that already has DOM focus.
// Normally DialogInput shows it by itself on focus, but in the degraded
// post-session state (focus context inactive) the show is suppressed even
// though the input registers itself as the keyboard's target. Re-activate the
// context and use the manager's own recovery hook to bring the keyboard up.
function _summonVirtualKeyboard(): void {
  setTimeout(() => {
    try {
      const win: any = (Router as any)?.WindowStore?.GamepadUIMainWindowInstance;
      const vkm: any = win?.VirtualKeyboardManager;
      const doc: any = win?.BrowserWindow?.document;
      const input: any = doc?.activeElement;
      if (!vkm || !input || input.tagName !== 'INPUT') return;
      if (vkm.m_bIsInlineVirtualKeyboardOpen?.m_currentValue) return;
      // gamescope never returns OS focus to the Steam window after a game
      // session (document.hasFocus() stays false), so input.focus() moves
      // activeElement WITHOUT firing a DOM focus event — DialogInput's own
      // focus listener never registers the input with the keyboard manager
      // and nothing shows. Register + show it ourselves via the manager's
      // ref factory (verified live on-device).
      const ref = vkm.CreateVirtualKeyboardRef?.({
        BIsElementValidForInput: () => doc.activeElement === input,
      });
      ref?.ShowVirtualKeyboard?.();
    } catch { /* ignore */ }
  }, 150);
}

// Close the on-screen keyboard programmatically (used when Enter/R2 submits a
// wizard field: the step advances, so the keyboard shouldn't linger). Method
// names verified on-device: SetVirtualKeyboardDone is the "user finished" path,
// SetVirtualKeyboardHidden the plain hide.
function _dismissVirtualKeyboard(): void {
  try {
    const win: any = (Router as any)?.WindowStore?.GamepadUIMainWindowInstance;
    const vkm: any = win?.VirtualKeyboardManager;
    if (!vkm) return;
    if (typeof vkm.SetVirtualKeyboardDone === 'function') vkm.SetVirtualKeyboardDone();
    else vkm.SetVirtualKeyboardHidden?.();
  } catch { /* ignore */ }
}

// The document that gamepad focus actually lives in. Plugin code runs in
// Decky's SharedJSContext — its global `document` is NOT the Big Picture
// window's document, so .gpfocus queries there always come back empty.
function _gpFocusEl(): Element | null {
  try {
    const fnc: any = (window as any).FocusNavController;
    // Desktop shell (the @decky/* shim): there is no Steam FocusNavController —
    // gamepad focus is plain DOM focus in this SAME document. Report the active
    // element so callers that ask "where is focus / did the user move it" work
    // off real focus. Without this they always saw null and, e.g., the detail
    // page's tab-switch focus ladder could never tell the user had moved and kept
    // yanking focus back to the subtab's first element.
    if (!fnc) {
      const ae = document.activeElement as Element | null;
      return ae && ae !== document.body ? ae : null;
    }
    // m_ActiveContext is undefined while the context is deactivated (the very
    // state the post-session restore runs in) — fall back to the last one.
    const ctx = fnc?.m_ActiveContext ?? fnc?.m_LastActiveContext ?? fnc?.m_rgAllContexts?.[0];
    return ctx?.m_rootWindow?.document?.querySelector?.('.gpfocus') ?? null;
  } catch { return null; }
}

// The most recently readied auto-focus target (the active panel's first item);
// the post-emulator-session focus restore aims here so the first game/group is
// highlighted, matching what a normal tab switch lands on.
let _autoFocusFirstRef: React.MutableRefObject<any> | null = null;
function useAutoFocus(ready: boolean, dep?: any) {
  const ref = useRef<any>(null);
  useEffect(() => {
    if (!ready) return;
    _autoFocusFirstRef = ref;
    // _forceGamepadFocus, not plain focus(): gamescope leaves the window
    // OS-unfocused after an emulator session, so element.focus() fires no DOM
    // focus event and Steam never converts it into gamepad focus — the panel
    // would come up with nothing selected and the next press gets spent
    // re-acquiring focus. In the healthy state it degrades to the same focus().
    const timers = [0, 60, 160, 320].map((d) =>
      setTimeout(() => { try { if (ref.current) _forceGamepadFocus(ref.current); } catch { } }, d));
    return () => timers.forEach(clearTimeout);
  }, [ready, dep]);
  return ref;
}

// memo: a focus move updates the parent page's background-art state, which
// would otherwise re-render every tile in the grid on each dpad press (felt
// like the whole grid remounting). With stable props (game ref, useCallback'd
// onOpen, useState setter onActiveCover) only the newly focused/blurred tile
// re-renders for its own scale animation.
const GameTile = memo(function GameTile({ game, onOpen, onActiveCover, focusRef, index, onFocusIdx, focusable }:
  { game: LibGame; onOpen: (g: LibGame) => void; onActiveCover: (uri: string | null) => void; focusRef?: React.Ref<any>; index?: number; onFocusIdx?: (i: number) => void; focusable?: boolean }) {
  const wide = !!game.screenshot;
  // Wide cards adopt the screenshot's NATURAL aspect ratio (RomM derives the
  // card width from the cover's true shape at a fixed height); 16:9 until loaded.
  const [shotRatio, setShotRatio] = useState(16 / 9);
  const uriRef = useRef<string | null>(null);
  const [focused, setFocused] = useState(false);
  const [iconDark, setIconDark] = useState(false);
  const [dl, setDl] = useState(!!game.is_downloaded);
  const [busy, setBusy] = useState<null | 'download' | 'delete' | 'launch'>(null);
  const [activeDlRomId, setActiveDlRomId] = useState<number>(game.rom_id);
  const dlProgress = useDownloadProgress(activeDlRomId, busy === 'download');
  const dlPct = dlProgress?.percent ?? null;
  const extracting = dlProgress?.state === 'extracting';
  const globalDownloading = useIsDownloading(activeDlRomId);
  const downloading = busy === 'download' || globalDownloading;
  const ringColor = V2.brand;
  // A batch/global download for this tile finished successfully → light the dot
  // now instead of waiting for the next list refetch.
  const wasGlobalDl = useRef(false);
  useEffect(() => {
    if (wasGlobalDl.current && !globalDownloading && _dlSucceeded.has(game.rom_id)) setDl(true);
    wasGlobalDl.current = globalDownloading;
  }, [globalDownloading, game.rom_id]);
  // Track the list prop both ways: light when it turns downloaded, and CLEAR
  // when it turns not-downloaded (bulk "Remove downloaded" flips the prop with
  // no tile handler involved — the dot used to stay lit until re-entry). The
  // guards keep a transient refetch from undoing an in-flight or just-finished
  // download (_dlSucceeded is dropped again on delete by libCacheSetDownloaded).
  useEffect(() => {
    if (game.is_downloaded) setDl(true);
    else if (!downloading && !_dlSucceeded.has(game.rom_id)) setDl(false);
  }, [game.is_downloaded, downloading, game.rom_id]);
  // Offline: downloaded games still launch, but a fetch from the server can't
  // succeed — so block + visually dim download on not-yet-downloaded tiles
  // rather than letting the user trigger a guaranteed failure.
  const offline = useOffline();
  const downloadBlocked = offline && !dl;
  const [confirmDelete, setConfirmDelete] = useState(false);
  const confirmTimer = useRef<any>(null);
  const activate = () => { onActiveCover(uriRef.current); };

  // Multi-disc support on the cover: fetch the on-disk disc list when the tile
  // is first focused (for the disc-picker menu). The badge visibility is driven
  // by the backend is_multi_disc flag so it appears immediately.
  const [discs, setDiscs] = useState<LocalDisc[]>([]);
  const [discLast, setDiscLast] = useState<string>('');
  const discsTried = useRef(false);
  const pickableDiscs = discs.filter((d) => !d.is_m3u);
  const isMultiDisc = !!game.is_multi_disc && dl;
  // A downloaded multi-FILE ROM whose members are regional variants (no disc
  // playlist). Detected once the on-disk entries are fetched (on focus).
  const discsAreRegion = discs.length > 0 && discs.every((d) => d.is_region);
  const isMultiRegion = !!game.region_count && game.region_count > 1;
  const [activeRegionId, setActiveRegionId] = useState<number>(game.rom_id);
  const [downloadedRegionIds, setDownloadedRegionIds] = useState<Set<number>>(new Set());
  const siblingFetchTried = useRef(false);
  const ensureDiscs = async (force?: boolean) => {
    if ((discsTried.current && !force) || !dl) return;
    discsTried.current = true;
    try {
      const r = await getLocalDiscs(game.rom_id);
      setDiscs(r?.success ? (r.discs || []) : []);
      setDiscLast(r?.last || '');
    } catch { /* leave empty */ }
  };
  const ensureSiblings = async (force?: boolean) => {
    if ((siblingFetchTried.current && !force) || !isMultiRegion) return;
    siblingFetchTried.current = true;
    try {
      const r = await getLocalSiblings(game.rom_id);
      if (r?.success) setDownloadedRegionIds(new Set(r.downloaded_ids || []));
    } catch { /* leave empty */ }
  };
  // Hold A to open the disc/region picker; a quick press launches. The OK
  // button's onActivate fires on the PRESS edge on Steam Deck, so we can't let
  // it launch (it would fire before a hold is recognised). Instead, for multi
  // games launch is driven entirely from the release handler: arm a timer on
  // A-down that opens the picker at 500ms; on release, if the timer hasn't fired
  // yet it was a short press → launch. onActivate is suppressed for multi games.
  const isMulti = isMultiRegion || isMultiDisc;
  const longFired = useRef(false);
  const pressTimer = useRef<any>(null);
  // Set when a press starts on an overlay sub-button (Details / Delete). The
  // multi-game OK handlers below run on the PARENT and aren't stopped by the
  // child's stopPropagation, so without this a tap on Details would also launch.
  const subPress = useRef(false);
  const onBtnDown = (e: any) => {
    if (subPress.current) return;
    if (e?.detail?.button === GamepadButton.OK && isMulti) {
      longFired.current = false;
      if (pressTimer.current) clearTimeout(pressTimer.current);
      pressTimer.current = setTimeout(() => {
        longFired.current = true;
        pressTimer.current = null;
        if (isMultiRegion) {
          const allSiblings = game.sibling_roms || [];
          openRegionPicker(game.rom_id, game.name, allSiblings, downloadedRegionIds,
            activeRegionId, handleRegionSelected);
        } else {
          openDiscPicker(game.rom_id, game.name, discs, discLast, setBusy,
            () => ensureDiscs(true));
        }
      }, 500);
    }
  };
  const onBtnUp = (e: any) => {
    if (subPress.current) {
      subPress.current = false;
      if (pressTimer.current) { clearTimeout(pressTimer.current); pressTimer.current = null; }
      return;
    }
    if (e?.detail?.button === GamepadButton.OK && isMulti) {
      // Short press (timer still pending) → launch the default; long press
      // already opened the picker, so do nothing.
      if (pressTimer.current) {
        clearTimeout(pressTimer.current); pressTimer.current = null;
        if (!longFired.current) primary();
      }
    }
  };

  // Button scheme (RomM GameActions): A = download (if absent) / launch (if
  // present); X = details; Y = delete. Mouse: overlay buttons mirror these.
  const doDownload = async () => {
    if (busy) return;
    if (downloadBlocked) {
      toaster.toast({ title: 'Offline', body: 'Connect to RomM to download this game.' });
      return;
    }
    setBusy('download');
    setActiveDlRomId(game.rom_id);
    _setDlActive(game.rom_id, true, game.name);
    try {
      const start = await downloadGame(game.rom_id);
      if (!start?.success) { toaster.toast({ title: 'Download failed', body: start?.message || 'Error' }); return; }
      const res = await awaitDownload(game.rom_id);
      if (res.ok) {
        setDl(true); libCacheSetDownloaded(game.rom_id, true);
        toaster.toast({
          title: 'Downloaded', body: game.name,
          logo: <ToastCover romId={game.rom_id} hasCover={game.has_cover} />,
          // Clicking the toast opens the game it names. Origin is the library
          // root because the toast can outlive whatever page started the
          // download — backing out to a page that's no longer there would strand
          // the user.
          onClick: () => openGameById(game.rom_id, game.name, "/romm-sync-library"),
        });
      }
      else toaster.toast({ title: 'Download failed', body: res.message || 'Error' });
    } catch (e) { toaster.toast({ title: 'Download failed', body: String(e) }); }
    finally { _setDlActive(game.rom_id, false); setBusy(null); }
  };
  const doLaunch = async () => {
    if (busy) return;
    // A on a tile has no dimmed state to read, so say it out loud instead.
    if (_emuStatus && !_emuStatus.installed) {
      toaster.toast({ title: 'No emulator', body: 'Install RetroArch from Home to play this.' });
      return;
    }
    setBusy('launch');
    try {
      const r = await launchGameSmart(game.rom_id);
      // No success toast — the screen transitions to the launch immediately, so
      // the toast just races the thing it announces. Surface failures only.
      if (!r?.success && !offerCoreInstall(r, () => void doLaunch())) {
        toaster.toast({ title: 'Launch failed', body: r?.message || 'Error' });
      }
    } catch (e) { toaster.toast({ title: 'Launch failed', body: String(e) }); }
    finally { setBusy(null); }
  };
  const handleRegionSelected = async (selectedRomId: number) => {
    setActiveRegionId(selectedRomId);
    const isMainRom = selectedRomId === game.rom_id;
    const isAlreadyDownloaded = isMainRom ? dl : downloadedRegionIds.has(selectedRomId);
    if (!isAlreadyDownloaded) {
      if (busy) { toaster.toast({ title: 'Busy', body: 'Please wait for the current operation' }); return; }
      if (offline) {
        toaster.toast({ title: 'Offline', body: 'Connect to RomM to download this version.' });
        return;
      }
      setBusy('download');
      setActiveDlRomId(selectedRomId);
      _setDlActive(selectedRomId, true, game.name);
      try {
        const start = await downloadGame(selectedRomId);
        if (!start?.success) { toaster.toast({ title: 'Download failed', body: start?.message || 'Error' }); return; }
        const res = await awaitDownload(selectedRomId);
        if (res.ok) {
          setDownloadedRegionIds(prev => new Set([...prev, selectedRomId]));
          if (isMainRom) { setDl(true); libCacheSetDownloaded(game.rom_id, true); }
          // The main rom's art even when a regional sibling was the download —
          // it's the same game, and only `game` carries a known has_cover.
          toaster.toast({
            title: 'Downloaded', body: game.name,
            logo: <ToastCover romId={game.rom_id} hasCover={game.has_cover} />,
            // The main rom again, not selectedRomId: the detail page is the
            // game's, and regional siblings don't have one of their own.
            onClick: () => openGameById(game.rom_id, game.name, "/romm-sync-library"),
          });
        } else {
          toaster.toast({ title: 'Download failed', body: res.message || 'Error' });
          return;
        }
      } catch (e) { toaster.toast({ title: 'Download failed', body: String(e) }); return; }
      finally { _setDlActive(selectedRomId, false); setBusy(null); }
    }
    // After download (or if already downloaded): check if this region is multi-disc
    try {
      const localDiscs = await getLocalDiscs(selectedRomId);
      const discList: LocalDisc[] = localDiscs?.success ? (localDiscs.discs || []) : [];
      const pickable = discList.filter((d: LocalDisc) => !d.is_m3u);
      if (discList.length > 1 || pickable.length > 1) {
        openDiscPicker(selectedRomId, game.name, discList, localDiscs?.last || '', setBusy);
      } else {
        await runLaunch(selectedRomId, game.name, null, game.name, setBusy);
      }
    } catch {
      await runLaunch(selectedRomId, game.name, null, game.name, setBusy);
    }
  };
  const doDelete = async () => {
    if (busy) return;
    setBusy('delete');
    try {
      const r = await deleteGame(game.rom_id);
      if (r?.success) { setDl(false); libCacheSetDownloaded(game.rom_id, false); }
      else toaster.toast({ title: 'Delete failed', body: r?.message || 'Error' });
    } catch (e) { toaster.toast({ title: 'Delete failed', body: String(e) }); }
    finally { setConfirmDelete(false); setBusy(null); }
  };
  // Two-step confirm on the cover (matching the details page): the first delete
  // press arms it (button turns into a check), the second within 3s commits.
  const requestDelete = () => {
    if (busy) return;
    if (confirmDelete) { doDelete(); return; }
    setConfirmDelete(true);
    if (confirmTimer.current) clearTimeout(confirmTimer.current);
    confirmTimer.current = setTimeout(() => setConfirmDelete(false), 3000);
  };
  const primary = () => {
    if (dl) doLaunch();
    else doDownload();
  };

  // Keep our own handle on the DOM node (for the focus reveal/glimpse) while
  // still honoring the parent's object-or-callback focusRef.
  const selfRef = useRef<any>(null);
  const setRefs = (el: any) => {
    selfRef.current = el;
    if (typeof focusRef === 'function') focusRef(el);
    else if (focusRef) (focusRef as any).current = el;
  };
  // `focusable: false` while the containing panel is hidden — display:none does
  // NOT drop a Focusable from Steam's nav tree (verified on-device: hidden
  // tiles sit at rect 0×0 and spatial nav happily jumps to them — "phantom"
  // focus with a live footer legend but no visible selection).
  return (
    <Focusable noFocusRing className="romm-gt-wrap"
      {...({ focusable: focusable !== false } as any)}
      ref={setRefs}
      onActivate={() => {
        // A press that started on an overlay sub-button (Details / Delete) must
        // not also activate the cover — Steam routes the tap to this parent
        // Focusable since the sub-buttons are plain divs.
        if (subPress.current) { subPress.current = false; return; }
        // Multi games drive launch from the release handler (onBtnUp) so a hold
        // can open the picker without the press-edge activation launching first.
        if (isMulti) { longFired.current = false; return; }
        primary();
      }}
      onClick={primary}
      onButtonDown={onBtnDown}
      onButtonUp={onBtnUp}
      onSecondaryButton={() => onOpen(game)}
      onSecondaryActionDescription="Details"
      onOptionsButton={() => { if (dl) requestDelete(); }}
      onOptionsActionDescription={dl ? (confirmDelete ? 'Confirm delete' : 'Delete') : undefined}
      onOKActionDescription={dl ? (isMultiRegion ? 'Launch (hold: regions)' : isMultiDisc ? (discsAreRegion ? 'Launch (hold: regions)' : 'Launch (hold: discs)') : 'Launch') : 'Download'}
      onFocus={() => { setFocused(true); activate(); ensureDiscs(); ensureSiblings(); if (index !== undefined) onFocusIdx?.(index); _tileFocusScrub(selfRef.current, game.name); }}
      onBlur={() => setFocused(false)}
      onMouseEnter={() => { setFocused(true); activate(); ensureDiscs(); ensureSiblings(); }}
      onMouseLeave={() => setFocused(false)}
      style={{ cursor: 'pointer', display: 'flex', flexDirection: 'column', gap: '7px' }}
    >
      <div className="romm-gt-cover" style={{
        position: 'relative', overflow: 'hidden',
        // Wide (continue-playing) cards are a fixed-height 16:9 screenshot with
        // natural width; portrait cards keep the cover's 3:4 footprint.
        ...(wide ? { height: '176px', aspectRatio: String(shotRatio) } : {}),
        transform: 'scale(1)',
        transition: 'transform 0.18s ease, box-shadow 0.18s ease',
        borderRadius: V2.radiusArt,
        ...V2Focus.tile(focused),
      }}>
        {wide ? (
          <>
            <ScreenshotArt path={game.screenshot!} onLoaded={(u) => { uriRef.current = u; }} onRatio={setShotRatio} />
            <CoverPip romId={game.rom_id} hasCover={game.has_cover} hidden={focused} />
          </>
        ) : (
          <GameCover romId={game.rom_id} hasCover={game.has_cover}
            onLoaded={(u) => { uriRef.current = u; }} />
        )}
        {/* Platform icon badge — top-right circular scrim with the real RomM
            platform icon (RomM GameCard .r-gc__platform-icon: 7px inset, 3px
            pad, 78% black scrim, 12%-white border, always visible). */}
        {game.platform_slug && (
          <div style={{
            position: 'absolute', top: '7px', right: '7px', zIndex: 2,
            padding: '3px', borderRadius: '50%',
            background: iconDark ? 'rgba(255,255,255,0.82)' : 'rgba(0,0,0,0.78)',
            border: iconDark ? '1px solid rgba(0,0,0,0.18)' : '1px solid rgba(255,255,255,0.12)',
            lineHeight: 0, transition: 'background 0.2s ease, border-color 0.2s ease',
          }}>
            <div style={{
              width: '22px', height: '22px', display: 'flex',
              alignItems: 'center', justifyContent: 'center', color: V2.fg,
            }}>
              <PlatformIcon slug={game.platform_slug} size={22} onTone={setIconDark} />
            </div>
          </div>
        )}
        {/* Downloaded status dot — top-left corner, opposite the platform
            icon so the two affordances don't collide. Hidden for multi-region
            games (the region badge replaces it). */}
        {dl && !isMultiRegion && (
          <div style={{
            position: 'absolute', top: '7px', left: '7px', zIndex: 2,
            width: '10px', height: '10px', borderRadius: '50%',
            background: V2.success, boxShadow: '0 0 0 2px rgba(0,0,0,0.45)',
          }} />
        )}

        {/* Region badge — globe icon + region count, top-left corner. Shown for
            multi-region games so the region picker is discoverable. */}
        {isMultiRegion && (
          <div style={{
            position: 'absolute', left: '7px', top: '7px', zIndex: 2,
            display: 'inline-flex', alignItems: 'center', gap: '4px',
            padding: '2px 6px', borderRadius: V2.radiusPill, fontSize: '10px', fontWeight: 600,
            background: 'rgba(0,0,0,0.78)', border: '1px solid rgba(255,255,255,0.12)', color: V2.fg,
            opacity: focused ? 0 : 1, transition: 'opacity 0.18s ease',
          }}>
            <FaGlobe size={9} />{game.region_count}
          </div>
        )}

        {/* Multi-disc badge — a small disc-count pill (RomM-style scrim chip)
            shown for downloaded multi-disc games so the hold-A picker is
            discoverable. Shows the actual count once fetched, otherwise a
            generic disc icon. */}
        {dl && isMultiDisc && (
          <div style={{
            position: 'absolute', left: '7px', bottom: '7px', zIndex: 2,
            display: 'inline-flex', alignItems: 'center', gap: '4px',
            padding: '2px 6px', borderRadius: V2.radiusPill, fontSize: '10px', fontWeight: 600,
            background: 'rgba(0,0,0,0.78)', border: '1px solid rgba(255,255,255,0.12)', color: V2.fg,
            opacity: focused ? 0 : 1, transition: 'opacity 0.18s ease',
          }}>
            {discsAreRegion
              ? <><FaGlobe size={9} />{discs.length || game.disc_count || ''}</>
              : <><FaClone size={9} />{game.disc_count || pickableDiscs.length || ''}</>}
          </div>
        )}

        {/* GameActions overlay — gradient scrim, center primary (download/play),
            bottom Details + Delete; revealed on hover/focus. The reveal is
            ALSO driven by CSS :hover (.romm-gt-actions/.romm-gt-primary/
            .romm-gt-scrim) so the mouse can reach the buttons even when no
            React onMouseEnter fires — on desktop the pointer often ends up
            inside a cover without crossing its boundary (gamepad mode toggles
            body pointer-events), which left the buttons unclickable. */}
        <div className="romm-gt-scrim" style={{
          position: 'absolute', inset: 0, borderRadius: V2.radiusArt, pointerEvents: 'none',
          background: 'linear-gradient(to top, rgba(0,0,0,0.78) 0%, rgba(0,0,0,0) 55%)',
          opacity: focused ? 1 : 0, transition: 'opacity 0.18s ease',
        }} />
        {/* Outer-only download glow — a blurred copy of the arc painted BEHIND
            the opaque white button, so the button masks the inner half and only
            the outward halo escapes. */}
        {downloading && (
          <div style={{
            position: 'absolute', top: '50%', left: '50%',
            transform: 'translate(-50%,-50%)', pointerEvents: 'none',
          }}>
            <ProgressRing pct={dlPct} size={48} stroke={4} glow color={ringColor} />
          </div>
        )}
        {/* Center primary (A) — emphasized white round button (RomM Play). */}
        <div
          className="romm-gt-primary"
          onClick={(e: any) => { e.stopPropagation(); primary(); }}
          style={{
            position: 'absolute', top: '50%', left: '50%', transform: 'translate(-50%,-50%)',
            ...roundBtn(44, 'emphasized'), boxShadow: '0 2px 10px rgba(0,0,0,0.55)',
            // Stay visible while downloading so the fill ring is always shown,
            // even if focus moves away mid-download.
            opacity: (focused || downloading) ? (downloadBlocked ? 0.4 : 1) : 0,
            filter: downloadBlocked ? 'grayscale(1)' : 'none',
            transition: 'opacity 0.18s ease',
          }}>
          {/* While downloading, the progress ring rides ON the button's border:
              the 44px button has radius 22, so a 48px ring with a 4px stroke has
              its circle radius at exactly (48-4)/2 = 22, centered on the rim. */}
          {downloading && (
            <div style={{
              position: 'absolute', top: '50%', left: '50%',
              transform: 'translate(-50%,-50%)', pointerEvents: 'none',
            }}>
              <ProgressRing pct={dlPct} size={48} stroke={4} color={ringColor} />
            </div>
          )}
          {downloading
            ? (extracting ? <FaBoxOpen size={15} /> : <FaDownload size={15} />)
            : busy === 'launch'
              ? <FaSync size={16} style={{ animation: 'spin 1s linear infinite' }} />
              : dl ? <FaPlay size={15} style={{ marginLeft: '2px' }} /> : <FaDownload size={15} />}
        </div>
        {/* Bottom row: Details (X) + Delete (Y, when downloaded) — glass buttons. */}
        <div className="romm-gt-actions" style={{
          position: 'absolute', left: '8px', right: '8px', bottom: '8px',
          display: 'flex', justifyContent: 'space-between', alignItems: 'center',
          opacity: focused ? 1 : 0, transform: focused ? 'translateY(0)' : 'translateY(6px)',
          transition: 'opacity 0.18s ease, transform 0.18s ease',
        }}>
          <div onPointerDown={() => { subPress.current = true; }}
            onClick={(e: any) => { e.stopPropagation(); subPress.current = false; onOpen(game); }} style={roundBtn(30, 'glass')}>
            <FaInfoCircle size={13} />
          </div>
          {dl && (
            <div onPointerDown={() => { subPress.current = true; }}
              onClick={(e: any) => { e.stopPropagation(); subPress.current = false; requestDelete(); }}
              style={{
                ...roundBtn(30, 'danger'),
                // Armed state: solid red fill + check glyph, so it's clear the
                // next press commits the delete.
                ...(confirmDelete ? { background: V2.danger, borderColor: V2.danger, color: '#fff' } : {})
              }}>
              {busy === 'delete'
                ? <FaSync size={12} style={{ animation: 'spin 1s linear infinite' }} />
                : confirmDelete ? <FaCheck size={12} /> : <FaTrash size={12} />}
            </div>
          )}
        </div>
      </div>
      <div style={{
        fontSize: '11.5px', color: focused ? V2.fg : V2.fg2, textAlign: 'center',
        whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
        transition: 'color 0.18s', padding: '0 1px',
        // Wide cards have no fixed-width parent — pin the label to the art's
        // width so a long name ellipsises instead of widening the card.
        ...(wide ? { width: 0, minWidth: '100%', maxWidth: '100%' } : {}),
      }}>
        {game.name}
      </div>
    </Focusable>
  );
});

// One image fetched by RomM resource path (collection mosaic cells), base64
// via the backend, cached. Renders nothing visible until loaded.
function PathImage({ path }: { path: string }) {
  const ik = `img:${path}`;
  const [uri, setUri] = useState<string | null>(peekCover(ik) ?? null);
  // Not viewport-gated: IO doesn't fire on gamepad focus-scroll under gamescope.
  useEffect(() => {
    let alive = true;
    const p = peekCover(ik);
    if (p !== undefined) { setUri(p); return; }
    (async () => {
      try { const u = await awaitCover(ik, () => qGetImage(path)); if (alive) setUri(u); }
      catch { /* ignore */ }
    })();
    return () => { alive = false; };
  }, [path]);
  return (
    <div style={{ width: '100%', height: '100%', background: V2.coverPlaceholder, overflow: 'hidden' }}>
      {uri && <img src={uri} style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />}
    </div>
  );
}

// Collection cover mosaic — 1 cover fills the box, 2+ paint a 2×2 grid
// (RomM CollectionMosaic). Portrait 3:4 to match the game cards.
function CollectionMosaic({ covers }: { covers: string[] }) {
  const cs = (covers || []).slice(0, 4);
  return (
    <div style={{
      position: 'relative', width: '100%', aspectRatio: '3 / 4',
      borderRadius: V2.radiusLg, overflow: 'hidden', background: V2.coverPlaceholder,
      display: 'grid',
      gridTemplateColumns: cs.length <= 1 ? '1fr' : '1fr 1fr',
      gridTemplateRows: cs.length <= 1 ? '1fr' : '1fr 1fr',
    }}>
      {cs.length === 0 ? (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', color: V2.fgMuted }}>
          <FaBookmark size={20} />
        </div>
      ) : cs.map((p, i) => <PathImage key={i} path={p} />)}
    </div>
  );
}

// Shared per-collection sync state, polled ONCE for the whole grid (not one poll
// per tile) from get_service_status, broadcast to every CollectionTile. Lets the
// tiles show the same download ring as game covers while a collection syncs.
interface ColSyncState { state: string; pct: number | null; downloaded?: number; total?: number; }
const _colSync = new Map<string, ColSyncState>();
const _colSyncListeners = new Set<() => void>();
let _colSyncTimer: any = null;
let _colSyncRefs = 0;
// Latest connection state from the shared poll ('online'|'offline_cached'|
// 'disconnected'|'connecting'), so tiles can disable server-only actions (e.g.
// download) without each one polling get_service_status independently.
let _connState: string | null = null;
// Last full status object from the shared poll, so components can read
// connection/snapshot_fetched_at/pending_saves without their own poller.
let _lastStatus: any = null;
async function _colSyncTick() {
  try {
    const st = await getServiceStatus();
    _lastStatus = st ?? null;
    _connState = st?.connection ?? null;
    _colSync.clear();
    for (const c of (st?.collections || [])) {
      _colSync.set(c.name, {
        state: c.sync_state,
        pct: typeof c.downloaded_pct === 'number' ? c.downloaded_pct : null,
        downloaded: c.downloaded, total: c.total,
      });
    }
    _colSyncListeners.forEach((l) => { try { l(); } catch { } });
  } catch { /* transient */ }
}
// Subscribe a component to the shared status poll, starting/stopping the timer
// via the shared ref count. Returns the unsubscribe cleanup.
function _subscribeStatus(listener: () => void): () => void {
  _colSyncListeners.add(listener);
  _colSyncRefs++;
  if (!_colSyncTimer) { _colSyncTick(); _colSyncTimer = setInterval(_colSyncTick, 1500); }
  return () => {
    _colSyncListeners.delete(listener);
    _colSyncRefs--;
    if (_colSyncRefs <= 0 && _colSyncTimer) { clearInterval(_colSyncTimer); _colSyncTimer = null; }
  };
}
// Force an immediate poll outside the 1.5s cadence — used when the device's
// network state flips so the UI reflects it without waiting for the next tick.
function refreshStatusNow() { _colSyncTick(); }
function useCollectionSync(name: string): ColSyncState | undefined {
  const [, force] = useState(0);
  useEffect(() => _subscribeStatus(() => force((n) => n + 1)), []);
  return _colSync.get(name);
}
// True when the server isn't reachable (cached-offline or disconnected) — used
// by tiles to dim/disable download actions that would just fail offline.
function useOffline(): boolean {
  const [, force] = useState(0);
  useEffect(() => _subscribeStatus(() => force((n) => n + 1)), []);
  return _connState === 'offline_cached' || _connState === 'disconnected';
}
// Full service status from the shared poll (one poller for the whole UI).
function useServiceStatus(): any {
  const [, force] = useState(0);
  useEffect(() => _subscribeStatus(() => force((n) => n + 1)), []);
  return _lastStatus;
}

// ── Emulator status ─────────────────────────────────────────────────────────
// Whether RetroArch/RetroDECK is actually installed, and whether any saved
// folder still points into an emulator that was uninstalled. One fetch serves
// the whole UI (Home banner, Play button, Emulator page). The backend re-detects
// on every plugin start, so this cache only needs invalidating when WE change
// something — a path repair or an install — which is what refresh does.
type EmuStalePath = {
  section: string; key: string; label: string; kind: string;
  value: string; reason: string; suggested: string;
};
type EmuStatus = {
  installed: boolean;
  kind: 'retrodeck' | 'flatpak' | 'snap' | 'native' | 'none';
  executable: string | null;
  cores_dir: string | null;
  core_count: number;
  stale_paths: EmuStalePath[];
  save_dirs: Record<string, string>;
  bios_dir: string;
  // Raw configured values by kind — '' means "not set, we detect it".
  configured_paths: Record<string, string>;
  // What each folder would be with nothing chosen, so a row can offer to go
  // back to it. '' means "clear it and let detection answer".
  default_paths: Record<string, string>;
  // Where the detected emulator keeps things, existing yet or not — what a row
  // shows when nothing is configured and nothing is on disk to detect.
  expected_paths: Record<string, string>;
  // Whether Ludo can install an emulator itself. False on Windows, without
  // flatpak, or as root — the reason is what we show instead of the button.
  install: { available: boolean; reason: string };
};
let _emuStatus: EmuStatus | null = null;
let _emuInflight: Promise<EmuStatus | null> | null = null;
const _emuSubs = new Set<() => void>();

function publishEmulatorStatus(s: EmuStatus | null) {
  _emuStatus = s;
  [..._emuSubs].forEach((f) => f());
}

async function loadEmulatorStatus(refresh = false): Promise<EmuStatus | null> {
  // Coalesce: several components mount at once on a cold start and would
  // otherwise each pay for the (filesystem-probing) detection.
  if (!refresh && _emuInflight) return _emuInflight;
  const run = (async () => {
    try {
      const r = await getEmulatorStatus(refresh);
      if (r?.success) {
        publishEmulatorStatus({
          installed: !!r.installed,
          kind: r.kind || 'none',
          executable: r.executable || null,
          cores_dir: r.cores_dir || null,
          core_count: r.core_count || 0,
          stale_paths: r.stale_paths || [],
          save_dirs: r.save_dirs || {},
          bios_dir: r.bios_dir || '',
          configured_paths: r.configured_paths || {},
          default_paths: r.default_paths || {},
          expected_paths: r.expected_paths || {},
          install: r.emulator_install || { available: false, reason: '' },
        });
      }
    } catch { /* leave the last known answer in place */ }
    finally { _emuInflight = null; }
    return _emuStatus;
  })();
  _emuInflight = run;
  return run;
}

function useEmulatorStatus(): EmuStatus | null {
  const [, force] = useState(0);
  useEffect(() => {
    const f = () => force((n) => n + 1);
    _emuSubs.add(f);
    if (!_emuStatus) loadEmulatorStatus();
    return () => { _emuSubs.delete(f); };
  }, []);
  return _emuStatus;
}

// Every stale path now earns a Home banner. That was once saves-only, on the
// grounds that only saves fail silently — but staleness itself was then loose
// enough to flag a ROM folder that worked fine, and interrupting for a
// non-problem is what the restraint was really guarding against. With that false
// positive gone (see stale_emulator_paths), the survivors all genuinely break
// the app: saves lose progress, BIOS blocks the games that need it, and a dead
// executable override stops launching altogether.
// Headline and detail per kind, worst first. Saves lead when several are broken:
// it's the only one that loses data you can't recreate.
const _STALE_RANK: Record<string, number> = { saves: 0, exe: 1, bios: 2, roms: 3 };

function staleCopy(stale: EmuStalePath[]): { title: string; body: string } {
  const worst = [...stale].sort(
    (a, b) => (_STALE_RANK[a.kind] ?? 9) - (_STALE_RANK[b.kind] ?? 9))[0];
  const rest = stale.length < 2 ? ''
    : stale.length === 2 ? ' One other folder needs the same fix.'
      : ` ${stale.length - 1} other folders need the same fix.`;
  switch (worst?.kind) {
    case 'saves':
      return { title: 'Saves are going to the wrong place',
        body: 'Your save folder still points into an emulator that was removed. '
          + 'Saves are being written where nothing will read them.' + rest };
    case 'bios':
      return { title: 'BIOS files are going to the wrong place',
        body: 'Your BIOS folder still points into an emulator that was removed, so '
          + 'games that need a BIOS will not start.' + rest };
    case 'exe':
      return { title: 'Your emulator path is broken',
        body: 'Ludo is set to launch an emulator that is no longer there, so nothing '
          + 'will start until this is cleared.' + rest };
    default:
      return { title: 'A folder points at a removed emulator',
        body: 'One of your folders belongs to an emulator that is gone.' + rest };
  }
}

// ── RetroArch install ───────────────────────────────────────────────────────
// The install runs in a backend thread (a few hundred MB of flatpak, plus the
// KDE runtime if it isn't already there); the UI polls its
// progress. Module-level so the Home banner and the Emulator page show the same
// run, and so navigating away mid-install doesn't orphan it.
type EmuInstall = {
  active: boolean; phase: string; pct: number | null; detail: string; error: string | null;
  // Real byte counts from flatpak's own ref table, or null when it couldn't be
  // read — the size varies hugely with whether the KDE runtime tags along, so
  // there is no sane fallback number to invent.
  bytesDone: number | null; bytesTotal: number | null;
};
let _emuInstall: EmuInstall = { active: false, phase: '', pct: null, detail: '', error: null,
                                bytesDone: null, bytesTotal: null };
const _emuInstallSubs = new Set<() => void>();
let _emuInstallPoll: any = null;
// True while the setup wizard is on screen. Its Emulator step reports the
// install's every state inline — progress, failure, and a "Emulator ready"
// panel — so the module-level toasts would just repeat it back over a screen
// that already says so.
let _wizardOpen = false;

function _publishInstall(next: EmuInstall) {
  _emuInstall = next;
  [..._emuInstallSubs].forEach((f) => f());
}

function _pollInstall() {
  if (_emuInstallPoll) return;
  _emuInstallPoll = setInterval(async () => {
    try {
      const r = await emulatorInstallState();
      _publishInstall({
        active: !!r?.active, phase: r?.phase || '',
        pct: r?.pct ?? null, detail: r?.detail || '', error: r?.error || null,
        bytesDone: r?.bytes_done ?? null, bytesTotal: r?.bytes_total ?? null,
      });
      if (!r?.active) {
        clearInterval(_emuInstallPoll); _emuInstallPoll = null;
        // The emulator either exists now or the attempt failed — either way the
        // cached status is stale, and a fresh install ships zero cores, so the
        // Cores page needs to re-read too.
        await loadEmulatorStatus(true);
        if (_wizardOpen) return;
        if (r?.error) toaster.toast({ title: 'RetroArch', body: r.error });
        else if (r?.installed) {
          // Folders the install moved off the emulator that was removed. Worth
          // saying: it changes where saves and BIOS files land from now on.
          const fixed: string[] = r?.repaired || [];
          toaster.toast({
            title: 'RetroArch',
            body: fixed.length
              ? `Installed, and pointed ${fixed.join(' and ').toLowerCase()} at it.`
              : 'Installed',
          });
        }
      }
    } catch { /* keep polling; a dropped IPC frame isn't a failure */ }
  }, 1000);
}

async function startEmulatorInstall() {
  _publishInstall({ active: true, phase: 'Starting…', pct: null, detail: '', error: null, bytesDone: null, bytesTotal: null });
  try {
    const r = await installEmulator();
    if (!r?.success) {
      _publishInstall({ active: false, phase: '', pct: null, detail: '', error: r?.message || 'Could not start the install', bytesDone: null, bytesTotal: null });
      // The wizard's Emulator step renders install.error itself.
      if (!_wizardOpen) toaster.toast({ title: 'RetroArch', body: r?.message || 'Could not start the install' });
      return;
    }
    _pollInstall();
  } catch (e) {
    _publishInstall({ active: false, phase: '', pct: null, detail: '', error: String(e), bytesDone: null, bytesTotal: null });
  }
}

// "142 MB of 409 MB" while the sizes are known, '' when flatpak's ref table
// couldn't be read — better to say nothing than to quote a made-up total.
// flatpak reports SI sizes, so divide by 1000, not 1024, to match what it and
// Flathub show for the same app.
function installSize(s: EmuInstall): string {
  if (!s.bytesTotal) return '';
  const mb = (n: number) => `${Math.round(n / 1e6)} MB`;
  return s.bytesDone == null ? mb(s.bytesTotal)
    : `${mb(s.bytesDone)} of ${mb(s.bytesTotal)}`;
}

function useEmulatorInstall(): EmuInstall {
  const [, force] = useState(0);
  useEffect(() => {
    const f = () => force((n) => n + 1);
    _emuInstallSubs.add(f);
    return () => { _emuInstallSubs.delete(f); };
  }, []);
  return _emuInstall;
}

// Collection tile — mosaic cover + kind badge + name/count below, with the
// focus scale + brand glow (RomM CollectionTile).
function CollectionTile({ group, onOpen, focusRef, focusable }: { group: LibGroup; onOpen: (g: LibGroup) => void; focusRef?: React.Ref<any>; focusable?: boolean }) {
  const [focused, setFocused] = useState(false);
  // Virtual (autogenerated) collections are browse/download only: no persistent
  // auto-sync, no local-delete (they aren't tracked by CollectionSyncManager).
  const isVirtual = !!group.virtual;
  // Per-tile auto-sync state (optimistic), so Y toggles sync straight from the
  // collections grid/rail and the green dot reflects it instantly.
  const [synced, setSynced] = useState(!!group.synced);
  // Live sync state from the shared poll — drives the download ring (same as
  // game covers) while this collection is actively downloading.
  const live = useCollectionSync(group.key);
  const syncing = live?.state === 'syncing';
  const syncPct = live?.pct != null ? live.pct
    : (live && live.total ? Math.round(((live.downloaded || 0) / live.total) * 100) : 0);
  const toggleSync = async () => {
    const next = !synced;
    setSynced(next);
    try {
      const ok = await toggleCollectionSync(group.key, next);
      if (ok === false) throw new Error('backend declined');
      toaster.toast({ title: next ? 'Auto-sync on' : 'Auto-sync off', body: group.label });
    } catch (e) {
      setSynced(!next); // revert
      toaster.toast({ title: 'Sync toggle failed', body: String(e) });
    }
  };
  // Collection actions menu (same as the in-collection header menu): one-shot
  // "Sync missing" + destructive "Remove downloaded" (arm→confirm). Reached by
  // HOLDING A on the tile (or right-click / the ⋯ chip for mouse).
  const removeArmed = useRef(false);
  const doTileRemove = async () => {
    try {
      if (synced) { await toggleCollectionSync(group.key, false); setSynced(false); }
      const ok = await deleteCollectionRoms(group.key, 'collection');
      if (ok === false) throw new Error('backend declined');
      // Mirror the deletion into the shared caches (these games also live in
      // their platform lists), then refetch whatever is mounted — without this
      // the dots stayed lit until the group was re-entered.
      const list = _libGamesCache.get(`collection:${group.key}`) || [];
      for (const g of list) if (g.is_downloaded) libCacheSetDownloaded(g.rom_id, false);
      libCacheDelete(`collection:${group.key}`);
      _broadcastLibRefresh();
    } catch (e) { toaster.toast({ title: 'Remove failed', body: String(e) }); }
  };
  const openMenu = () => {
    const armed = removeArmed.current;
    showContextMenu(
      <Menu label={group.label} onCancel={() => { removeArmed.current = false; }}>
        <MenuItem onSelected={async () => {
          const res = await getLibraryGames('collection', group.key).catch(() => null);
          const missing = res?.success ? (res.games || []).filter((g: LibGame) => !g.is_downloaded).map((g: LibGame) => ({ id: g.rom_id, name: g.name })) : [];
          if (!missing.length) { toaster.toast({ title: 'Nothing to sync', body: 'All games are already downloaded' }); return; }
          // Shared module-level batch: same job key as the collection page, so
          // opening the collection mid-batch shows the running header progress.
          // Toast click reuses the tile's own open handler, so it lands on the
          // collection with the same sibling list the tile would have given it.
          runCollectionBatch(`collection:${group.key}`, missing, () => onOpen(group));
        }}>{isVirtual ? 'Download missing' : 'Sync missing'}</MenuItem>
        {!isVirtual && (
          <MenuItem tone="destructive" onSelected={() => {
            if (!armed) {
              removeArmed.current = true;
              setTimeout(() => { removeArmed.current = false; }, 4000);
              requestAnimationFrame(openMenu);
            } else { removeArmed.current = false; doTileRemove(); }
          }}>{armed ? 'Confirm remove' : 'Remove downloaded'}</MenuItem>
        )}
      </Menu>,
    );
  };

  // Distinguish tap (open) from hold (actions menu) on the A button. onButtonDown
  // starts the hold timer; onActivate (fires on release) opens only if the hold
  // didn't already trigger the menu. Repeats are ignored so the timer fires once.
  const holdTimer = useRef<any>(null);
  const held = useRef(false);
  const onBtnDown = (e: any) => {
    if (e?.detail?.button !== GamepadButton.OK || e?.detail?.is_repeat) return;
    held.current = false;
    clearTimeout(holdTimer.current);
    holdTimer.current = setTimeout(() => { held.current = true; openMenu(); }, 500);
  };
  const onActivate = () => {
    clearTimeout(holdTimer.current);
    if (held.current) { held.current = false; return; } // hold opened the menu
    onOpen(group);
  };

  const badge = group.kind === 'smart' ? { label: 'SMART', bg: V2.brandHover }
    : group.kind === 'virtual' ? { label: 'VIRTUAL', bg: V2.brandHover }
      : group.kind === 'favorite' ? { label: '★', bg: '#ff4f6b' }
        : null;
  // Terse footer labels — the long "Open · Hold: Actions" + "Sync collection"
  // pair wrapped the Deck's button legend onto two rows. The hold affordance
  // is already advertised by the tile's ⋯ HOLD chip.
  const selfRef = useRef<any>(null);
  const setRefs = (el: any) => {
    selfRef.current = el;
    if (typeof focusRef === 'function') focusRef(el);
    else if (focusRef) (focusRef as any).current = el;
  };
  return (
    <Focusable noFocusRing className="romm-ct-wrap"
      {...({ focusable: focusable !== false } as any)}
      ref={setRefs}
      onClick={() => onOpen(group)}
      onActivate={onActivate}
      onButtonDown={onBtnDown}
      onOKActionDescription="Open"
      onOptionsButton={isVirtual ? undefined : toggleSync}
      onOptionsActionDescription={isVirtual ? undefined : (synced ? 'Sync off' : 'Sync')}
      onFocus={() => { setFocused(true); _tileFocusScrub(selfRef.current, group.label); }} onBlur={() => setFocused(false)}
      onMouseEnter={() => setFocused(true)} onMouseLeave={() => setFocused(false)}
      style={{ cursor: 'pointer', display: 'flex', flexDirection: 'column', gap: '8px' }}
    >
      <div className="romm-ct-cover" style={{
        position: 'relative', borderRadius: V2.radiusLg,
        transform: 'scale(1)', transition: 'transform 0.18s ease, box-shadow 0.18s ease',
        boxShadow: '0 2px 8px rgba(0,0,0,0.35)',
        ...V2Focus.tile(focused),
      }}>
        <CollectionMosaic covers={group.covers || []} />
        {/* Download ring + glyph while syncing — mirrors the game-cover affordance
            so a downloading collection reads the same as a downloading game. */}
        {syncing && (
          <>
            <div style={{
              position: 'absolute', inset: 0, borderRadius: V2.radiusLg,
              background: 'rgba(0,0,0,0.45)', pointerEvents: 'none', zIndex: 1,
            }} />
            <div style={{
              position: 'absolute', top: '50%', left: '50%', transform: 'translate(-50%,-50%)',
              zIndex: 2, ...roundBtn(44, 'emphasized'), boxShadow: '0 2px 10px rgba(0,0,0,0.55)',
            }}>
              <div style={{
                position: 'absolute', top: '50%', left: '50%',
                transform: 'translate(-50%,-50%)', pointerEvents: 'none',
              }}>
                <ProgressRing pct={syncPct} size={48} stroke={4} />
              </div>
              <FaDownload size={15} />
            </div>
          </>
        )}
        {/* Synced status dot — same green dot as downloaded games, placed
            top-right so it never collides with the kind badge (top-left).
            Hidden while the ring is showing. */}
        {synced && !syncing && (
          <div style={{
            position: 'absolute', top: '7px', right: '7px', zIndex: 2,
            width: '10px', height: '10px', borderRadius: '50%',
            background: V2.success, boxShadow: '0 0 0 2px rgba(0,0,0,0.45)',
          }} />
        )}
        {badge && (
          <span style={{
            position: 'absolute', top: '6px', left: '6px',
            fontSize: '9px', fontWeight: 800, letterSpacing: '0.04em',
            padding: '2px 7px', borderRadius: V2.radiusChip, color: '#fff',
            background: badge.bg, boxShadow: '0 1px 3px rgba(0,0,0,0.5)',
          }}>{badge.label}</span>
        )}
        {/* Actions hint — a ⋯ chip on focus/hover signals the long-press (hold A)
            / right-click actions menu exists; also clickable for mouse users. */}
        {focused && !syncing && (
          <div
            onClick={(e: any) => { e.stopPropagation(); openMenu(); }}
            style={{
              position: 'absolute', bottom: '6px', right: '6px', zIndex: 3,
              display: 'flex', alignItems: 'center', gap: '4px',
              padding: '2px 6px', borderRadius: V2.radiusChip,
              background: 'rgba(0,0,0,0.62)', color: V2.fg,
              fontSize: '9px', fontWeight: 700, letterSpacing: '0.02em',
              boxShadow: '0 1px 3px rgba(0,0,0,0.5)', pointerEvents: 'auto',
            }}>
            <FaEllipsisH size={9} /><span>HOLD</span>
          </div>
        )}
      </div>
      <div>
        <div style={{
          fontSize: '12.5px', fontWeight: 600, color: focused ? V2.fg : V2.fg2,
          whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
          transition: 'color 0.18s',
        }}>{group.label}</div>
        <div style={{ fontSize: '11px', color: V2.fgMuted }}>
          {group.count} {group.count === 1 ? 'game' : 'games'}
        </div>
      </div>
    </Focusable>
  );
}

// True RomM platform icon, served by the RomM server at
// /assets/platforms/{slug}.svg (the RPlatformIcon fallback chain:
// fsSlug.svg → fsSlug.ico → slug.svg → slug.ico). Each candidate is fetched
// via the backend get_image RPC; falls back to a gamepad glyph if none load.
function PlatformIcon({ slug, fsSlug, size, onTone }: { slug?: string | null; fsSlug?: string | null; size: number; onTone?: (dark: boolean) => void }) {
  const key = `${(fsSlug || '').toLowerCase().trim()}|${(slug || '').toLowerCase().trim()}`;
  // Resolved-icon cache: which candidate URL actually exists is unknown up
  // front, so we cache the RESOLVED data URI (or null = none) per platform key.
  // Seeding from it means a tab switch repaints icons synchronously instead of
  // popping them in one-by-one as each async RPC lands.
  const cached = _platIconCache.has(key) ? _platIconCache.get(key) : undefined;
  const [uri, setUri] = useState<string | null>(cached ?? null);
  const [failed, setFailed] = useState(cached === null);
  useEffect(() => {
    if (_platIconCache.has(key)) {
      const c = _platIconCache.get(key)!;
      setUri(c ?? null); setFailed(c === null); return;
    }
    let alive = true;
    const fs = (fsSlug || slug || '').toLowerCase().trim();
    const s = (slug || '').toLowerCase().trim();
    const cands: string[] = [];
    if (fs) cands.push(`/assets/platforms/${fs}.svg`, `/assets/platforms/${fs}.ico`);
    if (s && s !== fs) cands.push(`/assets/platforms/${s}.svg`, `/assets/platforms/${s}.ico`);
    cands.push('/assets/platforms/default.ico');
    (async () => {
      for (const c of cands) {
        try {
          const r = await awaitCover(`img:${c}`, () => qGetImage(c));
          if (!alive) return;
          if (r) { _platIconCacheSet(key, r); setUri(r); return; }
        } catch { /* try next */ }
      }
      if (alive) { _platIconCacheSet(key, null); setFailed(true); }
    })();
    return () => { alive = false; };
  }, [key]);
  // Report the icon's own tone so a caller's scrim can flip for contrast (dark
  // logo → light scrim), mirroring the screenshot-edge arrows. Average only the
  // opaque pixels — platform SVGs are mostly transparent, so counting the empty
  // field would wash every icon toward "light".
  useEffect(() => {
    if (!uri || !onTone) return;
    let alive = true;
    const img = new Image();
    img.onload = () => {
      try {
        const s = 24;
        const c = document.createElement('canvas');
        c.width = s; c.height = s;
        const ctx = c.getContext('2d');
        if (!ctx) return;
        ctx.drawImage(img, 0, 0, s, s);
        const d = ctx.getImageData(0, 0, s, s).data;
        let lum = 0, a = 0;
        for (let k = 0; k < d.length; k += 4) {
          const w = d[k + 3] / 255;
          lum += (0.2126 * d[k] + 0.7152 * d[k + 1] + 0.0722 * d[k + 2]) * w;
          a += w;
        }
        if (alive) onTone(a > 4 ? lum / a < 120 : false);
      } catch { /* tainted canvas: leave the default scrim */ }
    };
    img.src = uri;
    return () => { alive = false; };
  }, [uri]);
  if (uri) return <img src={uri} style={{ width: '100%', height: '100%', objectFit: 'contain' }} />;
  if (failed || (!slug && !fsSlug)) return <FaGamepad size={Math.round(size * 0.75)} />;
  return null; // loading
}

// Platform tile — centered icon-led card (RomM PlatformTile): bg-elevated
// card, large icon on top, name + count, focus brand glow.
function PlatformTile({ group, onOpen, focusRef, focusable }: { group: LibGroup; onOpen: (g: LibGroup) => void; focusRef?: React.Ref<any>; focusable?: boolean }) {
  const [focused, setFocused] = useState(false);
  const selfRef = useRef<any>(null);
  const setRefs = (el: any) => {
    selfRef.current = el;
    if (typeof focusRef === 'function') focusRef(el);
    else if (focusRef) (focusRef as any).current = el;
  };
  return (
    <Focusable noFocusRing className="romm-ptile-wrap"
      {...({ focusable: focusable !== false } as any)}
      ref={setRefs}
      onActivate={() => onOpen(group)} onClick={() => onOpen(group)}
      onFocus={() => { setFocused(true); _tileFocusScrub(selfRef.current, group.label); }} onBlur={() => setFocused(false)}
      onMouseEnter={() => setFocused(true)} onMouseLeave={() => setFocused(false)}
      style={{ cursor: 'pointer' }}
    >
      {/* Visuals live on this inner wrapper — NOT the Focusable itself — so the
          gamepad-focusable box carries no ring of its own (Steam otherwise draws
          a faint default outline over our brand ring). Mirrors GameTile. The
          focused look is ALSO expressed as CSS :focus-within (romm-ptile-*
          classes, see V2_ROW_STYLE) so a forced gamepad focus that skips React's
          onFocus still highlights. */}
      <div className="romm-ptile-v" style={{
        display: 'flex', flexDirection: 'column', alignItems: 'center',
        gap: '12px', padding: '24px 16px 18px',
        background: focused ? V2.surface : 'rgba(255,255,255,0.045)',
        border: `1px solid ${focused ? V2.brand : V2.border}`, borderRadius: V2.radiusCard,
        transform: 'scale(1)',
        transition: 'background 0.15s, border-color 0.15s, transform 0.15s, box-shadow 0.15s',
        ...V2Focus.tile(focused),
      }}>
        <div className="romm-ptile-ic" style={{
          width: '72px', height: '72px', display: 'grid', placeItems: 'center',
          color: focused ? V2.brandHover : V2.fg2, opacity: focused ? 1 : 0.9,
          transition: 'color 0.15s',
        }}>
          <PlatformIcon slug={group.slug} fsSlug={group.fs_slug} size={72} />
        </div>
        {/* Fixed two-line box (clamped) so a long name can't make its tile
            taller than its row siblings — every tile ends up the same height
            regardless of label length. */}
        <div className="romm-ptile-lb" style={{
          fontSize: '12px', fontWeight: 600, textAlign: 'center', lineHeight: 1.35,
          color: focused ? V2.fg : V2.fg2,
          height: '2.7em', display: '-webkit-box', WebkitLineClamp: 2,
          WebkitBoxOrient: 'vertical', overflow: 'hidden',
        }}>
          {group.label}
        </div>
        <div style={{ fontSize: '11px', color: V2.fgMuted }}>
          {group.count} {group.count === 1 ? 'game' : 'games'}
          {group.downloaded != null && group.downloaded > 0 && (
            <span style={{ color: V2.success }}>{`  ·  ${group.downloaded} ↓`}</span>
          )}
        </div>
      </div>
    </Focusable>
  );
}

// RomM AppNav — fixed glass top bar: logo (left) · centered tab pill
// (Home/Platforms/Collections/Search) · right cluster. Geometry is grid
// 1fr/auto/1fr so the pill stays viewport-centered (AppNav.vue). The tab
// pill is RSliderBtnGroup's "tab" variant: surface bg + strong border, pill
// radius, and the ACTIVE tab is a solid white (--r-color-fg) pill with dark
// (--r-color-bg) text.
// Compact labeled pill for the top bar's optional "Launch RetroDECK" action.
// Sits beside the 32px brand mark: app icon + short label so the action reads
// clearly (vs. a bare glyph). Fully controller-focusable.
function NavLaunchButton({ iconSrc, label, onActivate }:
  { iconSrc: string | null; label?: string; onActivate: () => void }) {
  const [active, setActive] = useState(false);
  return (
    <Focusable noFocusRing
      onActivate={onActivate} onClick={onActivate}
      onFocus={() => setActive(true)} onBlur={() => setActive(false)}
      onMouseEnter={() => setActive(true)} onMouseLeave={() => setActive(false)}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: '7px',
        height: '34px', padding: iconSrc ? '0 7px 0 5px' : '0 10px',
        borderRadius: V2.radiusPill, cursor: 'pointer',
        background: active ? 'rgba(255,255,255,0.10)' : V2.surface,
        color: active ? V2.fg : V2.fg2,
        fontSize: '13px', fontWeight: 600, whiteSpace: 'nowrap',
        border: `1px solid ${active ? V2.brand : V2.borderStrong}`,
        boxShadow: active ? `0 0 0 1px ${V2.brand}` : 'none',
        transition: 'background 0.15s, color 0.15s, border-color 0.15s, box-shadow 0.15s',
      }}
    >
      {iconSrc
        ? <img src={iconSrc} style={{ width: '26px', height: '26px', display: 'block', flexShrink: 0, borderRadius: '50%' }} />
        : <FaExternalLinkAlt size={13} style={{ marginLeft: '3px' }} />}
      <FaPlay size={11} style={{ flexShrink: 0 }} />
      {label && <span>{label}</span>}
    </Focusable>
  );
}

type NavId = 'home' | 'platforms' | 'collections' | 'search';

// Remembered account identity (username / role / avatar data URI), mirrored to
// localStorage the same way the browse caches are. The identity is the same on
// every launch, so serving last session's copy paints the real pill on the first
// frame instead of a placeholder; the fetch below still runs and overwrites it, so
// a renamed account or a new avatar corrects itself as soon as the answer lands.
// No TTL — a revalidation happens every launch by construction. Cleared on logout
// (see handleLogout) so the next user never sees the previous one's pill.
type NavIdentity = { username: string; role: string; avatar: string | null };
const _LS_IDENTITY = 'romm:identity:v1';
function readIdentity(): NavIdentity | null {
  if (!_lsAvail) return null;
  try {
    const o = JSON.parse(localStorage.getItem(_LS_IDENTITY) || 'null');
    if (o && typeof o.username === 'string' && o.username)
      return { username: o.username, role: typeof o.role === 'string' ? o.role : '', avatar: o.avatar || null };
  } catch { }
  return null;
}
function writeIdentity(id: NavIdentity) {
  if (!_lsAvail) return;
  // An avatar is a data URI; a huge one would blow the quota and take the browse
  // caches down with it, so skip persisting anything oversized (the pill just
  // falls back to the initial for one frame, then the fetched image lands).
  const avatar = id.avatar && id.avatar.length < 512 * 1024 ? id.avatar : null;
  try { localStorage.setItem(_LS_IDENTITY, JSON.stringify({ ...id, avatar })); } catch { }
}
// Not exported: this is the plugin's rollup ENTRY, and decky's config declares
// output.exports "default". A second named export off the entry fails the whole
// bundle ("default" was specified … has the following exports: clearIdentityCache
// and default), which is why the Decky zip stopped building. Both callers are in
// this file, so the keyword bought nothing.
function clearIdentityCache() {
  if (!_lsAvail) return;
  try { localStorage.removeItem(_LS_IDENTITY); } catch { }
}

// Everything the top-bar chrome needs (brand marks, account identity, RetroDECK
// launch button state). Lifted into a hook so the owning page (LibraryGroupsPage)
// can drive both the V2NavBar rendering AND the controller shortcuts / footer
// hints from one fetch, instead of the nav bar owning state the page can't reach.
export type NavChrome = {
  iso: string | null; word: string | null;
  username: string; role: string; avatar: string | null;
  rdEnabled: boolean; rdIcon: string | null;
};
function useNavChrome(): NavChrome {
  const [iso, setIso] = useState<string | null>(null);
  const [word, setWord] = useState<string | null>(null);
  // Last session's identity if we have one, else empty — NOT 'Guest': the fetch
  // answers a beat after first paint, and seeding the real default made every
  // cold launch flash "Guest" + a "G" avatar before snapping to the actual
  // account. While empty the pill renders a neutral placeholder, and 'Guest' is
  // only set once we know there's no account to show.
  const cached = useRef(readIdentity()).current;
  const [username, setUsername] = useState<string>(cached?.username || '');
  const [role, setRole] = useState<string>(cached?.role || '');
  const [avatar, setAvatar] = useState<string | null>(cached?.avatar || null);
  const [rdEnabled, setRdEnabled] = useState<boolean>(false);
  const [rdIcon, setRdIcon] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    (async () => {
      try { const a = await getImage('/assets/isotipo.svg'); if (alive) setIso(a?.data_uri || null); } catch { }
      try { const b = await getImage('/assets/logotipo.svg'); if (alive) setWord(b?.data_uri || null); } catch { }
      try {
        const on = await getRetrodeckButtonEnabled();
        if (alive) setRdEnabled(!!on);
        if (on) { const r = await getRetrodeckLogo(); if (alive) setRdIcon(r?.data_uri || null); }
      } catch { }
      // The fetched values are authoritative over the cached seed above, and
      // whatever they resolve to becomes next launch's seed. `fresh` starts from
      // the cache so a failed leg keeps the remembered value rather than
      // persisting a blank over a good one.
      const fresh: NavIdentity = {
        username: cached?.username || '', role: cached?.role || '', avatar: cached?.avatar || null,
      };
      let known = false;
      try {
        const acc = await getAccountUsername();
        fresh.username = acc?.username || 'Guest';
        fresh.role = acc?.role || '';
        known = true;
        if (alive) { setUsername(fresh.username); setRole(fresh.role); }
      } catch { if (alive && !fresh.username) setUsername('Guest'); }
      // Avatar fetched raw by the backend (get_avatar) — keeps transparency and
      // logs a wrong path/404 instead of silently showing the initial fallback.
      try {
        const av = await getAvatar();
        fresh.avatar = av?.data_uri || null;
        if (alive) setAvatar(fresh.avatar);
      } catch { }
      // Only remember a real identity: 'Guest' means signed out, and caching it
      // would paint "Guest" on the next launch before the fetch corrects it —
      // exactly the flash this cache exists to remove.
      if (known && fresh.username && fresh.username !== 'Guest') writeIdentity(fresh);
      else if (known) clearIdentityCache();
    })();
    return () => { alive = false; };
  }, []);
  return { iso, word, username, role, avatar, rdEnabled, rdIcon };
}

function V2NavBar({ active, onTab, activeRef, chrome, onLaunchRd }:
  { active: NavId; onTab: (id: NavId) => void; activeRef?: React.MutableRefObject<any>;
    chrome: NavChrome; onLaunchRd: () => void }) {
  const { iso, word, username, role, avatar, rdEnabled, rdIcon } = chrome;
  const wideBar = useWideTopBar();
  const tabs: { id: NavId; label: string; Icon: any }[] = [
    { id: 'home', label: 'Home', Icon: FaHome },
    { id: 'platforms', label: 'Platforms', Icon: FaGamepad },
    { id: 'collections', label: 'Collections', Icon: FaBookmark },
    { id: 'search', label: 'Search', Icon: FaSearch },
  ];

  // Sliding active indicator (RSliderBtnGroup): one white pill whose left/width
  // animates between the active tab's measured position, instead of toggling a
  // background per button.
  const btnRefs = useRef<(HTMLDivElement | null)[]>([]);
  const [ind, setInd] = useState<{ left: number; width: number } | null>(null);
  const [shown, setShown] = useState(false); // drives the first-load grow/fade-in
  const [focusedIdx, setFocusedIdx] = useState<number | null>(null);
  const activeIdx = tabs.findIndex((t) => t.id === active);
  // Drop any lingering focus tint when the active tab changes: on an LB/RB
  // switch the old panel's unmount can leave focusedIdx pointing at the
  // previous tab (its blur never fires), which kept that tab looking
  // highlighted. A genuinely focused pill re-tints via its own onFocus.
  useEffect(() => { setFocusedIdx(null); }, [active]);
  useEffect(() => {
    const el = btnRefs.current[activeIdx];
    if (el) {
      setInd({ left: el.offsetLeft, width: el.offsetWidth });
      // Next frame: flip from the collapsed/transparent initial state to full so
      // the indicator animates into place on first paint.
      requestAnimationFrame(() => setShown(true));
    }
  }, [activeIdx]);

  return (
    // Horizontal-flow Focusable so the three clusters (RetroDECK launch · nav
    // tabs · user pill) navigate with LEFT/RIGHT. Without this the row is a plain
    // div inside the page's vertical-flow Focusable, so Steam stacked the three
    // as a vertical list and you had to press UP/DOWN to reach the side clusters.
    <Focusable noFocusRing flow-children="horizontal" style={{
      position: 'sticky', top: 0, zIndex: 50, height: '58px',
      display: 'grid', gridTemplateColumns: '1fr auto 1fr', alignItems: 'center',
      padding: '0 20px', background: 'rgba(7,7,15,0.78)',
      backdropFilter: 'blur(20px)', WebkitBackdropFilter: 'blur(20px)',
      borderBottom: `1px solid ${V2.border}`,
    }}>
      {/* Left cluster: brand mark + wordmark. When the RetroDECK launch button
          is enabled, the wordmark gives way to the button so the left column
          stays compact on small (Deck) screens — mark + button, never both
          the wordmark and the button. */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
        {iso && <img src={iso} style={{ width: '32px', height: '32px', display: 'block' }} />}
        {rdEnabled
          ? <NavLaunchButton iconSrc={rdIcon} onActivate={onLaunchRd} />
          : (word && <img src={word} style={{ height: '22px', width: 'auto', display: 'block' }} />)}
      </div>
      <div style={{ justifySelf: 'center', display: 'flex', alignItems: 'center', gap: '10px' }}>
        <Bumper label="L1" />
        {/* shim-topnav marks the tabs pill so the desktop gamepad shim, when an
            Up move enters the sticky top bar, always lands INSIDE this pill (the
            column-nearest tab) rather than on the side clusters — matching the
            Deck, where Up into the nav always lands on a nav tab. Harmless on the
            Deck (just an extra class). */}
        <Focusable noFocusRing className="shim-topnav" flow-children="horizontal" style={{
          position: 'relative', display: 'flex', gap: '2px', padding: '4px',
          background: V2.surface, border: `1px solid ${V2.borderStrong}`, borderRadius: V2.radiusPill,
        }}>
          {/* Sliding indicator */}
          {ind && (
            <div style={{
              position: 'absolute', top: '4px', bottom: '4px',
              left: `${ind.left}px`, width: `${ind.width}px`,
              background: V2.fg, borderRadius: V2.radiusPill, zIndex: 0,
              opacity: shown ? 1 : 0,
              transform: shown ? 'scaleX(1)' : 'scaleX(0.6)', transformOrigin: 'center',
              transition: 'left 0.28s cubic-bezier(0.22,1,0.36,1), width 0.28s cubic-bezier(0.22,1,0.36,1), opacity 0.28s ease, transform 0.28s cubic-bezier(0.22,1,0.36,1)',
            }} />
          )}
          {tabs.map(({ id, label, Icon }, i) => {
            const on = active === id;
            return (
              <Focusable noFocusRing key={id} ref={on && activeRef ? activeRef : undefined}
                className={on ? 'shim-navtab-active' : undefined}
                onActivate={() => onTab(id)} onClick={() => onTab(id)}
                onFocus={() => setFocusedIdx(i)} onBlur={() => setFocusedIdx(null)}
                onMouseEnter={() => setFocusedIdx(i)} onMouseLeave={() => setFocusedIdx(null)}>
                <div ref={(el) => { btnRefs.current[i] = el; }}
                  style={{
                    position: 'relative', zIndex: 1,
                    display: 'flex', alignItems: 'center', gap: '7px', padding: '7px 18px',
                    borderRadius: V2.radiusPill, fontSize: '13.5px', cursor: 'pointer',
                    fontWeight: on ? 600 : 500, color: on ? V2.bg : V2.fg2,
                    // Focus affordance is the brand ring, shown whenever a pill is
                    // focused — including the ALREADY-ACTIVE one, so the controller
                    // highlight is visible on the selected tab (it rides on top of
                    // the white sliding indicator). Inactive pills also get a tint;
                    // the active pill's white indicator is tint enough on its own.
                    background: (!on && focusedIdx === i) ? 'rgba(255,255,255,0.10)' : 'transparent',
                    boxShadow: (focusedIdx === i) ? `inset 0 0 0 1.5px ${V2.brand}` : 'none',
                    transition: 'color 0.2s ease, background 0.15s ease, box-shadow 0.15s ease',
                  }}>
                  <Icon size={12} /><span>{label}</span>
                </div>
              </Focusable>
            );
          })}
        </Focusable>
        <Bumper label="R1" />
      </div>
      {/* User pill — RomM AppShell/UserMenu.vue's .r-v2-user, copied 1:1:
          avatar(30) + username + chevron, pill radius, surface bg + strong
          border, tight 3px padding on the avatar side. Opens the account menu
          (Stats / Settings for now). */}
      <div style={{ justifySelf: 'end', display: 'flex', alignItems: 'center', gap: '8px' }}>
        {/* Wide top bars get a dedicated download chip; on the Deck the same
            glimpse collapses onto the user pill's avatar (no extra width). */}
        <NavDownloadGlimpse />
        <UserPill username={username} role={role} avatar={avatar} glimpse={!wideBar} />
      </div>
    </Focusable>
  );
}

// Renders the chip only when wide AND something is downloading — kept as its
// own component so the glimpse polling doesn't re-render the whole nav bar.
function NavDownloadGlimpse() {
  const wide = useWideTopBar();
  const dl = useDownloadGlimpse();
  if (!wide || dl.count === 0) return null;
  return <DownloadChip count={dl.count} pct={dl.pct} />;
}

// Circular avatar — real RomM avatar when uploaded, else the RAvatar fallback
// (surface circle with the user's initial). Shared by the pill and the menu.
function UserAvatar({ username, avatar, size }: { username: string; avatar: string | null; size: number }) {
  return (
    <div style={{
      width: `${size}px`, height: `${size}px`, borderRadius: '50%', flexShrink: 0,
      background: V2.bgElevated, border: `1px solid ${V2.borderStrong}`,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      fontSize: `${Math.round(size * 0.43)}px`, fontWeight: 700, color: V2.fg2, overflow: 'hidden',
    }}>
      {/* No initial while the username is still unknown — an empty circle reads
          as "loading", a letter reads as a real (wrong) account. */}
      {avatar
        ? <img src={avatar} style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
        : username.slice(0, 1).toUpperCase()}
    </div>
  );
}

// One RomM RMenuItem row: leading icon + label, hover/focus highlight, optional
// danger variant. Closes the menu, then runs the action.
// `armed` inverts the danger combination — the tinted-background/red-text row
// becomes a solid red fill with light text, so a half-pressed destructive row
// reads as live at a glance rather than as another idle menu entry.
function UserMenuRow({ icon, label, danger, armed, disabled, onSelect }:
  { icon: any; label: string; danger?: boolean; armed?: boolean; disabled?: boolean; onSelect: () => void }) {
  const [hot, setHot] = useState(false);
  const fg = disabled ? V2.fgFaint : (armed ? '#fff' : (danger ? V2.danger : V2.fg));
  const bg = armed
    ? (hot ? '#ff6a6a' : V2.danger)
    : ((hot && !disabled) ? (danger ? 'rgba(255,80,80,0.12)' : V2.surfaceHover) : 'transparent');
  return (
    <Focusable noFocusRing onActivate={() => !disabled && onSelect()} onClick={() => !disabled && onSelect()}
      onFocus={() => setHot(true)} onBlur={() => setHot(false)}
      onMouseEnter={() => setHot(true)} onMouseLeave={() => setHot(false)}
      style={{
        display: 'flex', alignItems: 'center', gap: '11px', padding: '9px 12px',
        borderRadius: V2.radiusMd, cursor: disabled ? 'default' : 'pointer',
        background: bg,
        color: fg, transition: 'background 0.12s ease, color 0.12s ease', opacity: disabled ? 0.55 : 1,
      }}>
      <div style={{ flexShrink: 0, width: '16px', display: 'flex', justifyContent: 'center', color: disabled ? V2.fgFaint : (armed ? '#fff' : (danger ? V2.danger : V2.fgMuted)) }}>{icon}</div>
      <span style={{ fontSize: '13.5px', fontWeight: 500 }}>{label}</span>
    </Focusable>
  );
}

// One entry on the Downloads page: game name over a live progress track, with
// speed/percent on the right and a bytes/ETA detail line while transferring.
function DownloadStatusRow({ romId, name }: { romId: number; name: string }) {
  const prog = useDownloadProgress(romId, true);
  const pct = Math.max(0, Math.min(100, prog?.percent ?? 0));
  const extracting = prog?.state === 'extracting';
  const bytes = prog && prog.total > 0 ? `${fmtBytes(prog.downloaded)} / ${fmtBytes(prog.total)}` : '';
  const eta = prog ? formatEta(prog.eta) : '';
  // During extraction there's no transfer to report — surface the phase instead.
  const sub = extracting
    ? 'Unpacking archive…'
    : [bytes, eta ? `${eta} left` : ''].filter(Boolean).join('  ·  ');
  const barColor = V2.brand;
  return (
    <div style={{ padding: '10px 14px 12px' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: '10px', minWidth: 0 }}>
        <span style={{
          fontSize: '13px', fontWeight: 600, color: V2.fg, minWidth: 0, display: 'inline-flex',
          alignItems: 'center', gap: '7px', overflow: 'hidden',
        }}>
          {extracting && <FaBoxOpen size={12} style={{ color: V2.fgMuted, flexShrink: 0 }} />}
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{name}</span>
        </span>
        <span style={{ fontSize: '11.5px', fontWeight: 600, color: V2.fgMuted, flexShrink: 0, fontVariantNumeric: 'tabular-nums' }}>
          {extracting ? `Extracting… ${pct}%` : `${prog && prog.speed > 0 ? `${formatSpeed(prog.speed)} · ` : ''}${pct}%`}
        </span>
      </div>
      <div style={{ height: '4px', borderRadius: '2px', background: V2.surface, marginTop: '7px', overflow: 'hidden' }}>
        <div style={{ height: '100%', width: `${pct}%`, background: barColor, borderRadius: '2px', transition: 'width 0.3s ease, background 0.3s ease' }} />
      </div>
      {sub && <div style={{ fontSize: '10.5px', color: V2.fgMuted, marginTop: '5px', fontVariantNumeric: 'tabular-nums' }}>{sub}</div>}
    </div>
  );
}

// Same row shape for a backend collection auto-sync pass (CollectionSyncManager),
// which downloads outside the frontend registry — surfaced from the shared
// service-status poll (sync_state 'syncing').
function CollectionSyncStatusRow({ col }: { col: any }) {
  const pct = typeof col.downloaded_pct === 'number'
    ? Math.max(0, Math.min(100, col.downloaded_pct))
    : (col.total ? Math.max(0, Math.min(100, (col.downloaded || 0) / col.total * 100)) : 0);
  return (
    <div style={{ padding: '10px 14px 12px' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: '10px', minWidth: 0 }}>
        <span style={{
          fontSize: '13px', fontWeight: 600, color: V2.fg, minWidth: 0,
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}>Collection · {col.name}</span>
        <span style={{ fontSize: '11.5px', fontWeight: 600, color: V2.fgMuted, flexShrink: 0, fontVariantNumeric: 'tabular-nums' }}>
          {col.speed > 0 ? `${formatSpeed(col.speed)} · ` : ''}{col.downloaded || 0}/{col.total || 0} games
        </span>
      </div>
      <div style={{ height: '4px', borderRadius: '2px', background: V2.surface, marginTop: '7px', overflow: 'hidden' }}>
        <div style={{ height: '100%', width: `${pct}%`, background: V2.brand, borderRadius: '2px', transition: 'width 0.3s ease' }} />
      </div>
    </div>
  );
}

// RomM UserMenu, rebuilt in the v2 design language (matches RestoreModal's
// chrome): a glass panel anchored top-right (RomM's location="bottom end"),
// with the identity header card over Stats / Settings / Log out.
function UserMenuModal({ username, role, avatar, closeModal }:
  { username: string; role: string; avatar: string | null; closeModal?: () => void }) {
  const panelRef = useRef<HTMLDivElement>(null);
  useEffect(() => { const t = setTimeout(() => { if (panelRef.current) _forceGamepadFocus(panelRef.current); }, 60); return () => clearTimeout(t); }, []);
  const [refreshing, setRefreshing] = useState(false);
  // Live count badge for the Downloads row (registry + collection auto-sync).
  const dlGlimpse = useDownloadGlimpse();

  // In-library view when the library route hosts us (keeps the tabs tree
  // mounted underneath), real navigation otherwise.
  const go = (route: string) => { closeModal?.(); libNavigate(route); };
  const doRefresh = async () => {
    if (refreshing) return;
    setRefreshing(true);
    try {
      const res = await refreshFromRomm(false); // incremental
      if (res?.success) {
        toaster.toast({ title: 'RomM library refreshed', body: res.message || 'Up to date.' });
        _broadcastLibRefresh();
      } else {
        toaster.toast({ title: 'Refresh failed', body: res?.message ?? 'Unknown error' });
      }
    } catch (e) {
      toaster.toast({ title: 'Refresh failed', body: String(e) });
    } finally {
      setRefreshing(false);
    }
  };
  // Desktop shell exposes a quit bridge; the Deck build has no such object, so
  // the Exit row only appears in the PC app. Logout lives in Settings.
  const desktop = (window as any).__rommDesktop;
  // Quit is one keypress away from killing a session, so it arms on the first
  // activate and only exits on the second (same arm → confirm shape as
  // CollectionActionsModal's "Remove downloaded"), disarming after 4s.
  const [quitArmed, setQuitArmed] = useState(false);
  useEffect(() => { if (!quitArmed) return; const t = setTimeout(() => setQuitArmed(false), 4000); return () => clearTimeout(t); }, [quitArmed]);
  const doQuit = () => {
    if (!quitArmed) { setQuitArmed(true); return; }
    setQuitArmed(false);
    closeModal?.();
    try { desktop?.quit?.(); } catch { /* no-op */ }
  };

  return (
    <ModalRoot bHideCloseIcon onCancel={closeModal} onEscKeypress={closeModal}
      className="romm-modal-collapse" modalClassName="romm-modal-collapse">
      <Focusable noFocusRing className="romm-ui"
        onCancelButton={() => closeModal?.()}
        onButtonDown={(e: any) => { if (e?.detail?.button === GamepadButton.CANCEL) closeModal?.(); }}
        style={{
          position: 'fixed', inset: 0, zIndex: 9999,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          background: 'rgba(7,7,15,0.45)',
          WebkitBackdropFilter: 'blur(8px)', backdropFilter: 'blur(8px)',
        }}>
        <style>{`
          ${V2_FOCUS_STYLE}
          .romm-modal-collapse, .romm-modal-collapse > div {
            background: transparent !important; border: none !important; box-shadow: none !important; padding: 0 !important;
          }
          @keyframes umIn { from { opacity: 0; transform: translateY(-6px) scale(0.98); } to { opacity: 1; transform: none; } }
        `}</style>
        {/* Click-away scrim */}
        <div onClick={() => closeModal?.()} style={{ position: 'absolute', inset: 0 }} />
        <Focusable noFocusRing autoFocus ref={panelRef} flow-children="vertical" style={{
          position: 'relative', width: '260px', maxWidth: '90vw', boxSizing: 'border-box',
          fontFamily: V2.font, color: V2.fg, padding: '8px',
          display: 'flex', flexDirection: 'column',
          background: 'linear-gradient(180deg, rgba(20,20,30,0.7) 0%, rgba(10,10,18,0.78) 100%)',
          WebkitBackdropFilter: 'blur(28px) saturate(1.1)', backdropFilter: 'blur(28px) saturate(1.1)',
          border: `1px solid rgba(255,255,255,0.12)`, borderRadius: V2.radiusCard,
          boxShadow: '0 16px 48px rgba(0,0,0,0.55)',
          maxHeight: '82vh', overflowY: 'auto',
          animation: 'umIn 0.18s cubic-bezier(0.22,1,0.36,1)',
        }}>
          {/* Identity header card — RomM UserMenu __header. */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '6px 8px 12px', minWidth: 0 }}>
            <UserAvatar username={username} avatar={avatar} size={34} />
            <div style={{ minWidth: 0 }}>
              <div style={{
                fontSize: '13px', fontWeight: 700, color: V2.fg, lineHeight: 1.3,
                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              }}>{username}</div>
              {role && <div style={{
                fontSize: '10.5px', fontWeight: 600, textTransform: 'capitalize',
                color: V2.fgMuted, marginTop: '2px', whiteSpace: 'nowrap',
              }}>{role}</div>}
            </div>
          </div>
          <div style={{ height: '1px', background: V2.border, margin: '0 4px 4px' }} />
          <UserMenuRow icon={<FaChartBar size={15} />} label="Stats" onSelect={() => go("/romm-sync-stats")} />
          <UserMenuRow icon={<FaPuzzlePiece size={15} />} label="Emulator Cores" onSelect={() => go("/romm-sync-cores")} />
          <UserMenuRow icon={<FaCog size={15} />} label="Settings" onSelect={() => go("/romm-sync-settings")} />
          <UserMenuRow
            icon={<FaSync size={15} style={refreshing ? { animation: 'spin 1s linear infinite' } : undefined} />}
            label={refreshing ? 'Refreshing…' : 'Refresh library'} disabled={refreshing} onSelect={doRefresh} />
          <UserMenuRow icon={<FaDownload size={15} />}
            label={`Downloads${dlGlimpse.count > 0 ? ` (${dlGlimpse.count})` : ''}`}
            onSelect={() => go("/romm-sync-downloads")} />
          {desktop && (
            <>
              <div style={{ height: '1px', background: V2.border, margin: '4px 4px' }} />
              <UserMenuRow icon={quitArmed ? <FaCheck size={15} /> : <FaPowerOff size={15} />}
                label={quitArmed ? 'Confirm quit' : 'Quit'} danger armed={quitArmed} onSelect={doQuit} />
            </>
          )}
        </Focusable>
      </Focusable>
    </ModalRoot>
  );
}

// Per-folder actions, in the account-menu chrome. A on a folder row opens this
// rather than jumping straight into the picker: choosing a folder is only half
// of what people want to do with one, and "back to the default" needs to say
// what the default IS before you commit to it.
function FolderActionsModal({ label, current, def, isDefault, onChoose, onReset, closeModal }:
  {
    label: string; current: string; def: string; isDefault: boolean;
    onChoose: () => void; onReset: () => void; closeModal?: () => void;
  }) {
  const panelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const t = setTimeout(() => { if (panelRef.current) _forceGamepadFocus(panelRef.current); }, 60);
    return () => clearTimeout(t);
  }, []);
  const act = (f: () => void) => { closeModal?.(); f(); };
  return (
    <ModalRoot bHideCloseIcon onCancel={closeModal} onEscKeypress={closeModal}
      className="romm-modal-collapse" modalClassName="romm-modal-collapse">
      <Focusable noFocusRing className="romm-ui"
        onCancelButton={() => closeModal?.()}
        onButtonDown={(e: any) => { if (e?.detail?.button === GamepadButton.CANCEL) closeModal?.(); }}
        style={{
          position: 'fixed', inset: 0, zIndex: 9999,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          background: 'rgba(7,7,15,0.45)',
          WebkitBackdropFilter: 'blur(8px)', backdropFilter: 'blur(8px)',
        }}>
        <style>{`
          ${V2_FOCUS_STYLE}
          .romm-modal-collapse, .romm-modal-collapse > div {
            background: transparent !important; border: none !important; box-shadow: none !important; padding: 0 !important;
          }
          @keyframes umIn { from { opacity: 0; transform: translateY(-6px) scale(0.98); } to { opacity: 1; transform: none; } }
        `}</style>
        <div onClick={() => closeModal?.()} style={{ position: 'absolute', inset: 0 }} />
        <Focusable noFocusRing autoFocus ref={panelRef} flow-children="vertical" style={{
          position: 'relative', width: '380px', maxWidth: '92vw', boxSizing: 'border-box',
          fontFamily: V2.font, color: V2.fg, padding: '8px',
          display: 'flex', flexDirection: 'column',
          background: 'linear-gradient(180deg, rgba(20,20,30,0.7) 0%, rgba(10,10,18,0.78) 100%)',
          WebkitBackdropFilter: 'blur(28px) saturate(1.1)', backdropFilter: 'blur(28px) saturate(1.1)',
          border: `1px solid rgba(255,255,255,0.12)`, borderRadius: V2.radiusCard,
          boxShadow: '0 16px 48px rgba(0,0,0,0.55)',
          maxHeight: '82vh', overflowY: 'auto',
          animation: 'umIn 0.18s cubic-bezier(0.22,1,0.36,1)',
        }}>
          <div style={{ padding: '8px 10px 10px', minWidth: 0 }}>
            <div style={{ fontSize: '14px', fontWeight: 700, lineHeight: 1.3 }}>{label}</div>
            <div style={{
              fontSize: '11px', color: V2.fgMuted, marginTop: '3px', wordBreak: 'break-all',
            }}>{current || 'Not set'}</div>
          </div>
          <div style={{ height: '1px', background: V2.border, margin: '0 4px 4px' }} />
          <UserMenuRow icon={<FaBoxOpen size={14} />} label="Choose a folder…"
            onSelect={() => act(onChoose)} />
          {/* Only when it would actually change something — a reset that is a
              no-op is noise, and worse, it implies the current value is wrong. */}
          {!isDefault && (
            <UserMenuRow icon={<FaUndo size={14} />}
              label={def ? 'Use the default folder' : 'Back to auto-detect'}
              onSelect={() => act(onReset)} />
          )}
          {!isDefault && def && (
            <div style={{
              padding: '2px 12px 8px', fontSize: '10.5px', color: V2.fgFaint,
              wordBreak: 'break-all',
            }}>{def}</div>
          )}
        </Focusable>
      </Focusable>
    </ModalRoot>
  );
}

// ── Missing-core picker ──────────────────────────────────────────────────────
// A launch that fails for a missing core is fixable right there, so instead of a
// toast that only names the problem, offer the fix: install the recommended core
// for that platform (or a different one), then start the game. Same glass chrome
// as the user menu.
type CoreGap = {
  platform_name: string;
  platform_slug: string;
  candidates: string[];
  installed_cores: string[];
  can_download: boolean;
  download_reason: string;
};

// Alternatives shown without asking. Two rows cost less attention than a row
// that says "two more rows in here".
const INLINE_CORES = 2;

function coreLabel(name: string): string {
  // Buildbot names are like 'mupen64plus_next' — readable enough once the
  // separators are spaces, and the real identifier still shows underneath.
  return name.replace(/_libretro$/, '').replace(/_/g, ' ');
}

function MissingCoreModal({ gap, onPlay, closeModal }:
  { gap: CoreGap; onPlay: () => void; closeModal?: () => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [failed, setFailed] = useState<string>('');
  const [showAll, setShowAll] = useState(false);
  const panelRef = useRef<HTMLDivElement | null>(null);

  const recommended = gap.candidates[0] || '';
  const others = gap.candidates.slice(1);

  const install = async (core: string) => {
    setBusy(core); setFailed('');
    try {
      const r = await downloadCore(core);
      if (!r?.success) {
        setFailed(r?.message || `Could not install ${core}`);
        return;
      }
      // Pin it for this platform when it isn't the one we'd have guessed:
      // otherwise resolution could pick a different installed core next time and
      // the user's choice here would look ignored.
      if (core !== recommended && gap.platform_slug) {
        try { await setCoreOverride(gap.platform_slug, core); } catch { /* non-fatal */ }
      }
      setDone(core);
      // The cores page and the emulator status both cache a core count.
      try { await loadEmulatorStatus(true); } catch { /* non-fatal */ }
    } catch (e) {
      setFailed(String(e));
    } finally {
      setBusy(null);
    }
  };

  const playNow = () => { closeModal?.(); onPlay(); };

  return (
    <ModalRoot bHideCloseIcon onCancel={closeModal} onEscKeypress={closeModal}
      className="romm-modal-collapse" modalClassName="romm-modal-collapse">
      <Focusable noFocusRing className="romm-ui"
        onCancelButton={() => closeModal?.()}
        onButtonDown={(e: any) => { if (e?.detail?.button === GamepadButton.CANCEL) closeModal?.(); }}
        style={{
          position: 'fixed', inset: 0, zIndex: 9999,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          background: 'rgba(7,7,15,0.45)',
          WebkitBackdropFilter: 'blur(8px)', backdropFilter: 'blur(8px)',
        }}>
        <style>{`
          ${V2_FOCUS_STYLE}
          .romm-modal-collapse, .romm-modal-collapse > div {
            background: transparent !important; border: none !important; box-shadow: none !important; padding: 0 !important;
          }
          @keyframes umIn { from { opacity: 0; transform: translateY(-6px) scale(0.98); } to { opacity: 1; transform: none; } }
        `}</style>
        <div onClick={() => closeModal?.()} style={{ position: 'absolute', inset: 0 }} />
        <Focusable noFocusRing autoFocus ref={panelRef} flow-children="vertical" style={{
          position: 'relative', width: '420px', maxWidth: '92vw', boxSizing: 'border-box',
          fontFamily: V2.font, color: V2.fg, padding: '8px',
          display: 'flex', flexDirection: 'column',
          background: 'linear-gradient(180deg, rgba(20,20,30,0.7) 0%, rgba(10,10,18,0.78) 100%)',
          WebkitBackdropFilter: 'blur(28px) saturate(1.1)', backdropFilter: 'blur(28px) saturate(1.1)',
          border: `1px solid rgba(255,255,255,0.12)`, borderRadius: V2.radiusCard,
          boxShadow: '0 16px 48px rgba(0,0,0,0.55)',
          maxHeight: '82vh', overflowY: 'auto',
          animation: 'umIn 0.18s cubic-bezier(0.22,1,0.36,1)',
        }}>
          {/* Header */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '11px', padding: '10px 10px 12px', minWidth: 0 }}>
            <div style={{
              flexShrink: 0, width: '34px', height: '34px', borderRadius: V2.radiusMd,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              background: V2.bgElevated, color: V2.brandHover,
            }}><FaPuzzlePiece size={16} /></div>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: '14px', fontWeight: 700, lineHeight: 1.3 }}>
                {done ? 'Core installed' : `${gap.platform_name} needs a core`}
              </div>
              <div style={{ fontSize: '11.5px', color: V2.fgMuted, marginTop: '2px' }}>
                {done
                  ? `${coreLabel(done)} is ready — start the game.`
                  : 'A core is the emulator that actually runs the game.'}
              </div>
            </div>
          </div>
          <div style={{ height: '1px', background: V2.border, margin: '0 4px 4px' }} />

          {failed && (
            <div style={{
              margin: '4px', padding: '9px 11px', borderRadius: V2.radiusMd,
              background: 'rgba(255,80,80,0.10)', color: V2.danger,
              fontSize: '11.5px', lineHeight: 1.4,
            }}>{failed}</div>
          )}

          {done ? (
            <UserMenuRow icon={<FaPlay size={14} />} label="Play now" onSelect={playNow} />
          ) : !gap.can_download ? (
            <div style={{ padding: '4px 12px 10px', fontSize: '12px', color: V2.fgMuted, lineHeight: 1.45 }}>
              {gap.download_reason
                || 'Cores cannot be installed from here. Add one in RetroArch, then try again.'}
            </div>
          ) : !gap.candidates.length ? (
            <div style={{ padding: '4px 12px 10px', fontSize: '12px', color: V2.fgMuted, lineHeight: 1.45 }}>
              No core for {gap.platform_name} is available from the libretro
              buildbot for this system. You can install one inside RetroArch and
              pick it in Settings ▸ Emulator Cores.
            </div>
          ) : (
            <>
              <CoreOption core={recommended} recommended busy={busy === recommended}
                disabled={!!busy} onSelect={() => install(recommended)} />
              {/* One or two alternatives are shorter than the row that would
                  hide them, so show them. Collapse only when the list is long
                  enough that it would bury the recommendation. */}
              {others.length > 0 && others.length <= INLINE_CORES && others.map((c) => (
                <CoreOption key={c} core={c} busy={busy === c} disabled={!!busy}
                  onSelect={() => install(c)} />
              ))}
              {others.length > INLINE_CORES && !showAll && (
                <UserMenuRow icon={<FaChevronRight size={13} />}
                  label={`Other cores (${others.length})`} disabled={!!busy}
                  onSelect={() => setShowAll(true)} />
              )}
              {others.length > INLINE_CORES && showAll && others.map((c) => (
                <CoreOption key={c} core={c} busy={busy === c} disabled={!!busy}
                  onSelect={() => install(c)} />
              ))}
              <div style={{ height: '1px', background: V2.border, margin: '4px' }} />
              <UserMenuRow icon={<FaCog size={14} />} label="Manage cores"
                disabled={!!busy}
                onSelect={() => { closeModal?.(); libNavigate('/romm-sync-cores'); }} />
            </>
          )}
        </Focusable>
      </Focusable>
    </ModalRoot>
  );
}

// One installable core in the picker: name, what it is, and its state.
function CoreOption({ core, recommended, busy, disabled, onSelect }:
  { core: string; recommended?: boolean; busy?: boolean; disabled?: boolean; onSelect: () => void }) {
  const [hot, setHot] = useState(false);
  return (
    <Focusable noFocusRing onActivate={() => !disabled && onSelect()} onClick={() => !disabled && onSelect()}
      onFocus={() => setHot(true)} onBlur={() => setHot(false)}
      onMouseEnter={() => setHot(true)} onMouseLeave={() => setHot(false)}
      style={{
        display: 'flex', alignItems: 'center', gap: '11px', padding: '9px 12px',
        borderRadius: V2.radiusMd, cursor: disabled ? 'default' : 'pointer',
        background: (hot && !disabled) ? V2.surfaceHover : 'transparent',
        transition: 'background 0.12s ease', opacity: disabled && !busy ? 0.55 : 1,
      }}>
      <div style={{ flexShrink: 0, width: '16px', display: 'flex', justifyContent: 'center', color: V2.fgMuted }}>
        {busy
          ? <FaSync size={13} style={{ animation: 'spin 1s linear infinite' }} />
          : <FaDownload size={13} />}
      </div>
      <div style={{ minWidth: 0, flex: '1 1 auto' }}>
        <div style={{ fontSize: '13.5px', fontWeight: 500, textTransform: 'capitalize' }}>
          {coreLabel(core)}
          {recommended && (
            <span style={{
              marginLeft: '7px', fontSize: '9.5px', fontWeight: 800, letterSpacing: '0.04em',
              textTransform: 'uppercase', color: V2.brandHover,
            }}>recommended</span>
          )}
        </div>
        <div style={{ fontSize: '10.5px', color: V2.fgFaint, marginTop: '1px' }}>
          {busy ? 'Installing…' : core}
        </div>
      </div>
    </Focusable>
  );
}

// Collection / platform actions menu, in the same v2 glass chrome as the
// account dropdown (UserMenuModal). Opened from the games-count rail. Holds
// "Sync/Download missing" and the destructive "Remove downloaded" (arm →
// confirm, matching the game-tile delete affordance).
function CollectionActionsModal({ title, isCollection, isVirtual, isSynced, missing, downloaded, syncing, onSyncMissing, onToggleSync, onRemove, closeModal }:
  {
    title: string; isCollection: boolean; isVirtual: boolean; isSynced: boolean;
    missing: number; downloaded: number; syncing: boolean;
    onSyncMissing: () => void; onToggleSync: () => void; onRemove: () => void; closeModal?: () => void;
  }) {
  const panelRef = useRef<HTMLDivElement>(null);
  const [armed, setArmed] = useState(false);
  useEffect(() => { const t = setTimeout(() => { if (panelRef.current) _forceGamepadFocus(panelRef.current); }, 60); return () => clearTimeout(t); }, []);
  useEffect(() => { if (!armed) return; const t = setTimeout(() => setArmed(false), 4000); return () => clearTimeout(t); }, [armed]);

  const syncDisabled = syncing || missing === 0;
  const removeDisabled = downloaded === 0;
  return (
    <ModalRoot bHideCloseIcon onCancel={closeModal} onEscKeypress={closeModal}
      className="romm-modal-collapse" modalClassName="romm-modal-collapse">
      <Focusable noFocusRing className="romm-ui"
        onCancelButton={() => closeModal?.()}
        onButtonDown={(e: any) => { if (e?.detail?.button === GamepadButton.CANCEL) closeModal?.(); }}
        style={{
          position: 'fixed', inset: 0, zIndex: 9999,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          background: 'rgba(7,7,15,0.45)',
          WebkitBackdropFilter: 'blur(8px)', backdropFilter: 'blur(8px)',
        }}>
        <style>{`
          ${V2_FOCUS_STYLE}
          .romm-modal-collapse, .romm-modal-collapse > div {
            background: transparent !important; border: none !important; box-shadow: none !important; padding: 0 !important;
          }
          @keyframes umIn { from { opacity: 0; transform: translateY(-6px) scale(0.98); } to { opacity: 1; transform: none; } }
        `}</style>
        <div onClick={() => closeModal?.()} style={{ position: 'absolute', inset: 0 }} />
        <Focusable noFocusRing autoFocus ref={panelRef} flow-children="vertical" style={{
          position: 'relative', width: '270px', maxWidth: '90vw', boxSizing: 'border-box',
          fontFamily: V2.font, color: V2.fg, padding: '8px',
          display: 'flex', flexDirection: 'column',
          background: 'linear-gradient(180deg, rgba(20,20,30,0.7) 0%, rgba(10,10,18,0.78) 100%)',
          WebkitBackdropFilter: 'blur(28px) saturate(1.1)', backdropFilter: 'blur(28px) saturate(1.1)',
          border: `1px solid rgba(255,255,255,0.12)`, borderRadius: V2.radiusCard,
          boxShadow: '0 16px 48px rgba(0,0,0,0.55)',
          maxHeight: '82vh', overflowY: 'auto',
          animation: 'umIn 0.18s cubic-bezier(0.22,1,0.36,1)',
        }}>
          {/* Header — collection/platform name. */}
          <div style={{
            fontSize: '11px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em',
            color: V2.fgMuted, padding: '6px 8px 10px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
          }}>{title}</div>
          <div style={{ height: '1px', background: V2.border, margin: '0 4px 4px' }} />
          <UserMenuRow
            icon={syncing ? <FaSync size={14} style={{ animation: 'spin 1s linear infinite' }} /> : <FaDownload size={14} />}
            label={`Download missing${missing ? ` (${missing})` : ''}`}
            disabled={syncDisabled}
            onSelect={() => { if (syncDisabled) return; closeModal?.(); onSyncMissing(); }} />
          <UserMenuRow icon={<FaRegClock size={14} />} label="View downloads"
            onSelect={() => { closeModal?.(); libNavigate("/romm-sync-downloads"); }} />
          {/* Auto-sync toggle — collections only (platforms have no continuous
              sync; virtual collections aren't tracked by the sync manager). */}
          {isCollection && !isVirtual && (
            <UserMenuRow
              icon={<FaSync size={14} />}
              label={isSynced ? 'Disable auto-sync' : 'Enable auto-sync'}
              onSelect={() => { closeModal?.(); onToggleSync(); }} />
          )}
          {!isVirtual && (
            <>
              <div style={{ height: '1px', background: V2.border, margin: '4px 4px' }} />
              <UserMenuRow
                icon={armed ? <FaCheck size={14} /> : <FaTrash size={14} />}
                label={armed ? 'Confirm remove' : `Remove downloaded${downloaded ? ` (${downloaded})` : ''}`}
                danger disabled={removeDisabled}
                onSelect={() => {
                  if (removeDisabled) return;
                  if (!armed) { setArmed(true); return; }
                  setArmed(false); closeModal?.(); onRemove();
                }} />
            </>
          )}
        </Focusable>
      </Focusable>
    </ModalRoot>
  );
}

// True on viewports with top-bar room to spare (external monitor / desktop Big
// Picture). The Deck's 1280×800 stays false — there the download glimpse must
// not add width, so it lives on the avatar instead of a separate chip.
function useWideTopBar(): boolean {
  const [wide, setWide] = useState(() => {
    try { return window.matchMedia('(min-width: 1440px)').matches; } catch { return false; }
  });
  useEffect(() => {
    try {
      const mq = window.matchMedia('(min-width: 1440px)');
      const l = (e: any) => setWide(e.matches);
      mq.addEventListener('change', l);
      return () => mq.removeEventListener('change', l);
    } catch { /* ignore */ }
  }, []);
  return wide;
}

// Wide-viewport download glimpse: a dedicated pill next to the user pill with a
// progress ring, active count and aggregate percent. Opens the Downloads page.
// Only rendered while something is downloading (and only on wide top bars).
function DownloadChip({ count, pct }: { count: number; pct: number | null }) {
  const [active, setActive] = useState(false);
  const open = () => libNavigate("/romm-sync-downloads");
  return (
    <Focusable noFocusRing onActivate={open} onClick={open}
      onFocus={() => setActive(true)} onBlur={() => setActive(false)}
      onMouseEnter={() => setActive(true)} onMouseLeave={() => setActive(false)}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: '7px',
        background: active ? 'rgba(255,255,255,0.10)' : V2.surface,
        border: `1px solid ${active ? V2.brand : V2.borderStrong}`,
        boxShadow: active ? `0 0 0 1px ${V2.brand}` : 'none',
        borderRadius: V2.radiusPill, padding: '3px 12px 3px 5px',
        color: V2.fg, cursor: 'pointer', transition: 'background 0.15s ease, border-color 0.15s ease, box-shadow 0.15s ease',
      }}>
      <ProgressRing pct={pct} size={26} stroke={2.5}>
        <FaDownload size={10} style={{ color: V2.fg2 }} />
      </ProgressRing>
      <span style={{ fontSize: '12.5px', fontWeight: 600, whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' }}>
        {count}{pct != null ? ` · ${Math.round(pct)}%` : ''}
      </span>
    </Focusable>
  );
}

// The account menu pill. Click/A opens the RomM-styled account dropdown.
// `glimpse` false suppresses the avatar download ring (a separate DownloadChip
// is showing it instead on wide top bars).
function UserPill({ username, role, avatar, glimpse = true }:
  { username: string; role: string; avatar: string | null; glimpse?: boolean }) {
  const [active, setActive] = useState(false);
  // Download glimpse: while anything is downloading, the avatar gains an
  // aggregate progress ring + count dot — zero extra top-bar width (the Deck's
  // bar is too tight for a separate chip).
  const dlRaw = useDownloadGlimpse();
  const dl = glimpse ? dlRaw : { count: 0, pct: null };
  const openMenu = () => showModal(
    <UserMenuModal username={username} role={role} avatar={avatar} />,
  );
  return (
    <Focusable noFocusRing onActivate={openMenu} onClick={openMenu}
      onFocus={() => setActive(true)} onBlur={() => setActive(false)}
      onMouseEnter={() => setActive(true)} onMouseLeave={() => setActive(false)}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: '8px',
        // Verified on-device: the old white tint was indistinguishable from the
        // resting surface on the Deck panel, so focus landing here (UP from the
        // first grid row) read as "selection disappeared". Brand ring instead.
        background: active ? 'rgba(255,255,255,0.10)' : V2.surface,
        border: `1px solid ${active ? V2.brand : V2.borderStrong}`,
        boxShadow: active ? `0 0 0 1px ${V2.brand}` : 'none',
        borderRadius: V2.radiusPill, padding: '3px 12px 3px 3px',
        color: V2.fg, cursor: 'pointer', transition: 'background 0.15s ease, border-color 0.15s ease, box-shadow 0.15s ease',
      }}>
      <div style={{ position: 'relative', flexShrink: 0 }}>
        {dl.count > 0 ? (
          <ProgressRing pct={dl.pct} size={30} stroke={2.5}>
            <UserAvatar username={username} avatar={avatar} size={24} />
          </ProgressRing>
        ) : (
          <UserAvatar username={username} avatar={avatar} size={30} />
        )}
        {dl.count > 0 && (
          <span style={{
            position: 'absolute', top: '-3px', right: '-3px',
            minWidth: '13px', height: '13px', padding: '0 3px', boxSizing: 'border-box',
            borderRadius: '7px', background: V2.brand, color: '#fff',
            fontSize: '8.5px', fontWeight: 700, lineHeight: '13px', textAlign: 'center',
            border: '1.5px solid rgba(10,10,18,0.9)',
          }}>{dl.count}</span>
        )}
      </div>
      {/* Placeholder bar while the account is still loading, so the pill keeps
          its shape instead of collapsing and then jumping to full width. */}
      {username
        ? <span style={{ fontSize: '13px', fontWeight: 500, whiteSpace: 'nowrap' }}>{username}</span>
        : <span style={{
            width: '58px', height: '9px', borderRadius: '5px',
            background: V2.bgElevated, opacity: 0.7,
          }} />}
      <FaChevronDown size={11} style={{ color: V2.fgMuted }} />
    </Focusable>
  );
}

// Bumper keycap hint (L1 / R1) flanking the nav pill — signals that the
// shoulder buttons page through the tabs.
function Bumper({ label }: { label: string }) {
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
      fontSize: '10px', fontWeight: 700, letterSpacing: '0.03em', color: V2.fg2,
      padding: '3px 8px', borderRadius: V2.radiusChip, background: V2.surface,
      border: `1px solid ${V2.borderStrong}`, boxShadow: '0 1px 2px rgba(0,0,0,0.4)',
      lineHeight: 1, whiteSpace: 'nowrap',
    }}>{label}</span>
  );
}

// RomM RTabNav "underlined" variant — tabs over a bottom border with a 2px
// brand underline that slides between the active tab (GameDetails tab strip).
function V2TabNav({ tabs, active, onTab }:
  { tabs: { id: string; label: string }[]; active: string; onTab: (id: string) => void }) {
  const refs = useRef<(HTMLDivElement | null)[]>([]);
  const [ind, setInd] = useState<{ left: number; width: number } | null>(null);
  const idx = tabs.findIndex((t) => t.id === active);
  useEffect(() => {
    const el = refs.current[idx];
    if (el) setInd({ left: el.offsetLeft, width: el.offsetWidth });
  }, [idx, tabs.length]);
  return (
    // Deliberately NOT gamepad-focusable: tabs switch with L1/R1 only (the
    // Bumper hints render beside the strip), so the dpad walks straight from
    // the action buttons into the tab CONTENT without stepping through pills.
    // The labels stay clickable for touch/mouse.
    <div style={{ position: 'relative', display: 'flex', gap: '2px', borderBottom: `1px solid ${V2.borderStrong}` }}>
      {tabs.map((t, i) => {
        const on = active === t.id;
        return (
          <div key={t.id} onClick={() => onTab(t.id)} ref={(el) => { refs.current[i] = el; }}
            style={{
              padding: '8px 18px', fontSize: '13px', cursor: 'pointer',
              fontWeight: 500, color: on ? V2.fg : V2.fgMuted, transition: 'color 0.15s ease',
            }}>
            {t.label}
          </div>
        );
      })}
      {ind && (
        <div style={{
          position: 'absolute', bottom: '-1px', height: '2px', borderRadius: '2px 2px 0 0',
          left: `${ind.left}px`, width: `${ind.width}px`, background: V2.brand,
          transition: 'left 0.25s cubic-bezier(0.22,1,0.36,1), width 0.25s cubic-bezier(0.22,1,0.36,1)',
        }} />
      )}
    </div>
  );
}

// RomM RBtn language: 8px rounded-rect (not a pill), three tones — filled
// brand (primary CTA), translucent surface (tonal), and bare text. Focus/hover
// brightens + paints the brand ring (matches RBtn's currentColor overlay +
// focus glow).
function V2Button({ children, onClick, variant = 'tonal', color, disabled }:
  { children: any; onClick: () => void; variant?: 'primary' | 'danger' | 'tonal' | 'text'; color?: string; disabled?: boolean }) {
  const [active, setActive] = useState(false);
  const base: any = {
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: '8px',
    height: '36px', padding: '0 16px', borderRadius: V2.radiusMd, fontSize: '14px',
    fontWeight: 600, whiteSpace: 'nowrap', border: '1px solid transparent',
    cursor: disabled ? 'default' : 'pointer', opacity: disabled ? 0.5 : 1,
    transition: 'background 0.15s, box-shadow 0.15s, filter 0.15s',
  };
  const tone =
    variant === 'primary' ? { background: V2.brand, color: '#fff' }
      : variant === 'danger' ? { background: V2.danger, color: '#fff' }
        : variant === 'tonal' ? { background: V2.surface, color: color || V2.fg, border: `1px solid ${V2.border}` }
          : { background: 'transparent', color: color || V2.fg2 };
  const glow = active && !disabled
    ? { boxShadow: `0 0 0 2px ${V2.brand}`, filter: 'brightness(1.12)' }
    : {};
  return (
    <Focusable noFocusRing
      className="romm-btn"
      onActivate={() => !disabled && onClick()}
      onClick={() => !disabled && onClick()}
      onFocus={() => setActive(true)} onBlur={() => setActive(false)}
      onMouseEnter={() => setActive(true)} onMouseLeave={() => setActive(false)}
      style={{ ...base, ...tone, ...glow }}
    >
      {children}
    </Focusable>
  );
}

// GameActionButton — RomM's GameActionBtn vocabulary (the action ribbon in the
// GameDetails header), distinct from V2Button's RBtn rounded-rect. Two shapes:
//   • emphasized + label → white pill CTA (#fff / #111117), used by Play / the
//     primary Download (overlay-emphasis tokens).
//   • surface, icon-only  → circular translucent-grey glass button matching the
//     page background (RTag tokens); used for Delete / secondary actions.
// `danger` is a filled-danger pill for the delete-confirm step. Pill radius
// throughout; controller focus paints a brand ring + slight scale.
function GameActionButton({ icon, label, onClick, variant = 'surface', accent, disabled, progress, progressColor,
  onOptionsButton, optionsHint, focusRef, onFocused, onBlurred }:
  {
    icon: any; label?: string; onClick: () => void;
    variant?: 'emphasized' | 'surface' | 'danger'; accent?: 'danger'; disabled?: boolean;
    progress?: number | null; progressColor?: string; onOptionsButton?: () => void; optionsHint?: boolean;
    focusRef?: React.MutableRefObject<any>;
    onFocused?: () => void; onBlurred?: () => void;
  }) {
  const [active, setActive] = useState(false);
  const labelled = !!label;
  const hasProgress = typeof progress === 'number';
  const pct = hasProgress ? Math.max(0, Math.min(100, progress as number)) : 0;
  // One-shot width "pop" when a download begins: as the label grows from
  // "Download" to "Downloading… 0%", the button overshoots wider then settles.
  const [pop, setPop] = useState(false);
  const wasProg = useRef(false);
  useEffect(() => {
    if (hasProgress && !wasProg.current) {
      wasProg.current = true;
      setPop(true);
      const t = setTimeout(() => setPop(false), 480);
      return () => clearTimeout(t);
    }
    if (!hasProgress) wasProg.current = false;
  }, [hasProgress]);
  const base: any = {
    position: 'relative', overflow: 'hidden',
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: '8px',
    height: '44px', borderRadius: V2.radiusPill, fontSize: '14px', fontWeight: 600,
    whiteSpace: 'nowrap', border: '1px solid transparent',
    cursor: disabled ? 'default' : 'pointer', opacity: disabled ? 0.5 : 1,
    ...(labelled ? { padding: '0 24px' } : { width: '44px' }),
    transition: 'background 0.15s, color 0.15s, transform 0.15s, box-shadow 0.15s, border-color 0.15s',
    // Grow rightward from the left edge as the label widens — no overshoot.
    ...(pop ? { animation: 'dlGrow 0.4s ease', transformOrigin: 'left center' } : {}),
  };
  // Danger-accented surface (Delete): red icon + red-tinted surface/border that
  // intensifies on focus, so it reads as destructive without being a filled CTA.
  const dangerSurface = accent === 'danger';
  const tone =
    variant === 'emphasized'
      ? { background: active ? '#e6e6e6' : '#ffffff', color: '#111117', borderColor: '#ffffff' }
      : variant === 'danger'
        ? { background: V2.danger, color: '#fff', borderColor: V2.danger }
        : dangerSurface
          ? {
            background: active ? 'rgba(255,80,80,0.18)' : 'rgba(255,80,80,0.10)',
            color: V2.danger, borderColor: active ? V2.danger : 'rgba(255,80,80,0.40)'
          }
          : {
            background: active ? V2.surfaceHover : V2.surface,
            color: active ? V2.fg : V2.fg2, borderColor: V2.borderStrong
          };
  const ring = dangerSurface ? V2.danger : V2.brand;
  const glow = active && !disabled ? { boxShadow: `0 0 0 2px ${ring}` } : {};
  return (
    <Focusable noFocusRing ref={focusRef}
      onActivate={() => !disabled && onClick()}
      onClick={() => !disabled && onClick()}
      onOptionsButton={onOptionsButton ? () => !disabled && onOptionsButton() : undefined}
      onOptionsActionDescription={onOptionsButton ? 'Select disc' : undefined}
      onFocus={() => { setActive(true); onFocused?.(); }} onBlur={() => { setActive(false); onBlurred?.(); }}
      onMouseEnter={() => setActive(true)} onMouseLeave={() => setActive(false)}
      style={{ ...base, ...tone, ...glow }}
    >
      {/* Download fill — a brand-tinted bar sweeping left→right behind the
          label, tracking the live download percentage. */}
      {hasProgress && (
        <div style={{
          position: 'absolute', left: 0, top: 0, bottom: 0, width: `${pct}%`,
          background: progressColor
            ? progressColor
            : variant === 'emphasized' ? 'rgba(139,116,232,0.30)' : 'rgba(139,116,232,0.45)',
          // Smoothly sweep the semi-transparent fill across the white button, and
          // fade it in on the first frame so the colour change is animated too.
          transition: 'width 0.45s cubic-bezier(0.22,1,0.36,1), background 0.3s ease',
          animation: 'dlFillIn 0.3s ease', pointerEvents: 'none',
        }} />
      )}
      <span style={{ position: 'relative', zIndex: 1, display: 'inline-flex', alignItems: 'center', gap: '8px' }}>
        {icon}
        {label && <span>{label}</span>}
        {optionsHint && (
          <span style={{
            marginLeft: '2px', fontSize: '11px', fontWeight: 700, lineHeight: 1,
            padding: '2px 5px', borderRadius: '6px',
            background: variant === 'emphasized' ? 'rgba(17,17,23,0.12)' : V2.surfaceHover,
            color: variant === 'emphasized' ? '#111117' : V2.fgMuted,
          }}>Y</span>
        )}
      </span>
      <style>{`
        @keyframes dlGrow { from { transform: scaleX(0.72); } to { transform: scaleX(1); } }
        @keyframes dlValIn { from { opacity: 0; transform: translateX(-6px); } to { opacity: 1; transform: translateX(0); } }
        @keyframes dlFillIn { from { opacity: 0; } to { opacity: 1; } }
      `}</style>
    </Focusable>
  );
}

// ── GameDetails sub-components (faithful to RomM's OverviewTab / MetadataTab) ──

// Uppercase eyebrow heading for an overview section (RomM
// .overview-tab__section-heading).
function SectionHeading({ icon, children }: { icon?: any; children: any }) {
  return (
    <div style={{
      display: 'inline-flex', alignItems: 'center', gap: '6px', margin: 0,
      fontSize: '11px', fontWeight: 700, letterSpacing: '0.1em',
      textTransform: 'uppercase', color: V2.fgFaint,
    }}>
      {icon}{children}
    </div>
  );
}

// PlayerCountBadge — pill with a player icon whose glyph scales with the
// max player count parsed from the free-form string (RomM PlayerCountBadge).
function PlayerCountBadge({ value }: { value: string }) {
  const nums = (value.match(/\d+/g) || []).map(Number);
  const n = nums.length ? Math.max(...nums) : null;
  const label = n === 1 ? 'Single player' : (n && n > 1) ? `${value} players` : value;
  return (
    <div style={{
      display: 'inline-flex', alignItems: 'center', gap: '8px', padding: '5px 12px 5px 10px',
      background: V2.surface, border: `1px solid ${V2.borderStrong}`, borderRadius: V2.radiusPill,
      fontSize: '12px', color: V2.fg2,
    }}>
      <FaUsers size={14} color={V2.brand} />
      <span style={{ fontWeight: 600, letterSpacing: '0.01em' }}>{label}</span>
    </div>
  );
}

// AgeRatingBadges — 44px icon badges from the IGDB rating-icon CDN (loaded
// directly), falling back to a shield text chip when the icon 404s (RomM
// AgeRatingBadges).
function AgeRatingBadge({ item }: { item: { category: string; rating: string; icon_url: string | null } }) {
  const [failed, setFailed] = useState(false);
  const label = item.category ? `${item.category}: ${item.rating}` : item.rating;
  if (item.icon_url && !failed) {
    return <img src={item.icon_url} alt={label} title={label} loading="lazy"
      onError={() => setFailed(true)}
      style={{
        width: '44px', height: '44px', objectFit: 'contain', borderRadius: V2.radiusSm,
        background: V2.surface, padding: '3px', border: `1px solid ${V2.border}`
      }} />;
  }
  return (
    <span title={label} style={{
      display: 'inline-flex', alignItems: 'center', gap: '5px', padding: '4px 10px',
      background: V2.surface, border: `1px solid ${V2.borderStrong}`, borderRadius: V2.radiusChip,
      fontSize: '11.5px', fontWeight: 600, color: V2.fg2, letterSpacing: '0.02em',
    }}>🛡 {label}</span>
  );
}
function AgeRatingBadges({ items }: { items: any[] }) {
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '10px', alignItems: 'center' }}>
      {items.map((b, i) => <AgeRatingBadge key={i} item={b} />)}
    </div>
  );
}

// HLTBStrip — up to four columns (main story / +extra / completionist / all
// styles). Durations are seconds → hours rounded to 0.5h (RomM HLTBStrip).
function HLTBStrip({ hltb }: { hltb: any }) {
  const fmtHours = (secs?: number | null): string | null => {
    if (!secs || secs <= 0) return null;
    const hours = secs / 3600;
    if (hours < 1) { const m = Math.round(secs / 60); return m > 0 ? `${m}m` : null; }
    return `${Math.round(hours * 2) / 2}h`;
  };
  const candidates: [string, number | undefined, number | undefined][] = [
    ['Main Story', hltb?.main_story, hltb?.main_story_count],
    ['Main + Extra', hltb?.main_plus_extra, hltb?.main_plus_extra_count],
    ['Completionist', hltb?.completionist, hltb?.completionist_count],
    ['All Styles', hltb?.all_styles, hltb?.all_styles_count],
  ];
  const entries = candidates
    .map(([label, v, c]) => ({ label, value: fmtHours(v), count: c }))
    .filter((e) => e.value);
  if (!entries.length) return null;
  return (
    <div style={{
      display: 'flex', alignItems: 'stretch', background: V2.bgElevated,
      border: `1px solid ${V2.border}`, borderRadius: V2.radiusLg, padding: '14px 0', maxWidth: '720px',
    }}>
      {entries.map((e, i) => (
        <div key={e.label} style={{
          flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '4px',
          padding: '0 12px', borderRight: i < entries.length - 1 ? `1px solid ${V2.border}` : 'none',
        }}>
          <div style={{ fontSize: '10px', fontWeight: 700, letterSpacing: '0.07em', textTransform: 'uppercase', color: V2.fgFaint, textAlign: 'center' }}>{e.label}</div>
          <div style={{ fontSize: '20px', fontWeight: 700, color: V2.fg }}>{e.value}</div>
          {e.count ? <div style={{ fontSize: '10px', color: V2.fgFaint }}>{e.count.toLocaleString()} players</div> : null}
        </div>
      ))}
    </div>
  );
}

// InfoGrid — two-column section grid; each section is icon + uppercase label
// over a row of chips (RomM InfoGrid).
function InfoGrid({ sections }: { sections: { label: string; items: string[]; icon?: any }[] }) {
  const visible = sections.filter((s) => s.items.length > 0);
  if (!visible.length) return null;
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, auto))', gap: '18px 24px', width: '100%' }}>
      {visible.map((s) => (
        <div key={s.label}>
          <div style={{
            display: 'inline-flex', alignItems: 'center', gap: '6px', marginBottom: '8px',
            fontSize: '10.5px', fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: V2.fgFaint,
          }}>
            {s.icon && <span style={{ color: V2.brand, display: 'inline-flex' }}>{s.icon}</span>}
            <span>{s.label}</span>
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
            {s.items.map((it, i) => (
              <span key={i} style={{
                background: V2.surface, border: `1px solid ${V2.borderStrong}`, borderRadius: V2.radiusChip,
                padding: '4px 10px', fontSize: '11.5px', fontWeight: 500, color: V2.fg2,
              }}>{it}</span>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

// RelatedGameCard — static cover tile using IGDB's external cover URL (loads
// directly, no auth). Cover + truncated label, focus lift (RomM RelatedGameCard
// in GameCard static mode). Non-navigating (synthetic).
function RelatedGameCard({ game }: { game: { id: number; name: string; cover_url?: string | null } }) {
  const [focused, setFocused] = useState(false);
  // IGDB thumb URLs are tiny (t_thumb); request the bigger cover art variant.
  const cover = game.cover_url ? game.cover_url.replace('/t_thumb/', '/t_cover_big/') : null;
  return (
    <Focusable noFocusRing
      onFocus={() => setFocused(true)} onBlur={() => setFocused(false)}
      onMouseEnter={() => setFocused(true)} onMouseLeave={() => setFocused(false)}
      style={{ width: '110px', flexShrink: 0, display: 'flex', flexDirection: 'column', gap: '6px', cursor: 'default' }}
    >
      <div style={{
        width: '100%', aspectRatio: '3 / 4', borderRadius: V2.radiusArt, overflow: 'hidden',
        background: V2.coverPlaceholder, display: 'flex', alignItems: 'center', justifyContent: 'center',
        transform: 'scale(1)', transition: 'transform 0.18s ease, box-shadow 0.18s ease',
        ...V2Focus.tile(focused),
      }}>
        {cover
          ? <img src={cover} style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
          : <span style={{ color: V2.fgMuted, fontSize: '10px', padding: '0 6px', textAlign: 'center' }}>{game.name}</span>}
      </div>
      <div style={{
        fontSize: '11px', color: focused ? V2.fg : V2.fg2, textAlign: 'center',
        whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
      }}>{game.name}</div>
    </Focusable>
  );
}

// One related-games section: eyebrow heading + flex-wrap row of cards.
function RelatedSection({ icon, title, items }: { icon: any; title: string; items: any[] }) {
  if (!items?.length) return null;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
      <SectionHeading icon={icon}>{title}</SectionHeading>
      <Focusable noFocusRing flow-children="horizontal" style={{ display: 'flex', flexWrap: 'wrap', gap: '14px 16px', padding: '6px 6px 4px' }}>
        {items.map((g) => <RelatedGameCard key={g.id ?? g.name} game={g} />)}
      </Focusable>
    </div>
  );
}

// Metadata-provider registry (RomM providers.ts): id field · brand colour ·
// logo asset · external URL builder.
const PROVIDERS: { key: string; name: string; color: string; logo: string; url: ((id: any) => string) | null }[] = [
  { key: 'igdb_id', name: 'IGDB', color: '#6366f1', logo: '/assets/scrappers/igdb.png', url: (id) => `https://www.igdb.com/search?type=1&q=${id}` },
  { key: 'moby_id', name: 'MobyGames', color: '#f59e0b', logo: '/assets/scrappers/moby.png', url: (id) => `https://www.mobygames.com/game/${id}/` },
  { key: 'ss_id', name: 'ScreenScraper', color: '#3b82f6', logo: '/assets/scrappers/ss.png', url: (id) => `https://www.screenscraper.fr/gameinfos.php?gameid=${id}` },
  { key: 'ra_id', name: 'RetroAchievements', color: '#ef4444', logo: '/assets/scrappers/ra.png', url: (id) => `https://retroachievements.org/game/${id}` },
  { key: 'sgdb_id', name: 'SteamGridDB', color: '#0ea5e9', logo: '/assets/scrappers/sgdb.png', url: (id) => `https://www.steamgriddb.com/game/${id}` },
  { key: 'launchbox_id', name: 'LaunchBox', color: '#8b5cf6', logo: '/assets/scrappers/launchbox.png', url: (id) => `https://gamesdb.launchbox-app.com/games/dbid/${id}` },
  { key: 'hasheous_id', name: 'Hasheous', color: '#6b7280', logo: '/assets/scrappers/hasheous.png', url: null },
  { key: 'flashpoint_id', name: 'Flashpoint Archive', color: '#f97316', logo: '/assets/scrappers/flashpoint.png', url: null },
  { key: 'hltb_id', name: 'HowLongToBeat', color: '#22c55e', logo: '/assets/scrappers/hltb.png', url: (id) => `https://howlongtobeat.com/game/${id}` },
];

// ProviderCard — logo + name + linked id (or "Not linked"); clickable when a
// URL resolves. Logo is base64'd via get_image (RomM-served asset).
function ProviderCard({ p, id }: { p: typeof PROVIDERS[number]; id: any }) {
  const [focused, setFocused] = useState(false);
  const logo = useRommImage(p.logo);
  const linked = id !== null && id !== undefined && id !== '' && id !== 0;
  const href = linked && p.url ? p.url(id) : null;
  const open = () => { if (href) try { Navigation?.NavigateToExternalWeb?.(href); } catch { /* ignore */ } };
  return (
    <Focusable noFocusRing
      onActivate={open} onClick={open}
      onFocus={() => setFocused(true)} onBlur={() => setFocused(false)}
      onMouseEnter={() => setFocused(true)} onMouseLeave={() => setFocused(false)}
      style={{
        display: 'flex', flexDirection: 'column', gap: '6px', padding: '12px 14px',
        background: V2.bgElevated, borderRadius: V2.radiusMd, color: V2.fg,
        border: `1px solid ${focused && href ? p.color : V2.border}`,
        opacity: linked ? 1 : 0.55, cursor: href ? 'pointer' : 'default',
        transform: focused && href ? 'translateY(-1px)' : 'none',
        transition: 'background 0.15s, border-color 0.15s, transform 0.15s',
      }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
        {logo && <img src={logo} alt={p.name} style={{ width: '16px', height: '16px', objectFit: 'contain', borderRadius: '2px' }} />}
        <span style={{ flex: 1, fontSize: '12.5px', fontWeight: 600, color: V2.fg }}>{p.name}</span>
        {href && <FaExternalLinkAlt size={11} color={V2.fgMuted} />}
      </div>
      <div style={{ fontSize: '11.5px', color: V2.fg2, fontVariantNumeric: 'tabular-nums' }}>
        {linked ? String(id) : <span style={{ fontStyle: 'italic', color: V2.fgFaint }}>Not linked</span>}
      </div>
    </Focusable>
  );
}

// MetadataTab — file info · hashes (click-to-copy) · verification tags ·
// provider grid (RomM MetadataTab).
function MetadataTab({ detail }: { detail: any }) {
  const providers = detail?.providers || {};
  const ordered = [...PROVIDERS].sort((a, b) => {
    const av = providers[a.key] ? 1 : 0, bv = providers[b.key] ? 1 : 0;
    return bv - av;
  });
  const hashes = detail?.hashes || {};
  const hashRows: [string, string | null][] = [
    ['CRC', hashes.crc], ['MD5', hashes.md5], ['SHA1', hashes.sha1], ['RA', hashes.ra],
  ];
  const copy = (v: string) => { try { navigator.clipboard?.writeText(v); toaster.toast({ title: 'Copied', body: v }); } catch { /* ignore */ } };
  const heading = (txt: string) => (
    <div style={{ fontSize: '13px', fontWeight: 600, color: V2.fg }}>{txt}</div>
  );
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
      {/* File info */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
        {heading('File info')}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: '12px 24px' }}>
          {[['Filename', detail?.fs_name || '—'], ['Size', detail?.fs_size_bytes ? fmtBytes(detail.fs_size_bytes) : '—']].map(([l, v]) => (
            <div key={l as string} style={{ display: 'flex', flexDirection: 'column', gap: '4px', minWidth: 0 }}>
              <div style={{ fontSize: '10.5px', fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: V2.fgFaint }}>{l}</div>
              <div style={{ fontSize: '13px', color: V2.fg2, wordBreak: 'break-all' }}>{v}</div>
            </div>
          ))}
        </div>
      </div>
      {/* Hashes */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
        {heading('Hashes')}
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', alignItems: 'center' }}>
          {hashRows.map(([label, val]) => (
            <Focusable key={label} noFocusRing
              onActivate={() => val && copy(val)} onClick={() => val && copy(val)}
              style={{
                display: 'inline-flex', alignItems: 'center', gap: '6px', padding: '4px 10px',
                background: V2.surface, border: `1px solid ${V2.borderStrong}`, borderRadius: V2.radiusChip,
                fontSize: '11.5px', cursor: val ? 'pointer' : 'default',
              }}>
              <span style={{ fontWeight: 700, color: V2.fgFaint, letterSpacing: '0.06em' }}>{label}</span>
              <span style={{ fontFamily: 'monospace', color: val ? V2.fg2 : V2.fgFaint }}>
                {val ? `${String(val).slice(0, 8)}…` : '—'}
              </span>
            </Focusable>
          ))}
        </div>
      </div>
      {/* Verification */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
        {heading('Verification')}
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', alignItems: 'center' }}>
          {(detail?.verifications || []).map((v: any) => (
            <span key={v.label} style={{
              display: 'inline-flex', alignItems: 'center', gap: '5px', padding: '4px 10px',
              borderRadius: V2.radiusChip, fontSize: '11.5px', fontWeight: 600,
              background: v.match ? 'rgba(74,222,128,0.12)' : V2.surface,
              border: `1px solid ${v.match ? 'rgba(74,222,128,0.4)' : V2.borderStrong}`,
              color: v.match ? V2.success : V2.fgMuted,
            }}>{v.match ? <FaCheckCircle size={12} /> : <FaTimes size={12} />}{v.label}</span>
          ))}
        </div>
      </div>
      {/* Provider links */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
        {heading('Metadata sources')}
        <Focusable noFocusRing style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: '10px' }}>
          {ordered.map((p) => <ProviderCard key={p.key} p={p} id={providers[p.key]} />)}
        </Focusable>
      </div>
    </div>
  );
}

// Module-level holders pass the selection between Game Browser routes without
// re-fetching (same pattern as _historyGameHolder).
let _libGroupHolder: { mode: string; group: LibGroup } | null = null;
// Sibling groups (same mode) so the game grid can page prev/next with L1/R1.
let _libGroupsHolder: { mode: string; groups: LibGroup[] } | null = null;
let _libGameHolder: LibGame | null = null;
// Route to return to when backing out of the game detail page. Steam's default
// NavigateBack on these custom Decky routes drops to the home/library root, so
// we navigate to the explicit origin route instead (set wherever a game opens).
let _libGameOrigin: string = "/romm-sync-library";
// Remember which library tab the user was on, so backing out of a games page
// returns to that tab (platforms/collections) instead of resetting to 'home'.
let _libLastTab: NavId = 'home';

// ── History-aware back navigation ────────────────────────────────────────────
// Navigation.Navigate always PUSHES a history entry. Backing out of our pages
// by pushing the origin route filled the router history with /romm-sync-*
// entries, so after leaving the plugin, B in Steam's OWN library popped that
// polluted stack and dragged the user back into the plugin (endless loop).
// The fix is to genuinely POP our entries. The Gamepad UI's react-router
// history is undocumented but reachable; everything is feature-detected with
// the old push as fallback.
const _gpHistory = (): any => {
  try { return (Router as any)?.WindowStore?.GamepadUIMainWindowInstance?.m_history; }
  catch { return undefined; }
};
// Timestamp of the last pop WE initiated. RouteGuard uses it to tell "the user
// backed out of a plugin page" (expected — render normally) apart from "Steam's
// own back walked into a plugin history entry" (unexpected — keep popping).
let _expectedPopAt = 0;
// Pop one history entry: react-router v5 history has goBack(), the newer
// history lib has back(); Steam's native NavigateBack as a last resort.
function _histBack(h: any): boolean {
  try {
    if (typeof h?.goBack === 'function') { h.goBack(); return true; }
    if (typeof h?.back === 'function') { h.back(); return true; }
  } catch { /* ignore */ }
  try { Navigation.NavigateBack(); return true; } catch { /* ignore */ }
  return false;
}
// Back out of a plugin page by genuinely POPPING the router history (pushing
// the origin route instead is what polluted the history and made Steam's own
// B walk back into the plugin). The entry below is the page that pushed us —
// a plugin page or, for e.g. Settings opened from the QAM, the Steam page the
// user was on; both are correct destinations.
function navBack(fallback: string) {
  _expectedPopAt = Date.now();
  if (!_histBack(_gpHistory())) {
    try { Navigation.Navigate(fallback); } catch { /* ignore */ }
  }
}
// B at the library root: leave the plugin with an UNEXPECTED pop — if the
// entry below is another plugin page (e.g. stale entries left by an earlier
// visit or a pre-update build), its RouteGuard keeps the cascade going until
// a real Steam page is on top.
function navExitPlugin() {
  _expectedPopAt = 0;
  _histBack(_gpHistory());
}

// ── In-library view switching (route-level keep-alive) ───────────────────────
// Steam's router unmounts a route's entire tree on navigation, so every trip
// into a platform grid / game detail / settings used to rebuild the four
// keep-alive tab panels on the way back (~100–200ms of long tasks plus a
// cover re-decode burst). Instead of leaving /romm-sync-library at all, the
// inner pages now mount as views INSIDE that route (LibraryRootPage) while
// the tabs tree stays mounted hidden underneath — same display:none trick
// that made tab switching instant, extended one level up.
// These module hooks are only set while LibraryRootPage is mounted; when they
// are null (e.g. Settings opened from the QAM as a real route) callers fall
// back to genuine navigation, preserving the old behavior.
type LibView = 'grid' | 'game' | 'settings' | 'stats' | 'cores' | 'downloads';
let _libPushView: ((v: LibView) => void) | null = null;
let _libPopView: (() => void) | null = null;
const _libViewForRoute: Record<string, LibView> = {
  '/romm-sync-settings': 'settings',
  '/romm-sync-stats': 'stats',
  '/romm-sync-cores': 'cores',
  '/romm-sync-downloads': 'downloads',
};
// Open a plugin page: as an in-library view when the library route hosts us,
// as a real route otherwise (QAM entry points, stale fallbacks).
function libNavigate(route: string) {
  const v = _libViewForRoute[route];
  if (v && _libPushView) { _libPushView(v); return; }
  try { Navigation.Navigate(route); } catch { /* ignore */ }
}
// Back out of a plugin page: pop the in-library view stack when hosted,
// otherwise genuinely pop the router history.
function libBack(fallback: string) {
  if (_libPopView) { _libPopView(); return; }
  navBack(fallback);
}
// Wraps every plugin route. A plugin page entered via a history POP we did not
// initiate means Steam's back navigation surfaced one of our history entries
// (possibly stale, from before a plugin update) — immediately pop again, so B
// cascades through plugin entries and always lands on a real Steam page. All
// intentional entries into the plugin arrive via PUSH and render normally.
function RouteGuard({ children }: { children: any }) {
  useEffect(() => {
    try {
      const h = _gpHistory();
      if (h?.action === 'POP') {
        if (Date.now() - _expectedPopAt < 1500) _expectedPopAt = 0;
        else _histBack(h);
      }
    } catch { /* ignore */ }
  }, []);
  return children;
}

// Play a Steam Deck UI sound (the same .wav files Big Picture / the Deck UI use
// for its own navigation). Steam serves them from the SP window's loopback host,
// so a plain Audio element reaches them. Everything is wrapped/swallowed: a
// missing file or a blocked autoplay must never break navigation. Elements are
// cached and cloned so rapid LB/RB presses can overlap instead of cutting off.
// The desktop app has no steamloopback.host, so its shell sets
// __ludoSoundBase to a backend route that serves the same files off the local
// Steam install; on the Deck the constant below is used unchanged.
const _navSoundCache: Record<string, HTMLAudioElement> = {};
function soundBase(): string {
  return (window as any).__ludoSoundBase || 'https://steamloopback.host/sounds/';
}
function playSteamSound(name: string) {
  try {
    let base = _navSoundCache[name];
    if (!base) {
      base = new Audio(`${soundBase()}${name}.wav`);
      base.preload = 'auto';
      _navSoundCache[name] = base;
    }
    const a = base.cloneNode(true) as HTMLAudioElement;
    a.volume = 1;
    void a.play?.();
  } catch { /* no audio → silent, never fatal */ }
}
// Per-group games cache (key: `${mode}:${groupKey}`) so paging to an already
// prefetched neighbour shows its covers instantly — the grid slides in with real
// content instead of popping in after an async fetch.
const _libGamesCache = new Map<string, LibGame[]>();

// Broadcast target for "the backend re-fetched from RomM, re-pull whatever's
// on screen now" (fired after a manual Refresh from the account menu). The
// Home/Groups panels stay mounted across tab switches (see below) and their
// silent-refresh effects don't re-run just because a modal closed on top of
// them, so without this a same-tab refresh would sit invisible until the
// user actually switched tabs.
const _libRefreshListeners = new Set<() => void>();
function _broadcastLibRefresh() { _libRefreshListeners.forEach((l) => { try { l(); } catch { } }); }

// Home tab data cache — survives tab-switch remounts so returning to Home paints
// instantly (then refreshes silently) instead of flashing "Loading…".
let _homeCache: {
  recent: LibGame[]; continuePlaying: LibGame[]; downloaded: LibGame[];
  platforms: LibGroup[]; collections: LibGroup[];
} | null = null;

// ---- Persistent browse cache -------------------------------------------------
// The Maps/vars above live in module scope, so they reset every time the plugin
// is reloaded or the Steam UI restarts — the browse lists then have to be
// refetched from the RomM server on the next open. Mirror them into localStorage
// (which survives reloads) so a restart paints from disk instantly and only
// silently refreshes in the background.
const _LS_LIB_PREFIX = 'romm:libcache:v1:';
const _LS_HOME_KEY = 'romm:homecache:v1';
// Set right before a self-update reload; consumed once on startup to reopen home.
const _LS_REOPEN_HOME = 'romm:reopen-home';
const _LS_TTL_MS = 1000 * 60 * 60 * 24; // 24h; lists rarely churn, dots refresh on fetch
const _lsAvail = (() => { try { return typeof localStorage !== 'undefined'; } catch { return false; } })();

function _persistLibGroup(key: string, list: LibGame[]) {
  if (!_lsAvail) return;
  try { localStorage.setItem(_LS_LIB_PREFIX + key, JSON.stringify({ t: Date.now(), v: list })); } catch { }
}
function _dropLibGroup(key: string) {
  if (!_lsAvail) return;
  try { localStorage.removeItem(_LS_LIB_PREFIX + key); } catch { }
}
// Write-through helpers — use these instead of touching _libGamesCache directly.
function libCacheSet(key: string, list: LibGame[]) { _libGamesCache.set(key, list); _persistLibGroup(key, list); }
function libCacheDelete(key: string) { _libGamesCache.delete(key); _dropLibGroup(key); }
// A game can appear in several cached groups (its platform + any collections), so
// flip is_downloaded across ALL of them. Without this, re-entering a group serves
// the stale cached list and the deleted game still shows as downloaded.
function libCacheSetDownloaded(romId: number, downloaded: boolean) {
  // A deletion invalidates the "downloaded this session" marker, otherwise the
  // tile's clear-guard would keep the dot lit after delete.
  if (!downloaded) _dlSucceeded.delete(romId);
  for (const [key, list] of _libGamesCache) {
    if (!list.some((g) => g.rom_id === romId && !!g.is_downloaded !== downloaded)) continue;
    libCacheSet(key, list.map((g) => g.rom_id === romId ? { ...g, is_downloaded: downloaded } : g));
  }
  // A single-game download/delete doesn't otherwise touch _homeCache, so Home's
  // "Downloaded" row (and any other mounted grid) would only pick it up on the
  // next tab switch. Bulk syncs already broadcast after the batch (see
  // runCollectionBatch); mirror that here for the single-game path.
  _broadcastLibRefresh();
}
// Find a cached LibGame by rom id, across every group it might sit in. Used to
// open a game from somewhere that only knows an id (the Downloads page's
// completed list). Returns null when nothing is cached — see openGameById for
// what happens then.
function libCacheFindGame(romId: number): LibGame | null {
  for (const [, list] of _libGamesCache) {
    const g = list.find((x) => x.rom_id === romId);
    if (g) return g;
  }
  // Home's rows aren't in _libGamesCache, and a just-downloaded game is very
  // likely sitting in one of them.
  for (const list of [_homeCache?.downloaded, _homeCache?.recent, _homeCache?.continuePlaying]) {
    const g = list?.find((x) => x.rom_id === romId);
    if (g) return g;
  }
  return null;
}

// Open the game detail page knowing only a rom id (and, at best, a name).
// GameDetailPage fetches its own detail from the backend, so a stub is enough
// to render — the cached LibGame is preferred only because it paints the name,
// platform and downloaded state on the first frame instead of after the fetch.
function openGameById(romId: number, name: string, origin: string) {
  const cached = libCacheFindGame(romId);
  _libGameHolder = cached || {
    rom_id: romId, name, platform: null,
    is_downloaded: true, has_cover: true,
  };
  _libGameOrigin = origin;
  if (_libPushView) _libPushView('game');
  else Navigation.Navigate(`/romm-sync-game/${romId}`);
}

// Open a platform/collection grid from outside the library (a toast click).
// Siblings are optional but strongly preferred: the grid header's carousel pages
// through them with L1/R1, and leaving a stale list from a different mode behind
// means the selected group isn't in its own carousel.
function openGroupPage(mode: string, group: LibGroup, siblings?: LibGroup[]) {
  _libGroupHolder = { mode, group };
  if (siblings?.length) _libGroupsHolder = { mode, groups: siblings };
  else if (_libGroupsHolder?.mode !== mode) _libGroupsHolder = { mode, groups: [group] };
  if (_libPushView) _libPushView('grid');
  else Navigation.Navigate(`/romm-sync-library/${encodeURIComponent(group.key)}`);
}

function persistHomeCache() {
  if (!_lsAvail || !_homeCache) return;
  try { localStorage.setItem(_LS_HOME_KEY, JSON.stringify({ t: Date.now(), v: _homeCache })); } catch { }
}

// Platforms/Collections index grids — same pattern as _homeCache: seed the grid
// from cache on tab switch (no "Loading…" flash / full remount pop-in), then
// refresh silently in the background.
const _groupsCache: Record<string, LibGroup[] | undefined> = {};
const _LS_GROUPS_KEY = 'romm:groupscache:v1';
function persistGroupsCache() {
  if (!_lsAvail) return;
  try { localStorage.setItem(_LS_GROUPS_KEY, JSON.stringify({ t: Date.now(), v: _groupsCache })); } catch { }
}

// Wipe every cached browse list, in memory and in localStorage. Called on logout:
// the caches outlive the session, so without this the next sign-in paints the
// previous account's games from disk until a fetch replaces them.
// Not exported — see clearIdentityCache: a named export off this entry file
// breaks the bundle.
function clearBrowseCaches() {
  _libGamesCache.clear();
  _homeCache = null;
  for (const k of Object.keys(_groupsCache)) delete _groupsCache[k];
  if (!_lsAvail) return;
  try {
    const stale: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(_LS_LIB_PREFIX)) stale.push(k);
    }
    for (const k of stale) localStorage.removeItem(k);
    localStorage.removeItem(_LS_HOME_KEY);
    localStorage.removeItem(_LS_GROUPS_KEY);
  } catch { }
}

// Hydrate both caches once at module load from any non-expired localStorage data.
(function _hydrateBrowseCaches() {
  if (!_lsAvail) return;
  const now = Date.now();
  try {
    const stale: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k || !k.startsWith(_LS_LIB_PREFIX)) continue;
      try {
        const o = JSON.parse(localStorage.getItem(k) || 'null');
        if (o && Array.isArray(o.v) && (now - (o.t || 0)) < _LS_TTL_MS)
          _libGamesCache.set(k.slice(_LS_LIB_PREFIX.length), o.v);
        else stale.push(k);
      } catch { stale.push(k); }
    }
    stale.forEach((k) => { try { localStorage.removeItem(k); } catch { } });
  } catch { }
  try {
    const o = JSON.parse(localStorage.getItem(_LS_HOME_KEY) || 'null');
    if (o && o.v && (now - (o.t || 0)) < _LS_TTL_MS) _homeCache = o.v;
    else if (o) localStorage.removeItem(_LS_HOME_KEY);
  } catch { }
  try {
    const o = JSON.parse(localStorage.getItem(_LS_GROUPS_KEY) || 'null');
    if (o && o.v && (now - (o.t || 0)) < _LS_TTL_MS)
      for (const k of Object.keys(o.v)) _groupsCache[k] = o.v[k];
    else if (o) localStorage.removeItem(_LS_GROUPS_KEY);
  } catch { }
  try {
    const o = JSON.parse(localStorage.getItem(_LS_PLATICON) || 'null');
    if (o && typeof o === 'object')
      for (const k of Object.keys(o)) _platIconCache.set(k, o[k]);
  } catch { }
})();

// Auto-update
const getPluginVersion = callable<[], string>("get_plugin_version");
const getUpdateChannel = callable<[], string>("get_update_channel");
const setUpdateChannel = callable<[string], string>("set_update_channel");
const checkForUpdate = callable<[string], any>("check_for_update");
const downloadUpdate = callable<[string], any>("download_update");
// Desktop-only: swaps the running AppImage. No-ops on Decky, which
// updates through the loader instead.
const applyAppImageUpdate = callable<[string], any>("apply_appimage_update");
const getCheckOnStartup = callable<[], boolean>("get_check_on_startup");
const setCheckOnStartup = callable<[boolean], boolean>("set_check_on_startup");
// Session cache for update checks: the section auto-checks on open, and this
// keeps reopening Settings from burning GitHub's anonymous rate limit (60/hr).
let _updCheckCache: { t: number; channel: string; info: any } | null = null;
const _UPD_CACHE_MS = 5 * 60 * 1000;
// Floor on how long a MANUAL update check shows its busy state, so the press
// reads as an action that ran rather than a flicker (see runUpdateCheck).
const MIN_CHECK_MS = 900;

const formatSpeed = (bytesPerSec: number): string => {
  if (bytesPerSec >= 1024 * 1024) return `${(bytesPerSec / (1024 * 1024)).toFixed(1)} MB/s`;
  if (bytesPerSec >= 1024) return `${(bytesPerSec / 1024).toFixed(0)} KB/s`;
  return `${bytesPerSec.toFixed(0)} B/s`;
};

// Background notification polling — drains events the backend emits at the exact
// moment a sync/removal happens. No state diffing, no transition inference: the
// backend is the single source of truth (see CollectionSyncManager.push_notification).
let backgroundInterval: any = null;
// Last connection state seen by the background poller, for edge detection. Only
// an online→offline (or offline→online) TRANSITION toasts — a cold start that's
// already offline must not fire a spurious "connection lost".
let _prevConn: string | null = null;
// Consecutive offline samples seen since the last online one. The toast needs
// two (~4s at this interval), because a SINGLE bad sample is routinely not an
// outage: the reachability probe times out under load, and every deliberate sync
// restart (a path repair, an emulator install) tears the client down and rebuilds
// it. Both produced a "Can't reach RomM server" toast on a server that was never
// down — reported from inside the setup wizard, where installing RetroArch
// saturates the connection AND restarts sync at the same moment.
let _offSamples = 0;

// The ack is a round trip and this poll runs every 2s, so without this the same
// announcement toasts two or three times before the backend clears it.
let _annShown = false;

const checkForNotifications = async () => {
  try {
    // Connection-lost / restored toast — runs here (not in a component) so it
    // fires even while the RomM app isn't open (e.g. mid-game).
    try {
      const st = await getServiceStatus();
      const conn = st?.connection ?? null;
      if (conn && conn !== 'connecting') {
        const isOff = conn === 'offline_cached' || conn === 'disconnected';
        _offSamples = isOff ? _offSamples + 1 : 0;
        // Going offline has to be CONFIRMED before it counts as the current
        // state — and while an emulator install runs it never counts, since that
        // restarts sync itself and already narrates its own progress. Leaving
        // _prevConn untouched (rather than just skipping the toast) is what stops
        // an unreported blip from being followed by a baffling "Back online".
        const confirmed = !isOff || (_offSamples >= 2 && !_emuInstall.active);
        if (confirmed) {
          if (_prevConn === 'online' && isOff) {
            const r = st?.unreachable_reason;
            const noNet = r === 'no_network' || r === 'airplane_mode';
            toaster.toast({
              title: r === 'airplane_mode' ? 'Airplane mode is on'
                : noNet ? 'No internet connection' : "Can't reach RomM server",
              body: noNet
                ? 'Showing your downloaded games — saves sync when you’re back online.'
                : 'The server isn’t responding — showing your downloaded games.',
              duration: 5000,
            });
          } else if ((_prevConn === 'offline_cached' || _prevConn === 'disconnected') && conn === 'online') {
            toaster.toast({ title: 'Back online', body: 'Reconnected to RomM — syncing.', duration: 4000 });
          }
          _prevConn = conn;
        }
      }
      // First-library-load toast. Fires from here rather than a component
      // because the whole point is the user who wandered off to Steam during
      // the ~12s first fetch. The backend only ever raises this once per
      // device — see _announce_library — so there's no rate limiting to do
      // here, and routine reconnects stay silent.
      const ann = st?.library_announcement;
      if (ann?.kind && !_annShown) {
        _annShown = true;   // stop the next 2s tick re-toasting before the ack lands
        if (ann.kind === 'ready') {
          toaster.toast({
            title: 'Your library is ready',
            // Report the server's own ROM count, not our grouped entry count:
            // it's the number RomM shows the user everywhere else, and the
            // grouping is an implementation detail a completion toast is the
            // wrong place to explain.
            body: `${(ann.files ?? ann.games ?? 0).toLocaleString()} games from RomM`,
            duration: 6000,
            onClick: () => { try { Navigation.Navigate('/romm-sync-library'); } catch { /* ignore */ } },
          });
        } else {
          toaster.toast({
            title: "Couldn't load your library",
            body: "Ludo can't reach your RomM server. Check that it's running, then try again from Settings.",
            duration: 8000,
            onClick: () => { try { Navigation.Navigate('/romm-sync-settings'); } catch { /* ignore */ } },
          });
        }
        try { await ackLibraryAnnouncement(); } catch { /* retried next load */ }
      }
    } catch { /* transient */ }

    const { events } = await drainNotifications();
    if (!events?.length) return;
    for (let i = 0; i < events.length; i++) {
      // Slight stagger so the toaster doesn't dedupe a burst into one.
      if (i > 0) await new Promise(resolve => setTimeout(resolve, 300));
      const ev = events[i];
      toaster.toast({ title: ev.title, body: ev.body, duration: 5000 });
    }
  } catch (error) {
    console.error('[BACKGROUND NOTIFICATION] Error draining notifications:', error);
  }
};

const startBackgroundMonitoring = () => {
  if (backgroundInterval) {
    clearInterval(backgroundInterval);
  }
  console.log('[BACKGROUND] Starting background notification monitoring');
  backgroundInterval = setInterval(checkForNotifications, 2000);
};

const stopBackgroundMonitoring = () => {
  if (backgroundInterval) {
    console.log('[BACKGROUND] Stopping background notification monitoring');
    clearInterval(backgroundInterval);
    backgroundInterval = null;
  }
};

// Start monitoring immediately when module loads
console.log('[PLUGIN INIT] Module loaded, starting background monitoring');
startBackgroundMonitoring();

// Configuration / first-time setup page
function ConfigPage() {
  const [url, setUrl] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [romDir, setRomDir] = useState('');
  const [saveDir, setSaveDir] = useState('');
  const [biosDir, setBiosDir] = useState('');
  const [deviceName, setDeviceName] = useState('');
  const [deviceNameDefault, setDeviceNameDefault] = useState('SteamOS');
  const [hasPassword, setHasPassword] = useState(false);
  const [retrodeckDetected, setRetrodeckDetected] = useState(false);
  const [isFirstTime, setIsFirstTime] = useState(false);
  const [loading, setLoading] = useState(true);
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [pairCode, setPairCode] = useState('');
  const [pairing, setPairing] = useState(false);
  const [testResult, setTestResult] = useState<{ success: boolean; message: string } | null>(null);

  useEffect(() => {
    const load = async () => {
      try {
        const config = await getConfig();
        setUrl(config.url || '');
        setUsername(config.username || '');
        setRomDir(config.rom_directory || '');
        setSaveDir(config.save_directory || '');
        setBiosDir(config.bios_directory || '');
        setDeviceName(config.device_name || '');
        setDeviceNameDefault(config.device_name_default || 'SteamOS');
        setHasPassword(config.has_password || false);
        setRetrodeckDetected(config.retrodeck_detected || false);
        setIsFirstTime(!config.configured);
      } catch (e) {
        console.error('[ConfigPage] Failed to load config:', e);
      } finally {
        setLoading(false);
      }
    };
    load();
  }, []);

  const handleTest = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const result = await testRommConnection(url.trim(), username.trim(), password);
      setTestResult(result);
    } catch (e) {
      setTestResult({ success: false, message: 'Test failed unexpectedly.' });
    } finally {
      setTesting(false);
    }
  };

  const handlePair = async () => {
    if (!url.trim() || !pairCode.trim()) return;
    setPairing(true);
    try {
      const result = await pairDevice(url.trim(), pairCode.trim());
      if (result.success) {
        // No in-progress toast — NavigateBack to the connected UI is the feedback.
        setPairCode('');
        Navigation.NavigateBack();
      } else {
        toaster.toast({ title: 'Ludo Error', body: result.message || 'Pairing failed.', duration: 5000 });
      }
    } catch (e) {
      toaster.toast({ title: 'Ludo Error', body: 'Pairing failed unexpectedly.', duration: 5000 });
    } finally {
      setPairing(false);
    }
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      const effectiveDeviceName = deviceName.trim() || deviceNameDefault;
      const result = await saveConfig(url.trim(), username.trim(), password, romDir.trim(), saveDir.trim(), effectiveDeviceName, biosDir.trim());
      if (result.success) {
        // No in-progress toast — NavigateBack to the reconnecting UI is the feedback.
        Navigation.NavigateBack();
      } else {
        toaster.toast({ title: 'Ludo Error', body: result.error || 'Failed to save configuration.', duration: 5000 });
      }
    } catch (e) {
      toaster.toast({ title: 'Ludo Error', body: 'Failed to save configuration.', duration: 5000 });
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return <div style={{ color: 'white', padding: '20px' }}>Loading configuration…</div>;
  }

  const canSubmit = url.trim().length > 0 && username.trim().length > 0 && (password.length > 0 || hasPassword);

  return (
    <div style={{ overflowY: 'auto', height: 'calc(100vh - 40px)', marginTop: '40px', paddingBottom: '40px', color: 'white' }}>

      {/* Header */}
      {isFirstTime ? (
        <div style={{ padding: '16px 16px 4px' }}>
          <div className={staticClasses.Title} style={{ marginBottom: '8px' }}>Welcome to Ludo</div>
          <div style={{ fontSize: '13px', color: '#d1d5db', lineHeight: '1.6' }}>
            Connect your SteamOS device to your RomM server to automatically sync ROMs and save files across devices.
          </div>
        </div>
      ) : (
        <div className={staticClasses.Title} style={{ margin: '0 16px 8px' }}>RomM Connection Setup</div>
      )}

      {/* RetroDECK banner */}
      {retrodeckDetected && (
        <div style={{
          margin: '8px 16px 4px',
          padding: '10px 14px',
          background: 'rgba(74, 222, 128, 0.12)',
          border: '1px solid rgba(74, 222, 128, 0.4)',
          borderRadius: '6px',
          fontSize: '13px',
          color: '#4ade80',
          lineHeight: '1.5',
        }}>
          <strong>RetroDECK detected!</strong> ROM and save directories have been pre-filled with RetroDECK defaults. You can change them below if needed.
        </div>
      )}

      <PanelSection title="Connection">
        <PanelSectionRow>
          <TextField
            label="RomM URL"
            value={url}
            onChange={(e: ChangeEvent<HTMLInputElement>) => { setUrl(e.target.value); setTestResult(null); }}
            description="e.g. https://romm.example.com"
          />
        </PanelSectionRow>
        <PanelSectionRow>
          <TextField
            label="Username"
            value={username}
            onChange={(e: ChangeEvent<HTMLInputElement>) => { setUsername(e.target.value); setTestResult(null); }}
          />
        </PanelSectionRow>
        <PanelSectionRow>
          <TextField
            label="Password"
            value={password}
            onChange={(e: ChangeEvent<HTMLInputElement>) => { setPassword(e.target.value); setTestResult(null); }}
            description={hasPassword && !password ? 'Leave blank to keep the saved password' : undefined}
            bIsPassword={true}
          />
        </PanelSectionRow>
        {testResult && (
          <PanelSectionRow>
            <div style={{ color: testResult.success ? '#4ade80' : '#f87171', fontSize: '0.9em', padding: '4px 0' }}>
              {testResult.success ? '✅' : '❌'} {testResult.message}
            </div>
          </PanelSectionRow>
        )}
        <PanelSectionRow>
          <ButtonItem layout="below" onClick={handleTest} disabled={testing || saving || !url.trim() || !username.trim()}>
            {testing ? 'Testing…' : '🔌 Test Connection'}
          </ButtonItem>
        </PanelSectionRow>
      </PanelSection>

      <PanelSection title="Pair with code (recommended)">
        <PanelSectionRow>
          <TextField
            label="Pairing code"
            value={pairCode}
            onChange={(e: ChangeEvent<HTMLInputElement>) => setPairCode(e.target.value)}
            description="Create a token in the RomM web UI, start pairing, and enter the code here — no password needed."
          />
        </PanelSectionRow>
        <PanelSectionRow>
          <ButtonItem layout="below" onClick={handlePair} disabled={pairing || saving || !url.trim() || !pairCode.trim()}>
            {pairing ? 'Pairing…' : '🔗 Pair Device'}
          </ButtonItem>
        </PanelSectionRow>
      </PanelSection>

      <PanelSection title="Device">
        <PanelSectionRow>
          <TextField
            label="Device Name"
            value={deviceName}
            onChange={(e: ChangeEvent<HTMLInputElement>) => setDeviceName(e.target.value)}
            description={`Identifies this device in RomM for save syncing. Defaults to "${deviceNameDefault}" if left blank.`}
          />
        </PanelSectionRow>
      </PanelSection>

      <PanelSection title="Directories">
        <PanelSectionRow>
          <TextField
            label="ROM Directory"
            value={romDir}
            onChange={(e: ChangeEvent<HTMLInputElement>) => setRomDir(e.target.value)}
            description="Where ROMs will be downloaded"
          />
        </PanelSectionRow>
        <PanelSectionRow>
          <ButtonItem layout="below" onClick={async () => {
            try {
              const res = await openFilePicker(FileSelectionType.FOLDER, pickerStart(romDir), false, true);
              if (res?.realpath) setRomDir(res.realpath);
            } catch { }
          }}>
            Browse…
          </ButtonItem>
        </PanelSectionRow>
        <PanelSectionRow>
          <TextField
            label="Save Directory"
            value={saveDir}
            onChange={(e: ChangeEvent<HTMLInputElement>) => setSaveDir(e.target.value)}
            description="Where save files are stored (used for upload/download)"
          />
        </PanelSectionRow>
        <PanelSectionRow>
          <ButtonItem layout="below" onClick={async () => {
            try {
              const res = await openFilePicker(FileSelectionType.FOLDER, pickerStart(saveDir), false, true);
              if (res?.realpath) setSaveDir(res.realpath);
            } catch { }
          }}>
            Browse…
          </ButtonItem>
        </PanelSectionRow>
        <PanelSectionRow>
          <TextField
            label="BIOS Directory"
            value={biosDir}
            onChange={(e: ChangeEvent<HTMLInputElement>) => setBiosDir(e.target.value)}
            description="Where BIOS/firmware files are stored"
          />
        </PanelSectionRow>
        <PanelSectionRow>
          <ButtonItem layout="below" onClick={async () => {
            try {
              const res = await openFilePicker(FileSelectionType.FOLDER, pickerStart(biosDir), false, true);
              if (res?.realpath) setBiosDir(res.realpath);
            } catch { }
          }}>
            Browse…
          </ButtonItem>
        </PanelSectionRow>
      </PanelSection>

      <PanelSection>
        <PanelSectionRow>
          <ButtonItem layout="below" onClick={handleSave} disabled={saving || testing || !canSubmit}>
            {saving ? 'Saving…' : isFirstTime ? '🚀 Connect & Start' : '💾 Save & Apply'}
          </ButtonItem>
        </PanelSectionRow>
        <PanelSectionRow>
          <ButtonItem layout="below" onClick={async () => {
            try {
              const r = await clearCoverCache();
              _coverCache.clear(); _coverInflight.clear(); // drop the frontend hot layer too
              toaster.toast({ title: 'Cover cache cleared', body: r?.success ? `${r.removed ?? 0} files removed` : (r?.message || 'Error') });
            } catch (e) { toaster.toast({ title: 'Clear failed', body: String(e) }); }
          }}>
            Clear cover cache
          </ButtonItem>
        </PanelSectionRow>
        <PanelSectionRow>
          <ButtonItem layout="below" onClick={() => Navigation.NavigateBack()}>
            Cancel
          </ButtonItem>
        </PanelSectionRow>
      </PanelSection>
    </div>
  );
}

// Settings page component
// ---------------------------------------------------------------------------
// Shared save/state version types + formatters, used by the game detail
// Save Data tab (server save/state versions; restore in-place or as a copy).
// ---------------------------------------------------------------------------

interface HistoryEntry {
  id: number; slot: any; save_type: string; file_name: string;
  updated_at: string | null; size_bytes: number | null;
  device: string | null; has_screenshot: boolean;
}

function fmtHistTs(iso: string | null): string {
  if (!iso) return "Unknown time";
  try {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return iso;
    return d.toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  } catch { return iso; }
}

function fmtHistSize(n: number | null): string {
  if (n == null || isNaN(n as any)) return "";
  let v = Number(n);
  for (const u of ['B', 'KB', 'MB', 'GB']) {
    if (v < 1024) return u === 'B' ? `${v.toFixed(0)} ${u}` : `${v.toFixed(1)} ${u}`;
    v /= 1024;
  }
  return `${v.toFixed(1)} TB`;
}

function slotLabel(e: HistoryEntry): string {
  const fn = (e.file_name || '').toLowerCase();
  if (fn.endsWith('.state.auto')) return 'Auto';
  const m = fn.match(/\.state(\d+)$/);
  if (m) return `Slot ${m[1]}`;
  if (fn.endsWith('.state')) return 'Quicksave';
  if (e.slot != null && e.slot !== '') return String(e.slot);
  return e.save_type === 'states' ? 'State' : 'Save';
}

// ---------------------------------------------------------------------------
// Game Browser — controller-first library with cover art, per-game download,
// and metadata. Styled with RomM v2 tokens (V2), not the Steam/Decky chrome.
// Routes: /romm-sync-library  ->  /romm-sync-library/:key  ->  /romm-sync-game/:romId
// ---------------------------------------------------------------------------

// Suppress Steam's gamepad focus highlight (the square "overdraw" box drawn on
// every Focusable) inside the plugin UI. We rely on our own per-component focus
// styling (card scale/glow, row lift, button glow) instead, so the Steam box is
// fully removed rather than restyled.
// Steam draws its gamepad focus box in JS; we disable it per-element via the
// noFocusRing prop on every Focusable. Here we only strip the CEF :focus
// outline (our components supply their own glow), without touching box-shadow
// so our focus glows survive.
const V2_FOCUS_STYLE = `
  .romm-ui *:focus, .romm-ui *:focus-visible { outline: none !important; }
  /* Nothing here is a document to be read and copied — drag-selecting a game
     title just leaves stray highlight behind. Scoped to .romm-ui so Steam's own
     UI is untouched; inputs keep selection so the caret still works. */
  .romm-ui { user-select: none; -webkit-user-select: none; }
  .romm-ui input, .romm-ui textarea, .romm-ui [contenteditable="true"] {
    user-select: text; -webkit-user-select: text;
  }
`;

// Shared list-row / tile hover+focus treatment — the canonical RomM interaction
// vocabulary (brand ring + soft purple glow + slight lift). Injected globally by
// v2Page so every list (saves, achievements, …) reads identically instead of
// each component reinventing it. `.romm-row` for full-width rows, `.romm-tile`
// for the card grid. Note: hosts must NOT clip these (no overflow:hidden on the
// immediate wrapper) or the outset glow gets cut off.
const _EASE = 'cubic-bezier(0.22,1,0.36,1)';

// ── Focus system ────────────────────────────────────────────────────────────
// Single source of truth for how a focused (gamepad or mouse) element reads.
// Gamepad focus under gamescope doesn't reliably fire CSS :focus-within, so most
// call sites drive focus with JS state (onFocus/onBlur) and spread one of these
// fragments; the .romm-row / .romm-tile CSS below is sourced from the SAME
// constants so mouse (:hover/:focus-within) and gamepad focus render identically.
//
//   V2Focus.tile(f)   — card/tile-shaped things that pop toward you (scale)
//   V2Focus.row(f)    — full-width list rows (lift instead of scale)
//   V2Focus.field(f)  — text inputs: quiet halo, no lift/ring
//   V2Focus.flat(f)   — buttons/pills: crisp ring, no lift; opts.glow adds a
//                       faint halo for filled/primary buttons
//   V2Focus.segment(f)— selected-segment tint (nav tabs / channel switch); the
//                       one intentional no-ring affordance
const _RING = `0 0 0 2px ${V2.brand}`;
const _GLOW = 'rgba(139,116,232,0.45)';
const V2Focus = {
  tile: (f: boolean) => f ? {
    transform: 'scale(1.04)', borderColor: V2.brand,
    boxShadow: `0 8px 28px rgba(0,0,0,0.4), ${_RING}, 0 0 18px rgba(139,116,232,0.55)`,
  } : {},
  row: (f: boolean) => f ? {
    background: V2.surfaceHover, borderColor: V2.brand, transform: 'translateY(-1px)',
    boxShadow: `0 8px 22px rgba(0,0,0,0.4), ${_RING}, 0 0 16px ${_GLOW}`,
  } : {},
  // field returns borderColor on BOTH branches: callers pair it with a
  // `border: 1px solid …` shorthand, and if the longhand is only present while
  // focused, React drops border-color entirely on blur (without re-applying the
  // shorthand) — border-color then falls back to currentColor and the field
  // keeps a solid white 1px ring. Verified live on-device via CDP.
  field: (f: boolean) => f ? {
    borderColor: V2.brand, boxShadow: `0 0 0 3px rgba(139,116,232,0.22)`,
  } : { borderColor: V2.border },
  flat: (f: boolean, opts?: { glow?: boolean }) => f ? {
    boxShadow: opts?.glow ? `${_RING}, 0 0 14px rgba(139,116,232,0.35)` : _RING,
  } : {},
  segment: (f: boolean) => f ? { background: 'rgba(255,255,255,0.10)' } : {},
};

const V2_ROW_STYLE = `
  .romm-row { background: ${V2.surface}; border: 1px solid ${V2.border}; transition: background 0.15s ease, border-color 0.15s ease, transform 0.15s ${_EASE}, box-shadow 0.15s ease; }
  .romm-row:hover, .romm-row.gpfocuswithin {
    background: ${V2.surfaceHover}; border-color: ${V2.brand}; transform: translateY(-1px);
    box-shadow: 0 8px 22px rgba(0,0,0,0.4), ${_RING}, 0 0 16px ${_GLOW};
  }
  .romm-tile { background: ${V2.surface}; border: 1px solid ${V2.border}; transition: background 0.15s ease, transform 0.15s ${_EASE}, box-shadow 0.15s ease, border-color 0.15s ease; }
  .romm-tile:hover, .romm-tile.gpfocuswithin {
    background: ${V2.surfaceHover}; transform: translateY(-2px); border-color: ${V2.brand};
    box-shadow: 0 8px 22px rgba(0,0,0,0.4), ${_RING}, 0 0 16px ${_GLOW};
  }
  /* Gamepad focus can be FORCED onto a tile (returning from an emulator
     session) without firing React's onFocus, so the highlight must also be
     reachable via CSS. Keyed to Steam's own .gpfocuswithin marker — NOT DOM
     :focus-within: gamescope leaves the window unfocused after a session, so
     element.focus() (e.g. useAutoFocus on remount) moves DOM activeElement
     silently and :focus-within would light a SECOND tile alongside the one
     Steam actually has gamepad focus on. */
  .romm-ptile-wrap:hover .romm-ptile-v, .romm-ptile-wrap.gpfocuswithin .romm-ptile-v {
    background: ${V2.surface} !important; border-color: ${V2.brand} !important; transform: scale(1.04) !important;
    box-shadow: 0 8px 28px rgba(0,0,0,0.4), ${_RING}, 0 0 18px rgba(139,116,232,0.55) !important;
  }
  .romm-ptile-wrap:hover .romm-ptile-ic, .romm-ptile-wrap.gpfocuswithin .romm-ptile-ic { color: ${V2.brandHover} !important; opacity: 1 !important; }
  .romm-ptile-wrap:hover .romm-ptile-lb, .romm-ptile-wrap.gpfocuswithin .romm-ptile-lb { color: ${V2.fg} !important; }
  .romm-gt-wrap:hover .romm-gt-cover, .romm-gt-wrap.gpfocuswithin .romm-gt-cover {
    transform: scale(1.04) !important;
    box-shadow: 0 8px 28px rgba(0,0,0,0.4), ${_RING}, 0 0 18px rgba(139,116,232,0.55) !important;
  }
  /* Reveal the cover's action overlay on real mouse hover, not just the React
     focused state — onMouseEnter can miss when the pointer ends up inside a
     cover without crossing its boundary (see the overlay comment in GameTile),
     which otherwise left the Details/Delete/Play buttons unclickable. */
  .romm-gt-wrap:hover .romm-gt-scrim,
  .romm-gt-wrap:hover .romm-gt-primary { opacity: 1 !important; }
  .romm-gt-wrap:hover .romm-gt-actions { opacity: 1 !important; transform: translateY(0) !important; }
  .romm-ct-wrap:hover .romm-ct-cover, .romm-ct-wrap.gpfocuswithin .romm-ct-cover {
    transform: scale(1.04) !important;
    box-shadow: 0 8px 28px rgba(0,0,0,0.4), ${_RING}, 0 0 18px rgba(139,116,232,0.55) !important;
  }
`;

function v2Page(children: any, bgUri: string | null = null) {
  return (
    <div className="romm-ui" style={{
      fontFamily: V2.font, color: V2.fg, background: V2.bg,
      position: 'relative', overflowY: 'auto', height: 'calc(100vh - 40px)',
      marginTop: '40px', scrollPaddingTop: '120px', scrollPaddingBottom: '80px',
    }}>
      <style>{V2_FOCUS_STYLE}{V2_ROW_STYLE}</style>
      <V2Bg uri={bgUri} />
      {/* Bottom padding covers Steam's fixed footer button legend (measured
          42px tall on-device, overlaying the screen bottom) + ~22px of real
          clearance, so a fully scrolled last row sits above the glass bar
          instead of under it. */}
      <div style={{ position: 'relative', zIndex: 2, padding: '0 0 64px' }}>
        {children}
      </div>
    </div>
  );
}

const NAV_ORDER: NavId[] = ['home', 'platforms', 'collections', 'search'];

// RomM RTextField (filled) search field — uses @decky/ui TextField for
// Steam virtual keyboard support, with CSS overrides to strip the default
// Steam DialogInput styling and apply the V2 theme. Wrapped in Focusable for
// gamepad navigation; onActivate focuses the inner input to trigger keyboard.
const V2SearchField = forwardRef(function V2SearchField(
  { value, onChange }: { value: string; onChange: (v: string) => void },
  fwdRef: Ref<any>,
) {
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const [focused, setFocused] = useState(false);

  return (
    <Focusable
      ref={(el: any) => {
        wrapperRef.current = el;
        if (typeof fwdRef === 'function') fwdRef(el);
        else if (fwdRef) (fwdRef as any).current = el;
      }}
      noFocusRing
      onActivate={() => {
        const input = wrapperRef.current?.querySelector('input');
        if (input) input.focus();
        _summonVirtualKeyboard();
      }}
      onFocus={() => setFocused(true)} onBlur={() => setFocused(false)}
      onMouseEnter={() => setFocused(true)} onMouseLeave={() => setFocused(false)}
      style={{ borderRadius: V2.radiusMd }}
    >
      <style>{`
        .romm-search-input label { display: none !important; }
        .romm-search-input, .romm-search-input > div, .romm-search-input > div > div { background: transparent !important; border: none !important; box-shadow: none !important; padding: 0 !important; margin: 0 !important; width: 100% !important; }
        .romm-search-input input { background: transparent !important; border: none !important; outline: none !important; box-shadow: none !important; color: ${V2.fg} !important; font-size: 14px !important; font-family: inherit !important; padding: 0 10px !important; margin: 0 !important; height: auto !important; min-height: 0 !important; caret-color: ${V2.brand} !important; }
        .romm-search-input input::placeholder { color: rgba(255,255,255,0.45) !important; }
      `}</style>
      {/* Mirrors RomM's gallery search RTextField (outlined + inline icon
          "well"): a left adornment box with its own elevated fill and a
          divider that turns brand on focus, brand border + halo when active. */}
      <div className="romm-search-wrap" style={{
        display: 'flex', alignItems: 'stretch', height: '40px', overflow: 'hidden',
        borderRadius: V2.radiusMd,
        background: V2.bgElevated,
        border: `1px solid ${V2.border}`,
        transition: 'background 0.2s, border-color 0.2s, box-shadow 0.2s',
        ...V2Focus.field(focused),
      }}>
        <div style={{
          display: 'flex', alignItems: 'center', padding: '0 11px', flexShrink: 0,
          background: 'rgba(255,255,255,0.06)',
          borderRight: `1px solid ${focused ? V2.brand : V2.border}`,
          color: focused ? V2.brandHover : V2.fgMuted,
          transition: 'border-right-color 0.2s, color 0.2s',
        }}>
          <FaSearch size={14} />
        </div>
        <div className="romm-search-input" style={{ flex: '1 1 auto', minWidth: 0, display: 'flex', alignItems: 'center' }}
          onFocusCapture={() => setFocused(true)}
          onBlurCapture={() => setFocused(false)}
        >
          <TextField
            value={value}
            onChange={(e: ChangeEvent<HTMLInputElement>) => onChange(e.target.value)}
          />
        </div>
        {value && (
          <div onClick={() => onChange('')}
            style={{
              flexShrink: 0, cursor: 'pointer', color: V2.fgMuted, display: 'flex', alignItems: 'center',
              padding: '0 11px',
            }}>
            <FaTimesCircle size={15} />
          </div>
        )}
      </div>
    </Focusable>
  );
});

// V2TextField — labeled text input sharing the V2SearchField look (RomM
// RTextField filled variant): rounded surface box, brand focus border + halo.
// Used by the setup wizard so its fields match the library search bar.
function V2TextField({ label, value, onChange, password, placeholder, icon, mono, maxLength, onKb, focusRef, onEnter }:
  { label?: string; value: string; onChange: (v: string) => void; password?: boolean; placeholder?: string; icon?: any; mono?: boolean; maxLength?: number; onKb?: (open: boolean) => void; focusRef?: React.MutableRefObject<any>; onEnter?: () => void }) {
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const [focused, setFocused] = useState(false);
  const uid = useRef(`v2tf-${Math.random().toString(36).slice(2, 8)}`).current;
  useEffect(() => {
    if (placeholder) {
      const input = wrapperRef.current?.querySelector('input');
      if (input) input.setAttribute('placeholder', placeholder);
    }
  }, [placeholder]);
  // Bring up the Steam keyboard AND lift the field clear of it: the keyboard is
  // an overlay that covers the bottom ~half of the screen without reflowing the
  // page, so a centered field would sit behind it. onKb(true) asks the wizard to
  // add bottom scroll room, then we scroll the field to the top of the scroll
  // area (scrollMarginTop keeps it off the very edge).
  const enterInput = () => {
    const input = wrapperRef.current?.querySelector('input');
    if (input) (input as HTMLElement).focus();
    _summonVirtualKeyboard();
    onKb?.(true);
    // Two passes: one right after the kbRoom padding lands, one after the
    // keyboard's own open animation settles (it can scroll-fight the first).
    [120, 600].forEach((d) => setTimeout(() => {
      try { wrapperRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }); } catch { }
    }, d));
  };
  // Blur the inner input when gamepad focus leaves the field: it registered
  // itself as the virtual-keyboard target on focus and would otherwise stay
  // activeElement after you move away.
  const leaveInput = () => {
    setFocused(false);
    onKb?.(false);
    const input = wrapperRef.current?.querySelector('input');
    if (input) (input as HTMLElement).blur();
  };
  return (
    // Focusable noFocusRing wrapper: without it the bare TextField carries
    // Steam's own gamepad focus box, which leaves a stray white ring behind
    // after the highlight moves away. noFocusRing suppresses it; our own field
    // halo (V2Focus.field) is the only focus affordance.
    <Focusable
      noFocusRing
      className="wiz-field"
      ref={(el: any) => { wrapperRef.current = el; if (focusRef) focusRef.current = el; }}
      onActivate={enterInput}
      onFocus={() => setFocused(true)} onBlur={leaveInput}
      onMouseEnter={() => setFocused(true)} onMouseLeave={() => setFocused(false)}
      // Enter on the on-screen keyboard (also R2, which Steam maps to Enter)
      // reaches the input as a keydown — treat it as "submit this field":
      // collapse the keyboard and hand off.
      onKeyDownCapture={onEnter ? (e: any) => { if (e.key === 'Enter') { e.preventDefault(); _dismissVirtualKeyboard(); onEnter(); } } : undefined}
      style={{ display: 'flex', flexDirection: 'column', gap: '6px', width: '100%', scrollMarginTop: '12vh' }}
    >
      {label && <div style={{ fontSize: '11px', fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', color: V2.fgMuted, textAlign: 'center' }}>{label}</div>}
      <style>{`.${uid} label{display:none!important}.${uid}>div{background:transparent!important;border:none!important;box-shadow:none!important;padding:0!important;margin:0!important}.${uid}>div>div{background:transparent!important;border:none!important;box-shadow:none!important;padding:0!important}.${uid} input,.${uid} input:focus,.${uid} input:focus-visible{background:transparent!important;border:none!important;outline:none!important;box-shadow:none!important;color:${V2.fg}!important;font-size:${mono ? '20px' : '14px'}!important;font-weight:${mono ? '700' : '400'}!important;font-family:${mono ? 'monospace' : 'inherit'}!important;padding:0!important;margin:0!important;height:auto!important;min-height:0!important;caret-color:${V2.brand}!important;text-align:center!important;letter-spacing:${mono ? '.3em' : 'normal'}!important;text-indent:${mono ? '.3em' : 0}!important;text-transform:${mono ? 'uppercase' : 'none'}!important}.${uid} input::placeholder{color:rgba(255,255,255,0.40)!important}`}</style>
      <div className={uid} style={{
        display: 'flex', alignItems: 'center', gap: '10px', height: '38px', padding: '0 12px',
        borderRadius: V2.radiusMd,
        background: focused ? V2.surfaceHover : 'rgba(255,255,255,0.045)',
        border: `1px solid ${V2.border}`,
        transition: 'background 0.2s, border-color 0.2s, box-shadow 0.2s',
        ...V2Focus.field(focused),
      }}>
        {icon && <span style={{ flexShrink: 0, color: focused ? V2.brandHover : V2.fgMuted, display: 'inline-flex' }}>{icon}</span>}
        <div style={{ flex: '1 1 auto', minWidth: 0 }}
          onFocusCapture={() => setFocused(true)}
          onBlurCapture={() => setFocused(false)}
        >
          <TextField
            value={value}
            bIsPassword={password}
            onChange={(e: ChangeEvent<HTMLInputElement>) => onChange(maxLength != null ? e.target.value.slice(0, maxLength) : e.target.value)}
          />
        </div>
      </div>
    </Focusable>
  );
}

// PairCodeField — masked XXXX-XXXX entry. Shows an 8-slot template where each
// typed character replaces one `*` (rather than a placeholder that vanishes on
// the first keystroke). A transparent, char-aligned input sits over the mask so
// the caret lands on the next empty slot.
function PairCodeField({ label, value, onChange, onKb, onEnter }:
  { label?: string; value: string; onChange: (v: string) => void; onKb?: (open: boolean) => void; onEnter?: () => void }) {
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const [focused, setFocused] = useState(false);
  const digits = value.replace(/-/g, '');
  const font: any = { fontFamily: 'monospace', fontSize: '20px', fontWeight: 700, letterSpacing: '0.3em', textIndent: '0.3em' };
  const cells: any[] = [];
  for (let i = 0; i < 8; i++) {
    const ch = digits[i];
    cells.push(<span key={i} style={{ color: ch ? V2.fg : V2.fgMuted }}>{ch || '*'}</span>);
    if (i === 3) cells.push(<span key="dash" style={{ color: digits.length > 4 ? V2.fg : V2.fgMuted }}>-</span>);
  }
  const uid = useRef(`v2pf-${Math.random().toString(36).slice(2, 8)}`).current;
  const enterInput = () => {
    const input = wrapperRef.current?.querySelector('input');
    if (input) (input as HTMLElement).focus();
    _summonVirtualKeyboard();
    onKb?.(true);
    [120, 600].forEach((d) => setTimeout(() => {
      try { wrapperRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }); } catch { }
    }, d));
  };
  // See V2TextField.leaveInput — drop the VK target on blur so no white ring lingers.
  const leaveInput = () => {
    setFocused(false);
    onKb?.(false);
    const input = wrapperRef.current?.querySelector('input');
    if (input) (input as HTMLElement).blur();
  };
  return (
    // See V2TextField: Focusable noFocusRing suppresses Steam's stray white
    // focus box; scrollIntoView lifts the field clear of the on-screen keyboard.
    <Focusable
      noFocusRing
      className="wiz-field"
      ref={(el: any) => { wrapperRef.current = el; }}
      onActivate={enterInput}
      onFocus={() => setFocused(true)} onBlur={leaveInput}
      onMouseEnter={() => setFocused(true)} onMouseLeave={() => setFocused(false)}
      onKeyDownCapture={onEnter ? (e: any) => { if (e.key === 'Enter') { e.preventDefault(); _dismissVirtualKeyboard(); onEnter(); } } : undefined}
      style={{ display: 'flex', flexDirection: 'column', gap: '6px', width: '100%', scrollMarginTop: '12vh' }}
    >
      {label && <div style={{ fontSize: '11px', fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', color: V2.fgMuted, textAlign: 'center' }}>{label}</div>}
      <style>{`.${uid} label{display:none!important}.${uid}>div{background:transparent!important;border:none!important;box-shadow:none!important;padding:0!important;margin:0!important}.${uid}>div>div{background:transparent!important;border:none!important;box-shadow:none!important;padding:0!important}.${uid} input,.${uid} input:focus,.${uid} input:focus-visible{position:absolute!important;inset:0!important;width:100%!important;background:transparent!important;border:none!important;outline:none!important;box-shadow:none!important;color:transparent!important;caret-color:${V2.brand}!important;padding:0!important;margin:0!important;height:100%!important;min-height:0!important;font-family:monospace!important;font-size:20px!important;font-weight:700!important;letter-spacing:.3em!important;text-indent:.3em!important;text-transform:uppercase!important}`}</style>
      <div className={uid} style={{
        display: 'flex', alignItems: 'center', justifyContent: 'center', height: '40px', padding: '0 12px',
        borderRadius: V2.radiusMd,
        background: focused ? V2.surfaceHover : 'rgba(255,255,255,0.045)',
        border: `1px solid ${V2.border}`,
        transition: 'background 0.2s, border-color 0.2s, box-shadow 0.2s',
        ...V2Focus.field(focused),
      }}>
        <div style={{ position: 'relative', display: 'inline-block', width: '100%' }}
          onFocusCapture={() => setFocused(true)}
          onBlurCapture={() => setFocused(false)}
        >
          <div style={{ ...font, whiteSpace: 'pre', pointerEvents: 'none' }}>{cells}</div>
          <TextField
            value={value}
            onChange={(e: ChangeEvent<HTMLInputElement>) => onChange(e.target.value.slice(0, 9))}
          />
        </div>
      </div>
    </Focusable>
  );
}

// Search tab — debounced text filter over the whole library, results as a
// cover-art grid (the nav 'Search' destination).
function SearchPanel({ onOpen, onBg, visible }: { onOpen: (g: LibGame) => void; onBg: (uri: string | null) => void; visible: boolean }) {
  // Minimum characters before we hit the backend. Browsing the whole library
  // (empty query) renders every cover tile, which tanks performance on big
  // collections — so search is gated until the user starts typing.
  const MIN_CHARS = 2;
  const [q, setQ] = useState('');
  const [results, setResults] = useState<LibGame[]>([]);
  const [loading, setLoading] = useState(false);
  const query = q.trim();
  const tooShort = query.length < MIN_CHARS;
  useEffect(() => {
    // Below the threshold: don't search, clear any prior results.
    if (tooShort) { setResults([]); setLoading(false); return; }
    // Keep the current results on screen while the new query debounces/fetches
    // — refining "syph" → "sypho" shouldn't blow the grid away and flash
    // "Searching…" on every keystroke. The full-screen loading state is only
    // shown when there's nothing to display yet (see render below).
    setLoading(true);
    const t = setTimeout(async () => {
      try { const r = await searchGames(q); setResults(r?.success ? (r.games || []) : []); }
      catch { setResults([]); }
      finally { setLoading(false); }
    }, 250);
    return () => clearTimeout(t);
  }, [q]);

  // On-demand windowed mount — same scheme as the platform/collection games
  // page (visN + focus-driven growth + IO sentinel). A broad query (e.g. "ma")
  // can match hundreds of ROMs; mounting every Focusable tree at once stutters,
  // so render the first screenful and grow as the user scrolls toward the end.
  const GRID_FIRST = 30, GRID_CHUNK = 30;
  const [visN, setVisN] = useState(GRID_FIRST);
  useEffect(() => { setVisN(Math.min(results.length, GRID_FIRST)); }, [results]);
  const visNRef = useRef(visN); visNRef.current = visN;
  const resultsLenRef = useRef(results.length); resultsLenRef.current = results.length;
  const onTileFocus = useRef((i: number) => {
    if (i >= visNRef.current - 12)
      setVisN((n) => Math.min(resultsLenRef.current, Math.max(n, i + 1 + GRID_CHUNK)));
  }).current;
  const sentinelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (visN >= results.length) return;
    const el = sentinelRef.current;
    const bump = () => setVisN((n) => Math.min(results.length, n + GRID_CHUNK));
    if (!el || typeof IntersectionObserver === 'undefined') { bump(); return; }
    let io: IntersectionObserver | null = null;
    try {
      io = new IntersectionObserver((es) => { if (es.some((e) => e.isIntersecting)) bump(); },
        { rootMargin: '400px' });
      io.observe(el);
    } catch { bump(); }
    return () => { try { io?.disconnect(); } catch { } };
  }, [visN, results.length]);

  // Stable callback identity so memo(GameTile) isn't invalidated each render.
  const onOpenRef = useRef(onOpen); onOpenRef.current = onOpen;
  const openGame = useRef((g: LibGame) => onOpenRef.current(g)).current;
  const onBgRef = useRef(onBg); onBgRef.current = onBg;
  const setBg = useRef((uri: string | null) => onBgRef.current(uri)).current;

  const gridTiles = useMemo(() => results.slice(0, visN).map((g, i) => (
    <GameTile key={g.rom_id} game={g} onOpen={openGame} onActiveCover={setBg}
      index={i} onFocusIdx={onTileFocus} focusable={visible} />
  )), [results, visN, visible]);

  // Land gamepad focus on the search field when the tab opens (same retry
  // cadence as the group grids) — entering Search with nothing highlighted
  // parked focus on the page-root container, which showed a stray outline.
  // NOTE: deliberately a LOCAL effect, not useAutoFocus — useAutoFocus writes
  // the shared _autoFocusFirstRef that the post-game return-focus effect reads
  // as its target. Letting the search field register there meant returning from
  // a game launched off the Search tab focused the empty field instead of a
  // game (the "broke focus coming back from a game" regression).
  const searchFieldRef = useRef<any>(null);
  useEffect(() => {
    // Panels stay mounted across tab switches (display:none) — refire the
    // focus grab each time the tab becomes the visible one, not just on mount.
    if (!visible) return;
    // _forceGamepadFocus, not focus(): silent while the window is OS-unfocused
    // after an emulator session (same as useAutoFocus).
    const timers = [0, 60, 160, 320].map((d) =>
      setTimeout(() => { try { if (searchFieldRef.current) _forceGamepadFocus(searchFieldRef.current); } catch { } }, d));
    return () => timers.forEach(clearTimeout);
  }, [visible]);

  return (
    <div style={{ padding: '16px 16px 0' }}>
      <div style={{ maxWidth: '520px', margin: '0 auto 16px' }}>
        {/* Unmounted while the tab is hidden: the wrapper Focusable AND the
            TextField's DialogInput otherwise linger in Steam's nav tree as 0×0
            phantom focus targets (display:none doesn't remove them — verified
            on-device; these two were the last phantoms after the tiles got
            focusable={visible}). Remount is cheap — it's one input, and `q`
            lives up here so the text survives. */}
        {visible ? <V2SearchField ref={searchFieldRef} value={q} onChange={setQ} />
          : <div style={{ height: '40px' }} />}
      </div>
      {tooShort ? (
        <div style={{ padding: '24px', color: V2.fgMuted, fontSize: '13px', textAlign: 'center' }}>
          {`Type at least ${MIN_CHARS} characters to search your library.`}
        </div>
      ) : results.length === 0 ? (
        // Only the empty grid swaps to a text state: loading on first fetch,
        // "no match" once a fetch has resolved with nothing.
        <div style={{ padding: loading ? '16px' : '24px', color: V2.fgMuted, fontSize: '13px', textAlign: 'center' }}>
          {loading ? 'Searching…' : `No games match "${query}".`}
        </div>
      ) : (
        // Results present: keep the grid mounted even while a refined query is
        // in flight, so typing another letter doesn't flash "Searching…".
        <Focusable noFocusRing {...NAV_MAINTAIN_X} style={{
          display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(132px, 1fr))',
          gap: '18px 16px', padding: '6px 0',
        }}>
          {gridTiles}
          {visN < results.length && (
            <div ref={sentinelRef} style={{ gridColumn: '1 / -1', height: '1px' }} />
          )}
        </Focusable>
      )}
    </div>
  );
}

// Small count tag — RomM RTag x-small used in CardRow headers.
function Tag({ children }: { children: any }) {
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
      minWidth: '18px', height: '18px', padding: '0 6px', borderRadius: V2.radiusChip,
      background: V2.surface, border: `1px solid ${V2.border}`,
      fontSize: '11px', fontWeight: 700, color: V2.fg2, fontVariantNumeric: 'tabular-nums',
    }}>{children}</span>
  );
}

// CardRow — RomM v2 Home section: header (icon + title + count) over a
// horizontal-scroll track. Gamepad focus scrolls the track natively; the
// gradient chevron arrows (RomM style) appear only when the track overflows
// in that direction, signaling "more to the right".
function CardRow({ icon, title, count, children }:
  { icon: any; title: string; count?: number; children: any }) {
  const trackRef = useRef<HTMLDivElement | null>(null);
  const [canLeft, setCanLeft] = useState(false);
  const [canRight, setCanRight] = useState(false);

  const update = () => {
    const el = trackRef.current;
    if (!el) return;
    setCanLeft(el.scrollLeft > 8);
    setCanRight(el.scrollLeft + el.clientWidth < el.scrollWidth - 8);
  };
  useEffect(() => {
    const el = trackRef.current;
    if (!el) return;
    requestAnimationFrame(update);
    const ro = new ResizeObserver(update);
    ro.observe(el);
    for (const c of Array.from(el.children)) ro.observe(c as Element);
    return () => ro.disconnect();
  }, [children]);
  const scroll = (dir: -1 | 1) => {
    const el = trackRef.current;
    if (!el) return;
    el.scrollBy({ left: dir * el.clientWidth * 0.8, behavior: 'smooth' });
  };

  // Arrows are always mounted and fade in/out (opacity + slide) with the
  // overflow state so they don't pop; hidden ones drop pointer events.
  const arrow = (dir: -1 | 1, show: boolean): any => ({
    position: 'absolute', top: '50%', zIndex: 10,
    [dir < 0 ? 'left' : 'right']: '8px',
    width: '36px', height: '36px', borderRadius: '50%',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    cursor: show ? 'pointer' : 'default', pointerEvents: show ? 'auto' : 'none',
    background: 'rgba(0,0,0,0.4)', color: V2.fg2, border: `1px solid ${V2.border}`,
    backdropFilter: 'blur(10px)', WebkitBackdropFilter: 'blur(10px)',
    boxShadow: '0 2px 10px rgba(0,0,0,0.4)',
    opacity: show ? 1 : 0,
    transform: `translateY(-50%) translateX(${show ? '0' : `${dir < 0 ? -6 : 6}px`})`,
    transition: 'opacity 0.2s ease, transform 0.2s ease',
  });

  return (
    <section style={{ marginBottom: '22px' }}>
      <header style={{
        display: 'flex', alignItems: 'center', gap: '10px',
        padding: '0 16px', marginBottom: '12px', color: V2.fg2,
      }}>
        <span style={{ opacity: 0.6, display: 'inline-flex', alignItems: 'center' }}>{icon}</span>
        <h2 style={{ fontSize: '14.5px', fontWeight: 600, letterSpacing: '0.01em', lineHeight: 1.2, margin: 0 }}>{title}</h2>
        {count != null && <Tag>{count}</Tag>}
      </header>
      <div style={{ position: 'relative' }}>
        <div style={arrow(-1, canLeft)} onClick={() => canLeft && scroll(-1)}><FaChevronLeft size={15} /></div>
        <div style={arrow(1, canRight)} onClick={() => canRight && scroll(1)}><FaChevronRight size={15} /></div>
        {/* Top/bottom padding gives the focus scale + glow room so the
            scroll container (overflow-x:auto clips y too) doesn't crop the
            top of hovered covers. Matches RomM's 16/20 track padding. */}
        <div
          ref={trackRef}
          onScroll={update}
          style={{ overflowX: 'auto', overflowY: 'visible' }}
        >
          <Focusable noFocusRing flow-children="horizontal" {...NAV_MAINTAIN_X} style={{ display: 'flex', gap: '12px', padding: '24px 16px 28px' }}>
            {children}
          </Focusable>
        </div>
      </div>
    </section>
  );
}

// Placeholder block with a slow left-to-right sheen — the shared building brick
// for every "we don't know this yet" shape.
function Shimmer({ style }: { style?: any }) {
  return (
    <div style={{
      background: V2.bgElevated, borderRadius: V2.radiusSm, overflow: 'hidden',
      position: 'relative', ...style,
    }}>
      <div style={{
        position: 'absolute', inset: 0,
        background: 'linear-gradient(100deg, transparent 20%, rgba(255,255,255,0.055) 50%, transparent 80%)',
        animation: 'rommShimmer 1.4s ease-in-out infinite',
      }} />
    </div>
  );
}

// Home's first-run state: the real layout with its content greyed out, instead
// of a centred "Loading…". A cold start has no cached lists to seed from, and a
// single line of text on an empty screen gave no sense of what was coming — the
// page then snapped from nothing to a full dashboard. Same row count, header
// sizes, tile widths and paddings as the real CardRows below, so the content
// lands in place rather than pushing a different layout out of the way.
function HomeSkeleton() {
  // Row 1 is landscape (Continue playing's screenshot cards), the rest portrait
  // covers — matching what usually renders in each slot.
  const rows: { tiles: number; w: number; ratio: string }[] = [
    { tiles: 4, w: 234, ratio: '16 / 9' },
    { tiles: 7, w: 132, ratio: '3 / 4' },
    { tiles: 7, w: 132, ratio: '3 / 4' },
  ];
  return (
    <div style={{ paddingTop: '8px' }} aria-busy="true">
      <style>{`
        @keyframes rommShimmer { 0% { transform: translateX(-100%); } 100% { transform: translateX(100%); } }
        @keyframes rommSkelIn { from { opacity: 0; } to { opacity: 1; } }
      `}</style>
      {rows.map((row, r) => (
        // Stagger the rows in so the skeleton itself arrives calmly rather than
        // all at once — and so a fast backend never flashes the full set.
        <section key={r} style={{
          marginBottom: '22px', opacity: 0,
          animation: `rommSkelIn 0.5s ease ${r * 0.12 + 0.15}s forwards`,
        }}>
          <header style={{
            display: 'flex', alignItems: 'center', gap: '10px',
            padding: '0 16px', marginBottom: '12px',
          }}>
            <Shimmer style={{ width: '14px', height: '14px', borderRadius: '4px' }} />
            <Shimmer style={{ width: `${110 + r * 22}px`, height: '13px', borderRadius: '4px' }} />
          </header>
          <div style={{ display: 'flex', gap: '12px', padding: '24px 16px 28px', overflow: 'hidden' }}>
            {Array.from({ length: row.tiles }).map((_, i) => (
              <div key={i} style={{ width: `${row.w}px`, flexShrink: 0 }}>
                <Shimmer style={{ width: '100%', aspectRatio: row.ratio, borderRadius: V2.radiusArt }} />
                {/* The title line under each cover, so the row's height matches
                    the real one and nothing shifts when the data lands. */}
                <Shimmer style={{ width: `${60 + ((i * 37) % 35)}%`, height: '9px', marginTop: '8px', borderRadius: '4px' }} />
              </div>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

// Same idea for the Platforms/Collections index: the real grid geometry, greyed
// out, so the tiles fade into position instead of replacing a line of text.
function GroupGridSkeleton() {
  return (
    <div style={{ paddingTop: '6px', opacity: 0, animation: 'rommSkelIn 0.5s ease 0.15s forwards' }} aria-busy="true">
      <style>{`
        @keyframes rommShimmer { 0% { transform: translateX(-100%); } 100% { transform: translateX(100%); } }
        @keyframes rommSkelIn { from { opacity: 0; } to { opacity: 1; } }
      `}</style>
      <div style={{ padding: '6px 16px 10px' }}>
        <Shimmer style={{ width: '92px', height: '10px', borderRadius: '4px' }} />
      </div>
      <div style={{
        display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(132px, 1fr))',
        gap: '18px 16px', padding: '0 16px 8px',
      }}>
        {Array.from({ length: 12 }).map((_, i) => (
          <div key={i}>
            <Shimmer style={{ width: '100%', aspectRatio: '3 / 4', borderRadius: V2.radiusArt }} />
            <Shimmer style={{ width: `${55 + ((i * 41) % 40)}%`, height: '9px', marginTop: '8px', borderRadius: '4px' }} />
          </div>
        ))}
      </div>
    </div>
  );
}

// Home dashboard — faithful to RomM v2 Home.vue: horizontal CardRows
// (Continue playing / Recently added / Platforms / Collections).
// Home banner for the two emulator states that change what the app can do:
// nothing installed (games download but can't launch), and a save folder left
// pointing into an emulator that was uninstalled (sync writes where nothing
// reads, while still reporting success). Every other stale path is a quiet
// warning row in Settings ▸ Folders instead — see FoldersSection.
// Install progress. Determinate once flatpak reports a percentage, and a moving
// indeterminate sweep before that — resolving refs and verifying take a while
// with no numbers attached, and a bar frozen at 0% looks like a hung download.
function InstallProgressBar({ pct }: { pct: number | null }) {
  const known = pct != null;
  return (
    <div style={{ marginTop: '8px', display: 'flex', alignItems: 'center', gap: '10px' }}>
      <div style={{
        flex: '1 1 auto', height: '6px', borderRadius: V2.radiusPill,
        background: 'rgba(255,255,255,0.12)', overflow: 'hidden', position: 'relative',
      }}>
        <div style={{
          position: 'absolute', top: 0, bottom: 0,
          left: known ? 0 : undefined,
          width: known ? `${Math.max(2, Math.min(100, pct!))}%` : '35%',
          borderRadius: V2.radiusPill,
          background: `linear-gradient(90deg, ${V2.brand}, ${V2.brandHover})`,
          transition: known ? 'width 0.4s ease-out' : 'none',
          animation: known ? undefined : 'rommIndet 1.4s linear infinite',
        }} />
      </div>
      <span style={{
        fontSize: '11px', fontWeight: 700, color: V2.fg2,
        minWidth: '34px', textAlign: 'right', fontVariantNumeric: 'tabular-nums',
      }}>{known ? `${pct}%` : '…'}</span>
      {/* Per-component keyframes, the convention everywhere else in this file.
          `spin` is here too because the banner's own Fix button asks for it.
          The offsets are in units of the SWEEPER's width (35% of the track), so
          -115% is what actually parks it off the left edge and 300% clears the
          right — a smaller start left it half-visible at 0%, popping in. */}
      <style>{`
        @keyframes rommIndet {
          0%   { transform: translateX(-115%); }
          100% { transform: translateX(300%); }
        }
        @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
      `}</style>
    </div>
  );
}

function EmulatorBanner() {
  const status = useEmulatorStatus();
  const install = useEmulatorInstall();
  const [fixing, setFixing] = useState(false);
  if (!status) return null;

  const stale = status.stale_paths || [];
  if (status.installed && !stale.length && !install.active) return null;
  const copy = staleCopy(stale);

  const tone = status.installed ? V2.warning : V2.brandHover;
  // Fixes everything the banner is complaining about, since that is what it now
  // reports. BIOS repair only redirects where new files go — it moves nothing —
  // so the toast says which folders changed rather than implying a migration.
  const fixStale = async () => {
    setFixing(true);
    const title = 'Emulator folders';
    try {
      const keys = stale.map((p) => `${p.section}.${p.key}`);
      const r = await repairEmulatorPaths(keys);
      // success with nothing repaired is not success — say so rather than
      // congratulating the user next to a warning that hasn't moved.
      if (r?.success && r.repaired?.length) {
        publishEmulatorStatus({ ...status, stale_paths: r.stale_paths || [] });
        const names = r.repaired.map((x: any) => x.label || x.key).join(', ');
        toaster.toast({ title, body: `Pointed back at your emulator: ${names}` });
      } else if (r?.success) {
        await loadEmulatorStatus(true);
        toaster.toast({ title, body: 'Nothing changed — check Settings ▸ Emulator & folders' });
      } else {
        toaster.toast({ title, body: r?.message || 'Could not update them' });
      }
    } catch { toaster.toast({ title, body: 'Could not update them' }); }
    finally { setFixing(false); }
  };

  const body = install.active
    ? [install.phase || 'Installing RetroArch',
       installSize(install),
       install.detail,
       'You can keep browsing while it runs.']
      .filter(Boolean).join(' · ')
    : status.installed
      ? copy.body
      : status.install.available
        ? 'Downloading and syncing still work — you just need an emulator to play. Installing RetroArch takes a few minutes.'
        // Can't install from here (Windows, no flatpak, running as root): say why
        // rather than offering a button that can only fail.
        : `Downloading and syncing still work, but playing needs RetroArch or RetroDECK — ${status.install.reason || 'install one to play'}.`;

  return (
    <div style={{ padding: '4px 20px 12px' }}>
      <div style={{
        display: 'flex', alignItems: 'center', gap: '14px', padding: '14px 16px',
        borderRadius: V2.radiusCard, background: V2.surface,
        border: `1px solid ${tone}`, boxShadow: `inset 3px 0 0 ${tone}`,
      }}>
        <div style={{
          flexShrink: 0, width: '36px', height: '36px', borderRadius: V2.radiusMd,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          background: V2.bgElevated, color: tone,
        }}>
          {status.installed ? <FaExclamationTriangle size={16} /> : <FaGamepad size={17} />}
        </div>
        <div style={{ flex: '1 1 auto', minWidth: 0 }}>
          <div style={{ fontSize: '14px', fontWeight: 700 }}>
            {install.active ? 'Installing RetroArch'
              : status.installed ? copy.title
                : 'No emulator installed'}
          </div>
          <div style={{ fontSize: '12px', color: V2.fgMuted, lineHeight: 1.4, marginTop: '2px' }}>{body}</div>
          {install.active && <InstallProgressBar pct={install.pct} />}
        </div>
        {!install.active && (
          <Focusable noFocusRing flow-children="horizontal" style={{ display: 'flex', gap: '8px', flexShrink: 0 }}>
            {status.installed ? (
              <>
                <GameActionButton variant="emphasized" disabled={fixing} onClick={fixStale}
                  label={fixing ? 'Fixing…' : stale.length > 1 ? 'Fix all' : 'Fix'}
                  icon={fixing
                    ? <FaSync size={14} style={{ animation: 'spin 1s linear infinite' }} />
                    : <FaCheck size={14} />} />
                {/* Review it instead: Settings ▸ Folders shows every path and
                    what each would become. */}
                <GameActionButton variant="surface" onClick={() => libNavigate('/romm-sync-settings')}
                  icon={<FaChevronRight size={15} />} />
              </>
            ) : (
              <>
                {status.install.available && (
                  <GameActionButton variant="emphasized" onClick={startEmulatorInstall}
                    label="Install RetroArch" icon={<FaDownload size={14} />} />
                )}
                <GameActionButton variant="surface" onClick={() => libNavigate('/romm-sync-cores')}
                  icon={<FaChevronRight size={15} />} />
              </>
            )}
          </Focusable>
        )}
      </div>
    </div>
  );
}

function HomePanel({ onOpen, onOpenGroup, onBg, visible }:
  { onOpen: (g: LibGame) => void; onOpenGroup: (mode: string, g: LibGroup, gs: LibGroup[]) => void; onBg: (uri: string | null) => void; visible: boolean }) {
  // Seed from the module-level cache so re-mounting (tab switch back to Home)
  // paints instantly instead of flashing "Loading…" and refetching.
  const c0 = _homeCache;
  const [recent, setRecent] = useState<LibGame[]>(c0?.recent || []);
  const [continuePlaying, setContinuePlaying] = useState<LibGame[]>(c0?.continuePlaying || []);
  const [downloaded, setDownloaded] = useState<LibGame[]>(c0?.downloaded || []);
  const [platforms, setPlatforms] = useState<LibGroup[]>(c0?.platforms || []);
  const [collections, setCollections] = useState<LibGroup[]>(c0?.collections || []);
  const [loading, setLoading] = useState(!c0);
  const offline = useOffline();

  useEffect(() => {
    let alive = true;
    let retry: any = null;
    const load = async (attempt = 0) => {
      try {
        const [h, p, c] = await Promise.all([
          getHomeData(), getLibraryGroups('platform'), getLibraryGroups('collection'),
        ]);
        if (!alive) return;
        const prev = _homeCache;   // state mirrors this (seed + paired setStates)
        const next = { ...prev } as NonNullable<typeof _homeCache>;
        // Only setState when a list actually changed — the silent refresh runs
        // on every tab switch back to Home, and unconditional setStates with
        // fresh array identities re-rendered every tile (visible pop-in +
        // stutter) even when the data was byte-identical to the cache seed.
        const upd = <T,>(fresh: T, prev: T | undefined, set: (v: any) => void): T => {
          if (JSON.stringify(fresh) !== JSON.stringify(prev)) set(fresh);
          return fresh;
        };
        if (h?.success) {
          next.recent = upd(h.recent || [], prev?.recent, setRecent);
          next.downloaded = upd(h.downloaded_games || [], prev?.downloaded, setDownloaded);
        }
        // Continue playing is the one row fetched live from RomM, so it alone
        // can come back "unknown" (null) — not authenticated yet at boot,
        // offline, a 5xx. Keep whatever we last knew instead of blanking the
        // row; an empty ARRAY is a real answer and does clear it. Runs outside
        // the h.success guard so a failed payload can't clear it either.
        if (h?.continue_playing != null) {
          next.continuePlaying = upd(h.continue_playing, prev?.continuePlaying, setContinuePlaying);
        } else if (attempt < 3) {
          // Losing the race with login is the common case on a cold start, and
          // it resolves silently a second or two later — without this the row
          // would stay missing until something else triggered a reload.
          retry = setTimeout(() => { if (alive) load(attempt + 1); }, 2500);
        }
        if (p?.success) next.platforms = upd(p.groups || [], prev?.platforms, setPlatforms);
        if (c?.success) next.collections = upd(c.groups || [], prev?.collections, setCollections);
        // On a first run the wizard lands here while the initial fetch is still
        // going, so every one of these calls answers truthfully-empty: no games
        // yet means no Recently added, no platforms, no collections. Those
        // answers must not be cached — the seed is what Home paints on the next
        // mount, and nothing else would have gone back for the real ones.
        // Keep asking until the backend says the library is in.
        const notReady = h?.library_ready === false
          || p?.library_ready === false || c?.library_ready === false;
        if (notReady) {
          // Every 3s, capped at ~10min: enough for the 50–80k libraries this is
          // worst on, and bounded so a backend that never becomes ready doesn't
          // leave a poll running for the session.
          if (attempt < 200) {
            clearTimeout(retry);
            retry = setTimeout(() => { if (alive) load(attempt + 1); }, 3000);
          }
          return;
        }
        _homeCache = next;
        persistHomeCache();
      } catch (e) { console.error('home load failed', e); }
      finally { if (alive) setLoading(false); }
    };
    load();
    // Re-fetch on a manual "Refresh library" (account menu) so a same-tab
    // refresh shows up immediately instead of waiting for a tab switch.
    _libRefreshListeners.add(load);
    return () => { alive = false; clearTimeout(retry); _libRefreshListeners.delete(load); };
    // Re-fetch when connectivity flips: offline filters the library to
    // downloaded-only, so the rows must rebuild without a tab switch.
  }, [offline]);

  // Land focus on the first card of whichever row renders first, so the user can
  // navigate straight in (no DOWN press needed off the nav bar).
  const firstList = continuePlaying.length ? 'cp' : downloaded.length ? 'dl'
    : recent.length ? 'rc' : platforms.length ? 'pf' : collections.length ? 'cl' : null;
  // visible in the ready flag: the panel stays mounted while hidden, so the
  // focus grab must refire on each return to the tab, not just on mount.
  const firstRef = useAutoFocus(visible && !loading && firstList !== null, firstList);

  if (loading) return <HomeSkeleton />;
  return (
    <div style={{ paddingTop: '8px' }}>
      <EmulatorBanner />
      {/* Continue playing — per-user last_played from RomM (cross-device). */}
      {continuePlaying.length > 0 && (
        <CardRow icon={<FaPlay size={14} />} title="Continue playing" count={continuePlaying.length}>
          {continuePlaying.map((g, i) => (
            // Screenshot cards size to their natural (landscape) width; games
            // with no screenshot fall back to the portrait 132px cover.
            <div key={g.rom_id} style={{ flexShrink: 0, ...(g.screenshot ? {} : { width: '132px' }) }}>
              <GameTile game={g} onOpen={onOpen} onActiveCover={onBg}
                focusRef={firstList === 'cp' && i === 0 ? firstRef : undefined} focusable={visible} />
            </div>
          ))}
        </CardRow>
      )}

      {/* Downloaded — locally installed games, latest download first, so a
          just-downloaded game is one row away instead of a search away. */}
      {downloaded.length > 0 && (
        <CardRow icon={<FaDownload size={14} />} title="Downloaded" count={downloaded.length}>
          {downloaded.map((g, i) => (
            <div key={g.rom_id} style={{ width: '132px', flexShrink: 0 }}>
              <GameTile game={g} onOpen={onOpen} onActiveCover={onBg}
                focusRef={firstList === 'dl' && i === 0 ? firstRef : undefined} focusable={visible} />
            </div>
          ))}
        </CardRow>
      )}

      {/* Recently added */}
      {recent.length > 0 && (
        <CardRow icon={<FaRegClock size={16} />} title="Recently added" count={recent.length}>
          {recent.map((g, i) => (
            <div key={g.rom_id} style={{ width: '132px', flexShrink: 0 }}>
              <GameTile game={g} onOpen={onOpen} onActiveCover={onBg}
                focusRef={firstList === 'rc' && i === 0 ? firstRef : undefined} focusable={visible} />
            </div>
          ))}
        </CardRow>
      )}

      {/* Platforms */}
      {platforms.length > 0 && (
        <CardRow icon={<FaGamepad size={16} />} title="Platforms" count={platforms.length}>
          {platforms.map((g, i) => (
            <div key={g.key} style={{ width: '150px', flexShrink: 0 }}>
              <PlatformTile group={g} onOpen={(grp) => onOpenGroup('platform', grp, platforms)}
                focusRef={firstList === 'pf' && i === 0 ? firstRef : undefined} focusable={visible} />
            </div>
          ))}
        </CardRow>
      )}

      {/* Collections */}
      {collections.length > 0 && (
        <CardRow icon={<FaLayerGroup size={15} />} title="Collections" count={collections.length}>
          {collections.map((g, i) => (
            <div key={g.key} style={{ width: '132px', flexShrink: 0 }}>
              <CollectionTile group={g} onOpen={(grp) => onOpenGroup('collection', grp, collections)}
                focusRef={firstList === 'cl' && i === 0 ? firstRef : undefined} focusable={visible} />
            </div>
          ))}
        </CardRow>
      )}

      {continuePlaying.length === 0 && downloaded.length === 0 && recent.length === 0 && platforms.length === 0 && collections.length === 0 && (
        <div style={{ padding: '16px', color: V2.fgMuted, fontSize: '13px' }}>
          {offline
            ? 'No downloaded games yet. Reconnect to browse and download your library.'
            : 'No games in your library yet.'}
        </div>
      )}
    </div>
  );
}

// Platforms/Collections index grid — one component instance per mode, kept
// mounted across tab switches (the parent hides inactive panels with
// display:none) so switching back doesn't rebuild 150+ cover <img>s from
// scratch: measured on-device, each remount inserted ~170–270 fresh imgs and
// cost ~100–200ms of main-thread long tasks (the visible repopulation+stutter).
// L2/R2 alphabet fast-scroll ("letter scrubber", à la Big Picture): the visible
// GroupsPanel registers its jump function here; the library root page's
// onButtonDown dispatches trigger presses into it.
let _libLetterJump: ((dir: 1 | -1) => void) | null = null;
const _scrubLetterOf = (s: string) => {
  const c = (s || '').trim().charAt(0).toUpperCase();
  return c >= 'A' && c <= 'Z' ? c : '#';
};

// Entering a grid/row container from above or below should land on the tile in
// the SAME COLUMN you came from, not the container's remembered last-active
// child (Steam's default "preferred child" made UP/DOWN between rows snap back
// to wherever you were last in that row — verified on-device by live-patching
// nav nodes). 2 = NavEntryPositionPreferences.MAINTAIN_X (@decky/ui declares
// the enum but doesn't export it at runtime). Spread as any: not in decky's
// FocusableProps typing, but Steam's Focusable forwards it into m_Properties.
const NAV_MAINTAIN_X = { navEntryPreferPosition: 2 } as any;

// Fast-scroll glimpse (Big Picture-style): show the current letter only while
// the user is genuinely flying through the grid — a sustained run of held-repeat
// focus moves. Deliberate d-pad taps land ~250ms+ apart even when quick, while
// Steam's held-repeat cadence is well under 200ms, so the tight window plus a
// long streak keeps the overlay away from normal browsing.
let _scrubGlimpse: ((letter: string) => void) | null = null;
let _scrubFocusTs = 0;
let _scrubStreak = 0;
// The letter glimpse is for flying VERTICALLY through the alphabetized grid, so
// only a sustained run of fast ROW-TO-ROW moves should raise it. Browsing
// horizontally within a row must never trigger it — on a wide desktop row that's
// a long run of quick focus moves, which is exactly what popped the overlay
// unbidden. The shim records the axis of the last directional move on
// window.__rommNavH; a horizontal move resets the streak. On the Deck (Steam's
// native nav) the flag is undefined, so behaviour there is unchanged.
function _tileFocusScrub(_el: any, label: string) {
  if ((window as any).__rommNavH) { _scrubStreak = 0; return; }
  const now = Date.now();
  _scrubStreak = now - _scrubFocusTs < 200 ? _scrubStreak + 1 : 1;
  _scrubFocusTs = now;
  if (_scrubStreak >= 5) { try { _scrubGlimpse?.(_scrubLetterOf(label)); } catch { /* ignore */ } }
}

// Shared jump math: given the displayed labels and the current index, the index
// to land on. R2 → first item of the next letter block (last item from the last
// block); L2 → first item of the current block, or of the previous block when
// already there.
function _scrubTargetIdx(labels: string[], cur: number, dir: 1 | -1): number {
  const curL = _scrubLetterOf(labels[cur]);
  if (dir === 1) {
    for (let i = cur + 1; i < labels.length; i++) {
      if (_scrubLetterOf(labels[i]) !== curL) return i;
    }
    return labels.length - 1;
  }
  let start = cur;
  while (start > 0 && _scrubLetterOf(labels[start - 1]) === curL) start--;
  if (start === cur && start > 0) {
    const prevL = _scrubLetterOf(labels[start - 1]);
    let i = start - 1;
    while (i > 0 && _scrubLetterOf(labels[i - 1]) === prevL) i--;
    return i;
  }
  return start;
}

// Big Picture-style letter overlay shown while scrubbing — dims/blurs the
// whole screen (not just a small centered card) so the letter reads as a
// full-screen state change rather than a floating window.
function ScrubOverlay({ letter }: { letter: string | null }) {
  return (
    <div style={{
      position: 'fixed', inset: 0, display: 'grid', placeItems: 'center',
      pointerEvents: 'none', zIndex: 60,
      background: 'rgba(6,7,10,0.55)', backdropFilter: 'blur(6px)',
      opacity: letter ? 1 : 0, transition: 'opacity 0.18s ease',
    }}>
      <div style={{
        fontSize: '220px', fontWeight: 800, lineHeight: 1, color: V2.fg,
        textShadow: '0 12px 44px rgba(0,0,0,0.6)',
      }}>
        {letter ?? ''}
      </div>
    </div>
  );
}

function GroupsPanel({ mode, visible, onOpenGroup, svcStatus }:
  { mode: 'platform' | 'collection'; visible: boolean; onOpenGroup: (mode: string, g: LibGroup, gs: LibGroup[]) => void; svcStatus: any }) {
  const c0 = _groupsCache[mode];
  const [groups, setGroups] = useState<LibGroup[]>(c0 || []);
  const [loading, setLoading] = useState(!c0);
  const offline = svcStatus?.connection === 'offline_cached' || svcStatus?.connection === 'disconnected';

  // Silent refresh each time the tab becomes visible (and on connectivity
  // flips while visible — offline filters the list to downloaded-only). The
  // seq guard drops stale responses when the user bumper-cycles faster than
  // the RPC; the JSON compare skips the setState (and the full grid
  // re-render) when nothing changed, which is the common case.
  const seq = useRef(0);
  useEffect(() => {
    if (!visible) return;
    let retry: any = null;
    const load = async () => {
      const s = ++seq.current;
      try {
        const res = await getLibraryGroups(mode);
        if (s !== seq.current) return;
        if (res?.success) {
          const next: LibGroup[] = res.groups || [];
          // Same first-run trap as HomePanel: an answer given before the
          // initial fetch lands is empty and correct, and must not become the
          // cached seed. Show it, don't persist it, and come back for the
          // real one.
          if (res.library_ready === false) {
            setGroups(next);
            retry = setTimeout(() => { if (s === seq.current) load(); }, 3000);
            return;
          }
          if (JSON.stringify(next) !== JSON.stringify(_groupsCache[mode])) {
            _groupsCache[mode] = next;
            persistGroupsCache();
            setGroups(next);
          }
        } else if (!_groupsCache[mode]) {
          setGroups([]);
        }
      } catch (e) {
        console.error('get_library_groups failed', e);
      } finally {
        if (s === seq.current) setLoading(false);
      }
    };
    load();
    // Re-fetch on a manual "Refresh library" (account menu) so a same-tab
    // refresh shows up immediately instead of waiting for a tab switch.
    _libRefreshListeners.add(load);
    return () => { clearTimeout(retry); _libRefreshListeners.delete(load); };
  }, [visible, offline]);

  // visible in the ready flag so the focus grab refires on each return to the
  // tab (the panel no longer remounts). Backing out of a group should land on
  // the group you were just in, not the first tile — _libGroupHolder still
  // holds the last-viewed group (updated on open AND on L1/R1 paging).
  const lastKey = (_libGroupHolder && _libGroupHolder.mode === mode) ? _libGroupHolder.group.key : null;
  const focusKey = (lastKey && groups.some((g) => g.key === lastKey)) ? lastKey : (groups[0]?.key ?? null);
  const firstGroupRef = useAutoFocus(visible && !loading && groups.length > 0, `${mode}:${focusKey}`);
  const openGroup = (g: LibGroup) => onOpenGroup(mode, g, groups);

  // ---- L2/R2 letter scrubbing -------------------------------------------
  // Displayed order (collections render in three sections, so the jump order
  // must match what's on screen, not the raw list order).
  const order: LibGroup[] = mode === 'platform' ? groups
    : ([['favorite', 'collection'], ['smart'], ['virtual']] as string[][])
        .flatMap((kinds) => groups.filter((g) => kinds.includes(g.kind || 'collection')));
  const orderRef = useRef<LibGroup[]>(order);
  orderRef.current = order;
  // Every tile registers its DOM node so the jump can (a) locate the currently
  // focused tile via .gpfocus containment and (b) force focus onto the target.
  const tileEls = useRef(new Map<string, any>());
  const tileRef = (key: string, autoKey: string | null) => (el: any) => {
    if (el) tileEls.current.set(key, el); else tileEls.current.delete(key);
    if (key === autoKey) firstGroupRef.current = el;
  };
  // Big centered letter overlay while scrubbing (Big Picture-style).
  const [scrubLetter, setScrubLetter] = useState<string | null>(null);
  const scrubTimer = useRef<any>(null);
  useEffect(() => () => clearTimeout(scrubTimer.current), []);
  const showScrubRef = useRef<(l: string) => void>(() => { });
  showScrubRef.current = (l) => {
    setScrubLetter(l);
    clearTimeout(scrubTimer.current);
    scrubTimer.current = setTimeout(() => setScrubLetter(null), 750);
  };
  const jumpRef = useRef<(dir: 1 | -1) => void>(() => { });
  jumpRef.current = (dir) => {
    const ord = orderRef.current;
    if (!ord.length) return;
    const focusEl = _gpFocusEl();
    let cur = ord.findIndex((o) => {
      const el = tileEls.current.get(o.key);
      return !!(el && focusEl && el.contains(focusEl));
    });
    if (cur < 0) cur = 0;
    const target = _scrubTargetIdx(ord.map((o) => o.label), cur, dir);
    const g = ord[target];
    const el = tileEls.current.get(g.key);
    if (el && target !== cur) {
      _forceGamepadFocus(el);
      try { el.scrollIntoView({ block: 'center', behavior: 'smooth' }); } catch { /* ignore */ }
      playSteamSound('deck_ui_tab_transition_01');
    }
    showScrubRef.current(_scrubLetterOf(g.label));
  };
  useEffect(() => {
    if (!visible) return;
    const fn = (d: 1 | -1) => jumpRef.current(d);
    _libLetterJump = fn;
    // Fast-scroll glimpse: tiles report rapid focus moves here.
    const gl = (l: string) => showScrubRef.current(l);
    _scrubGlimpse = gl;
    return () => {
      if (_libLetterJump === fn) _libLetterJump = null;
      if (_scrubGlimpse === gl) _scrubGlimpse = null;
    };
  }, [visible]);
  const scrubOverlay = <ScrubOverlay letter={scrubLetter} />;
  // -----------------------------------------------------------------------

  if (loading) return <GroupGridSkeleton />;
  if (groups.length === 0) {
    return (
      <div style={{ padding: '16px', color: V2.fgMuted, fontSize: '13px' }}>
        {offline
          ? (mode === 'collection'
              ? "Collections aren't available offline — reconnect to browse them."
              : 'No downloaded games yet. Reconnect to download from your library.')
          : (mode === 'collection' ? 'No collections found on the server.' : 'No games found.')}
      </div>
    );
  }
  if (mode === 'platform') {
    return (
      <Focusable noFocusRing {...NAV_MAINTAIN_X}
        style={{
          display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))',
          // 16px + the 8px tab spacer = 24px above row one; the bottom gap
          // comes from v2Page's 64px page padding, which nets ~22px of visible
          // clearance above Steam's 42px footer legend once scrolled — the
          // same breathing room as the top.
          gap: '14px', padding: '16px 16px 0',
        }}
      >
        {groups.map((g) => <PlatformTile key={g.key} group={g} onOpen={openGroup} focusRef={tileRef(g.key, focusKey)} focusable={visible} />)}
        {scrubOverlay}
      </Focusable>
    );
  }
  // Collections, grouped into sections (Collections / Smart / Virtual) like
  // RomM's collection index.
  const sections: { title: string; kinds: string[] }[] = [
    { title: 'Collections', kinds: ['favorite', 'collection'] },
    { title: 'Smart', kinds: ['smart'] },
    { title: 'Virtual', kinds: ['virtual'] },
  ];
  // Focus target across all sections: the remembered group (focusKey) if it
  // renders here, else the very first rendered tile.
  let firstKey: string | null = null;
  for (const s of sections) {
    const it = groups.find((g) => s.kinds.includes(g.kind || 'collection'));
    if (it) { firstKey = it.key; break; }
  }
  if (focusKey && groups.some((g) => g.key === focusKey)) firstKey = focusKey;
  return (
    <div style={{ paddingTop: '16px' }}>
      {scrubOverlay}
      {sections.map((s) => {
        const items = groups.filter((g) => s.kinds.includes(g.kind || 'collection'));
        if (items.length === 0) return null;
        return (
          <div key={s.title} style={{ marginBottom: '6px' }}>
            <div style={{
              fontSize: '11px', fontWeight: 700, letterSpacing: '0.06em',
              textTransform: 'uppercase', color: V2.fgMuted, padding: '6px 16px 10px',
              display: 'flex', alignItems: 'center', gap: '6px',
            }}>
              <FaBookmark size={10} /><span>{s.title}</span>
            </div>
            <Focusable noFocusRing {...NAV_MAINTAIN_X}
              style={{
                display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(132px, 1fr))',
                gap: '18px 16px', padding: '0 16px 8px',
              }}
            >
              {items.map((g) => <CollectionTile key={g.key} group={g} onOpen={openGroup} focusRef={tileRef(g.key, firstKey)} focusable={visible} />)}
            </Focusable>
          </div>
        );
      })}
    </div>
  );
}

// Slim, full-width strip shown ONLY when the backend reports a non-online
// connection state. It explains what offline means rather than just flagging an
// error: cached browse + downloaded-game launch keep working, and any saves made
// offline will sync on reconnect. Self-hides when online so the normal case is
// untouched. Reads connection/snapshot_fetched_at/pending_saves from
// get_service_status (see main.py get_service_status).
function OfflineBanner({ status }: { status: any }) {
  const conn = status?.connection;
  // A library fetch in flight is worth a banner even when the connection is
  // healthy — that IS the normal case, since auth completes long before the
  // fetch does. Without this the loading state was unreachable in practice.
  const loading = status?.library_progress;
  if (!conn || (conn === 'online' && !loading)) return null;

  // Distinguish "the Deck has no internet" from "the Deck is online but the
  // RomM server isn't responding" — same offline browse experience, but the
  // cause (and what the user should check) is different.
  const reason = status?.unreachable_reason;
  const airplane = reason === 'airplane_mode';
  // 'airplane_mode' and 'no_network' share the "device has no connectivity"
  // experience; only the remedy copy differs (toggle airplane vs. join a
  // network). 'server_unreachable' is the device-online-but-server-down case.
  const noNetwork = airplane || reason === 'no_network';
  const pending = status?.pending_saves || 0;

  // Short title fragment + remedy sentence for the no-connectivity cases.
  const netTitle = airplane ? 'Airplane mode is on' : 'No internet connection';
  const netRemedy = airplane
    ? 'Turn off airplane mode to browse your library and sync saves.'
    : 'Connect to a network to browse your library and sync saves.';

  let dot = V2.warning, title = '', detail = '';
  if (conn === 'connecting' || (conn === 'online' && loading)) {
    dot = V2.fgMuted;
    // Connecting is over in well under a second; the rest of the wait is the
    // library, so say so and put a number on it. A count that moves is what
    // separates "busy" from "hung" — which is the whole reason a big library
    // felt broken. No percentage bar: it implies an ETA we can't honour when
    // the server stalls mid-fetch.
    const prog = status?.library_progress;
    // Nothing has ever been fetched, so there is nothing downloaded to fall
    // back on — the "play your downloaded games meanwhile" line is only true
    // from the second run onward, and on a first run it points at an empty
    // library. snapshot_fetched_at is present in both status branches and is
    // null until a fetch has succeeded once.
    const firstRun = !status?.snapshot_fetched_at;
    const meanwhile = firstRun ? '' : ' — you can play your downloaded games meanwhile';
    if (prog?.total > 0) {
      title = 'Loading your library…';
      detail = `${(prog.loaded ?? 0).toLocaleString()} of ${prog.total.toLocaleString()} games${meanwhile}.`;
    } else {
      title = prog ? 'Loading your library…' : 'Connecting to RomM…';
      detail = firstRun
        ? 'This can take a minute on a large library.'
        : 'Your downloaded games are ready to play in the meantime.';
    }
  } else if (conn === 'offline_cached') {
    dot = V2.warning;
    title = noNetwork
      ? `${netTitle} — showing your downloaded games`
      : "Can't reach your RomM server — showing your downloaded games";
    detail = noNetwork
      ? `Only games saved on this device are shown. ${netRemedy} Your full library and saves sync when you’re back online.`
      : 'The server isn’t responding. Only games saved on this device are shown; everything syncs once it’s reachable.';
  } else { // 'disconnected' — no cached library to show
    dot = V2.danger;
    title = noNetwork ? netTitle : "Can't reach your RomM server";
    detail = noNetwork
      ? netRemedy
      : 'Your device is online but the RomM server isn’t responding. Check that it’s running and reachable.';
  }

  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: '10px',
      margin: '0 16px 8px', padding: '8px 12px',
      background: V2.surface, border: `1px solid ${V2.borderStrong}`,
      borderRadius: V2.radiusMd, fontSize: '12px',
    }}>
      <div style={{
        width: '8px', height: '8px', borderRadius: '50%', flexShrink: 0,
        background: dot, boxShadow: `0 0 6px ${dot}`,
      }} />
      <div style={{ minWidth: 0 }}>
        <div style={{ fontWeight: 600, color: V2.fg }}>{title}</div>
        <div style={{ color: V2.fgMuted, marginTop: '1px' }}>{detail}</div>
        {conn !== 'connecting' && pending > 0 && (
          <div style={{ color: V2.brandHover, marginTop: '4px', fontWeight: 600 }}>
            {pending === 1 ? '1 game waiting to sync' : `${pending} games waiting to sync`}
          </div>
        )}
      </div>
    </div>
  );
}

// Route component for /romm-sync-library. Hosts the tabs page permanently and
// stacks the inner pages (game grid, game detail, settings family) on top as
// internal views, so backing out of any of them re-shows the still-mounted
// tabs tree instead of rebuilding it (see the LibView comment above).
function LibraryRootPage() {
  const [stack, setStack] = useState<LibView[]>([]);
  const viewRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    _libPushView = (v) => setStack((s) => [...s, v]);
    _libPopView = () => setStack((s) => s.slice(0, -1));
    return () => { _libPushView = null; _libPopView = null; };
  }, []);

  // Logged-out guard: after a logout the credentials are cleared, but the tile
  // still launches straight into this route (and Back can land here too). If
  // RomM is no longer configured, don't show a stale signed-out home — bounce to
  // the setup wizard so the only way forward is signing back in.
  useEffect(() => {
    (async () => {
      try {
        const c = await getConfig();
        if (!c?.configured) {
          try { Navigation.NavigateBack(); } catch { /* ignore */ }
          setTimeout(() => { try { Navigation.Navigate("/romm-sync-setup"); } catch { /* ignore */ } }, 60);
        }
      } catch { /* ignore */ }
    })();
  }, []);
  const top = stack.length ? stack[stack.length - 1] : null;

  // An internally pushed view gets no route-change focus pass from Steam (that
  // only happens on real navigation), so pull gamepad focus onto its first
  // focusable element — unless the page's own autofocus (e.g. the grid's first
  // tile) already landed inside it. On pop, no work is needed here: the tab
  // panels' useAutoFocus re-fires when their `visible` flips back on and lands
  // on the first item, exactly what a route remount used to do.
  useEffect(() => {
    if (!top) return;
    const timers = [80, 240, 500].map((d) => setTimeout(() => {
      try {
        const host = viewRef.current;
        if (!host) return;
        const cur = _gpFocusEl();
        if (cur && host.contains(cur)) return;
        const first = host.querySelector('[tabindex]') as HTMLElement | null;
        if (first) _forceGamepadFocus(first);
      } catch { /* ignore */ }
    }, d));
    return () => timers.forEach(clearTimeout);
  }, [top]);

  return (
    <>
      {/* Never unmounts while inside the library — that's the whole point.
          NOTE display:none does NOT remove hidden Focusables from gamepad nav
          (verified on-device — they linger as 0×0 "phantom" focus targets);
          the tiles opt out themselves via focusable={visible}. */}
      <div style={{ display: top ? 'none' : undefined }}>
        <LibraryGroupsPage covered={!!top} />
      </div>
      {top && (
        <div ref={viewRef}>
          {top === 'grid' && <LibraryGamesPage />}
          {top === 'game' && <GameDetailPage />}
          {top === 'settings' && <SettingsPage />}
          {top === 'stats' && <StatsPage />}
          {top === 'cores' && <CoresPage />}
          {top === 'downloads' && <DownloadsPage />}
        </div>
      )}
    </>
  );
}

function LibraryGroupsPage({ covered = false }: { covered?: boolean }) {
  // Reaching the library is the success signal for the post-update "reopen Home"
  // breadcrumb — consume it here (not on plugin load) so it survives the double
  // reload the installer causes. See the _LS_REOPEN_HOME consumer in definePlugin.
  useEffect(() => { try { localStorage.removeItem(_LS_REOPEN_HOME); } catch { /* ignore */ } }, []);
  // Opening the Game Browser counts as "using RomM": surface the tile in the
  // home row's Recent Games even when no emulator session runs this visit.
  useEffect(() => { touchRommRecency(); }, []);
  const [active, setActive] = useState<NavId>(_libLastTab);
  const [bgUri, setBgUri] = useState<string | null>(null);
  const svcStatus = useServiceStatus();

  // Panels mount lazily on first visit, then STAY mounted (hidden with
  // display:none) — see GroupsPanel's comment for the measured remount cost.
  const seenRef = useRef<Record<string, boolean>>({});
  seenRef.current[active] = true;
  const seen = seenRef.current;

  // Home rows carry their own mode + sibling list (independent of the active tab).
  const openGroupFrom = (m: string, g: LibGroup, gs: LibGroup[]) => {
    _libGroupHolder = { mode: m, group: g };
    _libGroupsHolder = { mode: m, groups: gs };
    if (_libPushView) _libPushView('grid');
    else Navigation.Navigate(`/romm-sync-library/${encodeURIComponent(g.key)}`);
  };

  const openGame = (g: LibGame) => {
    _libGameHolder = g;
    // Opened from the home/search/index grid → back returns to the library root.
    _libGameOrigin = "/romm-sync-library";
    if (_libPushView) _libPushView('game');
    else Navigation.Navigate(`/romm-sync-game/${g.rom_id}`);
  };

  const onTab = (id: NavId) => { _libLastTab = id; setActive(id); };

  // L1 / R1 page through the nav tabs (BackgroundArt cleared on home/search).
  // After switching, the active panel remounts and drops gamepad focus, so we
  // re-anchor focus on the persistent active nav pill — otherwise Steam eats the
  // next bumper press to re-acquire focus (the "press twice to switch" bug).
  const navPillRef = useRef<any>(null);

  // Returning from an emulator session: the session-end watch navigated here,
  // but after a game exits Steam re-acquires gamepad focus onto its own chrome
  // on a slower schedule than a plain tab switch — the page renders with no
  // visible selection and the dpad does nothing predictable. Pull focus onto
  // the persistent nav pill with a longer retry tail than useAutoFocus.
  useEffect(() => {
    if (!_rommReturnFocusPending) return;
    _rommReturnFocusPending = false;
    // Steam's input pipeline swallows the first button press after a session
    // to wake itself back up (the "press twice" bug: LB/RB, dpad, anything).
    // Feed it a sacrificial virtual press of an unbound button (INVALID=0) so
    // the wake-up happens now and the user's first real press lands.
    try { (window as any).FocusNavController?.DispatchVirtualButtonClick?.(0, true); } catch { /* ignore */ }
    // After a game exits Steam often parks gamepad focus on our ROOT Focusable
    // (noFocusRing — buttons respond but nothing is highlighted) or on its own
    // chrome, so "some element has .gpfocus" is not success. Poll and re-assert
    // focus onto the target, but ONLY while focus is somewhere unhelpful — the
    // nav pill fallback or outside our UI (Steam chrome). The instant focus is
    // on any real element inside our content (the target, OR a sibling tile the
    // user has already navigated to), hand off and stop: re-forcing then would
    // yank the user back to the first tile the moment they press a direction
    // (the "press right → snaps back to the first game" bug). Give up after 8s.
    const started = Date.now();
    const iv = setInterval(() => {
      try {
        if (Date.now() - started > 8000) { clearInterval(iv); return; }
        const first = _autoFocusFirstRef?.current;
        const target = (first && first.isConnected) ? first : navPillRef.current;
        const cur = _gpFocusEl();
        // Done: focus reached a REAL target tile (not the nav-pill fallback,
        // which is invisible — keep polling for the real first item then).
        const onRealTarget = target && target !== navPillRef.current;
        if (onRealTarget && cur && (cur === target || (typeof target.contains === 'function' && target.contains(cur)))) { clearInterval(iv); return; }
        // Hand off: focus is on a real element inside our content that isn't the
        // nav-pill fallback — the user is now driving, don't fight them.
        const inOurUI = cur && typeof (cur as any).closest === 'function' && (cur as any).closest('.romm-ui');
        const onNavPill = cur && navPillRef.current && (cur === navPillRef.current || (typeof navPillRef.current.contains === 'function' && navPillRef.current.contains(cur)));
        if (inOurUI && !onNavPill) { clearInterval(iv); return; }
        // Otherwise focus is nowhere useful (null / Steam chrome / nav pill) —
        // keep pulling it to the target.
        if (target) _forceGamepadFocus(target);
      } catch { /* ignore */ }
    }, 250);
    return () => clearInterval(iv);
  }, []);

  const cycle = (dir: -1 | 1) => {
    const i = NAV_ORDER.indexOf(active);
    const next = NAV_ORDER[(i + dir + NAV_ORDER.length) % NAV_ORDER.length];
    playSteamSound('deck_ui_tab_transition_01');   // native LB/RB tab-switch sound
    _libLastTab = next;
    setActive(next);
    // Bridge the remount gap with a SINGLE pill focus, then hand off to the new
    // panel's useAutoFocus (which retries onto its first item). This timer fires
    // before the panel mounts, so its useAutoFocus runs afterwards and wins the
    // final resting place — the first tile/field, matching a fresh tab switch.
    // Don't keep re-focusing the pill on a retry ladder: that raced useAutoFocus
    // and yanked focus back to the pill after the panel had already moved it,
    // leaving BOTH the pill and the first item highlighted (the double-focus).
    // The lone pill focus only lingers while the destination is still loading
    // (no item to focus yet); once it loads, useAutoFocus takes over.
    // _forceGamepadFocus, not plain focus(): post-session the window is
    // OS-unfocused (no DOM focus events), so focus() moves nothing gamepad-wise
    // and Steam eats the next bumper press re-acquiring focus.
    setTimeout(() => { try { if (navPillRef.current) _forceGamepadFocus(navPillRef.current); } catch { } }, 0);
  };

  // Top-bar chrome (account + RetroDECK) is fetched here — not inside V2NavBar —
  // so the same data drives the visible pills AND the controller shortcuts below.
  // The side clusters (RetroDECK button, user pill) sit in separate grid columns
  // that Steam's directional focus can't reliably reach from the content grid, so
  // we expose them as buttons too: Y opens the user menu, X launches RetroDECK.
  const chrome = useNavChrome();
  const launchRd = async () => {
    try {
      const r = await launchRetrodeckViaSteam();
      if (r.ok) { try { Navigation.CloseSideMenus(); } catch { /* ignore */ } }
      else toaster.toast({ title: 'RetroDECK', body: r.reason || 'Launch failed' });
    } catch (e) { toaster.toast({ title: 'RetroDECK', body: String(e) }); }
  };
  const openUserMenu = () => showModal(
    <UserMenuModal username={chrome.username} role={chrome.role} avatar={chrome.avatar} />,
  );

  const onButtonDown = (evt: any) => {
    const b = evt?.detail?.button;
    if (b === GamepadButton.BUMPER_LEFT) cycle(-1);
    else if (b === GamepadButton.BUMPER_RIGHT) cycle(1);
    else if (b === GamepadButton.SELECT) { playSteamSound('deck_ui_show_modal'); libNavigate("/romm-sync-settings"); }
    else if (b === GamepadButton.OPTIONS) openUserMenu();               // Y → account menu
    else if (b === GamepadButton.START) openUserMenu();                 // ☰ Start → account menu
    // L2/R2 → alphabet fast-scroll on the platform/collection grids (repeats
    // allowed so holding the trigger keeps scrubbing).
    else if (b === GamepadButton.TRIGGER_LEFT || b === GamepadButton.TRIGGER_RIGHT) {
      if (active === 'platforms' || active === 'collections') {
        _libLetterJump?.(b === GamepadButton.TRIGGER_RIGHT ? 1 : -1);
      }
    }
  };
  // X → RetroDECK, but through Steam's action-button dispatch (NOT the raw
  // onButtonDown hook): onButtonDown sees every press in the tree, so it also
  // fired when X was pressed on a game tile whose own onSecondaryButton opens
  // the detail page — the tile opened Details AND RetroDECK launched over it.
  // As an action handler, the focused tile consumes X first and this only runs
  // when nothing focused claims it.
  const onSecondary = chrome.rdEnabled ? launchRd : undefined;

  // B at the library root: consume it and leave the plugin UI deliberately.
  // Every inner page "backs out" by PUSHING /romm-sync-library (Steam's default
  // NavigateBack misbehaves on custom Decky routes), so the history stack fills
  // with our own routes — letting Steam's default back run here popped that
  // stack and bounced the user between home and the page they just left,
  // endlessly. Exiting to Steam's library breaks the loop.
  const onExit = navExitPlugin;

  // Surface the page-level shortcuts in Steam's NATIVE bottom hint bar (not a
  // custom overlay). Settings goes through actionDescriptionMap because Select
  // (the View button) has no dedicated on*ActionDescription prop — and Steam
  // slots that map entry into the far-left navigation cluster of the footer,
  // ahead of the A/B/X/Y group. Account (Y) and RetroDECK (X) use their standard
  // named props. Set on the root Focusable so the labels show for the whole
  // library regardless of which tile is focused (a focused tile only overrides
  // the specific buttons it defines).
  return v2Page(
    <Focusable noFocusRing onButtonDown={onButtonDown}
      onSecondaryButton={onSecondary} onCancelButton={onExit}
      actionDescriptionMap={{ [GamepadButton.SELECT]: 'Settings', [GamepadButton.START]: 'Account' }}
      onOptionsActionDescription="Account"
      onSecondaryActionDescription={chrome.rdEnabled ? 'RetroDECK' : undefined}>
      <V2NavBar active={active} onTab={onTab} activeRef={navPillRef} chrome={chrome} onLaunchRd={launchRd} />

      <div style={{ height: '8px' }} />

      <OfflineBanner status={svcStatus} />

      {/* All four panels stay mounted once visited; only the active one is
          displayed. Unmounting on switch rebuilt every cover <img> and cost
          ~100–200ms long tasks per switch (measured on-device). `covered`
          (an inner view is stacked on top of this whole page) gates `visible`
          too, so a hidden panel's useAutoFocus can't steal gamepad focus from
          the view above when a silent refetch changes its first item. */}
      <div style={{ display: active === 'home' ? undefined : 'none' }}>
        {seen['home'] && <HomePanel visible={!covered && active === 'home'} onOpen={openGame} onOpenGroup={openGroupFrom} onBg={setBgUri} />}
      </div>
      <div style={{ display: active === 'platforms' ? undefined : 'none' }}>
        {seen['platforms'] && <GroupsPanel mode="platform" visible={!covered && active === 'platforms'} onOpenGroup={openGroupFrom} svcStatus={svcStatus} />}
      </div>
      <div style={{ display: active === 'collections' ? undefined : 'none' }}>
        {seen['collections'] && <GroupsPanel mode="collection" visible={!covered && active === 'collections'} onOpenGroup={openGroupFrom} svcStatus={svcStatus} />}
      </div>
      <div style={{ display: active === 'search' ? undefined : 'none' }}>
        {seen['search'] && <SearchPanel visible={!covered && active === 'search'} onOpen={openGame} onBg={setBgUri} />}
      </div>
    </Focusable>,
    bgUri,
  );
}

function LibraryGamesPage() {
  const holder = _libGroupHolder;
  const mode = holder?.mode || 'platform';
  const [group, setGroup] = useState<LibGroup | null>(holder?.group || null);
  const cacheKey = (k: string) => `${mode}:${k}`;
  const cached0 = group ? _libGamesCache.get(cacheKey(group.key)) : undefined;
  const [games, setGames] = useState<LibGame[]>(cached0 || []);
  const [loading, setLoading] = useState(!cached0);
  const [bgUri, setBgUri] = useState<string | null>(null);

  // Sibling groups (same mode) so the game grid can page prev/next with L1/R1.
  const siblings = (_libGroupsHolder && _libGroupsHolder.mode === mode) ? _libGroupsHolder.groups : [];

  // Prefetch a neighbour group's games LIST only (cheap, small JSON) so an
  // L1/R1 page lands instantly. Covers are deliberately NOT warmed here — those
  // tiles aren't on screen, and warming ~18 covers per neighbour fetched ~70
  // covers (≈14MB of base64) for platforms the user never opened, which is what
  // caused the load freeze. Each tile fetches its own cover when it mounts.
  const prefetch = async (key: string) => {
    const ck = cacheKey(key);
    if (_libGamesCache.get(ck)) return;
    try {
      const res = await getLibraryGames(mode, key);
      const list: LibGame[] | null = res?.success ? (res.games || []) : null;
      if (list) libCacheSet(ck, list);
    } catch { /* best-effort prefetch */ }
  };

  useEffect(() => {
    let alive = true;
    (async () => {
      if (!group) { setLoading(false); return; }
      setBgUri(null);
      const ck = cacheKey(group.key);
      const hit = _libGamesCache.get(ck);
      if (hit) {
        // Instant: real covers slide in with the carousel, no pop-in.
        setGames(hit); setLoading(false);
        // …then silently reconcile against the backend. The cache survives
        // restarts (localStorage), so a game deleted off-device in a previous
        // session would otherwise keep showing as downloaded until the 24h TTL —
        // and launching it fails ("not downloaded"). Refetch and, if the
        // download state (or membership) drifted, repaint from truth.
        (async () => {
          try {
            const res = await getLibraryGames(mode, group.key);
            if (!alive || !res?.success) return;
            const fresh: LibGame[] = res.games || [];
            const changed = fresh.length !== hit.length ||
              fresh.some((g, i) => g.rom_id !== hit[i]?.rom_id ||
                                   !!g.is_downloaded !== !!hit[i]?.is_downloaded);
            if (changed) { libCacheSet(ck, fresh); setGames(fresh); }
          } catch { /* offline / transient — keep the cached paint */ }
        })();
      } else {
        setLoading(true);
        try {
          const res = await getLibraryGames(mode, group.key);
          if (res?.success) libCacheSet(ck, res.games || []);
          if (alive) setGames(res?.success ? (res.games || []) : []);
        } catch (e) {
          console.error('get_library_games failed', e);
          if (alive) setGames([]);
        } finally {
          if (alive) setLoading(false);
        }
      }
      // Warm the immediate neighbours so the next L1/R1 is instant.
      const i = siblings.findIndex((s) => s.key === group.key);
      if (i >= 0) {
        const nbrs = [siblings[i - 1], siblings[i + 1],
        siblings[(i + 1) % siblings.length], siblings[(i - 1 + siblings.length) % siblings.length]];
        for (const n of nbrs) if (n) prefetch(n.key);
      }
    })();
    return () => { alive = false; };
  }, [group?.key]);

  // Repaint from cache when a download/delete/refresh elsewhere flips a game's
  // state (libCacheSetDownloaded → _broadcastLibRefresh). Without this, a
  // launch-failure self-heal or a delete on another surface wouldn't update the
  // tiles mounted here until the group was re-entered.
  useEffect(() => {
    if (!group) return;
    const ck = cacheKey(group.key);
    const l = () => { const list = _libGamesCache.get(ck); if (list) setGames(list); };
    _libRefreshListeners.add(l);
    return () => { _libRefreshListeners.delete(l); };
  }, [group?.key]);

  // Once games load (initial entry or after L1/R1 paging), drop focus onto the
  // first tile so the user can navigate straight into the grid — no extra DOWN
  // press to leave the header carousel.
  const firstTileRef = useAutoFocus(!loading && games.length > 0, group?.key);

  // Progressive mount: a big platform (e.g. GBA = 480 games) mounted all tiles
  // in one commit → ~360ms layout before anything showed. Render the first
  // screenful immediately, then grow the count in chunks across frames so first
  // paint is fast and the rest fill in without blocking. Covers are viewport-
  // gated already, so off-screen appended tiles cost almost nothing.
  // On-demand mount (infinite scroll): rather than eagerly mounting all 480
  // tiles for a big platform (480 Focusable trees is inherently heavy, even
  // spread across frames), keep only what's reached. A sentinel below the last
  // rendered tile grows the count by a chunk whenever it nears the viewport, so
  // typically ~2-3 screens of tiles are mounted and the grid stays fluid.
  const GRID_FIRST = 30, GRID_CHUNK = 30;
  const [visN, setVisN] = useState(() => Math.min(games.length || 0, GRID_FIRST));
  useEffect(() => { setVisN(Math.min(games.length || 0, GRID_FIRST)); }, [group?.key]);
  // Focus-driven growth — the reliable trigger under gamescope. When the
  // focused tile nears the end of the mounted set, mount another chunk. (The IO
  // sentinel below stays as a touch-scroll fallback.) Stable identity via refs
  // so it doesn't invalidate memo(GameTile).
  const visNRef = useRef(visN); visNRef.current = visN;
  const gamesLenRef = useRef(games.length); gamesLenRef.current = games.length;
  const gamesRef = useRef(games); gamesRef.current = games;
  const onTileFocus = useRef((i: number) => {
    if (i >= visNRef.current - 12)
      setVisN((n) => Math.min(gamesLenRef.current, Math.max(n, i + 1 + GRID_CHUNK)));
  }).current;

  const sentinelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (visN >= games.length) return;
    const el = sentinelRef.current;
    const bump = () => setVisN((n) => Math.min(games.length, n + GRID_CHUNK));
    // ~one screen of lookahead — enough that tiles are ready just before you
    // reach them, without over-mounting rows you may never scroll to.
    if (!el || typeof IntersectionObserver === 'undefined') { bump(); return; }
    let io: IntersectionObserver | null = null;
    try {
      io = new IntersectionObserver((es) => { if (es.some((e) => e.isIntersecting)) bump(); },
        { rootMargin: '400px' });
      io.observe(el);
    } catch { bump(); }
    return () => { try { io?.disconnect(); } catch { } };
  }, [visN, games.length]);

  // Stable identity across renders so memo(GameTile) isn't invalidated every
  // time the page re-renders (e.g. on background-art / progress updates). The
  // latest `group` is read through a ref.
  const openGameImpl = (g: LibGame) => {
    _libGameHolder = g;
    // Return to THIS collection/platform's games page when backing out.
    _libGameOrigin = group ? `/romm-sync-library/${encodeURIComponent(group.key)}` : "/romm-sync-library";
    if (_libPushView) _libPushView('game');
    else Navigation.Navigate(`/romm-sync-game/${g.rom_id}`);
  };
  const openGameImplRef = useRef(openGameImpl);
  openGameImplRef.current = openGameImpl;
  const openGame = useRef((g: LibGame) => openGameImplRef.current(g)).current;

  // Memoize the tile elements so a background-art re-render (setBgUri fires on
  // EVERY focus move) reuses the same element references instead of rebuilding
  // and re-diffing all `visN` tiles — that O(mounted) reconciliation per dpad
  // press is what made scrolling degrade as more tiles mounted. Recomputed only
  // when the game list or mounted count actually changes.
  // ---- L2/R2 letter scrubbing (same UX as the index grids) ---------------
  // Every mounted tile registers its DOM node; the jump grows visN first (the
  // target tile may not be mounted yet — the grid is virtualized) and then
  // retries focusing until the tile appears.
  const gameTileEls = useRef(new Map<number, any>());
  const gameTileRef = (romId: number, first: boolean) => (el: any) => {
    if (el) gameTileEls.current.set(romId, el); else gameTileEls.current.delete(romId);
    if (first) firstTileRef.current = el;
  };
  const [scrubLetter, setScrubLetter] = useState<string | null>(null);
  const scrubTimer = useRef<any>(null);
  const scrubFocusTimer = useRef<any>(null);
  useEffect(() => () => { clearTimeout(scrubTimer.current); clearTimeout(scrubFocusTimer.current); }, []);
  const showScrubRef = useRef<(l: string) => void>(() => { });
  showScrubRef.current = (l) => {
    setScrubLetter(l);
    clearTimeout(scrubTimer.current);
    scrubTimer.current = setTimeout(() => setScrubLetter(null), 750);
  };
  // Fast-scroll glimpse while this page is up (tiles report rapid focus moves).
  useEffect(() => {
    const gl = (l: string) => showScrubRef.current(l);
    _scrubGlimpse = gl;
    return () => { if (_scrubGlimpse === gl) _scrubGlimpse = null; };
  }, []);
  const scrubJump = (dir: 1 | -1) => {
    const list = gamesRef.current;
    if (!list.length) return;
    const focusEl = _gpFocusEl();
    let cur = -1;
    if (focusEl) {
      for (let i = 0; i < list.length; i++) {
        const el = gameTileEls.current.get(list[i].rom_id);
        if (el && el.contains(focusEl)) { cur = i; break; }
      }
    }
    if (cur < 0) cur = 0;
    const target = _scrubTargetIdx(list.map((g) => g.name), cur, dir);
    const g = list[target];
    if (target !== cur) {
      setVisN((n) => Math.min(gamesLenRef.current, Math.max(n, target + 1 + GRID_CHUNK)));
      const tryFocus = (attempt: number) => {
        const el = gameTileEls.current.get(g.rom_id);
        if (el) {
          _forceGamepadFocus(el);
          try { el.scrollIntoView({ block: 'center', behavior: 'smooth' }); } catch { /* ignore */ }
          playSteamSound('deck_ui_tab_transition_01');
        } else if (attempt < 8) scrubFocusTimer.current = setTimeout(() => tryFocus(attempt + 1), 80);
      };
      clearTimeout(scrubFocusTimer.current);
      tryFocus(0);
    }
    showScrubRef.current(_scrubLetterOf(g.name));
  };
  // -----------------------------------------------------------------------

  const gridTiles = useMemo(() => games.slice(0, visN).map((g, i) => (
    <GameTile key={g.rom_id} game={g} onOpen={openGame} onActiveCover={setBgUri}
      focusRef={gameTileRef(g.rom_id, i === 0)} index={i} onFocusIdx={onTileFocus} />
  )), [games, visN]);

  // L1 / R1 page through sibling groups (same mode) without backing out.
  // (`siblings` is declared above for the prefetch logic.)
  // Re-anchor focus on the persistent header row after paging — the games grid
  // remounts on group change and drops gamepad focus, which would otherwise make
  // Steam eat the next bumper press ("press twice to switch").
  const headerRef = useRef<any>(null);
  // The selected slot grows to fit its full label (no truncation); measure its
  // real width so the track translate keeps it perfectly centred.
  const selSlotRef = useRef<HTMLDivElement | null>(null);
  const [selW, setSelW] = useState(120);
  // Right-hand status column (count + synced dot, or live sync progress). It's
  // content-sized so the count never clips on smaller screens; we measure its
  // real width and mirror it to the left spacer so the carousel stays centred.
  const railRef = useRef<HTMLDivElement | null>(null);
  const [railW, setRailW] = useState(64);
  // Which carousel name slot holds gamepad focus — the unselected slots are
  // half-faded, so without an explicit focus tint, landing on one (UP from the
  // first grid row) read as "selection disappeared".
  const [focSlot, setFocSlot] = useState<string | null>(null);
  // Focus/hover state for the games-count action trigger, so it reads as a
  // pressable control rather than a static label.
  const [actHot, setActHot] = useState(false);
  // Direction of the last group change, so the games grid slides in from the same
  // side as the carousel — making the header + covers read as one moving surface.
  const [slideDir, setSlideDir] = useState<1 | -1>(1);
  const cycle = (dir: -1 | 1) => {
    if (!group || siblings.length < 2) return;
    const i = siblings.findIndex((s) => s.key === group.key);
    if (i < 0) return;
    const next = siblings[(i + dir + siblings.length) % siblings.length];
    setSlideDir(dir);
    _libGroupHolder = { mode, group: next };
    setGroup(next);
    requestAnimationFrame(() => { try { if (headerRef.current) _forceGamepadFocus(headerRef.current); } catch { } });
  };
  // Collection auto-sync toggle (Y). Keyed by collection name (== group.key).
  // Optimistic local override layered over the backend's `synced` flag so the
  // header reflects the change instantly; backend persists it to settings.ini.
  const isCollection = mode === 'collection';
  // Virtual collections are browse/download only (no auto-sync, no local-delete).
  const isVirtual = !!group?.virtual;
  const [syncOverrides, setSyncOverrides] = useState<Record<string, boolean>>({});
  const isSynced = isCollection && !isVirtual && group
    ? (syncOverrides[group.key] ?? !!group.synced) : false;
  const toggleSync = async () => {
    if (!isCollection || isVirtual || !group) return;
    const name = group.key;
    const next = !(syncOverrides[name] ?? !!group.synced);
    setSyncOverrides((m) => ({ ...m, [name]: next }));
    try {
      const ok = await toggleCollectionSync(name, next);
      if (ok === false) throw new Error('backend declined');
      toaster.toast({ title: next ? 'Auto-sync on' : 'Auto-sync off', body: name });
    } catch (e) {
      setSyncOverrides((m) => ({ ...m, [name]: !next })); // revert
      toaster.toast({ title: 'Sync toggle failed', body: String(e) });
    }
  };

  // One-shot "Sync missing": download every game in this collection that isn't
  // already local, through the per-game download path (covers light up as they
  // go). Job state lives in the module-level _batchJobs so it survives leaving
  // and re-entering this page mid-batch.
  const syncJob = useBatchJob(group ? cacheKey(group.key) : null);
  const syncMissing = () => {
    if (!group || syncJob) return; // already running for this group
    const missing = games.filter((g) => !g.is_downloaded).map((g) => ({ id: g.rom_id, name: g.name }));
    if (missing.length === 0) { toaster.toast({ title: 'Nothing to sync', body: 'All games are already downloaded' }); return; }
    // Started from this page, but the toast can land long after the user has
    // navigated away — so it still needs a way back to this collection.
    const g = group, sibs = siblings;
    runCollectionBatch(cacheKey(group.key), missing, () => openGroupPage(mode, g, sibs));
  };

  // Re-pull the list when a batch completes anywhere (runCollectionBatch fires
  // _broadcastLibRefresh), so the dots update even if the batch was started
  // from a previous mount of this page or from a collection tile's menu.
  useEffect(() => {
    const l = () => { refreshGames(); };
    _libRefreshListeners.add(l);
    return () => { _libRefreshListeners.delete(l); };
  }, [group?.key]);

  // Re-fetch this group's games (bypassing the stale cache) so the downloaded
  // dots reflect games pulled in by a collection sync without a plugin restart.
  const refreshGames = async () => {
    if (!group) return;
    try {
      const res = await getLibraryGames(mode, group.key);
      if (res?.success) {
        const list: LibGame[] = res.games || [];
        libCacheSet(cacheKey(group.key), list);
        setGames(list);
      }
    } catch (e) { console.error('refreshGames failed', e); }
  };

  // Background auto-sync progress for THIS collection, polled from the backend so
  // the header reflects the CollectionSyncManager's downloads — not only the
  // frontend one-shot batch. build_sync_status emits sync_state/downloaded/total.
  // pct (when present) is the backend's fine-grained byte-level percent for the
  // collection, so the bar moves continuously rather than stepping per game.
  const [autoProg, setAutoProg] = useState<{ done: number; total: number; speed: number; pct: number | null } | null>(null);
  useEffect(() => {
    if (!isCollection || isVirtual || !group) { setAutoProg(null); return; }
    let alive = true;
    const tick = async () => {
      try {
        const st = await getServiceStatus();
        const col = (st?.collections || []).find((c: any) => c.name === group.key);
        if (!alive) return;
        if (col && col.sync_state === 'syncing' && typeof col.total === 'number') {
          setAutoProg({
            done: col.downloaded || 0, total: col.total, speed: col.speed || 0,
            pct: typeof col.downloaded_pct === 'number' ? col.downloaded_pct : null,
          });
        } else {
          // Just finished a backend auto-sync pass → refresh the dots once.
          setAutoProg((prev) => { if (prev) refreshGames(); return null; });
        }
      } catch { /* transient */ }
    };
    tick();
    const id = setInterval(tick, 1500);
    return () => { alive = false; clearInterval(id); };
  }, [isCollection, group?.key]);

  // Fine-grained fill for the one-shot batch: poll the in-flight downloads (≤
  // concurrency) and sum their percentages AND speeds, so the bar advances
  // smoothly within each game and we get a live aggregate transfer rate.
  const [syncStats, setSyncStats] = useState<{ frac: number; speed: number }>({ frac: 0, speed: 0 });
  useEffect(() => {
    if (!syncJob) { setSyncStats({ frac: 0, speed: 0 }); return; }
    let alive = true;
    const tick = async () => {
      const active = syncJob.ids.filter((id) => _dlActive.has(id));
      let frac = 0, speed = 0;
      await Promise.all(active.map(async (id) => {
        try {
          const p = await getDownloadProgress(id);
          if (p) {
            if (typeof p.percent === 'number') frac += p.percent / 100;
            if (typeof p.speed === 'number') speed += p.speed;
          }
        } catch { /* transient */ }
      }));
      if (alive) setSyncStats({ frac, speed });
    };
    tick();
    const id = setInterval(tick, 350);
    return () => { alive = false; clearInterval(id); };
  }, [syncJob]);

  // Unified progress: the one-shot "Sync missing" batch takes precedence (it's
  // the user's explicit action), otherwise fall back to background auto-sync.
  const prog = syncJob
    ? { done: syncJob.done, total: syncJob.total, speed: syncStats.speed }
    : autoProg;
  // Fine-grained percent (0..100): one-shot uses completed + in-flight fraction;
  // auto-sync prefers the backend's byte-level pct, falling back to the ratio.
  const progPctRaw = !prog || !prog.total ? 0 : Math.min(100, Math.round(
    syncJob
      ? ((syncJob.done + syncStats.frac) / syncJob.total) * 100
      : (autoProg?.pct != null ? autoProg.pct : (prog.done / prog.total) * 100),
  ));
  // Monotonic clamp: at download boundaries the in-flight fraction and the
  // completed count update on different ticks, so the raw value can dip for a
  // beat (finished item leaves the fraction before done++ lands, or a new item
  // starts at 0). True batch progress never decreases — hold the max.
  const progPctMax = useRef(0);
  if (!prog) progPctMax.current = 0;
  else progPctMax.current = Math.max(progPctMax.current, progPctRaw);
  const progPct = prog ? progPctMax.current : 0;
  // Remaining-time estimate from the percentage velocity (works for both paths).
  const progEta = useEtaFromPct(progPct, !!prog);

  // Remove this collection's downloaded ROMs. Per the chosen UX: turn auto-sync
  // OFF first (so the worker doesn't immediately re-download), then delete the
  // local files. The dots clear via the setGames update below; we deliberately
  // do NOT remount the grid (that would replay the slide/fade animation).
  const [reloadTick] = useState(0);
  const doRemove = async () => {
    if (!group) return;
    const name = group.key;
    try {
      if (isSynced) {
        await toggleCollectionSync(name, false);
        setSyncOverrides((m) => ({ ...m, [name]: false }));
      }
      const ok = await deleteCollectionRoms(name, mode);
      if (ok === false) throw new Error('backend declined');
      // Clear download state for every affected ROM across ALL cached groups
      // (these games also live in their platform view / other collections),
      // then drop this group's own entry so it re-fetches fresh on next entry.
      for (const g of games) if (g.is_downloaded) libCacheSetDownloaded(g.rom_id, false);
      setGames((gs) => gs.map((g) => ({ ...g, is_downloaded: false })));
      libCacheDelete(cacheKey(name));
      _broadcastLibRefresh(); // Home/groups panels re-pull their downloaded counts
    } catch (e) {
      toaster.toast({ title: 'Remove failed', body: String(e) });
    }
  };

  // Press A / activate on the games-count opens the collection action menu,
  // styled in the v2 glass chrome (matching the account dropdown). The
  // destructive "Remove downloaded" arms on first select then commits on the
  // second — matching the game-tile delete affordance.
  const openActions = () => {
    const missing = games.filter((g) => !g.is_downloaded).length;
    const downloaded = games.filter((g) => g.is_downloaded).length;
    showModal(
      <CollectionActionsModal
        title={group?.label || 'Library'} isCollection={isCollection} isVirtual={isVirtual} isSynced={isSynced}
        missing={missing} downloaded={downloaded} syncing={!!syncJob}
        onSyncMissing={syncMissing} onToggleSync={toggleSync} onRemove={doRemove} />,
    );
  };

  const onButtonDown = (evt: any) => {
    const b = evt?.detail?.button;
    if (b === GamepadButton.BUMPER_LEFT) cycle(-1);
    else if (b === GamepadButton.BUMPER_RIGHT) cycle(1);
    // No page-level Y binding: Y is the tiles' delete button, and an invisible
    // "toggle auto-sync" shortcut here could silently kick off (or cancel) a
    // whole-collection download. Auto-sync lives in the actions menu (Start /
    // games-count rail) and on the collection tile's hinted Y in the index grid.
    else if (b === GamepadButton.SELECT) { playSteamSound('deck_ui_show_modal'); libNavigate("/romm-sync-settings"); }
    else if (b === GamepadButton.START) openActions();                  // ☰ Start → games-count actions menu (top-right)
    // L2/R2 → alphabet fast-scroll across the game grid.
    else if (b === GamepadButton.TRIGGER_LEFT || b === GamepadButton.TRIGGER_RIGHT) {
      scrubJump(b === GamepadButton.TRIGGER_RIGHT ? 1 : -1);
    }
  };
  // Back → library index. Use onCancelButton (not a CANCEL case in onButtonDown):
  // it CONSUMES the B press so Steam's default router-back doesn't ALSO fire and
  // pop us right back into this platform.
  const onBack = () => libBack("/romm-sync-library");

  const jumpTo = (g: LibGroup) => {
    const from = siblings.findIndex((s) => s.key === group?.key);
    const to = siblings.findIndex((s) => s.key === g.key);
    if (from >= 0 && to >= 0) setSlideDir(to >= from ? 1 : -1);
    _libGroupHolder = { mode, group: g };
    setGroup(g);
  };

  if (!group) {
    return v2Page(<div style={{ padding: '16px', color: V2.fgMuted }}>No group selected.</div>);
  }

  const canPage = siblings.length > 1;
  const ci = siblings.findIndex((s) => s.key === group.key);
  // Sliding-track carousel: every sibling is a content-sized slot on a track
  // anchored at left:50%. We measure the selected slot's real centre offset and
  // translate the track by -that, so the selected name sits dead-centre no matter
  // its width. All slots show their full label (no truncation). Bumpers live
  // outside the clipped viewport so the edge fade never hides them.
  const DOTGAP = 16; // px gap on each side of a separator dot
  // Re-measure the selected slot's centre whenever the group/list changes.
  useLayoutEffect(() => {
    const el = selSlotRef.current;
    if (el) setSelW(el.offsetLeft + el.offsetWidth / 2);
  }, [group?.key, siblings.length]);

  // Width reserved for the right-hand status column (and mirrored by the left
  // spacer so the carousel stays screen-centred). While syncing it's a fixed
  // box so the per-second speed/ETA text doesn't resize it; otherwise we let it
  // size to its content and measure that real width so the count never clips.
  useLayoutEffect(() => {
    if (prog) { setRailW(188); return; }
    const el = railRef.current;
    if (el) setRailW(el.offsetWidth + 16); // + outer box's 12+4px horizontal padding
  }, [prog, games.length, isSynced, loading, group?.key]);

  return v2Page(
    <Focusable noFocusRing onButtonDown={onButtonDown} onCancelButton={onBack}
      actionDescriptionMap={{ [GamepadButton.START]: 'Actions' }}
      onOptionsActionDescription={isCollection && !isVirtual ? (isSynced ? 'Stop syncing' : 'Sync collection') : undefined}>
      <div style={{
        position: 'sticky', top: 0, zIndex: 50,
        background: 'rgba(7,7,15,0.78)',
        backdropFilter: 'blur(20px)', WebkitBackdropFilter: 'blur(20px)',
        borderBottom: `1px solid ${V2.border}`,
        padding: '6px 0',
      }}>
        <Focusable noFocusRing ref={headerRef} style={{
          display: 'flex', alignItems: 'center', height: '46px',
        }}>
          {/* Spacer mirrors the games-count column on the right so the carousel
              stays centred on the screen, not just within the flex row. */}
          <div style={{ flexShrink: 0, width: `${railW}px`, padding: '0 4px 0 12px', boxSizing: 'border-box', transition: 'width 0.32s cubic-bezier(0.22, 1, 0.36, 1)' }} />
          {canPage && <div style={{ flexShrink: 0, padding: '0 4px', zIndex: 2, display: 'flex', alignItems: 'center' }}><Bumper label="L1" /></div>}
          <div style={{
            position: 'relative', overflow: 'hidden', height: '100%', flex: 1,
            // Soft fade only at the inner edges, between bumpers and names.
            maskImage: 'linear-gradient(to right, transparent, #000 8%, #000 92%, transparent)',
            WebkitMaskImage: 'linear-gradient(to right, transparent, #000 8%, #000 92%, transparent)',
          }}>
            <div style={{
              position: 'absolute', top: 0, left: '50%', height: '100%',
              display: 'flex', alignItems: 'center',
              transform: `translateX(${-selW}px)`,
              transition: 'transform 0.32s cubic-bezier(0.22, 1, 0.36, 1)',
            }}>
              {siblings.map((g, idx) => {
                const sel = idx === ci;
                return [
                  idx > 0 && (
                    <span key={`dot-${g.key}`} style={{
                      flexShrink: 0, padding: `0 ${DOTGAP}px`,
                      color: V2.fgMuted, opacity: 0.5, fontSize: '13px',
                    }}>·</span>
                  ),
                  <Focusable noFocusRing key={g.key} ref={sel ? selSlotRef : undefined}
                    onActivate={() => jumpTo(g)} onClick={() => jumpTo(g)}
                    onFocus={() => setFocSlot(g.key)} onBlur={() => setFocSlot((k) => (k === g.key ? null : k))}
                    style={{
                      flexShrink: 0, height: '100%',
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      cursor: 'pointer', boxSizing: 'border-box',
                      fontSize: sel ? '22px' : '14px',
                      fontWeight: sel ? 800 : 500,
                      letterSpacing: sel ? '-0.01em' : '0',
                      color: sel || focSlot === g.key ? V2.fg : V2.fgMuted,
                      opacity: sel ? 1 : (focSlot === g.key ? 0.95 : 0.5),
                      whiteSpace: 'nowrap',
                      transition: 'opacity 0.32s, color 0.32s',
                    }}>
                    <span style={{
                      padding: '4px 10px', borderRadius: V2.radiusPill,
                      background: !sel && focSlot === g.key ? 'rgba(255,255,255,0.10)' : 'transparent',
                      border: `1px solid ${!sel && focSlot === g.key ? V2.brand : 'transparent'}`,
                      transition: 'background 0.15s ease, border-color 0.15s ease',
                    }}>{g.label}</span>
                  </Focusable>,
                ];
              })}
            </div>
          </div>
          {canPage && <div style={{ flexShrink: 0, padding: '0 4px', zIndex: 2, display: 'flex', alignItems: 'center' }}><Bumper label="R1" /></div>}
          {/* Games count doubles as the collection action trigger: focus it and
              press A to open the actions menu (Sync missing). While a sync job is
              running it shows live progress instead of the static count. */}
          {/* Outer box owns the animated px width (and clips during the slide);
              the inner node keeps its natural width so we can measure the real
              content size without a feedback loop. Width changes — entering or
              leaving sync, or the count growing after a sync — glide instead of
              snapping, in step with the left spacer. */}
          <Focusable noFocusRing onActivate={openActions} onClick={openActions}
            onFocus={() => setActHot(true)} onBlur={() => setActHot(false)}
            onMouseEnter={() => setActHot(true)} onMouseLeave={() => setActHot(false)}
            style={{
              flexShrink: 0, width: `${railW}px`, boxSizing: 'border-box',
              // Vertical padding exists purely so the pill's focus ring has room:
              // `overflow: hidden` is here to clip the width slide, and with a
              // content-height box it cropped the ring off entirely, leaving only
              // the border to show focus.
              padding: '6px 12px 6px 4px', overflow: 'hidden',
              fontSize: '11px',
              cursor: 'pointer', transition: 'width 0.32s cubic-bezier(0.22, 1, 0.36, 1)',
              color: V2.fgMuted,
              display: 'flex', alignItems: 'center', justifyContent: 'flex-end',
            }}>
            {/* The inner node reads as a pressable pill: subtle border + a
                trailing kebab so it's clearly a control, not a static count.
                Highlights on focus/hover. */}
            <div ref={railRef} style={{
              display: 'flex', alignItems: 'center', justifyContent: 'flex-end',
              gap: '6px', whiteSpace: 'nowrap', flexShrink: 0, textAlign: 'right',
              // Roomier than the text needs: the tint is the hover affordance, so
              // it has to have some body to it. UserPill gets its height from a
              // 30px avatar rather than padding, so matching it means padding here.
              padding: '7px 14px', borderRadius: V2.radiusPill, boxSizing: 'border-box',
              // Same treatment as UserPill in the top bar — the other pill-shaped
              // menu trigger in the chrome. Kept literal rather than via V2Focus
              // so the two stay visibly identical; if one moves, move both.
              border: `1px solid ${actHot ? V2.brand : V2.borderStrong}`,
              boxShadow: actHot ? `0 0 0 1px ${V2.brand}` : 'none',
              background: actHot ? 'rgba(255,255,255,0.10)' : V2.surface,
              color: actHot ? V2.fg : V2.fgMuted,
              transition: 'background 0.15s ease, border-color 0.15s ease, color 0.15s ease, box-shadow 0.15s ease',
            }}>
              {/* Synced indicator — same green dot as downloaded games/tiles. */}
              {isSynced && !prog && (
                <span style={{
                  width: '8px', height: '8px', borderRadius: '50%', flexShrink: 0,
                  background: V2.success, boxShadow: '0 0 0 2px rgba(0,0,0,0.45)',
                }} />
              )}
              {!loading && (prog
                ? `${progPct}%${prog.speed ? `   ·   ${formatSpeed(prog.speed)}` : ''}${formatEta(progEta) ? `   ·   ${formatEta(progEta)} left` : ''}`
                : `${games.length} ${games.length === 1 ? 'game' : 'games'}`)}
              {/* Kebab affordance — signals the count opens an actions menu. */}
              {!loading && !prog && (
                <FaEllipsisH size={10} style={{ flexShrink: 0, opacity: actHot ? 0.9 : 0.55 }} />
              )}
            </div>
          </Focusable>
        </Focusable>
        {/* Determinate sync bar — pinned to the header's bottom border, like
            Steam's achievement bar. The gradient is painted across the FULL
            width and revealed up to progPct (so the colour transition is visible
            at any fill level, not just the left stop). Fed by the unified,
            fine-grained model (one-shot batch + background auto-sync). */}
        {prog && prog.total > 0 && (
          <div style={{
            position: 'absolute', left: 0, right: 0, bottom: '-1px', height: '3px',
            overflow: 'hidden', background: 'rgba(255,255,255,0.12)',
          }}>
            {/* Gradient fill, clipped to progPct so it actually reflects progress. */}
            <div style={{
              height: '100%', width: `${progPct}%`,
              background: 'linear-gradient(90deg, #7c5cff 0%, #a18fff 45%, #5ce0ff 100%)',
              transition: 'width 0.3s ease',
            }} />
          </div>
        )}
      </div>

      {loading ? (
        <div style={{ padding: '16px', color: V2.fgMuted, fontSize: '13px' }}>Loading games…</div>
      ) : games.length === 0 ? (
        <div style={{ padding: '16px', color: V2.fgMuted, fontSize: '13px' }}>No games in this group.</div>
      ) : (
        <Focusable noFocusRing {...NAV_MAINTAIN_X}
          key={`${group.key}:${reloadTick}`}
          className={slideDir === 1 ? 'lib-slide-r' : 'lib-slide-l'}
          style={{
            display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(132px, 1fr))',
            gap: '18px 16px', padding: '16px 16px 0',
          }}
        >
          {gridTiles}
          {visN < games.length && (
            <div ref={sentinelRef} style={{ gridColumn: '1 / -1', height: '1px' }} />
          )}
        </Focusable>
      )}
      <ScrubOverlay letter={scrubLetter} />
      <style>{`
        @keyframes libSlideR { from { transform: translateX(7%); } to { transform: translateX(0); } }
        @keyframes libSlideL { from { transform: translateX(-7%); } to { transform: translateX(0); } }
        @keyframes libFade { from { opacity: 0.55; } to { opacity: 1; } }
        .lib-slide-r { animation: libSlideR 0.34s cubic-bezier(0.22, 1, 0.36, 1) both, libFade 0.16s ease-out both; }
        .lib-slide-l { animation: libSlideL 0.34s cubic-bezier(0.22, 1, 0.36, 1) both, libFade 0.16s ease-out both; }
      `}</style>
    </Focusable>,
    bgUri,
  );
}

// Fetch an auth-gated RomM resource path as a base64 data URI (backend proxy).
function useRommImage(path: string | null): string | null {
  const [uri, setUri] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    if (!path) { setUri(null); return; }
    (async () => {
      try { const r = await qGetImage(path); if (alive) setUri(r?.data_uri || null); }
      catch { if (alive) setUri(null); }
    })();
    return () => { alive = false; };
  }, [path]);
  return uri;
}

// Fullscreen screenshot lightbox — RCarousel equivalent. L1/R1 or the
// on-screen arrows page through; A/B close.
function ScreenshotLightbox({ paths, index, closeModal }:
  { paths: string[]; index: number; closeModal?: () => void; }) {
  const [i, setI] = useState(index);
  const uri = useRommImage(paths[i]);
  const go = (d: -1 | 1) => setI((p) => (p + d + paths.length) % paths.length);
  const onButtonDown = (evt: any) => {
    const b = evt?.detail?.button;
    if (b === GamepadButton.BUMPER_LEFT) go(-1);
    else if (b === GamepadButton.BUMPER_RIGHT) go(1);
  };
  const multi = paths.length > 1;

  // Sample the left/right edge luminance of the current shot so each arrow can
  // flip to a light or dark scrim and stay legible over the image behind it.
  // true = that edge is dark → use a light scrim with a dark icon.
  const [edgeDark, setEdgeDark] = useState<{ left: boolean; right: boolean }>({ left: true, right: true });
  useEffect(() => {
    if (!uri) { setEdgeDark({ left: true, right: true }); return; }
    let alive = true;
    const img = new Image();
    img.onload = () => {
      try {
        const w = 64, h = Math.max(1, Math.round(64 * img.height / Math.max(1, img.width)));
        const c = document.createElement('canvas');
        c.width = w; c.height = h;
        const ctx = c.getContext('2d');
        if (!ctx) return;
        ctx.drawImage(img, 0, 0, w, h);
        const lum = (x0: number) => {
          const d = ctx.getImageData(x0, 0, Math.max(1, Math.round(w * 0.18)), h).data;
          let s = 0, n = 0;
          for (let k = 0; k < d.length; k += 4) { s += 0.2126 * d[k] + 0.7152 * d[k + 1] + 0.0722 * d[k + 2]; n++; }
          return n ? s / n : 0;
        };
        if (alive) setEdgeDark({ left: lum(0) < 140, right: lum(Math.round(w * 0.82)) < 140 });
      } catch { /* canvas may be tainted; keep default */ }
    };
    img.src = uri;
    return () => { alive = false; };
  }, [uri]);

  // Circular scrim arrow matching the Home CardRow chevrons, but with the
  // scrim/icon inverted on bright screenshot edges for contrast.
  const arrowStyle = (side: 'left' | 'right'): any => {
    const dark = side === 'left' ? edgeDark.left : edgeDark.right;
    return {
      position: 'absolute', [side]: '8px', zIndex: 2,
      minWidth: '36px', width: '36px', height: '36px', padding: 0, borderRadius: '50%',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      background: dark ? 'rgba(255,255,255,0.4)' : 'rgba(0,0,0,0.4)',
      color: dark ? '#07070f' : V2.fg2,
      border: dark ? '1px solid rgba(0,0,0,0.2)' : `1px solid ${V2.border}`,
      backdropFilter: 'blur(10px)', WebkitBackdropFilter: 'blur(10px)',
      boxShadow: '0 2px 10px rgba(0,0,0,0.4)',
      transition: 'background 0.2s ease, color 0.2s ease',
    };
  };
  return (
    <ModalRoot onCancel={closeModal} onEscKeypress={closeModal}>
      <Focusable noFocusRing onButtonDown={onButtonDown}
        style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '14px' }}>
        <div style={{
          position: 'relative', width: '100%', display: 'flex',
          alignItems: 'center', justifyContent: 'center',
        }}>
          {multi && (
            <DialogButton onClick={() => go(-1)} style={arrowStyle('left')}>
              <FaChevronLeft size={15} />
            </DialogButton>
          )}
          {uri ? (
            <img src={uri} style={{
              maxWidth: '100%', maxHeight: '70vh', objectFit: 'contain',
              borderRadius: V2.radiusMd, boxShadow: V2.elev2,
            }} />
          ) : (
            <div style={{
              width: '100%', aspectRatio: '16 / 9', borderRadius: V2.radiusMd,
              background: V2.surface, display: 'flex', alignItems: 'center',
              justifyContent: 'center', color: V2.fgMuted, fontSize: '12px',
            }}>Loading…</div>
          )}
          {multi && (
            <DialogButton onClick={() => go(1)} style={arrowStyle('right')}>
              <FaChevronRight size={15} />
            </DialogButton>
          )}
        </div>
        {multi && (
          <div style={{ fontSize: '12px', color: V2.fgMuted }}>{i + 1} / {paths.length}</div>
        )}
      </Focusable>
    </ModalRoot>
  );
}

// One 16:9 screenshot thumbnail — opens the lightbox on activate.
function ScreenshotThumb({ paths, index }: { paths: string[]; index: number; }) {
  const uri = useRommImage(paths[index]);
  const [focused, setFocused] = useState(false);
  const open = () => showModal(<ScreenshotLightbox paths={paths} index={index} />);
  return (
    <Focusable noFocusRing
      onActivate={open}
      onClick={open}
      onFocus={() => setFocused(true)} onBlur={() => setFocused(false)}
      onMouseEnter={() => setFocused(true)}
      onMouseLeave={() => setFocused(false)}
      style={{
        cursor: 'pointer', position: 'relative', aspectRatio: '16 / 9',
        borderRadius: V2.radiusChip, overflow: 'hidden', background: V2.surface,
        transform: 'scale(1)',
        transition: 'transform 0.18s ease, box-shadow 0.18s ease',
        ...V2Focus.tile(focused),
      }}>
      {uri ? (
        <img src={uri} loading="lazy" style={{
          width: '100%', height: '100%', objectFit: 'cover', display: 'block',
        }} />
      ) : null}
    </Focusable>
  );
}

// Responsive grid of screenshot thumbnails (RomM ScreenshotsTab).
function ScreenshotGrid({ paths }: { paths: string[]; }) {
  return (
    <Focusable noFocusRing style={{
      display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))',
      gap: '10px', padding: '6px 6px 4px',
    }}>
      {paths.map((p, i) => <ScreenshotThumb key={p || i} paths={paths} index={i} />)}
    </Focusable>
  );
}

type Achievement = {
  ra_id: number | null; title: string; description: string; points: number;
  type: string; badge_id: string | null; badge_url: string | null;
  badge_url_lock: string | null; earned: boolean;
};
type TypeFilter = 'all' | 'progression' | 'missable' | 'win_condition';
type StatusFilter = 'all' | 'earned' | 'locked';

function AchievementsTab({ achievements }: { achievements: Achievement[] }) {
  const [typeFilter, setTypeFilter] = useState<TypeFilter>('all');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  // Which filter pill is focused, so it shows a highlight under the controller
  // (the pills otherwise only reflect active/inactive, not focus).
  const [filterFocus, setFilterFocus] = useState<string | null>(null);
  // Drive the summary progress bar from 0 → pct after mount so it animates in.
  const [barReady, setBarReady] = useState(false);
  useEffect(() => { const t = setTimeout(() => setBarReady(true), 60); return () => clearTimeout(t); }, []);

  if (!achievements.length) {
    return (
      <div style={{ padding: '30px 0', color: V2.fgMuted, fontSize: '13px', fontStyle: 'italic', textAlign: 'center' }}>
        No achievement data for this game.
      </div>
    );
  }

  const earnedCount = achievements.filter((a) => a.earned).length;
  const totalPoints = achievements.reduce((s, a) => s + (a.points || 0), 0);
  const progressionCount = achievements.filter((a) => a.type === 'progression').length;
  const missableCount = achievements.filter((a) => a.type === 'missable').length;

  const isVisible = (a: Achievement) => {
    if (typeFilter !== 'all' && a.type !== typeFilter) return false;
    if (statusFilter === 'earned' && !a.earned) return false;
    if (statusFilter === 'locked' && a.earned) return false;
    return true;
  };

  const typeLabel = (t: string) => t === 'win_condition' ? 'Win Condition' : t.charAt(0).toUpperCase() + t.slice(1);
  const toggleStatus = (s: StatusFilter) => setStatusFilter((cur) => cur === s ? 'all' : s);

  const stat = (val: any, lbl: string, missable = false) => (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '4px', padding: '0 12px' }}>
      <div style={{ fontSize: '20px', fontWeight: 700, color: missable ? V2.warning : V2.fg, fontVariantNumeric: 'tabular-nums' }}>{val}</div>
      <div style={{ fontSize: '10px', fontWeight: 700, letterSpacing: '0.07em', textTransform: 'uppercase', color: V2.fgMuted }}>{lbl}</div>
    </div>
  );

  const typeTagStyle = (t: string): any => {
    const base: any = { fontSize: '9.5px', fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', padding: '2px 7px', borderRadius: '8px' };
    if (t === 'progression') return { ...base, background: 'rgba(99,102,241,0.18)', color: V2.igdb };
    if (t === 'missable') return { ...base, background: 'rgba(251,191,36,0.18)', color: V2.warning };
    if (t === 'win_condition') return { ...base, background: 'rgba(74,222,128,0.18)', color: V2.success };
    return { ...base, background: V2.surface, color: V2.fg2 };
  };

  const filterBtn = (key: string, label: string, active: boolean, onClick: () => void, accent?: 'earned' | 'locked') => {
    let bg = V2.surface, color = V2.fg2, border = V2.border;
    if (active) {
      if (accent === 'earned') { bg = 'rgba(74,222,128,0.30)'; border = 'rgba(74,222,128,0.50)'; color = V2.fg; }
      else if (accent === 'locked') { bg = 'rgba(255,80,80,0.24)'; border = 'rgba(255,80,80,0.45)'; color = V2.fg; }
      else { bg = V2.fg; border = V2.fg; color = V2.bg; }
    }
    const focused = filterFocus === key;
    return (
      <Focusable noFocusRing
        key={key}
        onActivate={onClick}
        onClick={onClick}
        onFocus={() => setFilterFocus(key)} onBlur={() => setFilterFocus((c) => c === key ? null : c)}
        onMouseEnter={() => setFilterFocus(key)} onMouseLeave={() => setFilterFocus((c) => c === key ? null : c)}
        style={{
          background: focused && !active ? V2.surfaceHover : bg,
          border: `1px solid ${focused ? V2.brand : border}`, borderRadius: V2.radiusPill,
          color, padding: '5px 13px', fontSize: '11.5px', fontWeight: 500, cursor: 'pointer',
          transition: 'background 0.15s ease, border-color 0.15s ease, box-shadow 0.15s ease',
          ...V2Focus.flat(focused, { glow: true }),
        }}
      >
        {label}
      </Focusable>
    );
  };

  const pct = achievements.length ? Math.round((earnedCount / achievements.length) * 100) : 0;
  const EASE = 'cubic-bezier(0.22,1,0.36,1)';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
      <style>{`
        @keyframes achFade { from { opacity: 0; transform: translateY(14px); } to { opacity: 1; transform: translateY(0); } }
        .ach-fade { animation: achFade 320ms ${EASE} both; animation-delay: calc(var(--ach-i, 0) * 28ms); }
        /* Row hover is the shared .romm-row (see V2_ROW_STYLE). */
      `}</style>

      <div className="ach-fade" style={{ display: 'flex', flexDirection: 'column', background: V2.surface, border: `1px solid ${V2.border}`, borderRadius: V2.radiusLg, overflow: 'hidden' }}>
        <div style={{ display: 'flex', padding: '14px 0' }}>
          {stat(
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: '8px' }}>
              {earnedCount} / {achievements.length}
              <span style={{ width: '4px', height: '4px', borderRadius: '50%', background: V2.fgMuted }} />
              {pct}%
            </span>, 'Achievements')}
          <div style={{ width: '1px', background: V2.border }} />
          {stat(totalPoints, 'Total Points')}
          {progressionCount > 0 && <><div style={{ width: '1px', background: V2.border }} />{stat(progressionCount, 'Progression')}</>}
          {missableCount > 0 && <><div style={{ width: '1px', background: V2.border }} />{stat(missableCount, 'Missable', true)}</>}
        </div>
        <div style={{ height: '4px', background: 'rgba(255,255,255,0.06)' }}>
          <div style={{
            height: '100%', width: barReady ? `${pct}%` : '0%',
            background: `linear-gradient(90deg, ${V2.brand}, ${V2.success})`,
            borderRadius: '0 2px 2px 0', transition: `width 800ms ${EASE}`,
          }} />
        </div>
      </div>

      <Focusable noFocusRing className="ach-fade" style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '6px', '--ach-i': 1 } as any}>
        {(['all', 'progression', 'missable', 'win_condition'] as TypeFilter[]).map((f) =>
          filterBtn(f, typeLabel(f), typeFilter === f, () => setTypeFilter(f)))}
        <span style={{ width: '1px', height: '16px', background: V2.surfaceHover, margin: '0 4px' }} />
        {filterBtn('earned', '✓ Earned', statusFilter === 'earned', () => toggleStatus('earned'), 'earned')}
        {filterBtn('locked', '⊘ Locked', statusFilter === 'locked', () => toggleStatus('locked'), 'locked')}
      </Focusable>

      {/* Filtered-out rows simply unmount (with a fade on the survivors) so the
          list re-flows without a clipping wrapper — that lets the shared
          .romm-row outset glow show, identical to the saves list. */}
      <Focusable noFocusRing style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
        {achievements.filter(isVisible).map((a, i) => {
          const src = a.earned ? a.badge_url : a.badge_url_lock;
          // Dim LOCKED rows via their contents, not the Focusable itself: the
          // desktop shim reads an inline opacity<1 on a Focusable as the
          // "disabled control" signal and strips its tabindex, which made locked
          // rows unreachable by the controller (Down dead-ended at the filters).
          const dim = a.earned ? 1 : 0.55;
          return (
            <Focusable noFocusRing key={a.ra_id ?? i} onActivate={() => { }} className="romm-row ach-fade" style={{
              display: 'grid', gridTemplateColumns: '52px 1fr auto', gap: '14px', alignItems: 'center',
              padding: '10px 14px', borderRadius: V2.radiusMd,
              '--ach-i': Math.min(i, 12) + 2,
            } as any}>
              <div style={{ width: '52px', height: '52px', borderRadius: '8px', overflow: 'hidden', background: V2.coverPlaceholder, flexShrink: 0, opacity: dim }}>
                {src && <img src={src} alt={a.title} loading="lazy" style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
                  onError={(e) => { (e.target as HTMLImageElement).style.visibility = 'hidden'; }} />}
              </div>
              <div style={{ minWidth: 0, opacity: dim }}>
                <div style={{ fontSize: '13px', fontWeight: 600, color: V2.fg }}>{a.title}</div>
                <div style={{ fontSize: '11.5px', color: V2.fgMuted, marginTop: '2px', lineHeight: 1.4 }}>{a.description}</div>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: '4px', whiteSpace: 'nowrap', opacity: dim }}>
                <div style={{ fontSize: '12px', fontWeight: 700, color: V2.fg2, fontVariantNumeric: 'tabular-nums' }}>{a.points} pts</div>
                {a.type && <span style={typeTagStyle(a.type)}>{typeLabel(a.type)}</span>}
              </div>
            </Focusable>
          );
        })}
      </Focusable>
    </div>
  );
}

// Restore modal — a bare ModalRoot styled entirely in the RomM v2 design
// language (tokens, V2Button) rather than Steam chrome. Previews the chosen
// version (screenshot for states) and exposes Restore / Restore-as-copy /
// Cancel. closeModal is injected by showModal.
function RestoreModal({ romId, entry, shotUri, onDone, closeModal }: {
  romId: number; entry: HistoryEntry; shotUri?: string; onDone: () => void; closeModal?: () => void;
}) {
  const isState = entry.save_type === 'states';
  const [shot, setShot] = useState<string | null>(shotUri ?? null);
  // Fetch a preview for any version (saves can carry screenshots too), unless
  // we were handed a cached one. Loading runs until the fetch resolves.
  const [loadingShot, setLoadingShot] = useState(!shotUri);
  const [busy, setBusy] = useState<null | 'restore' | 'copy'>(null);
  const cardRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (shotUri) return;
    getSaveScreenshot(romId, entry.id, entry.save_type)
      .then((r: any) => setShot(r?.data_uri || null))
      .catch(() => setShot(null))
      .finally(() => setLoadingShot(false));
  }, []);

  // Move controller focus into the overlay (no ModalRoot to do it for us).
  useEffect(() => {
    const t = setTimeout(() => { if (cardRef.current) _forceGamepadFocus(cardRef.current); }, 60);
    return () => clearTimeout(t);
  }, []);

  const run = async (asCopy: boolean) => {
    if (busy) return;
    setBusy(asCopy ? 'copy' : 'restore');
    try {
      const res = await restoreSaveVersion(romId, entry.id, entry.save_type, asCopy);
      if (res?.success) {
        toaster.toast({ title: 'Restored', body: res.tgt_name ? `→ ${res.tgt_name}` : 'Version restored' });
        onDone();
        closeModal?.();
      } else {
        toaster.toast({ title: 'Restore failed', body: res?.message || 'Unknown error' });
        setBusy(null);
      }
    } catch (e) {
      toaster.toast({ title: 'Restore failed', body: String(e) });
      setBusy(null);
    }
  };

  const meta = [slotLabel(entry), entry.device || '', fmtHistSize(entry.size_bytes)].filter(Boolean).join(' · ');

  return (
    <ModalRoot bHideCloseIcon onCancel={closeModal} onEscKeypress={closeModal}
      className="romm-modal-collapse" modalClassName="romm-modal-collapse">
      <Focusable noFocusRing
        className="romm-ui"
        onCancelButton={() => closeModal?.()}
        onButtonDown={(e: any) => { if (e?.detail?.button === GamepadButton.CANCEL) closeModal?.(); }}
        style={{
          position: 'fixed', inset: 0, zIndex: 9999,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          background: 'rgba(7,7,15,0.45)',
          WebkitBackdropFilter: 'blur(8px)', backdropFilter: 'blur(8px)',
        }}
      >
        <style>{`
        @keyframes sdShimmer { 0% { background-position: -150% 0; } 100% { background-position: 150% 0; } }
        .sd-shimmer { background-image: linear-gradient(100deg, transparent 20%, rgba(255,255,255,0.22) 50%, transparent 80%) !important; background-size: 200% 100% !important; background-repeat: no-repeat; animation: sdShimmer 1.1s linear infinite; }
        ${V2_FOCUS_STYLE}
        /* Collapse ModalRoot's own panel chrome so only our overlay shows. */
        .romm-modal-collapse, .romm-modal-collapse > div {
          background: transparent !important; border: none !important; box-shadow: none !important; padding: 0 !important;
        }
      `}</style>
        <Focusable noFocusRing autoFocus ref={cardRef} flow-children="vertical" style={{
          fontFamily: V2.font, color: V2.fg, width: '520px', maxWidth: '90vw', boxSizing: 'border-box',
          padding: '18px', display: 'flex', flexDirection: 'column', gap: '12px',
          maxHeight: '82vh', overflowY: 'auto',
          background: 'linear-gradient(180deg, rgba(20,20,30,0.7) 0%, rgba(10,10,18,0.78) 100%)',
          WebkitBackdropFilter: 'blur(28px) saturate(1.1)', backdropFilter: 'blur(28px) saturate(1.1)',
          border: `1px solid rgba(255,255,255,0.12)`, borderRadius: V2.radiusCard,
          boxShadow: '0 16px 48px rgba(0,0,0,0.55)',
        }}>
          <div>
            <div style={{ fontSize: '11px', fontWeight: 700, letterSpacing: '0.07em', textTransform: 'uppercase', color: V2.brand }}>
              Restore {isState ? 'state' : 'save'}
            </div>
            <div style={{ fontSize: '20px', fontWeight: 800, marginTop: '4px' }}>{fmtHistTs(entry.updated_at)}</div>
            {meta && <div style={{ fontSize: '13px', color: V2.fg2, marginTop: '4px' }}>{meta}</div>}
          </div>

          <div className={loadingShot ? 'sd-shimmer' : ''} style={{
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            minHeight: loadingShot || !shot ? '120px' : undefined,
            backgroundColor: (loadingShot || !shot) ? V2.coverPlaceholder : 'transparent',
            borderRadius: V2.radiusLg, overflow: 'hidden',
            border: (loadingShot || !shot) ? `1px solid ${V2.border}` : 'none',
          }}>
            {loadingShot ? (
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '8px', color: V2.fgMuted }}>
                <FaSync size={16} style={{ animation: 'spin 1s linear infinite' }} />
                <span style={{ fontSize: '12px' }}>Loading preview…</span>
              </div>
            ) : shot ? (
              <img src={shot} style={{ maxWidth: '100%', maxHeight: '210px', width: 'auto', display: 'block', borderRadius: V2.radiusLg }} />
            ) : (
              <span style={{ fontSize: '12px', color: V2.fgMuted }}>No preview available</span>
            )}
          </div>

          <div style={{ fontSize: '12.5px', color: V2.fg2, lineHeight: 1.55, background: V2.surface, border: `1px solid ${V2.border}`, borderRadius: V2.radiusMd, padding: '10px 12px' }}>
            <span style={{ color: V2.fg, fontWeight: 600 }}>Restore (overwrite)</span> replaces the current file with this version. The current file is backed up first.
            {isState && <><br /><span style={{ color: V2.fg, fontWeight: 600 }}>Restore as copy</span> writes this version into a new free slot, leaving your current slots untouched.</>}
          </div>

          <Focusable noFocusRing flow-children="horizontal" style={{ display: 'flex', gap: '8px', flexWrap: 'nowrap', justifyContent: 'flex-end', alignItems: 'center' }}>
            <V2Button variant="text" disabled={!!busy} onClick={() => closeModal?.()}>Cancel</V2Button>
            {isState && (
              <V2Button variant="tonal" disabled={!!busy} onClick={() => run(true)}>
                {busy === 'copy' ? <FaSync size={12} style={{ animation: 'spin 1s linear infinite' }} /> : <FaCopy size={12} />}
                <span>Restore as copy</span>
              </V2Button>
            )}
            <V2Button variant="danger" disabled={!!busy} onClick={() => run(false)}>
              {busy === 'restore' ? <FaSync size={12} style={{ animation: 'spin 1s linear infinite' }} /> : <FaUndo size={12} />}
              <span>Restore (overwrite)</span>
            </V2Button>
          </Focusable>
        </Focusable>
      </Focusable>
    </ModalRoot>
  );
}

// Inline Save Data tab — Saves + States subtabs, mirrors RomM's SaveDataTab.
// Saves are a vertical info list; States are a screenshot tile grid. Selecting
// an item reveals inline restore actions (restore-in-place, and restore-as-copy
// for states) backed by the same callables the standalone history page uses.
function SaveDataTab({ romId }: { romId: number }) {
  const [sub, setSub] = useState<'saves' | 'states'>('saves');
  const [loading, setLoading] = useState(true);
  const [saves, setSaves] = useState<HistoryEntry[]>([]);
  const [states, setStates] = useState<HistoryEntry[]>([]);
  // shots[id]: 'loading' while fetching, '' once resolved with no screenshot,
  // otherwise the data URI. Absence means not yet requested.
  const [shots, setShots] = useState<Record<number, string>>({});
  // Gamepad focus under gamescope doesn't reliably fire CSS :focus-within, so
  // the selected save/state gets no highlight. Track the focused entry in JS
  // and paint the brand highlight explicitly (same approach as the nav tabs).
  const [focusedId, setFocusedId] = useState<number | null>(null);
  const [pillFocus, setPillFocus] = useState<'saves' | 'states' | null>(null);
  const EASE = 'cubic-bezier(0.22,1,0.36,1)';

  const load = async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const res = await getSaveHistory(romId);
      if (res?.success) {
        setSaves(res.saves || []);
        setStates(res.states || []);
      } else if (!silent) {
        setSaves([]); setStates([]);
      }
    } catch (e) {
      console.error('get_save_history failed', e);
      if (!silent) { setSaves([]); setStates([]); }
    } finally {
      if (!silent) setLoading(false);
    }
  };
  useEffect(() => { load(); }, []);

  // After a restore the new version is written locally and the file watcher
  // uploads it to the server a moment later. Mirror the GTK app's
  // _await_restore_sync: snapshot the current ids, wait for the upload debounce,
  // then poll once a second until a new id appears (bounded deadline).
  const pollCancelRef = useRef<(() => void) | null>(null);
  useEffect(() => () => pollCancelRef.current?.(), []);
  const reloadAfterRestore = () => {
    pollCancelRef.current?.();
    const baseline = new Set<number>([...saves, ...states].map((e) => e.id));
    let cancelled = false;
    pollCancelRef.current = () => { cancelled = true; };
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    (async () => {
      await sleep(3500); // upload debounce + buffer
      const deadline = Date.now() + 20000;
      while (!cancelled) {
        try {
          const res = await getSaveHistory(romId);
          if (res?.success) {
            const ids = [...(res.saves || []), ...(res.states || [])].map((e: any) => e.id);
            const hasNew = ids.some((id) => !baseline.has(id));
            if (hasNew || Date.now() >= deadline) {
              setSaves(res.saves || []); setStates(res.states || []);
              return;
            }
          }
        } catch { /* keep polling */ }
        if (Date.now() >= deadline) return;
        await sleep(1000);
      }
    })();
  };

  // Lazily fetch state screenshots once the States subtab is opened. The
  // backend serves them one request at a time, so fetch sequentially, newest
  // first, and commit each result as it lands — tiles fill in progressively
  // instead of all appearing only once the last one finishes.
  const requestedRef = useRef<Set<number>>(new Set());
  useEffect(() => {
    if (sub !== 'states') return;
    const queue = states
      .filter((s) => !requestedRef.current.has(s.id))
      .sort((a, b) => String(b.updated_at || '').localeCompare(String(a.updated_at || '')));
    if (!queue.length) return;
    queue.forEach((s) => requestedRef.current.add(s.id));
    setShots((p) => {
      const next = { ...p };
      queue.forEach((s) => { if (!(s.id in next)) next[s.id] = 'loading'; });
      return next;
    });
    let cancelled = false;
    (async () => {
      for (const s of queue) {
        if (cancelled) return;
        try {
          const r: any = await getSaveScreenshot(romId, s.id, 'states');
          setShots((p) => ({ ...p, [s.id]: r?.data_uri || '' }));
        } catch {
          setShots((p) => ({ ...p, [s.id]: '' }));
        }
      }
    })();
    return () => { cancelled = true; };
  }, [sub, states]);

  const openRestore = (e: HistoryEntry) => {
    const cached = shots[e.id];
    const shotUri = (cached && cached !== 'loading') ? cached : undefined;
    showModal(<RestoreModal romId={romId} entry={e} shotUri={shotUri} onDone={reloadAfterRestore} />);
  };

  const pill = (id: 'saves' | 'states', label: string, count: number) => {
    const active = sub === id;
    const focused = pillFocus === id;
    return (
      <Focusable noFocusRing
        key={id}
        onActivate={() => setSub(id)}
        onClick={() => setSub(id)}
        onFocus={() => setPillFocus(id)} onBlur={() => setPillFocus((c) => c === id ? null : c)}
        onMouseEnter={() => setPillFocus(id)} onMouseLeave={() => setPillFocus((c) => c === id ? null : c)}
        style={{
          display: 'inline-flex', alignItems: 'center', gap: '7px',
          background: active ? V2.fg : (focused ? V2.surfaceHover : V2.surface),
          border: `1px solid ${active ? V2.fg : (focused ? V2.brand : V2.border)}`,
          borderRadius: V2.radiusPill, color: active ? V2.bg : V2.fg2,
          padding: '5px 14px', fontSize: '12px', fontWeight: 600, cursor: 'pointer',
          transition: 'background 0.15s ease, border-color 0.15s ease, box-shadow 0.15s ease',
          // Ring on focus even when the pill is the ACTIVE one (like the
          // achievements filters) — the tab-switch focus-pull lands here, and
          // without the ring the landing was invisible.
          ...V2Focus.flat(focused, { glow: true }),
        }}
      >
        {label}
        <span style={{
          fontSize: '10px', fontWeight: 700, padding: '0px 6px', borderRadius: V2.radiusPill,
          background: active ? 'rgba(0,0,0,0.18)' : V2.surfaceHover, color: active ? V2.bg : V2.fgMuted,
        }}>{count}</span>
      </Focusable>
    );
  };

  // Group a type's entries by slot, newest-first within each slot (the newest
  // is the live/current file). Mirrors the standalone history browser.
  const groupBySlot = (entries: HistoryEntry[]) => {
    const groups: Record<string, HistoryEntry[]> = {};
    entries.forEach((e) => {
      const slot = (e.slot != null && e.slot !== '') ? String(e.slot) : slotLabel(e);
      (groups[slot] = groups[slot] || []).push(e);
    });
    return Object.keys(groups).sort().map((slot) => ({
      slot,
      items: groups[slot].slice().sort((a, b) => String(b.updated_at || '').localeCompare(String(a.updated_at || ''))),
    }));
  };

  const slotHeader = (slot: string, count: number) => (
    <div style={{ display: 'flex', alignItems: 'center', gap: '10px', margin: '2px 0' }}>
      <span style={{ fontSize: '11px', fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', color: V2.fgMuted, whiteSpace: 'nowrap' }}>Slot: {slot}</span>
      <span style={{ flex: 1, height: '1px', background: V2.border }} />
      <span style={{ fontSize: '10px', color: V2.fgMuted, whiteSpace: 'nowrap' }}>{count} version{count === 1 ? '' : 's'}</span>
    </div>
  );

  const currentChip = (
    <span style={{ fontSize: '9.5px', fontWeight: 700, letterSpacing: '0.05em', textTransform: 'uppercase', padding: '1px 7px', borderRadius: V2.radiusPill, background: 'rgba(74,222,128,0.18)', color: V2.success }}>Current</span>
  );

  if (loading) {
    return <div style={{ color: V2.fgMuted, fontSize: '12px', padding: '12px 0' }}>Loading save data…</div>;
  }

  const total = saves.length + states.length;
  if (total === 0) {
    return <div style={{ color: V2.fgMuted, fontSize: '13px', padding: '24px 0', textAlign: 'center', fontStyle: 'italic' }}>
      No server saves or states for this game yet.
    </div>;
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
      <style>{`
        @keyframes sdFade { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: translateY(0); } }
        .sd-fade { animation: sdFade 300ms ${EASE} both; animation-delay: calc(var(--sd-i, 0) * 26ms); }
        /* Row/tile hover is the shared .romm-row / .romm-tile (see V2_ROW_STYLE). */
        @keyframes sdShimmer { 0% { background-position: -150% 0; } 100% { background-position: 150% 0; } }
        .sd-shimmer { background-image: linear-gradient(100deg, transparent 20%, rgba(255,255,255,0.22) 50%, transparent 80%) !important; background-size: 200% 100% !important; background-repeat: no-repeat; animation: sdShimmer 1.1s linear infinite; }
      `}</style>

      <Focusable noFocusRing flow-children="horizontal" style={{ display: 'flex', gap: '8px' }}>
        {pill('saves', 'Saves', saves.length)}
        {pill('states', 'States', states.length)}
      </Focusable>

      {sub === 'saves' ? (
        saves.length === 0 ? (
          <div style={{ color: V2.fgMuted, fontSize: '12px', padding: '12px 0' }}>No saves for this game.</div>
        ) : (
          <Focusable noFocusRing style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
            {groupBySlot(saves).map((g) => (
              <div key={`sg-${g.slot}`} style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                {slotHeader(g.slot, g.items.length)}
                {g.items.map((e, idx) => {
                  const isCur = idx === 0;
                  const sub2 = [e.device || '', fmtHistSize(e.size_bytes)].filter(Boolean).join(' · ');
                  return (
                    <div key={`save-${e.id}`} className="sd-fade" style={{ '--sd-i': Math.min(idx, 14) } as any}>
                      <Focusable noFocusRing
                        className="romm-row"
                        onActivate={() => openRestore(e)}
                        onClick={() => openRestore(e)}
                        onFocus={() => setFocusedId(e.id)} onBlur={() => setFocusedId((c) => c === e.id ? null : c)}
                        onMouseEnter={() => setFocusedId(e.id)} onMouseLeave={() => setFocusedId((c) => c === e.id ? null : c)}
                        style={{
                          display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '10px', textAlign: 'left',
                          padding: '10px 13px', cursor: 'pointer', borderRadius: V2.radiusMd,
                          ...V2Focus.row(focusedId === e.id),
                        }}
                      >
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '3px', minWidth: 0 }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                            <span style={{ fontSize: '13px', fontWeight: 600, color: V2.fg }}>{fmtHistTs(e.updated_at)}</span>
                            {isCur && currentChip}
                          </div>
                          {sub2 && <div style={{ fontSize: '11px', color: V2.fgMuted }}>{sub2}</div>}
                        </div>
                        <FaUndo size={13} style={{ color: V2.fgMuted, flexShrink: 0 }} />
                      </Focusable>
                    </div>
                  );
                })}
              </div>
            ))}
          </Focusable>
        )
      ) : (
        states.length === 0 ? (
          <div style={{ color: V2.fgMuted, fontSize: '12px', padding: '12px 0' }}>No states for this game.</div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
            {(() => {
              const pending = states.filter((s) => shots[s.id] === undefined || shots[s.id] === 'loading').length;
              if (pending === 0) return null;
              const loaded = states.length - pending;
              return (
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '11px', color: V2.fgMuted }}>
                  <FaSync size={11} style={{ animation: 'spin 1s linear infinite' }} />
                  <span>Loading previews {loaded}/{states.length}…</span>
                </div>
              );
            })()}
            {groupBySlot(states).map((g) => (
              <div key={`stg-${g.slot}`} style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                {slotHeader(g.slot, g.items.length)}
                <Focusable noFocusRing style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: '12px' }}>
                  {g.items.map((e, idx) => {
                    const isCur = idx === 0;
                    const shot = shots[e.id];
                    const loadingShot = shot === undefined || shot === 'loading';
                    return (
                      <Focusable noFocusRing
                        key={`state-${e.id}`}
                        className="romm-tile sd-fade"
                        onActivate={() => openRestore(e)}
                        onClick={() => openRestore(e)}
                        onFocus={() => setFocusedId(e.id)} onBlur={() => setFocusedId((c) => c === e.id ? null : c)}
                        onMouseEnter={() => setFocusedId(e.id)} onMouseLeave={() => setFocusedId((c) => c === e.id ? null : c)}
                        style={{
                          display: 'flex', flexDirection: 'column', cursor: 'pointer', overflow: 'hidden',
                          borderRadius: V2.radiusLg,
                          '--sd-i': Math.min(idx, 14),
                          ...V2Focus.row(focusedId === e.id),
                        } as any}
                      >
                        <div className={loadingShot ? 'sd-shimmer' : ''} style={{ position: 'relative', aspectRatio: '16 / 9', backgroundColor: V2.coverPlaceholder, display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden' }}>
                          {loadingShot ? (
                            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '6px', color: V2.fgMuted }}>
                              <FaSync size={14} style={{ animation: 'spin 1s linear infinite' }} />
                              <span style={{ fontSize: '10px' }}>Downloading…</span>
                            </div>
                          ) : shot ? (
                            <img src={shot} style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
                          ) : (
                            <span style={{ fontSize: '10px', color: V2.fgMuted }}>No screenshot</span>
                          )}
                          {isCur && <div style={{ position: 'absolute', top: '6px', left: '6px' }}>{currentChip}</div>}
                        </div>
                        <div style={{ padding: '8px 10px' }}>
                          <div style={{ fontSize: '11px', color: V2.fg2 }}>{fmtHistTs(e.updated_at)}</div>
                        </div>
                      </Focusable>
                    );
                  })}
                </Focusable>
              </div>
            ))}
          </div>
        )
      )}
    </div>
  );
}

// ── Multi-disc helpers (shared by the cover tile, the Play button and the
// Files tab) ────────────────────────────────────────────────────────────────
type LocalDisc = { name: string; path: string; is_m3u: boolean; is_region?: boolean };

// Friendly label for a disc file: keep the "(Disc N)" tail when present, else
// fall back to the bare filename (sans extension).
function discDisplayLabel(fname: string): string {
  const base = fname.replace(/\.[^.]+$/, '');
  const m = base.match(/\(dis[ck]\s*\d+[^)]*\)/i);
  return m ? m[0].replace(/[()]/g, '') : base;
}

// Friendly label for a regional variant file: surface the "(Region)" tag
// (e.g. "(Italy)", "(USA, Europe)") that RomM/No-Intro dumps carry, else the
// bare filename (sans extension).
function regionDisplayLabel(fname: string): string {
  const base = fname.replace(/\.[^.]+$/, '');
  const m = base.match(/\(([^)]+)\)\s*$/);
  return m ? m[1] : base;
}

// Launch a game. Under gamescope (Steam Deck Gaming Mode) this routes through
// the RomM tile's session-host so the Steam overlay works: prepare_steam_launch
// writes the emulator argv, then we RunGame the tile and the host execs it as a
// Steam-tracked child. Anywhere that fails (not gamescope, no tile, RunGame
// unavailable) it falls back to the direct daemon launch.
async function launchGameSmart(romId: number, disc: string | null = null,
  siblingRomId: number | null = null): Promise<any> {
  try {
    // Re-resolve the live tile appid: SetShortcutExe renumbers it (appid is a
    // hash of exe+name), so a cached _rommAppId can be stale.
    const liveIds = _rommAppIds();
    const appId = (liveIds.length ? liveIds[0] : (_rommAppId ?? await findRommShortcut()));
    if (appId != null) {
      _rommAppId = appId;
      const prep = await prepareSteamLaunch(romId, disc, siblingRomId);
      if (prep?.steam_host) {
        _rommLaunchPending = true;
        // Mark the session active HERE, not only in the GameActionStart
        // intercept: on some Steam builds RunGame-initiated launches don't
        // fire GameActionStart, and then the app-lifetime end-watch would
        // never navigate back to the Game Browser.
        _rommSessionActive = true;
        try {
          // A non-Steam shortcut is launched by its 64-bit gameID, not the bare
          // 32-bit appid: gameID = (appid << 32) | 0x02000000 (shortcut tag).
          // This is the same value GameActionStart reports back to the intercept.
          const gid = ((BigInt(appId) << 32n) | 0x2000000n).toString();
          await _sc()?.Apps?.RunGame?.(gid, "", -1, 100);
          touchRommRecency();
          return { success: true, message: 'Launching' };
        } catch (e) {
          _rommLaunchPending = false;
          _rommSessionActive = false;
          console.error('[RomM] RunGame', e);
        }
      } else if (prep && prep.success === false && prep.steam_host === false
        && prep.message && prep.message !== 'Not running under gamescope') {
        // A real failure (e.g. game not downloaded) — surface it rather than
        // silently falling back to a direct launch that would fail the same way.
        return prep;
      }
    }
  } catch (e) { console.error('[RomM] launchGameSmart', e); }
  return await launchGame(romId, disc, siblingRomId);
}

// A launch that failed for a missing core: offer to install one and start the
// game, instead of a toast that only names the problem. Returns true when the
// picker took over, so the caller skips its own error toast.
function offerCoreInstall(r: any, retry: () => void): boolean {
  if (!r?.needs_core) return false;
  showModal(
    <MissingCoreModal
      gap={{
        platform_name: r.platform_name || 'This platform',
        platform_slug: r.platform_slug || '',
        candidates: r.candidates || [],
        installed_cores: r.installed_cores || [],
        can_download: !!r.can_download,
        download_reason: r.download_reason || '',
      }}
      onPlay={retry} />
  );
  return true;
}

async function runLaunch(romId: number, gameName: string, disc: string | null,
  label?: string, setBusy?: (b: any) => void, onDone?: () => void, siblingRomId?: number | null) {
  if (setBusy) setBusy('launch');
  try {
    const r = await launchGameSmart(romId, disc, siblingRomId ?? null);
    if (r?.success) toaster.toast({ title: 'Launching', body: label || gameName });
    else if (offerCoreInstall(r, () => void runLaunch(
      romId, gameName, disc, label, setBusy, onDone, siblingRomId))) {
      // The picker owns the outcome now — no toast.
    } else {
      toaster.toast({ title: 'Launch failed', body: r?.message || 'Error' });
      // Self-heal a stale "downloaded" tile: if launch failed because the files
      // aren't actually there (deleted off-device in a prior session, cache not
      // yet reconciled), flip every cached surface back to not-downloaded so the
      // cover offers Download instead of a Play that keeps failing.
      if (/not downloaded/i.test(r?.message || '')) libCacheSetDownloaded(romId, false);
    }
  } catch (e) {
    toaster.toast({ title: 'Launch failed', body: String(e) });
  } finally {
    if (setBusy) setBusy(null);
    if (onDone) onDone();
  }
}

// V2 glass picker — the disc/region selector in the app's own modal language
// (same chrome as CollectionActionsModal / UserMenuModal) instead of Steam's
// native context menu. Rows reuse UserMenuRow; the remembered/default entry
// carries a check in the icon slot.
function PickerModal({ title, items, closeModal }: {
  title: string;
  items: { key: string | number; label: string; active?: boolean; onSelect: () => void }[];
  closeModal?: () => void;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  useEffect(() => { const t = setTimeout(() => { if (panelRef.current) _forceGamepadFocus(panelRef.current); }, 60); return () => clearTimeout(t); }, []);
  return (
    <ModalRoot bHideCloseIcon onCancel={closeModal} onEscKeypress={closeModal}
      className="romm-modal-collapse" modalClassName="romm-modal-collapse">
      <Focusable noFocusRing className="romm-ui"
        onCancelButton={() => closeModal?.()}
        onButtonDown={(e: any) => { if (e?.detail?.button === GamepadButton.CANCEL) closeModal?.(); }}
        style={{
          position: 'fixed', inset: 0, zIndex: 9999,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          background: 'rgba(7,7,15,0.45)',
          WebkitBackdropFilter: 'blur(8px)', backdropFilter: 'blur(8px)',
        }}>
        <style>{`
          ${V2_FOCUS_STYLE}
          .romm-modal-collapse, .romm-modal-collapse > div {
            background: transparent !important; border: none !important; box-shadow: none !important; padding: 0 !important;
          }
          @keyframes umIn { from { opacity: 0; transform: translateY(-6px) scale(0.98); } to { opacity: 1; transform: none; } }
        `}</style>
        <div onClick={() => closeModal?.()} style={{ position: 'absolute', inset: 0 }} />
        <Focusable noFocusRing autoFocus ref={panelRef} flow-children="vertical" style={{
          position: 'relative', width: '340px', maxWidth: '90vw', boxSizing: 'border-box',
          fontFamily: V2.font, color: V2.fg, padding: '8px',
          display: 'flex', flexDirection: 'column',
          background: 'linear-gradient(180deg, rgba(20,20,30,0.7) 0%, rgba(10,10,18,0.78) 100%)',
          WebkitBackdropFilter: 'blur(28px) saturate(1.1)', backdropFilter: 'blur(28px) saturate(1.1)',
          border: `1px solid rgba(255,255,255,0.12)`, borderRadius: V2.radiusCard,
          boxShadow: '0 16px 48px rgba(0,0,0,0.55)',
          maxHeight: '82vh', overflowY: 'auto',
          animation: 'umIn 0.18s cubic-bezier(0.22,1,0.36,1)',
        }}>
          <div style={{
            fontSize: '11px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em',
            color: V2.fgMuted, padding: '6px 8px 10px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
          }}>{title}</div>
          <div style={{ height: '1px', background: V2.border, margin: '0 4px 4px' }} />
          {items.map((it) => (
            <UserMenuRow key={it.key}
              icon={it.active ? <FaCheck size={14} style={{ color: V2.brand }} /> : null}
              label={it.label}
              onSelect={() => { closeModal?.(); it.onSelect(); }} />
          ))}
        </Focusable>
      </Focusable>
    </ModalRoot>
  );
}

// Picker listing the bootable discs (V2 modal). The first item launches the
// .m3u playlist (in-game disc swap) when present, else disc 1. `last` is the
// remembered disc (what a plain Play resumes) and is checkmarked. Choosing the
// playlist persists the .m3u name so a later plain Play resumes the playlist.
function openDiscPicker(romId: number, gameName: string, discs: LocalDisc[],
  last?: string, setBusy?: (b: any) => void, onLaunched?: () => void) {
  // A regional multi-file ROM has no playlist — every entry is a standalone
  // region. Present it as a region picker (no "all discs" default).
  const isRegion = discs.length > 0 && discs.every((d) => d.is_region);
  if (isRegion) {
    // Default to the remembered region, else the first one.
    const activeName = (last && discs.some((d) => d.name === last)) ? last : discs[0]?.name;
    showModal(
      <PickerModal title="Select region" items={discs.map((d) => ({
        key: d.name, label: regionDisplayLabel(d.name), active: d.name === activeName,
        onSelect: () => runLaunch(romId, gameName, d.name, regionDisplayLabel(d.name), setBusy, onLaunched),
      }))} />
    );
    return;
  }
  const m3u = discs.find((d) => d.is_m3u);
  const pickable = discs.filter((d) => !d.is_m3u);
  // The playlist is the active default when it is the remembered choice, or when
  // nothing is remembered yet (the implicit first-launch default).
  const m3uActive = !!m3u && (last === m3u.name || !last);
  showModal(
    <PickerModal title="Select disc" items={[
      {
        key: '__all__', label: m3u ? 'Play (all discs, in-game swap)' : 'Play (disc 1)',
        active: m3uActive,
        onSelect: () => runLaunch(romId, gameName, m3u ? m3u.name : null,
          m3u ? 'All discs' : undefined, setBusy, onLaunched),
      },
      ...pickable.map((d) => ({
        key: d.name, label: discDisplayLabel(d.name), active: last === d.name,
        onSelect: () => runLaunch(romId, gameName, d.name, discDisplayLabel(d.name), setBusy, onLaunched),
      })),
    ]} />
  );
}

function openRegionPicker(
  romId: number, gameName: string,
  siblings: { rom_id: number; name: string }[],
  downloadedIds: Set<number>,
  lastUsedId?: number,
  onSelected?: (sibRomId: number) => void,
) {
  const mainEntry = { rom_id: romId, name: gameName };
  const sorted = [...siblings].sort((a, b) => {
    const aDl = downloadedIds.has(a.rom_id) ? 0 : 1;
    const bDl = downloadedIds.has(b.rom_id) ? 0 : 1;
    if (aDl !== bDl) return aDl - bDl;
    return a.name.localeCompare(b.name);
  });
  const all = [mainEntry, ...sorted];

  showModal(
    <PickerModal title="Select region" items={all.map((entry) => ({
      key: entry.rom_id,
      label: entry.name
        + (entry.rom_id !== romId && !downloadedIds.has(entry.rom_id) ? ' (not downloaded)' : ''),
      active: entry.rom_id === lastUsedId,
      onSelect: () => onSelected?.(entry.rom_id),
    }))} />
  );
}

function GameDetailPage() {
  const game = _libGameHolder;
  const [detail, setDetail] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<null | 'download' | 'delete' | 'launch'>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [isDownloaded, setIsDownloaded] = useState<boolean>(!!game?.is_downloaded);
  const [discs, setDiscs] = useState<LocalDisc[]>([]);
  const [discLast, setDiscLast] = useState<string>('');
  const [bgUri, setBgUri] = useState<string | null>(null);
  const [tab, setTab] = useState('overview');
  const dlProg = useDownloadProgress(game?.rom_id ?? -1, busy === 'download');
  const dlPct = dlProg?.percent ?? null;
  const extracting = dlProg?.state === 'extracting';
  const globalDownloading = useIsDownloading(game?.rom_id ?? -1);
  const downloading = busy === 'download' || globalDownloading;
  const smoothPct = useSmoothNumber(dlPct, downloading);
  // Nothing to launch into: Play dims rather than disappearing, and says why
  // when focused. Downloading stays available — building a library before you
  // own an emulator is legitimate.
  const emu = useEmulatorStatus();
  const noEmulator = emu != null && !emu.installed;
  const [ctaFocused, setCtaFocused] = useState(false);
  // Land gamepad focus on the primary CTA (Play / Download) when the page
  // opens. As an internal view (LibraryRootPage) there is no route change, so
  // Steam gives us no focus pass — without this the generic view focus-pull
  // could park focus on the page's invisible root Focusable.
  const ctaRef = useAutoFocus(true, game?.rom_id);

  const load = async () => {
    if (!game) { setLoading(false); return; }
    setLoading(true);
    const rid = game.rom_id;
    try {
      const res = await getGameDetail(rid);
      if (res?.success) {
        setDetail(res);
        setIsDownloaded(!!res.is_downloaded);
        // Earned achievements are fetched separately so nothing blocks on the
        // extra /users/me round-trip; patch earned flags in once they arrive.
        if (res.ra_id && (res.achievements?.length)) {
          getRaEarned(res.ra_id).then((r: any) => {
            const earned = new Set<string>(r?.earned || []);
            if (!earned.size) return;
            setDetail((prev: any) => prev && prev.rom_id === rid ? {
              ...prev,
              achievements: prev.achievements.map((a: any) =>
                ({ ...a, earned: a.badge_id != null && earned.has(String(a.badge_id)) })),
            } : prev);
          }).catch(() => { });
        }
      }
    } catch (e) {
      console.error('get_game_detail failed', e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  // If a download for this game finishes on another surface (e.g. its cover
  // tile), refresh so the CTA flips Download → Play here too.
  const prevDownloading = useRef(false);
  useEffect(() => {
    if (prevDownloading.current && !downloading) load();
    prevDownloading.current = downloading;
  }, [downloading]);

  // Resolve the on-disk disc files once the game is downloaded. A multi-disc
  // game exposes >1 entry (plus an .m3u); a single-disc game returns [].
  // `discReload` bumps after a disc launch so the remembered-disc checkmark and
  // the resume target stay current without leaving the page.
  const [discReload, setDiscReload] = useState(0);
  useEffect(() => {
    if (!game || !isDownloaded) { setDiscs([]); setDiscLast(''); return; }
    let alive = true;
    (async () => {
      try {
        const r = await getLocalDiscs(game.rom_id);
        if (alive) { setDiscs(r?.success ? (r.discs || []) : []); setDiscLast(r?.last || ''); }
      } catch { if (alive) { setDiscs([]); setDiscLast(''); } }
    })();
    return () => { alive = false; };
  }, [isDownloaded, game?.rom_id, discReload]);

  // A game is "multi-disc" for picker purposes when more than one bootable
  // disc exists (the .m3u playlist alone does not count as a choice).
  const pickableDiscs = discs.filter((d) => !d.is_m3u);
  const isMultiDisc = pickableDiscs.length > 1;

  const doDownload = async () => {
    if (!game) return;
    setBusy('download');
    _setDlActive(game.rom_id, true, detail?.name || game.name);
    try {
      const start = await downloadGame(game.rom_id);
      if (!start?.success) {
        toaster.toast({ title: 'Download failed', body: start?.message || 'Unknown error' });
        return;
      }
      const res = await awaitDownload(game.rom_id);
      if (res.ok) {
        toaster.toast({
          title: 'Downloaded', body: detail?.name || game.name,
          logo: <ToastCover romId={game.rom_id} hasCover={game.has_cover} />,
          // Started from this page, but the toast outlives it — a click has to
          // bring the user back rather than do nothing.
          onClick: () => openGameById(game.rom_id, detail?.name || game.name, "/romm-sync-library"),
        });
        setIsDownloaded(true);
        libCacheSetDownloaded(game.rom_id, true);
      } else {
        toaster.toast({ title: 'Download failed', body: res.message || 'Unknown error' });
      }
    } catch (e) {
      toaster.toast({ title: 'Download failed', body: String(e) });
    } finally {
      _setDlActive(game.rom_id, false);
      setBusy(null);
    }
  };

  const doLaunch = async (disc?: string | null, label?: string) => {
    if (!game) return;
    await runLaunch(game.rom_id, detail?.name || game.name, disc ?? null, label, setBusy);
    if (disc) setDiscReload((n) => n + 1);  // refresh remembered-disc marker
  };

  // Y / Options on the Play button: pick which disc to boot.
  const openDiscMenu = () => {
    if (game) openDiscPicker(game.rom_id, detail?.name || game.name, discs, discLast,
      setBusy, () => setDiscReload((n) => n + 1));
  };

  const doDelete = async () => {
    if (!game) return;
    setBusy('delete');
    try {
      const res = await deleteGame(game.rom_id);
      if (res?.success) {
        setIsDownloaded(false);
        libCacheSetDownloaded(game.rom_id, false);
      } else {
        toaster.toast({ title: 'Delete failed', body: res?.message || 'Unknown error' });
      }
    } catch (e) {
      toaster.toast({ title: 'Delete failed', body: String(e) });
    } finally {
      setBusy(null);
      setConfirmDelete(false);
    }
  };

  if (!game) {
    return v2Page(<div style={{ padding: '16px', color: V2.fgMuted }}>No game selected.</div>);
  }

  const name = detail?.name || game.name;
  const platform = detail?.platform || game.platform;
  const releaseDate = fmtReleaseDate(detail?.release_date);
  // RomM GameHeader meta row: platform-icon + platform · release date ·
  // verified — text items only (the tag chips render after as RTags).
  const meta: { text: string; color?: string }[] = [];
  if (platform) meta.push({ text: platform });
  if (releaseDate) meta.push({ text: releaseDate });

  // Header tag chips (RomM GameHeader): regions (info), languages (brand),
  // custom tags (neutral) — each an RTag.
  const headerTags: { text: string; tone: 'info' | 'brand' | 'neutral' }[] = [
    ...((detail?.regions || []) as string[]).map((r) => ({ text: r, tone: 'info' as const })),
    ...((detail?.languages || []) as string[]).map((l) => ({ text: l, tone: 'brand' as const })),
    ...((detail?.tags || []) as string[]).map((t) => ({ text: t, tone: 'neutral' as const })),
  ];

  // Overview "InfoGrid" sections — icon + label + chip items (RomM InfoGrid).
  const infoGrid: { label: string; items: string[]; icon?: any }[] = [];
  if (detail?.genres?.length) infoGrid.push({ label: 'Genres', items: detail.genres });
  if (detail?.companies?.length) infoGrid.push({ label: 'Companies', items: detail.companies });
  if (detail?.franchises?.length) infoGrid.push({ label: 'Franchises', items: detail.franchises });
  if (detail?.collections?.length) infoGrid.push({ label: 'Collections', items: detail.collections });

  const related = detail?.related || {};
  const hasRelated = ['expansions', 'dlcs', 'remakes', 'remasters']
    .some((k) => (related[k] || []).length);
  const ageRatings = detail?.age_ratings || [];
  const userCollections: string[] = detail?.user_collections || [];

  // Tab strip — Files only when the server reported files (RomM hides empty tabs).
  const tabList: { id: string; label: string }[] = [{ id: 'overview', label: 'Overview' }];
  if (detail?.files?.length) tabList.push({ id: 'files', label: 'Files' });
  if (detail?.screenshots?.length) tabList.push({ id: 'screenshots', label: 'Screenshots' });
  tabList.push({ id: 'save-data', label: 'Save Data' });
  if (detail?.achievements?.length) tabList.push({ id: 'achievements', label: 'Achievements' });
  tabList.push({ id: 'metadata', label: 'Metadata' });

  // L1 / R1 page through the detail tabs (RomM pages detail tabs with bumpers).
  // After a switch, land gamepad focus on the new tab's FIRST interactive
  // element (subtab pill, screenshot, filter, save row …) so the content is
  // immediately steerable — not back on the Play/Download CTA. The retry
  // ladder covers tabs whose content mounts async (Save Data fetches first);
  // a tab with nothing focusable (Overview's plain text) parks focus on the
  // CTA only if it died with the old tab's unmount, and each attempt bails
  // once focus is inside the content so the user is never fought.
  const tabContentRef = useRef<HTMLDivElement | null>(null);
  const tabFocusSeq = useRef(0);
  const cycleTab = (dir: -1 | 1) => {
    const i = tabList.findIndex((t) => t.id === tab);
    const ni = (i < 0 ? 0 : i + dir + tabList.length) % tabList.length;
    setTab(tabList[ni].id);
    const seq = ++tabFocusSeq.current;
    // The ladder stretches to ~3s because Save Data mounts its content only
    // after a fetch. Two guards keep it polite: it stops for good once focus
    // is inside the content, and it stops if the user has meanwhile driven
    // focus somewhere else themselves (any connected element that is neither
    // where focus was at switch time nor a spot we parked it on).
    const initial: any = _gpFocusEl();
    let parked: any = null;
    [60, 180, 400, 750, 1200, 2000, 3000].forEach((d) => setTimeout(() => {
      try {
        if (seq !== tabFocusSeq.current) return;      // superseded by a newer switch
        const host = tabContentRef.current;
        if (!host) return;
        const cur: any = _gpFocusEl();
        if (cur && cur.isConnected && host.contains(cur)) { tabFocusSeq.current++; return; }  // landed — done
        if (cur && cur.isConnected && cur !== initial && cur !== parked) { tabFocusSeq.current++; return; }  // user moved — don't fight
        // First LEAF focusable: containers (noFocusRing grids/lists) also carry
        // tabindex, but focusing them paints no highlight — skip to their first
        // real item.
        const nodes = Array.from(host.querySelectorAll('[tabindex]')) as HTMLElement[];
        const leaf = nodes.find((n) => !n.querySelector('[tabindex]'));
        if (leaf) { _forceGamepadFocus(leaf); return; }
        if ((!cur || !cur.isConnected) && ctaRef.current) { parked = ctaRef.current; _forceGamepadFocus(parked); }
      } catch { /* ignore */ }
    }, d));
  };
  const onButtonDown = (evt: any) => {
    const b = evt?.detail?.button;
    if (b === GamepadButton.BUMPER_LEFT) cycleTab(-1);
    else if (b === GamepadButton.BUMPER_RIGHT) cycleTab(1);
    else if (b === GamepadButton.SELECT) { playSteamSound('deck_ui_show_modal'); libNavigate("/romm-sync-settings"); }
  };
  // Back returns to the page this game was opened from (collection/platform games
  // page or the library index). onCancelButton CONSUMES B so Steam's default
  // router-back doesn't also fire (which would land somewhere else entirely).
  const onBack = () => libBack(_libGameOrigin);

  return v2Page(
    <Focusable noFocusRing onButtonDown={onButtonDown} onCancelButton={onBack} style={{ padding: '20px 16px' }}>
      <Focusable noFocusRing flow-children="horizontal" style={{ display: 'flex', gap: '22px', alignItems: 'flex-start' }}>
        {/* Cover */}
        <div style={{ flex: '0 0 220px', maxWidth: '220px' }}>
          <div style={{ boxShadow: V2.elev2, borderRadius: V2.radiusLg, overflow: 'hidden' }}>
            <GameCover romId={game.rom_id} hasCover={game.has_cover || !!detail?.has_cover} large
              radius={V2.radiusLg} onLoaded={setBgUri} />
          </div>
        </div>

        {/* Info + actions */}
        <Focusable noFocusRing flow-children="vertical" style={{ flex: '1 1 auto', minWidth: 0, display: 'flex', flexDirection: 'column', gap: '14px' }}>
          <div>
            <div style={{ fontSize: '30px', fontWeight: 800, lineHeight: '1.15', letterSpacing: '-0.01em' }}>{name}</div>
            <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '0', marginTop: '8px', fontSize: '13.5px', color: V2.fg2 }}>
              {/* Platform icon leads the meta row (RomM GameHeader). */}
              {game.platform_slug && (
                <span style={{ display: 'inline-flex', width: '16px', height: '16px', marginRight: '6px', alignItems: 'center', justifyContent: 'center' }}>
                  <PlatformIcon slug={game.platform_slug} size={16} />
                </span>
              )}
              {meta.map((m, i) => (
                <span key={i} style={{ display: 'inline-flex', alignItems: 'center' }}>
                  {i > 0 && <span style={{ opacity: 0.3, margin: '0 8px' }}>·</span>}
                  <span style={{ color: m.color || V2.fg2 }}>{m.text}</span>
                </span>
              ))}
              {/* Verified — icon-only check matching RomM GameHeader
                  (mdi-check-decagram seal); MdVerified is its react-icons twin. */}
              {detail?.verified && (
                <>
                  <span style={{ opacity: 0.3, margin: '0 8px' }}>·</span>
                  <MdVerified size={17} color={V2.success} />
                </>
              )}
              {/* Region / language / custom tag chips (RomM RTags). */}
              {headerTags.length > 0 && (
                <>
                  <span style={{ opacity: 0.3, margin: '0 8px' }}>·</span>
                  <span style={{ display: 'inline-flex', flexWrap: 'wrap', gap: '6px' }}>
                    {headerTags.map((tg, i) => {
                      const palette =
                        tg.tone === 'info' ? { c: '#93c5fd', b: 'rgba(147,197,253,0.14)', br: 'rgba(147,197,253,0.30)' }
                          : tg.tone === 'brand' ? { c: V2.brandHover, b: 'rgba(139,116,232,0.16)', br: 'rgba(139,116,232,0.30)' }
                            : { c: V2.fg2, b: V2.surface, br: V2.border };
                      return (
                        <span key={i} style={{
                          fontSize: '11px', fontWeight: 600, lineHeight: 1.6, padding: '1px 8px',
                          borderRadius: V2.radiusPill, color: palette.c,
                          background: palette.b, border: `1px solid ${palette.br}`,
                        }}>{tg.text}</span>
                      );
                    })}
                  </span>
                </>
              )}
            </div>
          </div>

          {/* Actions — RomM GameActions ribbon: an emphasized white pill for the
              primary CTA (Download when absent, Play when present) + circular
              surface icon buttons for the secondary actions (Delete). */}
          <Focusable noFocusRing flow-children="horizontal" style={{ display: 'flex', gap: '10px', flexWrap: 'wrap', alignItems: 'center' }}>
            {!isDownloaded ? (
              <GameActionButton variant="emphasized" focusRef={ctaRef} disabled={!!busy || downloading} onClick={doDownload}
                progress={downloading ? (dlPct ?? 0) : undefined}
                label={downloading
                  ? (extracting ? (dlPct != null ? `Extracting… ${dlPct}%` : 'Extracting…')
                     : dlPct != null ? `Downloading… ${smoothPct}%` : 'Downloading…')
                  : 'Download'}
                icon={downloading
                  ? (extracting ? <FaBoxOpen size={15} />
                     : <FaSync size={15} style={{ animation: 'spin 1s linear infinite' }} />)
                  : <FaDownload size={15} />} />
            ) : !confirmDelete ? (
              <>
                <GameActionButton variant="emphasized" focusRef={ctaRef} disabled={!!busy || noEmulator}
                  onClick={() => doLaunch()}
                  onFocused={() => setCtaFocused(true)} onBlurred={() => setCtaFocused(false)}
                  onOptionsButton={isMultiDisc && !noEmulator ? openDiscMenu : undefined}
                  optionsHint={isMultiDisc && !noEmulator}
                  label={busy === 'launch' ? 'Launching…' : 'Play'}
                  icon={busy === 'launch'
                    ? <FaSync size={15} style={{ animation: 'spin 1s linear infinite' }} />
                    : <FaPlay size={14} style={{ marginLeft: '2px' }} />} />
                {noEmulator && ctaFocused && (
                  <span style={{ fontSize: '12px', color: V2.warning, maxWidth: '260px', lineHeight: 1.35 }}>
                    No emulator installed — install RetroArch from Home to play.
                  </span>
                )}
                <GameActionButton variant="surface" accent="danger" onClick={() => setConfirmDelete(true)}
                  icon={<FaTrash size={15} />} />
              </>
            ) : (
              <>
                <GameActionButton variant="danger" disabled={!!busy} onClick={doDelete}
                  label={busy === 'delete' ? 'Deleting…' : 'Confirm delete'}
                  icon={busy === 'delete'
                    ? <FaSync size={15} style={{ animation: 'spin 1s linear infinite' }} />
                    : <FaTrash size={15} />} />
                <GameActionButton variant="surface" onClick={() => setConfirmDelete(false)}
                  icon={<FaTimes size={16} />} />
              </>
            )}
            {/* Live transfer readout — speed · ETA, shown beside the button only
                while a download is in flight (kept off the cover tiles by design). */}
            {downloading && dlProg && (dlProg.speed > 0 || dlProg.eta > 0) && (
              <span style={{
                display: 'inline-flex', alignItems: 'center', gap: '8px', fontSize: '13px', color: V2.fg2,
                animation: 'dlValIn 0.35s ease'
              }}>
                <span style={{ opacity: 0.3 }}>·</span>
                {dlProg.speed > 0 && <span>{formatSpeed(dlProg.speed)}</span>}
                {dlProg.speed > 0 && formatEta(dlProg.eta) && <span style={{ opacity: 0.3 }}>·</span>}
                {formatEta(dlProg.eta) && <span>{formatEta(dlProg.eta)} left</span>}
              </span>
            )}
          </Focusable>

          {/* Tabbed panel (RomM GameDetails: RTabNav + tab content). L1/R1 page tabs. */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <div style={{ flex: '1 1 auto', minWidth: 0 }}><V2TabNav tabs={tabList} active={tab} onTab={setTab} /></div>
            <Bumper label="L1" />
            <Bumper label="R1" />
          </div>
          <div ref={tabContentRef} style={{ paddingTop: '14px' }}>
            {loading ? (
              <div style={{ color: V2.fgMuted, fontSize: '12px' }}>Loading details…</div>
            ) : tab === 'overview' ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '30px' }}>
                {/* 1. Summary */}
                {detail?.summary && (
                  <div style={{ fontSize: '13.5px', color: V2.fg2, lineHeight: '1.7' }}>{detail.summary}</div>
                )}

                {/* 2. Left-labelled fact rows — Last played · Players · Age rating
                    (RomM OverviewTab __facts). */}
                {(() => {
                  const lp = detail?.last_played ? new Date(detail.last_played) : null;
                  const lpStr = lp && !isNaN(lp.getTime()) ? lp.toLocaleString() : null;
                  const rows: { label: string; field: any }[] = [];
                  if (lpStr) rows.push({ label: 'Last played', field: <span style={{ fontSize: '13px', color: V2.fg2 }}>{lpStr}</span> });
                  if (detail?.player_count) rows.push({ label: 'Players', field: <PlayerCountBadge value={String(detail.player_count)} /> });
                  if (ageRatings.length) rows.push({ label: 'Age rating', field: <AgeRatingBadges items={ageRatings} /> });
                  if (userCollections.length) rows.push({
                    label: 'Collections',
                    field: (
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
                        {userCollections.map((c, i) => (
                          <span key={i} style={{
                            display: 'inline-flex', alignItems: 'center', gap: '5px', padding: '4px 10px',
                            background: V2.surface, border: `1px solid ${V2.borderStrong}`, borderRadius: V2.radiusPill,
                            fontSize: '11.5px', fontWeight: 600, color: V2.fg2,
                          }}><FaBookmark size={10} color={V2.brand} />{c}</span>
                        ))}
                      </div>
                    ),
                  });
                  if (!rows.length) return null;
                  return (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
                      {rows.map((r) => (
                        <div key={r.label} style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
                          <div style={{ width: '120px', flexShrink: 0, fontSize: '10.5px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', color: V2.fgFaint }}>{r.label}</div>
                          <div style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: '12px' }}>{r.field}</div>
                        </div>
                      ))}
                    </div>
                  );
                })()}

                {/* 3. Info grid */}
                <InfoGrid sections={infoGrid} />

                {/* 4. HLTB */}
                {detail?.hltb && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                    <SectionHeading icon={<FaClock size={12} />}>How long to beat</SectionHeading>
                    <HLTBStrip hltb={detail.hltb} />
                  </div>
                )}

                {/* 5. Related games — one labelled section per category. */}
                {hasRelated && (
                  <>
                    <RelatedSection icon={<FaPuzzlePiece size={12} />} title="Expansions" items={related.expansions} />
                    <RelatedSection icon={<FaBoxOpen size={12} />} title="DLC" items={related.dlcs} />
                    <RelatedSection icon={<FaRedo size={12} />} title="Remakes" items={related.remakes} />
                    <RelatedSection icon={<FaClone size={12} />} title="Remasters" items={related.remasters} />
                  </>
                )}

                {!detail?.summary && infoGrid.length === 0 && !hasRelated && !detail?.hltb && !ageRatings.length && (
                  <div style={{ color: V2.fgMuted, fontSize: '12px' }}>No metadata available.</div>
                )}
              </div>
            ) : tab === 'files' ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
                {/* Discs — bootable entries on disk (downloaded multi-disc games).
                    Each row launches that disc; the playlist row boots all discs
                    with in-game swapping. */}
                {isMultiDisc && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                    <SectionHeading icon={<FaLayerGroup size={12} />}>Discs</SectionHeading>
                    {discs.some((d) => d.is_m3u) && (
                      <V2SettingsRow icon={<FaLayerGroup size={14} />}
                        title="All discs" subtitle="In-game disc swapping"
                        onClick={() => doLaunch(null, 'All discs')}
                        right={<FaPlay size={12} style={{ color: V2.fgMuted }} />} />
                    )}
                    {pickableDiscs.map((d) => (
                      <V2SettingsRow key={d.name} icon={<FaClone size={14} />}
                        title={discDisplayLabel(d.name)} subtitle={d.name}
                        onClick={() => doLaunch(d.name, discDisplayLabel(d.name))}
                        right={<FaPlay size={12} style={{ color: V2.fgMuted }} />} />
                    ))}
                  </div>
                )}
                <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                  {isMultiDisc && <SectionHeading icon={<FaBoxOpen size={12} />}>Files</SectionHeading>}
                  {(detail?.files || []).length === 0 ? (
                    <div style={{ color: V2.fgMuted, fontSize: '12px' }}>No file information.</div>
                  ) : (detail.files).map((f: any, i: number) => (
                    <div key={i} style={{
                      display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '12px',
                      padding: '9px 12px', borderRadius: V2.radiusMd, background: V2.surface, fontSize: '12px',
                    }}>
                      <span style={{ color: V2.fg2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.name}</span>
                      <span style={{ color: V2.fgMuted, flexShrink: 0 }}>{fmtBytes(f.size)}</span>
                    </div>
                  ))}
                </div>
              </div>
            ) : tab === 'screenshots' ? (
              <ScreenshotGrid paths={detail?.screenshots || []} />
            ) : tab === 'save-data' ? (
              <SaveDataTab romId={game.rom_id} />
            ) : tab === 'metadata' ? (
              <MetadataTab detail={detail} />
            ) : (
              <AchievementsTab achievements={detail?.achievements || []} />
            )}
          </div>
        </Focusable>
      </Focusable>
    </Focusable>,
    bgUri,
  );
}

// ── V2 settings primitives (full-screen, controller-first) ──────────────────
// Uppercase eyebrow + a column of rows, matching the GameDetails section look.
function V2SettingsSection({ title, children }: { title: string; children: any }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginBottom: '24px' }}>
      <div style={{
        fontSize: '11px', fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase',
        color: V2.fgMuted, padding: '0 2px',
      }}>{title}</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>{children}</div>
    </div>
  );
}

// A focusable surface row: leading icon, title + optional subtitle, optional
// trailing control. Acts as a button when onClick is given.
// Row highlight — hover and focus tracked separately, because they are not the
// same thing once a modal is involved. Closing a modal restores focus to the row
// that opened it (right for the gamepad: that's where the cursor should resume),
// but with a mouse the pointer has since moved on, leaving that row lit next to
// whatever you're now hovering — two highlighted rows.
//
// So a row lights up for focus only when the pointer isn't the thing driving,
// which takes two checks — the restore happens in a rAF after the modal closes,
// so it can land either side of the pointer's own movement:
//
//   1. At focus time, look BACK: if the pointer was active in the last moment,
//      this focus is the tail of a mouse interaction, not a gamepad landing on
//      the row — don't light it. Needed when the pointer has already settled on
//      its new row before the restore fires, leaving no later event to react to.
//   2. While lit, look FORWARD: any pointer movement retires the highlight.
//      Needed when the restore fires first and the pointer moves away after.
//
// A gamepad leaves the pointer untouched, so neither check ever trips and its
// focus highlight behaves exactly as before.
const POINTER_IDLE_MS = 500;
let _lastPointerAt = 0;
const _pointerSubs = new Set<() => void>();
if (typeof window !== 'undefined') {
  // Capture phase: still observed if something downstream stops propagation.
  // mousedown counts too — dismissing a modal by clicking the backdrop can
  // reach the row underneath without producing a single mousemove.
  for (const evt of ['mousemove', 'mousedown']) {
    window.addEventListener(evt, () => {
      _lastPointerAt = Date.now();
      if (_pointerSubs.size) [..._pointerSubs].forEach((f) => f());
    }, true);
  }
}

function useRowHighlight() {
  const [hover, setHover] = useState(false);
  const [focusLit, setFocusLit] = useState(false);
  useEffect(() => {
    if (!focusLit) return;
    const drop = () => setFocusLit(false);
    _pointerSubs.add(drop);
    return () => { _pointerSubs.delete(drop); };
  }, [focusLit]);
  return {
    active: hover || focusLit,
    highlightHandlers: {
      onFocus: () => setFocusLit(Date.now() - _lastPointerAt > POINTER_IDLE_MS),
      onBlur: () => setFocusLit(false),
      onMouseEnter: () => setHover(true),
      onMouseLeave: () => setHover(false),
    },
  };
}

function V2SettingsRow({ icon, title, subtitle, onClick, right, danger, disabled, bareIcon }:
  { icon?: any; title: any; subtitle?: any; onClick?: () => void; right?: any; danger?: boolean; disabled?: boolean; bareIcon?: boolean }) {
  const { active, highlightHandlers } = useRowHighlight();
  const interactive = !!onClick && !disabled;
  const accent = danger ? V2.danger : V2.brand;
  return (
    <Focusable noFocusRing
      onActivate={interactive ? onClick : undefined}
      onClick={interactive ? onClick : undefined}
      {...highlightHandlers}
      style={{
        display: 'flex', alignItems: 'center', gap: '14px', padding: '14px 16px',
        borderRadius: V2.radiusCard, background: active ? V2.surfaceHover : V2.surface,
        border: `1px solid ${active && interactive ? accent : V2.border}`,
        boxShadow: active && interactive ? `0 0 0 2px ${accent}` : 'none',
        cursor: interactive ? 'pointer' : 'default', opacity: disabled ? 0.5 : 1,
        transition: 'background 0.15s, border-color 0.15s, box-shadow 0.15s',
      }}>
      {icon && (
        <div style={{
          flexShrink: 0, width: '36px', height: '36px', borderRadius: V2.radiusMd,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          // bareIcon: no chip background (used for full-bleed platform icons,
          // matching the Stats page's plain icon cell).
          background: bareIcon ? 'transparent' : (danger ? 'rgba(255,80,80,0.12)' : V2.bgElevated),
          color: bareIcon ? V2.fg2 : (danger ? V2.danger : V2.brandHover),
        }}>{icon}</div>
      )}
      <div style={{ flex: '1 1 auto', minWidth: 0, display: 'flex', flexDirection: 'column', gap: '2px' }}>
        <div style={{ fontSize: '14px', fontWeight: 600, color: danger ? V2.danger : V2.fg }}>{title}</div>
        {subtitle && <div style={{ fontSize: '12px', color: V2.fgMuted, lineHeight: 1.35 }}>{subtitle}</div>}
      </div>
      {right != null && <div style={{ flexShrink: 0 }}>{right}</div>}
    </Focusable>
  );
}

// Where a folder picker should open. Prefer the folder already in use; with
// nothing set the Deck has a known home, while on the desktop we pass '' and let
// the shell answer with the real one — '/home/deck' does not exist there, which
// is how the picker ended up opening on an empty listing.
function pickerStart(current?: string | null): string {
  if (current) return current;
  return (window as any).__rommDesktop ? '' : '/home/deck';
}

// The same row, but flat: no card of its own, so several can live inside ONE
// surface separated by hairlines (see FoldersSection). Highlight is drawn inset
// instead of as a border, which keeps the card's outline unbroken.
function V2CardRow({ icon, title, subtitle, onClick, right, danger, divider, first, last }:
  { icon?: any; title: any; subtitle?: any; onClick?: () => void; right?: any;
    danger?: boolean; divider?: boolean; first?: boolean; last?: boolean }) {
  const { active, highlightHandlers } = useRowHighlight();
  const interactive = !!onClick;
  const accent = danger ? V2.danger : V2.brand;
  // The highlight ring has to follow the CARD's corners, not its own: a row in
  // the middle is square, but the top and bottom rows sit in the card's rounded
  // ends. One pixel less than the card radius, because the card's 1px border
  // sits outside this ring.
  const end = `calc(${V2.radiusCard} - 1px)`;
  return (
    <Focusable noFocusRing
      onActivate={interactive ? onClick : undefined}
      onClick={interactive ? onClick : undefined}
      {...highlightHandlers}
      style={{
        display: 'flex', alignItems: 'center', gap: '14px', padding: '13px 14px',
        borderTopLeftRadius: first ? end : 0,
        borderTopRightRadius: first ? end : 0,
        borderBottomLeftRadius: last ? end : 0,
        borderBottomRightRadius: last ? end : 0,
        borderTop: divider ? `1px solid ${V2.border}` : 'none',
        background: active && interactive ? V2.surfaceHover : 'transparent',
        boxShadow: active && interactive ? `inset 0 0 0 2px ${accent}` : 'none',
        cursor: interactive ? 'pointer' : 'default',
        transition: 'background 0.15s, box-shadow 0.15s',
      }}>
      {icon && (
        <div style={{
          flexShrink: 0, width: '32px', height: '32px', borderRadius: V2.radiusMd,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          background: danger ? 'rgba(255,80,80,0.12)' : V2.bgElevated,
          color: danger ? V2.danger : V2.brandHover,
        }}>{icon}</div>
      )}
      <div style={{ flex: '1 1 auto', minWidth: 0, display: 'flex', flexDirection: 'column', gap: '2px' }}>
        <div style={{ fontSize: '14px', fontWeight: 600, color: danger ? V2.danger : V2.fg }}>{title}</div>
        {subtitle && <div style={{ fontSize: '12px', color: V2.fgMuted, lineHeight: 1.35 }}>{subtitle}</div>}
      </div>
      {right != null && <div style={{ flexShrink: 0 }}>{right}</div>}
    </Focusable>
  );
}

// Small pill switch in the V2 palette (the row owns activation).
function V2Switch({ checked }: { checked: boolean }) {
  return (
    <div style={{
      width: '40px', height: '22px', borderRadius: V2.radiusPill, flexShrink: 0,
      background: checked ? V2.brand : 'rgba(255,255,255,0.18)',
      transition: 'background 0.15s', position: 'relative',
    }}>
      <div style={{
        position: 'absolute', top: '2px', left: checked ? '20px' : '2px',
        width: '18px', height: '18px', borderRadius: '50%', background: '#fff',
        transition: 'left 0.15s',
      }} />
    </div>
  );
}

// Settings ▸ Recent Activity — a curated feed of what the plugin actually did
// (downloads, collection syncs, save/state sync, account events). Backed by the
// persisted backend activity log (get_recent_activity), so it covers background
// work that happened while no UI was open.
const ACTIVITY_ICONS: Record<string, any> = {
  download: FaDownload, sync: FaSync, save: FaSave, delete: FaTrash,
  account: FaUser, error: FaExclamationTriangle,
};

function fmtAgo(ts: number): string {
  const s = Math.max(0, Math.floor(Date.now() / 1000 - ts));
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return d === 1 ? 'yesterday' : `${d} days ago`;
}

function RecentActivitySection() {
  const [events, setEvents] = useState<Array<{ kind: string, title: string, detail: string, timestamp: number }>>([]);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const res = await getRecentActivity(10);
        if (alive && res?.events) setEvents(res.events);
      } catch { }
    };
    load();
    // Light poll so background events (collection sync, save sync) appear
    // while the user is sitting on the Settings tab.
    const iv = setInterval(load, 10000);
    return () => { alive = false; clearInterval(iv); };
  }, []);

  const shown = expanded ? events : events.slice(0, 6);

  // One "control panel" card: all entries as compact divided rows inside a
  // single surface, with the controls in a footer bar — not a card per event.
  return (
    <V2SettingsSection title="Recent Activity">
      <div style={{
        borderRadius: V2.radiusCard, background: V2.surface,
        border: `1px solid ${V2.border}`, overflow: 'hidden',
      }}>
        {events.length === 0 ? (
          <div style={{ padding: '14px 16px', fontSize: '12px', color: V2.fgMuted }}>
            Nothing yet — downloads, collection syncs and save syncs will show up here.
          </div>
        ) : shown.map((e, i) => {
          const Icon = ACTIVITY_ICONS[e.kind] || FaHistory;
          const err = e.kind === 'error';
          return (
            <div key={`${e.timestamp}-${i}`} style={{
              display: 'flex', alignItems: 'center', gap: '10px', padding: '8px 14px',
              borderTop: i > 0 ? `1px solid ${V2.border}` : 'none',
            }}>
              <div style={{ flexShrink: 0, color: err ? V2.danger : V2.brandHover, display: 'flex' }}>
                <Icon size={13} />
              </div>
              <div style={{ flex: '1 1 auto', minWidth: 0 }}>
                <div style={{
                  fontSize: '12px', fontWeight: 600, color: err ? V2.danger : V2.fg,
                  whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                }}>{e.title}</div>
                {e.detail && <div style={{
                  fontSize: '11px', color: V2.fgMuted,
                  whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                }}>{e.detail}</div>}
              </div>
              <div style={{ flexShrink: 0, fontSize: '10px', color: V2.fgMuted, whiteSpace: 'nowrap' }}>
                {fmtAgo(e.timestamp)}
              </div>
            </div>
          );
        })}
        {events.length > 0 && (
          <Focusable flow-children="horizontal" style={{
            display: 'flex', gap: '8px', padding: '8px 10px',
            borderTop: `1px solid ${V2.border}`, background: V2.bgElevated,
          }}>
            {events.length > 6 && (
              <V2Button variant="tonal" onClick={() => setExpanded(x => !x)}>
                <FaChevronDown size={11} style={{ transform: expanded ? 'rotate(180deg)' : 'none' }} />
                <span>{expanded ? 'Show less' : `Show all (${events.length})`}</span>
              </V2Button>
            )}
            <V2Button variant="tonal" onClick={async () => {
              try { await clearRecentActivity(); } catch { }
              setEvents([]); setExpanded(false);
            }}>
              <FaTimes size={11} /><span>Clear</span>
            </V2Button>
          </Focusable>
        )}
      </div>
    </V2SettingsSection>
  );
}

// Stats page — 1:1 port of RomM's ServerStats.vue: a section stack of
// SummaryStatsSection (card grid in SettingsSection chrome) + PlatformsStatsSection
// (toolbar + per-platform rows with size/percentage and a progress bar that
// doubles as the row divider). Scope is plugin-local (this device).

// RomM SettingsSection chrome: a header bar (surface bg, rounded-top only) over
// a body box (bg-elevated, rounded-bottom).
function V2StatsSectionBox({ title, icon, children }: { title: string; icon?: any; children: any }) {
  return (
    <section>
      <header style={{
        display: 'flex', alignItems: 'center', gap: '10px', padding: '12px 16px',
        background: V2.surface, border: `1px solid ${V2.border}`, borderBottom: 'none',
        borderRadius: '10px 10px 0 0', color: V2.fgMuted,
      }}>
        {icon}
        <span style={{
          fontSize: '11px', fontWeight: 700, letterSpacing: '0.1em',
          textTransform: 'uppercase', color: V2.fg2,
        }}>{title}</span>
      </header>
      <div style={{
        border: `1px solid ${V2.border}`, borderRadius: '0 0 10px 10px',
        overflow: 'hidden', background: V2.bgElevated,
      }}>{children}</div>
    </section>
  );
}

// SummaryStatsSection card: leading icon + big tabular number + uppercase label.
function V2StatCard({ icon, value, label }: { icon: any; value: string; label: string }) {
  return (
    <div style={{
      display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: '4px',
      padding: '16px', background: V2.surface, border: `1px solid ${V2.border}`,
      borderRadius: V2.radiusLg, color: V2.fgMuted,
    }}>
      <div style={{ color: V2.brandHover }}>{icon}</div>
      <div style={{
        fontSize: '28px', fontWeight: 800, lineHeight: 1.1, color: V2.fg,
        fontVariantNumeric: 'tabular-nums',
      }}>{value}</div>
      <div style={{
        fontSize: '11px', fontWeight: 600, letterSpacing: '0.08em',
        textTransform: 'uppercase', color: V2.fgMuted,
      }}>{label}</div>
    </div>
  );
}

type PlatStat = { slug: string; fs_slug?: string; name: string; rom_count: number; downloaded: number; fs_size_bytes: number };

// PlatformsStatsSection row: icon · name + meta · size + pct · progress bar
// (spans full width, doubles as the divider; hidden on the last row).
function PlatformStatRow({ p, total }: { p: PlatStat; total: number }) {
  const pct = total > 0 ? (p.fs_size_bytes / total) * 100 : 0;
  // Same system as the achievements list: a shared .romm-row (CSS drives the
  // focus/hover highlight via :focus-within) plus an empty onActivate so the
  // row registers as a gamepad nav target. No JS focus state or inline border —
  // that's what left a stray border on blur.
  return (
    <Focusable noFocusRing onActivate={() => { }} className="romm-row" style={{
      display: 'grid', gridTemplateColumns: 'auto 1fr auto', columnGap: '14px', rowGap: '12px',
      alignItems: 'center', padding: '12px 14px', borderRadius: V2.radiusMd,
    }}>
      <div style={{
        flexShrink: 0, width: '32px', height: '32px',
        display: 'flex', alignItems: 'center', justifyContent: 'center', color: V2.fg2,
      }}><PlatformIcon slug={p.slug} fsSlug={p.fs_slug} size={32} /></div>
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: '14px', fontWeight: 600, color: V2.fg }}>{p.name}</div>
        <div style={{
          marginTop: '4px', display: 'flex', flexWrap: 'wrap', alignItems: 'center',
          gap: '6px', fontSize: '12px', color: V2.fgMuted,
        }}>
          <span style={{ fontWeight: 500, color: V2.fg2 }}>{p.rom_count} game{p.rom_count === 1 ? '' : 's'}</span>
          <span style={{ color: V2.fgFaint }}>·</span>
          <span style={{
            display: 'inline-flex', alignItems: 'center', gap: '4px', padding: '1px 6px',
            borderRadius: V2.radiusSm, background: V2.surface, border: `1px solid ${V2.border}`,
            fontSize: '11px', fontWeight: 500, color: V2.fg2,
          }}>{p.downloaded} downloaded</span>
        </div>
      </div>
      <div style={{ textAlign: 'right', flexShrink: 0 }}>
        <div style={{ fontSize: '13px', fontWeight: 700, color: V2.brand, fontVariantNumeric: 'tabular-nums' }}>
          {fmtBytes(p.fs_size_bytes) || '0 B'}
        </div>
        <div style={{ fontSize: '11px', color: V2.fgFaint }}>{pct.toFixed(1)}%</div>
      </div>
      <div style={{ gridColumn: '1 / -1', height: '3px', borderRadius: '2px', background: 'rgba(255,255,255,0.08)', overflow: 'hidden' }}>
        <div style={{ height: '100%', width: `${pct}%`, background: V2.brand }} />
      </div>
    </Focusable>
  );
}

function StatsPage() {
  const [stats, setStats] = useState<any | null>(null);
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<'name' | 'size' | 'count'>('size');
  // Without an explicit mount focus, gamepad focus never enters the page, so
  // nothing (search, sort, the rows) can be reached and it can't scroll. Focus a
  // concrete child (the search field) — focusing the container itself doesn't
  // descend to a child here — and let spatial navigation handle the rest.
  const searchRef = useRef<any>(null);
  useEffect(() => {
    (async () => {
      try { setStats(await getPluginStats()); } catch { setStats({}); }
    })();
  }, []);
  useEffect(() => {
    if (stats == null) return;
    const t = setTimeout(() => { try { if (searchRef.current) _forceGamepadFocus(searchRef.current); } catch { } }, 80);
    return () => clearTimeout(t);
  }, [stats]);

  const s = stats || {};
  const cards = [
    { icon: <FaGamepad size={22} />, value: (s.platforms ?? 0).toLocaleString(), label: 'Platforms' },
    { icon: <FaLayerGroup size={22} />, value: (s.games_total ?? 0).toLocaleString(), label: 'Library games' },
    { icon: <FaDownload size={22} />, value: (s.games_downloaded ?? 0).toLocaleString(), label: 'Downloaded' },
    { icon: <FaHome size={22} />, value: fmtBytes(s.size_on_disk) || '0 B', label: 'Size on disk' },
    { icon: <FaBookmark size={22} />, value: (s.collections_total ?? 0).toLocaleString(), label: 'Collections' },
    { icon: <FaCheckCircle size={22} />, value: (s.collections_synced ?? 0).toLocaleString(), label: 'Synced' },
  ];

  const plats: PlatStat[] = (s.platforms_breakdown || []);
  const total = Number(s.size_on_disk || 0);
  const q = query.trim().toLowerCase();
  const filtered = plats
    .filter((p) => !q || p.name.toLowerCase().includes(q) || p.slug.toLowerCase().includes(q))
    .sort((a, b) =>
      sort === 'name' ? a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
        : sort === 'count' ? b.rom_count - a.rom_count
          : b.fs_size_bytes - a.fs_size_bytes);

  const sortItems: { id: 'name' | 'size' | 'count'; label: string }[] = [
    { id: 'name', label: 'Name' }, { id: 'size', label: 'Size' }, { id: 'count', label: 'Games' },
  ];

  return v2Page(
    <Focusable noFocusRing
      onCancelButton={() => libBack("/romm-sync-library")}
      style={{ maxWidth: '760px', margin: '0 auto', padding: '20px 20px 80px' }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '24px' }}>
        <GameActionButton icon={<FaChevronLeft size={16} />} onClick={() => libBack("/romm-sync-library")} />
        <div style={{ fontSize: '24px', fontWeight: 800, letterSpacing: '-0.01em' }}>Stats</div>
      </div>

      {/* Section stack */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
        {/* Summary */}
        <V2StatsSectionBox title="Summary" icon={<FaInfoCircle size={14} />}>
          <div style={{
            display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: '12px', padding: '16px',
          }}>
            {cards.map((c) => <V2StatCard key={c.label} {...c} />)}
          </div>
        </V2StatsSectionBox>

        {/* Platforms breakdown — flush, no card chrome (matches RomM). */}
        <section style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
          <Focusable noFocusRing flow-children="horizontal" style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <div style={{ flex: '0 1 360px', minWidth: 0 }}>
              <V2SearchField ref={searchRef} value={query} onChange={setQuery} />
            </div>
            {/* Same segmented pill control as the update channel / setup switch. */}
            <div style={{ marginLeft: 'auto' }}>
              <V2Segment options={sortItems} value={sort} onChange={(v) => setSort(v as any)} />
            </div>
          </Focusable>

          <Focusable noFocusRing flow-children="vertical" style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
            {filtered.length === 0 ? (
              <div style={{
                display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px',
                padding: '24px', color: V2.fgMuted, fontSize: '13px',
              }}>
                <FaBoxOpen size={22} /><span>{q ? 'No matching platforms' : 'No platforms'}</span>
              </div>
            ) : filtered.map((p) => (
              <PlatformStatRow key={p.slug} p={p} total={total} />
            ))}
          </Focusable>
        </section>
      </div>
    </Focusable>,
  );
}

// Downloads page: every in-flight download (per-game registry + backend
// collection auto-sync passes) with live progress, plus recently completed
// downloads from the backend activity log. Opened from the account menu.
// One "Recently completed" row. Focusable and openable when the activity entry
// carries a rom_id — A jumps to that game's detail page. Entries without one
// (failures, and anything logged before rom_id was recorded) render as inert
// text rather than as a focus target that does nothing when pressed.
function CompletedDownloadRow({ event, first }: {
  event: { kind: string; title: string; detail: string; timestamp: number; rom_id?: number };
  first: boolean;
}) {
  const { active, highlightHandlers } = useRowHighlight();
  const name = event.detail || event.title;
  const romId = event.rom_id;
  const open = romId != null
    ? () => openGameById(romId, name, "/romm-sync-downloads")
    : undefined;
  return (
    <Focusable noFocusRing
      // `focusable` isn't in @decky/ui's prop types but is honoured at runtime —
      // same cast the tiles use to drop out of gamepad nav.
      {...({ focusable: !!open } as any)}
      onActivate={open}
      onClick={open}
      {...highlightHandlers}
      style={{
        display: 'flex', alignItems: 'center', gap: '10px', padding: '9px 14px',
        borderTop: first ? 'none' : `1px solid ${V2.border}`,
        background: active && open ? V2.surfaceHover : 'transparent',
        // Inset ring rather than a border: these rows share one card, and a
        // real border would break its outline (same reasoning as V2CardRow).
        boxShadow: active && open ? `inset 0 0 0 2px ${V2.brand}` : 'none',
        cursor: open ? 'pointer' : 'default',
        transition: 'background 0.15s, box-shadow 0.15s',
      }}>
      <div style={{ flexShrink: 0, color: V2.success, display: 'flex' }}><FaCheckCircle size={13} /></div>
      <div style={{
        flex: '1 1 auto', minWidth: 0, fontSize: '12.5px', fontWeight: 600, color: V2.fg,
        whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
      }}>{name}</div>
      <div style={{ flexShrink: 0, fontSize: '10.5px', color: V2.fgMuted, whiteSpace: 'nowrap' }}>
        {fmtAgo(event.timestamp)}
      </div>
      {open && (
        <div style={{
          flexShrink: 0, display: 'flex', color: active ? V2.fg2 : V2.fgMuted,
          opacity: active ? 1 : 0.5, transition: 'opacity 0.15s, color 0.15s',
        }}><FaChevronRight size={11} /></div>
      )}
    </Focusable>
  );
}

function DownloadsPage() {
  const activeDls = useActiveDownloads();
  const queued = useQueuedDownloads();
  const status = useServiceStatus();
  const pendingCount = status?.pending_saves || 0;
  const pendingUploads = usePendingUploads(pendingCount);
  const offline = !!status?.unreachable_reason;
  const syncingCols = ((status?.collections || []) as any[]).filter((c) => c.sync_state === 'syncing');
  const activeCount = activeDls.length + syncingCols.length;

  const [recent, setRecent] = useState<Array<{ kind: string, title: string, detail: string, timestamp: number }>>([]);
  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const res = await getRecentActivity(10);
        if (alive && res?.events) setRecent(res.events.filter((e) => e.kind === 'download'));
      } catch { /* transient */ }
    };
    load();
    const iv = setInterval(load, 5000);
    return () => { alive = false; clearInterval(iv); };
  }, []);

  // Same mount-focus dance as StatsPage: internally pushed views get no focus
  // pass from Steam, so drop gamepad focus on the first focusable element.
  const hostRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const t = setTimeout(() => {
      try {
        const first = hostRef.current?.querySelector('[tabindex]') as HTMLElement | null;
        if (first) _forceGamepadFocus(first);
      } catch { /* ignore */ }
    }, 100);
    return () => clearTimeout(t);
  }, []);

  return v2Page(
    <Focusable noFocusRing
      onCancelButton={() => libBack("/romm-sync-library")}
      style={{ maxWidth: '760px', margin: '0 auto', padding: '20px 20px 80px' }}>
      <div ref={hostRef} style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '24px' }}>
        <GameActionButton icon={<FaChevronLeft size={16} />} onClick={() => libBack("/romm-sync-library")} />
        <div style={{ fontSize: '24px', fontWeight: 800, letterSpacing: '-0.01em' }}>Downloads</div>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
        <V2StatsSectionBox title={`Active${activeCount ? ` (${activeCount})` : ''}`} icon={<FaDownload size={14} />}>
          {activeCount === 0 ? (
            <div style={{
              display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px',
              padding: '24px', color: V2.fgMuted, fontSize: '13px',
            }}>
              <FaBoxOpen size={20} /><span>No active downloads</span>
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column' }}>
              {syncingCols.map((c, i) => (
                <div key={`col-${c.name}`} style={{ borderTop: i > 0 ? `1px solid ${V2.border}` : 'none' }}>
                  <CollectionSyncStatusRow col={c} />
                </div>
              ))}
              {activeDls.map((d, i) => (
                <div key={d.romId} style={{ borderTop: (i > 0 || syncingCols.length > 0) ? `1px solid ${V2.border}` : 'none' }}>
                  <DownloadStatusRow romId={d.romId} name={d.name} />
                </div>
              ))}
            </div>
          )}
        </V2StatsSectionBox>

        {queued.length > 0 && (
          <V2StatsSectionBox title={`Queued (${queued.length})`} icon={<FaRegClock size={14} />}>
            {queued.slice(0, 12).map((q, i) => (
              <div key={q.romId} style={{
                display: 'flex', alignItems: 'center', gap: '10px', padding: '9px 14px',
                borderTop: i > 0 ? `1px solid ${V2.border}` : 'none',
              }}>
                <div style={{ flexShrink: 0, color: V2.fgMuted, display: 'flex' }}><FaRegClock size={12} /></div>
                <div style={{
                  flex: '1 1 auto', minWidth: 0, fontSize: '12.5px', fontWeight: 500, color: V2.fg2,
                  whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                }}>{q.name}</div>
                <div style={{ flexShrink: 0, fontSize: '10.5px', color: V2.fgMuted }}>Waiting</div>
              </div>
            ))}
            {queued.length > 12 && (
              <div style={{
                padding: '9px 14px', fontSize: '11.5px', color: V2.fgMuted,
                borderTop: `1px solid ${V2.border}`,
              }}>and {queued.length - 12} more…</div>
            )}
          </V2StatsSectionBox>
        )}

        {pendingUploads.length > 0 && (
          <V2StatsSectionBox
            title={`Waiting to upload (${pendingUploads.length})`}
            icon={<FaCloudUploadAlt size={14} />}>
            <div style={{
              padding: '9px 14px', fontSize: '11.5px', color: V2.fgMuted,
              borderBottom: `1px solid ${V2.border}`,
            }}>
              {offline
                ? 'These saves will sync automatically when you’re back online.'
                : 'These local changes will sync on the next pass.'}
            </div>
            {pendingUploads.slice(0, 12).map((p, i) => {
              const slots = p.files.length;
              return (
                <div key={`${p.game}-${p.type}`} style={{
                  display: 'flex', alignItems: 'center', gap: '10px', padding: '9px 14px',
                  borderTop: i > 0 ? `1px solid ${V2.border}` : 'none',
                }}>
                  <div style={{ flexShrink: 0, color: V2.fgMuted, display: 'flex' }}>
                    <FaCloudUploadAlt size={13} />
                  </div>
                  <div style={{ flex: '1 1 auto', minWidth: 0 }}>
                    <div style={{
                      fontSize: '12.5px', fontWeight: 600, color: V2.fg,
                      whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                    }}>{p.game}</div>
                    <div style={{ fontSize: '10.5px', color: V2.fgMuted, marginTop: '1px' }}>
                      {p.type === 'states' ? 'Save state' : 'Save'}
                      {slots > 1 ? ` · ${slots} files` : ''}
                      {p.emulator ? ` · ${p.emulator}` : ''}
                    </div>
                  </div>
                  <div style={{ flexShrink: 0, fontSize: '10.5px', color: V2.fgMuted }}>Waiting</div>
                </div>
              );
            })}
            {pendingUploads.length > 12 && (
              <div style={{
                padding: '9px 14px', fontSize: '11.5px', color: V2.fgMuted,
                borderTop: `1px solid ${V2.border}`,
              }}>and {pendingUploads.length - 12} more…</div>
            )}
          </V2StatsSectionBox>
        )}

        <V2StatsSectionBox title="Recently completed" icon={<FaHistory size={14} />}>
          {recent.length === 0 ? (
            <div style={{ padding: '14px 16px', fontSize: '12px', color: V2.fgMuted }}>
              Nothing yet — finished downloads will show up here.
            </div>
          ) : recent.map((e, i) => (
            <CompletedDownloadRow key={`${e.timestamp}-${i}`} event={e} first={i === 0} />
          ))}
        </V2StatsSectionBox>
      </div>
    </Focusable>,
  );
}

// Glassy core picker (RomM v2 chrome, like the account/collection menus).
// Lists "Auto" + every installed core, with RetroDECK's choices surfaced first
// and the current selection check-marked. closeModal is injected by showModal.
function CorePickerModal({ row, availableCores, canDownload, onPick, onDownload, closeModal }: {
  row: any; availableCores: string[]; canDownload: boolean; onPick: (core: string) => void;
  onDownload: (core: string) => void; closeModal?: () => void;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState('');
  // Cores the buildbot can supply for this platform that aren't installed. The
  // full buildbot catalogue (~200 cores) is only pulled in once you search, so
  // opening the picker stays a local, offline-safe operation.
  const [catalogue, setCatalogue] = useState<string[] | null>(null);
  const rdSet = new Set<string>(row?.retrodeck_choices || []);
  // RetroDECK's choices for this system are the cores actually meant for the
  // platform (mGBA/VBA-M for gba, Swanstation/Beetle for psx, …). Show only
  // those by default; expand to every installed core on demand (or when
  // RetroDECK has no entry for this system, so the list wouldn't be empty).
  const relevant = (row?.retrodeck_choices || []).filter((c: string) => availableCores.includes(c));
  const [showAll, setShowAll] = useState(relevant.length === 0);
  useEffect(() => { const t = setTimeout(() => { if (panelRef.current) _forceGamepadFocus(panelRef.current); }, 60); return () => clearTimeout(t); }, []);

  const q = query.trim().toLowerCase();
  const match = (c: string) => !q || c.toLowerCase().includes(q);
  // RetroDECK's choices first (in its priority order), then (if expanded) the rest.
  const rdOrdered = relevant.filter((c: string) => match(c));
  // Filtering searches the whole installed set even when collapsed, so you can
  // find any core by typing without toggling "show all" first.
  const others = (showAll || q) ? availableCores.filter((c) => !rdSet.has(c) && match(c)) : [];
  const current = row?.override || '';

  const pick = (core: string) => { closeModal?.(); onPick(core); };
  const grab = (core: string) => { closeModal?.(); onDownload(core); };

  // Suggested downloads for this platform, plus — once you type — anything else
  // in the catalogue. Both filtered against what's already installed.
  // Nothing downloadable on a RetroDECK install (it bundles its own cores in a
  // read-only tree) — the whole section, catalogue fetch included, stays off.
  const suggested: string[] = canDownload ? (row?.download_candidates || []).filter(match) : [];
  const catalogueHits = (canDownload && q && catalogue)
    ? catalogue.filter((c) => !availableCores.includes(c) && !suggested.includes(c) && match(c)).slice(0, 40)
    : [];
  useEffect(() => {
    if (!canDownload || !q || catalogue !== null) return;
    getDownloadableCores(false)
      .then((r: any) => setCatalogue(r?.success ? (r.cores || []).map((c: any) => c.name) : []))
      .catch(() => setCatalogue([]));
  }, [canDownload, q, catalogue]);

  const coreRow = (core: string) => (
    <UserMenuRow key={core}
      icon={current === core ? <FaCheck size={13} /> : <FaPuzzlePiece size={13} />}
      label={core + (row?.retrodeck_default === core ? '  · RetroDECK default' : (rdSet.has(core) ? '  · RetroDECK' : ''))}
      onSelect={() => pick(core)} />
  );

  const downloadRow = (core: string) => (
    <UserMenuRow key={`dl-${core}`}
      icon={<FaDownload size={13} />}
      label={`${core}  ·  download`}
      onSelect={() => grab(core)} />
  );

  return (
    <ModalRoot bHideCloseIcon onCancel={closeModal} onEscKeypress={closeModal}>
      <Focusable noFocusRing style={{
        position: 'fixed', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: 'rgba(7,7,15,0.45)', WebkitBackdropFilter: 'blur(8px)', backdropFilter: 'blur(8px)',
      }}>
        <style>{`${V2_FOCUS_STYLE}
          @keyframes umIn { from { opacity: 0; transform: translateY(-6px) scale(0.98); } to { opacity: 1; transform: none; } }`}</style>
        <div onClick={() => closeModal?.()} style={{ position: 'absolute', inset: 0 }} />
        <Focusable noFocusRing autoFocus ref={panelRef} flow-children="vertical" style={{
          position: 'relative', width: '340px', maxWidth: '92vw', boxSizing: 'border-box',
          fontFamily: V2.font, color: V2.fg, padding: '8px',
          display: 'flex', flexDirection: 'column',
          background: 'linear-gradient(180deg, rgba(20,20,30,0.7) 0%, rgba(10,10,18,0.78) 100%)',
          WebkitBackdropFilter: 'blur(28px) saturate(1.1)', backdropFilter: 'blur(28px) saturate(1.1)',
          border: `1px solid rgba(255,255,255,0.12)`, borderRadius: V2.radiusCard,
          boxShadow: '0 16px 48px rgba(0,0,0,0.55)', maxHeight: '82vh', overflowY: 'auto',
          animation: 'umIn 0.18s cubic-bezier(0.22,1,0.36,1)',
        }}>
          <div style={{
            fontSize: '11px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em',
            color: V2.fgMuted, padding: '6px 8px 10px',
          }}>Core · {row?.platform_name || ''}</div>
          <div style={{ padding: '0 4px 8px' }}>
            <V2SearchField value={query} onChange={setQuery} />
          </div>
          <div style={{ height: '1px', background: V2.border, margin: '0 4px 4px' }} />
          {/* Auto reverts to RetroDECK's choice / our guess. */}
          {match('auto') && (
            <UserMenuRow
              icon={!current ? <FaCheck size={13} /> : <FaUndo size={13} />}
              label={`Auto${row?.retrodeck_default ? `  ·  ${row.retrodeck_default}` : (row?.resolved_core ? `  ·  ${row.resolved_core}` : '')}`}
              onSelect={() => pick('')} />
          )}
          {rdOrdered.length > 0 && <div style={{ height: '1px', background: V2.border, margin: '4px 4px' }} />}
          {rdOrdered.map(coreRow)}
          {/* Expand to the full installed-core list (hidden by default so the
              platform's own cores aren't buried). Only offered when RetroDECK
              actually narrowed the list. */}
          {relevant.length > 0 && (
            <>
              <div style={{ height: '1px', background: V2.border, margin: '4px 4px' }} />
              <UserMenuRow
                icon={<FaLayerGroup size={13} />}
                label={showAll ? 'Show only cores for this platform' : 'Show all installed cores'}
                onSelect={() => setShowAll((v) => !v)} />
            </>
          )}
          {others.length > 0 && <div style={{ height: '1px', background: V2.border, margin: '4px 4px' }} />}
          {others.map(coreRow)}
          {/* Not installed, but the libretro buildbot has it — same source
              RetroArch's own Online Updater uses. */}
          {(suggested.length > 0 || catalogueHits.length > 0) && (
            <>
              <div style={{ height: '1px', background: V2.border, margin: '4px 4px' }} />
              <div style={{
                fontSize: '10px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em',
                color: V2.fgMuted, padding: '6px 8px 4px',
              }}>Available to download</div>
            </>
          )}
          {suggested.map(downloadRow)}
          {catalogueHits.map(downloadRow)}
        </Focusable>
      </Focusable>
    </ModalRoot>
  );
}

// Emulator Cores page: one row per library platform showing how its launch
// core resolves (user override > RetroDECK/ES-DE > built-in guess). A on a row
// opens the picker; the trailing badge shows the resolved core + its source.
// The Emulator page with nothing to configure: no RetroArch, no RetroDECK, so
// per-platform cores are meaningless until one exists. Offer the install
// instead of an empty list.
function NoEmulatorSection({ status }: { status: EmuStatus }) {
  const install = useEmulatorInstall();
  // Can't install from here — Windows, no flatpak, running as root. The row
  // becomes an explanation rather than a button that could only fail.
  const canInstall = status.install.available;
  return (
    <V2SettingsSection title="Emulator">
      <V2SettingsRow icon={<FaGamepad size={16} />}
        title={install.active ? 'Installing RetroArch…' : 'No emulator installed'}
        subtitle={install.active
          ? [install.phase || 'Installing', install.pct != null ? `${install.pct}%` : '',
             installSize(install)].filter(Boolean).join(' · ')
            || 'This takes a few minutes.'
          : install.error
            ? install.error
            : canInstall
              ? 'Ludo can download and sync your library, but it needs RetroArch or RetroDECK to launch anything. A installs RetroArch from Flathub — Ludo checks the download size first.'
              : `Ludo can download and sync your library, but it needs RetroArch or RetroDECK to launch anything. ${status.install.reason || 'Install one, then re-check.'}`}
        onClick={install.active || !canInstall ? undefined : startEmulatorInstall}
        right={install.active
          ? <FaSync size={15} style={{ animation: 'spin 1s linear infinite', color: V2.fgMuted }} />
          : canInstall
            ? <span style={{ fontSize: '13px', fontWeight: 600, color: V2.brandHover }}>Install</span>
            : null} />
      {/* Only worth suggesting where a flatpak install is actually possible —
          the reasons canInstall is false here are Windows, no flatpak, or root. */}
      {canInstall && <V2SettingsRow icon={<FaInfoCircle size={15} />}
        title="Prefer RetroDECK?"
        subtitle="Install it from Flathub yourself (net.retrodeck.retrodeck) — it's a ~10 GB suite with its own first-run setup, so Ludo won't pull it in for you. Ludo picks it up automatically once it's there."
        right={<span style={{ fontSize: '13px', fontWeight: 600, color: V2.brandHover }}>Re-check</span>}
        onClick={() => loadEmulatorStatus(true)} />}
      {/* Without the RetroDECK row there is nothing to re-detect with, and
          installing outside Ludo is exactly what needs a re-check. */}
      {!canInstall && <V2SettingsRow icon={<FaSync size={15} />}
        title="Re-check"
        subtitle="Look for RetroArch or RetroDECK again after installing one yourself."
        onClick={() => loadEmulatorStatus(true)} />}
    </V2SettingsSection>
  );
}

function CoresPage() {
  const [rows, setRows] = useState<any[]>([]);
  const [cores, setCores] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  // Whether this RetroArch can gain cores at all, and why not when it can't
  // (RetroDECK bundles them read-only; unsupported CPU; no writable dir).
  const [canDownload, setCanDownload] = useState(false);
  const [noDownloadReason, setNoDownloadReason] = useState('');

  const emu = useEmulatorStatus();

  const load = async () => {
    try {
      const r = await getCoreMappings();
      if (r?.success) {
        setRows(r.mappings || []);
        setCores(r.available_cores || []);
        setCanDownload(!!r.can_download_cores);
        setNoDownloadReason(r.download_unavailable_reason || '');
      }
    } catch { /* ignore */ }
    finally { setLoading(false); }
  };
  useEffect(() => { load(); }, []);
  // An install finishing while this page is open turns every row from
  // unresolvable to resolvable — re-read instead of stranding the empty state.
  const wasInstalled = useRef<boolean | null>(null);
  useEffect(() => {
    if (emu == null) return;
    if (wasInstalled.current != null && wasInstalled.current !== emu.installed) load();
    wasInstalled.current = emu.installed;
  }, [emu?.installed]);

  const apply = async (slug: string, core: string) => {
    try {
      const r = await setCoreOverride(slug, core);
      if (r?.success && r.mapping) {
        setRows((prev) => prev.map((x) => x.slug === slug ? { ...r.mapping } : x));
      }
    } catch { toaster.toast({ title: 'Core override', body: 'Could not save change' }); }
  };

  // Fetch a core, then pin it for this platform — picking a core you just
  // downloaded and NOT using it is never what was meant.
  const [busy, setBusy] = useState<string | null>(null);
  const install = async (row: any, core: string) => {
    setBusy(row.slug);
    toaster.toast({ title: 'Emulator core', body: `Downloading ${core}…` });
    try {
      const r = await downloadCore(core);
      if (r?.success) {
        toaster.toast({ title: 'Emulator core', body: `${core} installed` });
        await apply(row.slug, core);
        await load();   // the installed-core list grew
      } else {
        toaster.toast({ title: 'Emulator core', body: r?.message || `Could not download ${core}` });
      }
    } catch {
      toaster.toast({ title: 'Emulator core', body: `Could not download ${core}` });
    } finally { setBusy(null); }
  };

  const openPicker = (row: any) =>
    showModal(<CorePickerModal row={row} availableCores={cores} canDownload={canDownload}
      onPick={(c) => apply(row.slug, c)}
      onDownload={(c) => install(row, c)} />);

  const badge = (row: any) => {
    const labelFor: Record<string, string> = { override: 'pinned', retrodeck: 'RetroDECK', guess: 'auto', none: '—' };
    const color = row.source === 'override' ? V2.brandHover : (row.source === 'none' ? V2.danger : V2.fgMuted);
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
        <span style={{ fontSize: '13px', fontWeight: 600, color: row.resolved_core ? V2.fg : V2.danger }}>
          {row.resolved_core || 'no core'}
        </span>
        <span style={{
          fontSize: '10px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em',
          color, border: `1px solid ${color}`, borderRadius: V2.radiusChip, padding: '1px 6px',
        }}>{labelFor[row.source] || row.source}</span>
        <FaChevronRight size={12} style={{ color: V2.fgFaint }} />
      </div>
    );
  };

  return v2Page(
    <Focusable noFocusRing
      onCancelButton={() => libBack("/romm-sync-library")}
      style={{ maxWidth: '760px', margin: '0 auto', padding: '20px 20px 0' }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '24px' }}>
        <GameActionButton icon={<FaChevronLeft size={16} />} onClick={() => libBack("/romm-sync-library")} />
        <div style={{ fontSize: '24px', fontWeight: 800, letterSpacing: '-0.01em' }}>Emulator Cores</div>
      </div>

      {/* Stale folders used to be warned about here; they now live in
          Settings ▸ Folders, beside the folders themselves. */}

      {/* Nothing installed: the per-platform list would be a wall of "no core"
          rows that can't be resolved, so it collapses to the install prompt. */}
      {emu && !emu.installed ? <NoEmulatorSection status={emu} /> : (
      <V2SettingsSection title="Per-platform core">
        {loading ? (
          <V2SettingsRow icon={<FaPuzzlePiece size={16} />} title="Loading cores…" />
        ) : rows.length === 0 ? (
          <V2SettingsRow icon={<FaPuzzlePiece size={16} />}
            title="No platforms detected yet"
            subtitle="Open the Game Browser once so your library loads, then come back to pin a core per platform." />
        ) : rows.map((row) => (
          <V2SettingsRow key={row.slug}
            bareIcon
            icon={<PlatformIcon slug={row.slug} size={28} />}
            title={row.platform_name}
            subtitle={busy === row.slug
              ? 'Downloading core…'
              : row.source === 'none'
                ? ((row.download_candidates || []).length
                  ? `No core installed — A to download ${row.download_candidates[0]}`
                  : noDownloadReason
                    ? `No core installed — ${noDownloadReason}`
                    : 'No core installed — A to pick one')
                : row.source === 'override'
                  ? 'Pinned by you — A to change or reset to auto'
                  : 'Auto-resolved — A to pin a specific core'}
            onClick={() => openPicker(row)}
            right={badge(row)} />
        ))}
      </V2SettingsSection>
      )}
    </Focusable>
  );
}

// V2Segment — joined pill segmented control, styled 1:1 with the home V2NavBar
// tab group: a white sliding indicator (measured per option), dpad left/right
// navigation (flow-children), and the pill's own rounded shape as the focus
// affordance — no box-shadow ring. Used for the update channel and the setup
// wizard's login/pair switch.
function V2Segment({ options, value, onChange, disabled }:
  { options: { id: string; label: string }[]; value: string; onChange: (v: string) => void; disabled?: boolean }) {
  const opts = options;
  const activeIdx = Math.max(0, opts.findIndex((o) => o.id === value));
  const btnRefs = useRef<(HTMLDivElement | null)[]>([]);
  const [ind, setInd] = useState<{ left: number; width: number } | null>(null);
  const [focusedIdx, setFocusedIdx] = useState<number | null>(null);
  useEffect(() => {
    const el = btnRefs.current[activeIdx];
    if (el) setInd({ left: el.offsetLeft, width: el.offsetWidth });
  }, [activeIdx]);
  return (
    <Focusable noFocusRing flow-children="horizontal" style={{
      position: 'relative', display: 'flex', flexShrink: 0, gap: '2px', padding: '4px',
      background: V2.surface, border: `1px solid ${V2.borderStrong}`, borderRadius: V2.radiusPill,
      opacity: disabled ? 0.55 : 1,
    }}>
      {/* White sliding indicator — same as the home nav */}
      {ind && (
        <div style={{
          position: 'absolute', top: '4px', bottom: '4px',
          left: `${ind.left}px`, width: `${ind.width}px`,
          background: V2.fg, borderRadius: V2.radiusPill, zIndex: 0,
          transition: 'left 0.28s cubic-bezier(0.22,1,0.36,1), width 0.28s cubic-bezier(0.22,1,0.36,1)',
        }} />
      )}
      {opts.map(({ id, label }, i) => {
        const on = activeIdx === i;
        return (
          <Focusable noFocusRing key={id}
            onActivate={() => !disabled && onChange(id)}
            onClick={() => !disabled && onChange(id)}
            onFocus={() => setFocusedIdx(i)} onBlur={() => setFocusedIdx(null)}
            onMouseEnter={() => setFocusedIdx(i)} onMouseLeave={() => setFocusedIdx(null)}>
            {/* Marks this option — and which one is CURRENT — for the desktop
                shim's spatial nav, so entering the control from above/below
                lands on the selected value instead of whichever pill happens to
                be nearest. Inert on the Deck (Steam uses its own preferred-child
                tracking), and purely advisory: styling never keys off these. */}
            <div ref={(el) => { btnRefs.current[i] = el; }}
              data-seg-opt="1" data-seg-on={on ? '1' : undefined}
              style={{
                position: 'relative', zIndex: 1, padding: '5px 16px', borderRadius: V2.radiusPill,
                fontSize: '12.5px', textAlign: 'center', cursor: disabled ? 'default' : 'pointer',
                fontWeight: on ? 600 : 500, color: on ? V2.bg : V2.fg2,
                // Focus affordance: a brand ring shown on whichever option is
                // focused — including the already-active one, so the controller
                // can tell where the selection landed (it rides on the white
                // indicator). Inactive options also get a tint.
                background: (!on && focusedIdx === i) ? 'rgba(255,255,255,0.10)' : 'transparent',
                boxShadow: (focusedIdx === i) ? `inset 0 0 0 1.5px ${V2.brand}` : 'none',
                transition: 'color 0.2s ease, background 0.15s ease, box-shadow 0.15s ease',
              }}>
              {label}
            </div>
          </Focusable>
        );
      })}
    </Focusable>
  );
}

// UpdateActionBtn — full-width fixed-height action button whose background
// fills left→right with the brand color during install (progress lives IN the
// button, so nothing below it shifts).
function UpdateActionBtn({ label, icon, onClick, disabled, primary, progress, busy }:
  { label: string; icon: any; onClick: () => void; disabled?: boolean; primary?: boolean; progress?: number | null; busy?: boolean }) {
  const [focused, setFocused] = useState(false);
  const filling = progress != null;
  return (
    <Focusable noFocusRing
      onActivate={() => !disabled && onClick()}
      onClick={() => !disabled && onClick()}
      onFocus={() => setFocused(true)} onBlur={() => setFocused(false)}
      onMouseEnter={() => setFocused(true)} onMouseLeave={() => setFocused(false)}
      style={{
        position: 'relative', overflow: 'hidden', width: '100%', height: '40px',
        boxSizing: 'border-box',
        borderRadius: V2.radiusMd, border: `1px solid ${filling ? V2.brand : V2.border}`,
        background: primary && !filling ? V2.brand : V2.surface,
        // Dim only when the button is inert — NOT while it's working. The busy
        // shimmer and the "Checking…" label already say that, and on the desktop
        // shim a dimmed control drops its tabindex (opacity < 1 is that shim's
        // disabled convention), which blurred the button mid-check and threw
        // controller focus up to the page's Back button.
        opacity: disabled && !filling && !busy ? 0.55 : 1, cursor: disabled ? 'default' : 'pointer',
        transition: 'box-shadow 0.15s, background 0.2s, border-color 0.2s',
        ...V2Focus.flat(focused && !disabled, { glow: primary || filling }),
      }}>
      {/* Keyframes for the busy shimmer — scoped, defined inline so this works
          regardless of which other components happen to be mounted.
          translateX percentages are relative to the SWEEPER's width (55% of the
          button), not the button's, so the loop has to overshoot to clear both
          edges: -100% parks it fully off the left, and 200% (= 110% of the
          button) carries it fully off the right. Anything less leaves a bright
          edge on screen when the iteration restarts, which reads as a stutter. */}
      <style>{`@keyframes uabShimmer { 0% { transform: translateX(-100%); } 100% { transform: translateX(200%); } }`}</style>
      {filling && (
        <div style={{
          position: 'absolute', inset: 0, width: `${Math.max(2, progress ?? 0)}%`,
          background: V2.brand, transition: 'width 0.3s ease',
        }} />
      )}
      {busy && (
        <div style={{
          position: 'absolute', top: 0, bottom: 0, left: 0, width: '55%', zIndex: 2,
          background: `linear-gradient(90deg, transparent 0%, ${filling || primary ? 'rgba(255,255,255,0.28)' : 'rgba(255,255,255,0.14)'} 50%, transparent 100%)`,
          animation: 'uabShimmer 1.15s linear infinite', pointerEvents: 'none',
        }} />
      )}
      <div style={{
        position: 'relative', zIndex: 1, display: 'flex', alignItems: 'center',
        justifyContent: 'center', gap: '8px', height: '100%',
        fontSize: '14px', fontWeight: 600, color: primary || filling ? '#fff' : V2.fg,
      }}>
        {icon}<span>{label}</span>
      </div>
    </Focusable>
  );
}

// Settings ▸ Folders — where ROMs, saves and BIOS files actually live, which
// until now was only visible inside the setup wizard. Each row shows the path in
// use and whether it was set by the user or detected; A opens the folder picker.
// Stale-path warnings live here too, next to the folders they're about.
function FoldersSection() {
  const status = useEmulatorStatus();
  const [busy, setBusy] = useState<string | null>(null);
  if (!status) return null;

  const cfg = status.configured_paths || {};
  const defaults = status.default_paths || {};
  const stale = status.stale_paths || [];
  const staleFor = (kind: string) => stale.find((p) => p.kind === kind);

  // Shown when the user has set nothing. What's on disk first, then where the
  // emulator WILL keep it: a freshly installed emulator has created neither its
  // saves nor its system folder, and "Not set" was a worse answer than the
  // correct path. A ROM folder is ours to choose, so it has no detected value.
  const expected = status.expected_paths || {};
  const detected: Record<string, string> = {
    saves: status.save_dirs?.saves || expected.saves || '',
    bios: status.bios_dir || expected.bios || '',
  };

  const write = async (kind: string, value: string) => {
    setBusy(kind);
    try {
      const r = await setLibraryPaths(
        kind === 'roms' ? value : undefined,
        kind === 'saves' ? value : undefined,
        kind === 'bios' ? value : undefined,
        kind === 'exe' ? value : undefined);
      if (r?.success) {
        // The reply IS a fresh emulator_status, so the rows (and any stale
        // warning that just cleared) update without a second round-trip.
        publishEmulatorStatus({
          ...status,
          installed: !!r.installed, kind: r.kind || status.kind,
          executable: r.executable || null, cores_dir: r.cores_dir || null,
          core_count: r.core_count ?? status.core_count,
          stale_paths: r.stale_paths || [], save_dirs: r.save_dirs || {},
          bios_dir: r.bios_dir || '', configured_paths: r.configured_paths || {},
          default_paths: r.default_paths || status.default_paths || {},
          expected_paths: r.expected_paths || status.expected_paths || {},
        });
        toaster.toast({ title: 'Folders', body: value ? 'Folder updated' : 'Back to auto-detect' });
      } else {
        toaster.toast({ title: 'Folders', body: r?.message || 'Could not save that folder' });
      }
    } catch { toaster.toast({ title: 'Folders', body: 'Could not save that folder' }); }
    finally { setBusy(null); }
  };

  const pick = async (kind: string, current: string) => {
    try {
      const res = await openFilePicker(
        FileSelectionType.FOLDER, pickerStart(current), false, true);
      if (res?.realpath) await write(kind, res.realpath);
    } catch { /* the user dismissed the picker */ }
  };

  const fixStale = async (p: EmuStalePath) => {
    setBusy(p.kind);
    try {
      const r = await repairEmulatorPaths([`${p.section}.${p.key}`]);
      if (r?.success) {
        await loadEmulatorStatus(true);
        if (!r.repaired?.length) {
          toaster.toast({ title: 'Folders', body: 'Nothing to change here' });
        }
      } else toaster.toast({ title: 'Folders', body: r?.message || 'Could not update' });
    } catch { toaster.toast({ title: 'Folders', body: 'Could not update' }); }
    finally { setBusy(null); }
  };

  // A on a row opens the actions menu (choose / back to default) rather than the
  // picker directly — see FolderActionsModal.
  const openActions = (kind: string, label: string, inUse: string) => {
    const def = defaults[kind] ?? '';
    const configured = cfg[kind] || '';
    showModal(
      <FolderActionsModal
        label={label} current={inUse} def={def}
        // Already default when nothing is configured, or when what IS configured
        // is exactly what we would have chosen anyway.
        isDefault={!configured || configured === def}
        onChoose={() => void pick(kind, inUse)}
        onReset={() => void write(kind, def)} />
    );
  };

  const row = (kind: string, label: string, icon: any, hint: string) => {
    const configured = cfg[kind] || '';
    const inUse = configured || detected[kind] || '';
    const bad = staleFor(kind);
    return (
      <V2CardRow key={kind} icon={icon} danger={!!bad} title={label}
        subtitle={busy === kind ? 'Saving…' : bad ? (
          <span>
            {bad.reason} · <span style={{ textDecoration: 'line-through', opacity: 0.7 }}>{bad.value}</span>
            {' → '}<span style={{ color: V2.fg2 }}>{bad.suggested || 'auto-detect'}</span>
            {kind === 'bios' ? (
              // Fix redirects where BIOS files GO; it moves nothing. Saying so
              // matters when the old folder holds thousands of them.
              <span> · A sends new BIOS files to your emulator instead. Files
                already in that folder stay where they are.</span>
            ) : ' · A to fix'}
          </span>
        ) : (
          <span style={{ wordBreak: 'break-all' }}>
            {inUse || 'Not set'}
            <span style={{ color: V2.fgFaint }}>
              {'  ·  '}{configured ? hint
                : inUse ? 'detected automatically'
                  // Nothing set and nothing detected. "set by you" was plainly
                  // wrong here — it read "Not set · set by you" — and so was
                  // implying a problem: the BIOS folder is legitimately empty
                  // until the emulator's own one is known.
                  : 'Ludo will use your emulator\u2019s own folder'}
            </span>
          </span>
        )}
        onClick={busy ? undefined : () => (bad ? fixStale(bad) : openActions(kind, label, inUse))}
        right={bad
          ? <span style={{ fontSize: '13px', fontWeight: 600, color: V2.brandHover }}>Fix</span>
          : <FaChevronRight size={12} style={{ color: V2.fgFaint }} />} />
    );
  };

  // The emulator override is not a folder and has no picker — it only ever needs
  // clearing, which hands detection back to Ludo.
  const exeStale = staleFor('exe');
  const exeOverride = cfg.exe || '';

  // What Ludo actually found. Everything below it is derived from this, so it
  // reads first: a wrong answer here explains a wrong answer in every row.
  // kind is retrodeck | flatpak | snap | native — the last three are all
  // RetroArch, so name the flavour rather than dropping it.
  const emuRow = (
    <V2CardRow key="emu" icon={<FaGamepad size={15} />} danger={!status.installed}
      title={!status.installed ? 'No emulator found'
        : status.kind === 'retrodeck' ? 'RetroDECK'
          : status.kind === 'flatpak' ? 'RetroArch (Flatpak)'
            : status.kind === 'snap' ? 'RetroArch (Snap)'
              : 'RetroArch'}
      subtitle={status.installed ? (
        <span style={{ wordBreak: 'break-all' }}>
          {status.executable || 'detected'}
          <span style={{ color: V2.fgFaint }}>
            {'  ·  '}{status.core_count
              ? `${status.core_count} core${status.core_count === 1 ? '' : 's'}`
              : 'no cores installed'}
          </span>
        </span>
      ) : 'Install RetroArch or RetroDECK to play these games.'}
      onClick={() => libNavigate('/romm-sync-cores')}
      right={<FaChevronRight size={12} style={{ color: V2.fgFaint }} />} />
  );

  const rows = [
    emuRow,
    row('roms', 'ROM folder', <FaBoxOpen size={15} />, 'set by you'),
    row('saves', 'Save folder', <FaSave size={15} />, 'set by you'),
    row('bios', 'BIOS folder', <FaPuzzlePiece size={15} />, 'set by you'),
    (exeOverride || exeStale) ? (
      <V2CardRow key="exe" icon={<FaGamepad size={15} />} danger={!!exeStale}
        title="Emulator path"
        subtitle={busy === 'exe' ? 'Saving…' : exeStale
          ? `${exeStale.reason} · ${exeStale.value} · A to clear and auto-detect`
          : `${exeOverride}  ·  overriding auto-detection — A to clear`}
        onClick={busy ? undefined : () => (exeStale ? fixStale(exeStale) : write('exe', ''))}
        right={<span style={{ fontSize: '13px', fontWeight: 600, color: V2.brandHover }}>
          {exeStale ? 'Fix' : 'Clear'}</span>} />
    ) : null,
    stale.length > 1 ? (
      <V2CardRow key="all" icon={<FaCheck size={15} />}
        title={busy === 'all' ? 'Fixing all…' : 'Fix all'}
        subtitle={`Point all ${stale.length} of these back at your emulator.`}
        onClick={busy ? undefined : async () => {
          setBusy('all');
          try {
            const r = await repairEmulatorPaths();
            if (r?.success) await loadEmulatorStatus(true);
          } finally { setBusy(null); }
        }} />
    ) : null,
  ].filter(Boolean) as any[];

  return (
    <V2SettingsSection title="Emulator & folders">
      {/* One card, not one per folder: these are a single answer to "what did
          Ludo find and where does my library live", and reading them as a block
          is the point. Hairlines instead of gaps, and the first/last rows are
          told they sit in the card's rounded ends so the focus ring can follow
          them. Which row is last depends on the conditional ones, hence the
          clone rather than props at each call site. */}
      <div style={{
        display: 'flex', flexDirection: 'column',
        borderRadius: V2.radiusCard, background: V2.surface,
        border: `1px solid ${V2.border}`, overflow: 'hidden',
      }}>
        {rows.map((r, i) => cloneElement(r, {
          divider: i > 0, first: i === 0, last: i === rows.length - 1,
        }))}
      </div>
    </V2SettingsSection>
  );
}

function SettingsPage() {
  const [loggingEnabled, setLoggingEnabled] = useState<boolean>(true);
  const [loading, setLoading] = useState<boolean>(true);
  const [confirmLogout, setConfirmLogout] = useState<boolean>(false);
  const [loggingOut, setLoggingOut] = useState<boolean>(false);
  // When the log-out confirmation opens, land gamepad focus on its first option
  // instead of leaving the highlight parked on the (now-hidden) Log out row.
  const logoutFirstRef = useAutoFocus(confirmLogout, confirmLogout);
  // And bring the expanded panel on-screen: the forced focus above doesn't make
  // Steam scroll (only real navigation does), so without this the taller panel
  // opens below the fold and the user has to scroll to it manually.
  const confirmPanelRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!confirmLogout) return;
    const timers = [120, 400].map((d) => setTimeout(() => {
      try { confirmPanelRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' }); } catch { /* ignore */ }
    }, d));
    return () => timers.forEach(clearTimeout);
  }, [confirmLogout]);
  const [serverInfo, setServerInfo] = useState<string>('');
  const [rdDetected, setRdDetected] = useState<boolean>(false);
  const [rdButton, setRdButton] = useState<boolean>(false);

  // Desktop-only: the RomM tile in Steam's library. Unlike the Deck plugin —
  // which owns its tile through SteamClient's live API — the desktop shell has
  // no SteamClient and the backend edits shortcuts.vdf, so the tile only shows
  // up after Steam restarts. `tileNote` carries that hint to the row subtitle.
  const [tileState, setTileState] = useState<{ available: boolean; installed: boolean }>(
    { available: false, installed: false });
  const [tileBusy, setTileBusy] = useState<boolean>(false);
  const [tileNote, setTileNote] = useState<string>('');

  // Desktop-only: which screen corner notification toasts appear in. Persisted
  // in localStorage and read by the shim's ToastHost; the Deck build has no
  // __rommDesktop object so this section never renders there.
  const isDesktop = !!(window as any).__rommDesktop;
  const [toastPos, setToastPos] = useState<string>(() => {
    try { return localStorage.getItem('romm:toastPos') || 'bottom-right'; }
    catch { return 'bottom-right'; }
  });
  const handleToastPos = (pos: string) => {
    setToastPos(pos);
    try { localStorage.setItem('romm:toastPos', pos); } catch { /* no storage */ }
    try { window.dispatchEvent(new Event('romm:toastpos')); } catch { /* ignore */ }
  };

  // Whether the answers that decide the page's *shape* have landed. The
  // RetroDECK and Steam sections sit above everything else and only exist on
  // some machines, so painting before we know pushes the rest of the page down
  // a step at a time as each reply arrives. Hold the body for one round-trip
  // instead and it arrives whole. See `shapeTimer` below for the escape hatch.
  const [shapeReady, setShapeReady] = useState<boolean>(false);

  useEffect(() => {
    // The "RomM" tile is mandatory and auto-created at plugin load. Reconcile
    // here too (the shortcut store is reliably ready by the time Settings opens)
    // to sweep duplicates and repair the survivor's exe/name/art after updates.
    // Deliberately not awaited: nothing on this page renders from it, and
    // chaining it in front of the reads it doesn't feed just delays the paint.
    try { reconcileRommTile()?.catch?.(() => { /* ignore */ }); } catch { /* ignore */ }

    // Never let a wedged IPC hide the whole page — show what we have and let
    // the stragglers fill in, which is the old behaviour but only as a fallback.
    const shapeTimer = setTimeout(() => setShapeReady(true), 1500);

    // These reads are independent of each other, so run them together rather
    // than awaiting in a chain; the page's first paint costs one round-trip,
    // not five.
    const config = (async () => {
      const cfg = await getConfig();
      const url = cfg?.url || '';
      // Prefer the live RomM account name; never show the stored credential/token.
      let name = '';
      try { name = (await getAccountUsername())?.username || ''; } catch { /* ignore */ }
      setServerInfo(name && url ? `${name} · ${url}` : (name || url || ''));
      setRdDetected(!!cfg?.retrodeck_detected);
    })();
    const rdBtn = (async () => { setRdButton(await getRetrodeckButtonEnabled()); })();
    const tile = (async () => {
      if (!(window as any).__rommDesktop) return;
      const st = await getSteamTileStatus();
      setTileState({ available: !!st?.available, installed: !!st?.installed });
    })();

    Promise.all([config, rdBtn, tile].map((p) => p.catch(() => { /* ignore */ })))
      .then(() => { clearTimeout(shapeTimer); setShapeReady(true); });
    return () => clearTimeout(shapeTimer);
  }, []);

  const handleRdButtonToggle = async (enabled: boolean) => {
    setRdButton(enabled);
    try { await setRetrodeckButtonEnabled(enabled); }
    catch { setRdButton(!enabled); }
  };

  const handleSteamTileToggle = async (enabled: boolean) => {
    if (tileBusy) return;
    setTileBusy(true);
    setTileNote('');
    try {
      // The launch command can only come from the Electron main process — it
      // alone knows whether we're an AppImage, a packaged binary or a checkout.
      const spec = enabled ? (window as any).__rommDesktop?.launchSpec?.() : null;
      if (enabled && !spec?.exe) {
        setTileNote('Could not determine how to relaunch this app.');
        return;
      }
      const r = await setSteamTile(enabled, spec?.exe || '', spec?.startDir || '', spec?.args || '');
      if (r?.success) {
        setTileState((s) => ({ ...s, installed: enabled }));
        // "Restart Steam to see the RomM tile" is exactly what the row's own
        // subtitle already says, so echoing it back reads as a warning about
        // something new. Keep the note for the case the subtitle does NOT
        // cover: Steam wasn't running, so the tile is simply there.
        setTileNote(r.steam_running ? '' : (r.message || ''));
      } else {
        setTileNote(r?.message || 'Could not update the Steam library tile.');
      }
    } catch (e) {
      setTileNote(String(e));
    } finally {
      setTileBusy(false);
    }
  };

  // Auto-update state
  const [version, setVersion] = useState<string>('');
  const [channel, setChannel] = useState<string>('stable');
  const [checking, setChecking] = useState<boolean>(false);
  const [updating, setUpdating] = useState<boolean>(false);
  const [updateInfo, setUpdateInfo] = useState<any>(null);
  // What the update is doing right now. Decky reports real percentages
  // via loader events; the desktop path is a single long download with
  // none, so it names the phase instead of showing a frozen number.
  const [updatePhase, setUpdatePhase] = useState<string | null>(null);
  const [checkOnStartup, setCheckOnStartupState] = useState<boolean>(true);
  // Install progress % (from loader/plugin_download_info events) and the
  // inline status line under the action button ('ok' green / 'err' red).
  const [installPct, setInstallPct] = useState<number | null>(null);
  const [statusMsg, setStatusMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [lastChecked, setLastChecked] = useState<number | null>(null);

  useEffect(() => {
    // Load initial logging preference
    const loadSettings = async () => {
      try {
        const enabled = await getLoggingEnabled();
        setLoggingEnabled(enabled);
      } catch (error) {
        console.error('Failed to load logging preference:', error);
      } finally {
        setLoading(false);
      }
    };
    loadSettings();
    // Load version + update channel. Three unrelated reads, so fetch them at
    // once — serialised, they made the Updates section fill in field by field.
    (async () => {
      try {
        const [ver, ch, onStartup] = await Promise.all([
          getPluginVersion(), getUpdateChannel(), getCheckOnStartup(),
        ]);
        setVersion(ver);
        setChannel(ch);
        setCheckOnStartupState(onStartup);
        // Auto-check when the section opens so the state is visible without a
        // button press (cached — see _updCheckCache).
        runUpdateCheck(ch, false);
      } catch (error) {
        console.error('Failed to load version/channel:', error);
      }
    })();
  }, []);

  const handleCheckOnStartupToggle = async (enabled: boolean) => {
    setCheckOnStartupState(enabled);
    try {
      await setCheckOnStartup(enabled);
    } catch (error) {
      console.error('Failed to set check-on-startup:', error);
      setCheckOnStartupState(!enabled);
    }
  };

  const handleChannelChange = async (next: string) => {
    if (updating) return;
    setChannel(next);
    setUpdateInfo(null);
    setStatusMsg(null);
    try {
      await setUpdateChannel(next);
    } catch (error) {
      console.error('Failed to set update channel:', error);
    }
    // Re-check right away so switching channels never shows stale state.
    runUpdateCheck(next, false);
  };

  const applyCheckResult = (info: any, ch: string, checkedAt: number) => {
    setUpdateInfo(info);
    setLastChecked(checkedAt);
    if (!info?.success) {
      setStatusMsg({ kind: 'err', text: `Couldn't check for updates — ${info?.message ?? 'unknown error'}` });
    } else if (!info.available) {
      setStatusMsg({ kind: 'ok', text: `Up to date — v${info.current} is the latest on ${ch}.` });
    } else {
      setStatusMsg(null);
    }
  };

  const runUpdateCheck = async (ch: string, force: boolean) => {
    // Auto-checks (section open, channel switch) reuse a recent result; the
    // manual button always hits the network.
    const c = _updCheckCache;
    if (!force && c && c.channel === ch && Date.now() - c.t < _UPD_CACHE_MS) {
      applyCheckResult(c.info, ch, c.t);
      return;
    }
    setChecking(true);
    setUpdateInfo(null);
    setStatusMsg(null);
    const startedAt = Date.now();
    try {
      const info = await checkForUpdate(ch);
      // A manual check that comes back in ~200ms (the usual case) produced no
      // perceptible feedback at all: the subline it lands on is the SAME text
      // the mount-time auto-check already left there, so the only signal was a
      // "Checking…" flash the eye misses. Hold the busy state briefly so the
      // press visibly does something...
      if (force) {
        const remaining = MIN_CHECK_MS - (Date.now() - startedAt);
        if (remaining > 0) await new Promise((r) => setTimeout(r, remaining));
      }
      const now = Date.now();
      if (info?.success) _updCheckCache = { t: now, channel: ch, info };
      applyCheckResult(info, ch, now);
      // ...and answer the question the user actually asked. Only for manual
      // checks — auto-checks (mount, channel switch) must stay silent.
      if (force) {
        if (!info?.success) {
          toaster.toast({ title: 'Updates', body: `Couldn't check — ${info?.message ?? 'unknown error'}` });
        } else if (!info.available) {
          toaster.toast({ title: 'Updates', body: `Up to date — v${info.current} is the latest on ${ch}.` });
        }
        // An available update needs no toast: the card itself changes loudly
        // (version line, "Install v…" button, release notes).
      }
    } catch (error) {
      setLastChecked(Date.now());
      setStatusMsg({ kind: 'err', text: `Couldn't check for updates — ${String(error)}` });
    } finally {
      setChecking(false);
    }
  };

  const handleCheckUpdate = () => runUpdateCheck(channel, true);

  const handleInstallUpdate = async () => {
    if (!updateInfo?.url) return;
    setUpdating(true);
    setStatusMsg(null);
    setInstallPct(0);
    try {
      // Desktop: there is no plugin loader. The release asset is a single
      // AppImage, so we download it and swap the running file. The swap only
      // takes effect on restart, which Decky never needs since it reloads the
      // plugin in place.
      if ((window as any).__rommDesktop) {
        // No progress events on this path — the download is one long request,
        // so a percentage would sit at 0 for the whole ~170MB and read as
        // stalled. Use the busy state and say what is happening instead.
        setInstallPct(null);
        setUpdatePhase(`Downloading v${updateInfo.latest}…`);
        setStatusMsg({ kind: 'ok', text: `Downloading v${updateInfo.latest} — this may take a minute.` });
        const dl = await downloadUpdate(updateInfo.url);
        if (!dl?.success) {
          setStatusMsg({ kind: 'err', text: `Download failed — ${dl?.message ?? 'unknown error'}` });
          setUpdatePhase(null);
          setUpdating(false);
          setInstallPct(null);
          return;
        }
        setUpdatePhase('Installing…');
        const applied = await applyAppImageUpdate(dl.path);
        if (!applied?.success) {
          setStatusMsg({ kind: 'err', text: `Install failed — ${applied?.message ?? 'unknown error'}` });
          setUpdatePhase(null);
          setUpdating(false);
          setInstallPct(null);
          return;
        }
        setInstallPct(null);
        setUpdatePhase(null);
        setUpdating(false);
        // Clear `available`: the update is on disk, so offering "Install"
        // again is wrong. The action button becomes Restart instead.
        setUpdateInfo({ ...updateInfo, available: false, restartRequired: true });
        setStatusMsg({ kind: 'ok', text: `v${updateInfo.latest} installed — restart to finish.` });
        return;
      }

      // One-click install through the loader's WSRouter (window.DeckyBackend) —
      // @decky/api's `call` namespaces routes to our own plugin, so it can't
      // reach loader utilities/*. utilities/install_plugin only REGISTERS an
      // install request and emits loader/add_plugin_install_prompt, which
      // Decky's frontend turns into its own confirmation modal. The user already
      // confirmed in OUR UI, so we suppress Decky's listener for that one event,
      // catch the request_id ourselves, and confirm programmatically — no Decky
      // modal. Progress/completion arrive as loader/plugin_download_* events.
      try {
        const backend = (window as any).DeckyBackend;
        if (!backend?.call || !backend?.eventListeners?.get) throw new Error('DeckyBackend unavailable');

        const PROMPT = 'loader/add_plugin_install_prompt';
        const promptSet: Set<any> | undefined = backend.eventListeners.get(PROMPT);
        const saved = promptSet ? Array.from(promptSet) : [];
        promptSet?.clear();

        let restored = false;
        const restore = () => {
          if (restored) return;
          restored = true;
          try {
            backend.removeEventListener(PROMPT, onPrompt);
            for (const l of saved) backend.addEventListener(PROMPT, l);
            backend.removeEventListener('loader/plugin_download_info', onInfo);
            backend.removeEventListener('loader/plugin_download_finish', onFinish);
          } catch { /* ignore */ }
        };

        const onPrompt = (name: string, _version: string, request_id: string) => {
          if (name !== 'Ludo') return;
          // Put Decky's listeners back immediately — store installs must keep
          // prompting normally; only OUR request skips the modal.
          try {
            backend.removeEventListener(PROMPT, onPrompt);
            for (const l of saved) backend.addEventListener(PROMPT, l);
          } catch { /* ignore */ }
          backend.call('utilities/confirm_plugin_install', request_id).catch((e: any) => {
            restore();
            setUpdating(false);
            setInstallPct(null);
            setStatusMsg({ kind: 'err', text: `Install failed — ${String(e?.message ?? e)}` });
          });
        };
        const onInfo = (percent: number) => {
          if (typeof percent === 'number') setInstallPct(Math.max(0, Math.min(100, Math.round(percent))));
        };
        const onFinish = (name: string) => {
          if (name !== 'Ludo') return;
          restore();
          setInstallPct(100);
          toaster.toast({ title: `Updated to v${updateInfo.latest}`, body: '', duration: 5000 });
          // Do NOT call loader/reload_plugin here: utilities/install_plugin
          // ALREADY reloads us (its _install does stop() + import_plugin(), and
          // import_plugin re-imports the frontend via the loader/import_plugin
          // event). An extra reload stacked a 3× reload storm that left the UI
          // orphaned at 100%. The loader's own single reload picks up the reopen
          // breadcrumb set before the install call below.
        };

        backend.addEventListener(PROMPT, onPrompt);
        backend.addEventListener('loader/plugin_download_info', onInfo);
        backend.addEventListener('loader/plugin_download_finish', onFinish);
        // Safety net: if no prompt/finish ever arrives, restore Decky's
        // listeners and surface an error instead of hanging in "Installing…".
        setTimeout(() => {
          if (!restored) {
            restore();
            setUpdating(false);
            setInstallPct(null);
            setStatusMsg({ kind: 'err', text: 'Install timed out — try again or install from ZIP.' });
          }
        }, 90000);

        // Set the reopen-home breadcrumb NOW, before install — the loader may
        // tear the frontend down mid-install (import_plugin), so setting it in
        // onFinish could be too late. Survives the reload (Chromium-origin
        // localStorage); consumed once on the next startup.
        try { localStorage.setItem(_LS_REOPEN_HOME, String(Date.now())); } catch { /* ignore */ }

        await backend.call(
          'utilities/install_plugin',
          updateInfo.url,
          'Ludo',
          updateInfo.latest,
          '',
        );
        return; // stay in "Installing…" — the loader's install reloads us
      } catch (loaderErr) {
        console.warn('Loader install route unavailable, falling back to manual:', loaderErr);
        // Clear the breadcrumb — no reload will happen on this path, so it must
        // not hijack a later normal launch into reopening Home.
        try { localStorage.removeItem(_LS_REOPEN_HOME); } catch { /* ignore */ }
        setInstallPct(null);
      }

      // Fallback: download the zip ourselves and guide the user through Decky's
      // "Install plugin from ZIP" developer flow.
      const dl = await downloadUpdate(updateInfo.url);
      if (!dl?.success) {
        setStatusMsg({ kind: 'err', text: `Download failed — ${dl?.message ?? 'unknown error'}` });
        return;
      }
      setStatusMsg({ kind: 'ok', text: `v${updateInfo.latest} downloaded — install it via Decky ▸ gear ▸ Install plugin from ZIP.` });
      setUpdateInfo({ ...updateInfo, downloadedPath: dl.path });
      setUpdating(false);
    } catch (error) {
      setStatusMsg({ kind: 'err', text: `Update failed — ${String(error)}` });
      setUpdating(false);
      setInstallPct(null);
      setUpdatePhase(null);
    }
  };

  const handleLoggingToggle = async (enabled: boolean) => {
    setLoggingEnabled(enabled);
    try {
      await updateLoggingEnabled(enabled);
    } catch (error) {
      console.error('Failed to set logging preference:', error);
      setLoggingEnabled(!enabled);
    }
  };

  const handleLogout = async (wipeData: boolean) => {
    setLoggingOut(true);
    try {
      const result = await logout(wipeData);
      if (result?.success) {
        // Drop the remembered pill identity, or the next launch paints the
        // signed-out user's name and avatar until the fetch says otherwise.
        clearIdentityCache();
        // The browse lists are cached to localStorage for instant repaint, so
        // they'd otherwise survive the logout and greet the next user.
        clearBrowseCaches();
        // The backend re-arms its one-shot announcement on logout; this latch
        // has to drop too or the next sign-in's "library is ready" is swallowed
        // by a session that already toasted once.
        _annShown = false;
        toaster.toast({
          title: 'Logged out',
          body: wipeData
            ? `${result.deleted_roms ?? 0} ROM file(s) deleted. Signed out of RomM.`
            : 'Signed out of RomM. Downloaded files were kept.',
        });
        // Hand back to the setup wizard so the user can sign in again. Pop the
        // library route off the history stack FIRST (like the wizard's own
        // finish()), otherwise pressing Back from the wizard lands the user
        // right back on the now signed-out library home.
        try { Navigation.NavigateBack(); } catch { /* ignore */ }
        setTimeout(() => { Navigation.Navigate("/romm-sync-setup"); Navigation.CloseSideMenus(); }, 60);
      } else {
        toaster.toast({ title: 'Logout failed', body: result?.error ?? 'Unknown error' });
      }
    } catch (error) {
      toaster.toast({ title: 'Logout failed', body: String(error) });
    } finally {
      setLoggingOut(false);
      setConfirmLogout(false);
    }
  };

  return v2Page(
    <Focusable noFocusRing
      onCancelButton={() => libBack("/romm-sync-library")}
      style={{ maxWidth: '760px', margin: '0 auto', padding: '20px 20px 0' }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '24px' }}>
        <GameActionButton icon={<FaChevronLeft size={16} />} onClick={() => libBack("/romm-sync-library")} />
        <div style={{ fontSize: '24px', fontWeight: 800, letterSpacing: '-0.01em' }}>Settings</div>
      </div>

      {/* Held at opacity 0 for the one round-trip it takes to learn whether the
          RetroDECK and Steam sections apply, then faded in as a finished page.
          Opacity rather than a `shapeReady && ...` gate on purpose: this keeps
          the subtree mounted, so nothing remounts and gamepad focus never has
          to be re-seeded. `shapeTimer` guarantees this always resolves. */}
      <div style={{
        opacity: shapeReady ? 1 : 0,
        transition: 'opacity 140ms ease-out',
      }}>
      {rdDetected && (
        <V2SettingsSection title="RetroDECK">
          <V2SettingsRow
            icon={<FaExternalLinkAlt size={16} />}
            title="Show RetroDECK launch button"
            subtitle="Adds a button in the top bar to launch the RetroDECK frontend."
            onClick={() => handleRdButtonToggle(!rdButton)}
            right={<V2Switch checked={rdButton} />}
          />
        </V2SettingsSection>
      )}

      {isDesktop && tileState.available && (
        <V2SettingsSection title="Steam">
          <V2SettingsRow
            icon={<FaExternalLinkAlt size={16} />}
            title="Add to Steam library"
            subtitle={tileNote
              || 'Creates a "RomM" tile that opens this app. Steam must be restarted for it to appear.'}
            onClick={() => handleSteamTileToggle(!tileState.installed)}
            right={<V2Switch checked={tileState.installed} />}
          />
        </V2SettingsSection>
      )}

      {isDesktop && (
        <V2SettingsSection title="Notifications">
          <div style={{
            display: 'flex', flexDirection: 'column', gap: '12px', padding: '16px',
            borderRadius: V2.radiusCard, background: V2.surface, border: `1px solid ${V2.border}`,
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px', minWidth: 0 }}>
              <FaInfoCircle size={16} style={{ color: V2.fgMuted, flexShrink: 0 }} />
              <div style={{ display: 'flex', flexDirection: 'column', gap: '2px', minWidth: 0 }}>
                <span style={{ fontSize: '14px', fontWeight: 600 }}>Overlay position</span>
                <span style={{ fontSize: '12px', color: V2.fgMuted }}>
                  Which screen corner pop-up notifications appear in.
                </span>
              </div>
            </div>
            <div style={{ alignSelf: 'flex-start' }}>
              <V2Segment
                options={[
                  { id: 'top-left', label: 'Top left' },
                  { id: 'top-right', label: 'Top right' },
                  { id: 'bottom-left', label: 'Bottom left' },
                  { id: 'bottom-right', label: 'Bottom right' },
                ]}
                value={toastPos} onChange={handleToastPos} />
            </div>
          </div>
        </V2SettingsSection>
      )}

      <V2SettingsSection title="Updates">
        <div style={{
          display: 'flex', flexDirection: 'column', gap: '12px', padding: '16px',
          borderRadius: V2.radiusCard, background: V2.surface, border: `1px solid ${V2.border}`,
        }}>
          {/* Header: version prominent, channel as a segmented control */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px' }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '3px', minWidth: 0 }}>
              <span style={{ fontSize: '16px', fontWeight: 800, lineHeight: 1 }}>v{version || '…'}</span>
              {/* Status subline: one glanceable row with icon */}
              <div style={{ display: 'flex', alignItems: 'center', gap: '5px', fontSize: '12px', lineHeight: 1.3 }}>
                {checking ? (
                  <span style={{ color: V2.fgMuted }}>Checking…</span>
                ) : updateInfo?.available ? (
                  <>
                    <FaDownload size={10} style={{ color: V2.brand, flexShrink: 0 }} />
                    <span style={{ color: V2.brand, fontWeight: 600 }}>
                      v{updateInfo.latest} available{updateInfo.prerelease ? ' (pre-release)' : ''}
                    </span>
                  </>
                ) : statusMsg?.kind === 'err' ? (
                  <>
                    <FaTimesCircle size={10} style={{ color: V2.danger, flexShrink: 0 }} />
                    <span style={{ color: V2.danger }}>{statusMsg.text}</span>
                  </>
                ) : statusMsg?.kind === 'ok' ? (
                  <>
                    <FaCheckCircle size={10} style={{ color: '#4ade80', flexShrink: 0 }} />
                    <span style={{ color: V2.fgMuted }}>
                      Up to date{lastChecked != null && ` · checked ${Date.now() - lastChecked < 60000 ? 'just now' : `${Math.round((Date.now() - lastChecked) / 60000)}m ago`}`}
                    </span>
                  </>
                ) : (
                  <span style={{ color: V2.fgMuted }}>{channel} channel</span>
                )}
              </div>
            </div>
            <V2Segment options={[{ id: 'stable', label: 'Stable' }, { id: 'beta', label: 'Beta' }]}
              value={channel} onChange={handleChannelChange} disabled={updating} />
          </div>
          {/* Action: full width, fixed height; fills with brand color while installing */}
          {/* One action, whose meaning follows the state: check -> install ->
              restart. A separate restart button alongside a re-enabled
              "Install" reads as if the install failed. */}
          <UpdateActionBtn
            label={updating ? (updatePhase ?? `Installing…${installPct != null ? ` ${installPct}%` : ''}`)
              : checking ? 'Checking…'
                : updateInfo?.restartRequired ? 'Restart to finish updating'
                  : updateInfo?.available ? `Install v${updateInfo.latest}`
                    : 'Check for Updates'}
            icon={updateInfo?.restartRequired ? <FaSync size={13} />
              : updateInfo?.available && !updating ? <FaDownload size={13} />
                : <FaSync size={13} />}
            onClick={updateInfo?.restartRequired
              ? () => (window as any).__rommDesktop?.restart?.()
              : updateInfo?.available ? handleInstallUpdate : handleCheckUpdate}
            disabled={checking || updating}
            primary={(!!updateInfo?.available || !!updateInfo?.restartRequired) && !updating}
            progress={updating ? installPct : null}
            busy={checking || updating}
          />
          {updateInfo?.downloadedPath && (
            <div style={{ fontSize: '11px', color: V2.fgMuted, wordBreak: 'break-all' }}>
              Downloaded to: {updateInfo.downloadedPath}
            </div>
          )}
          {updateInfo?.available && !!updateInfo.notes && !updating && (
            <>
              <div style={{ height: '1px', background: V2.border }} />
              <div style={{ fontSize: '12px', color: V2.fg2, lineHeight: 1.5 }}>
                <div style={{ fontWeight: 600, color: V2.fg, marginBottom: '4px' }}>What's new in v{updateInfo.latest}</div>
                {/* Fade-out mask instead of a hard clip, so truncation reads as intentional */}
                <div style={{
                  whiteSpace: 'pre-wrap', maxHeight: '96px', overflow: 'hidden',
                  WebkitMaskImage: 'linear-gradient(180deg, black 62%, transparent 100%)',
                  maskImage: 'linear-gradient(180deg, black 62%, transparent 100%)',
                } as any}>
                  {String(updateInfo.notes).slice(0, 600)}
                </div>
              </div>
            </>
          )}
          <div style={{ height: '1px', background: V2.border }} />
          <RomSwitch
            checked={checkOnStartup}
            onChange={handleCheckOnStartupToggle}
            label="Check on startup"
            description="Show a notification when an update is available for the selected channel."
          />
        </div>
      </V2SettingsSection>

      <RecentActivitySection />

      <FoldersSection />

      <V2SettingsSection title="Account">
        {!confirmLogout ? (
          <V2SettingsRow
            icon={<FaUndo size={16} />}
            title="Log out"
            subtitle={serverInfo ? `Signed in as ${serverInfo}` : 'Sign out and return to setup.'}
            onClick={() => setConfirmLogout(true)}
            danger
          />
        ) : (
          <div ref={confirmPanelRef} style={{
            display: 'flex', flexDirection: 'column', gap: '12px', padding: '16px',
            borderRadius: V2.radiusCard, background: 'rgba(255,80,80,0.08)',
            border: `1px solid rgba(255,80,80,0.40)`,
          }}>
            <div style={{ fontSize: '13px', color: V2.fg2, lineHeight: 1.4 }}>
              How do you want to log out? You'll return to the setup wizard either way.
            </div>
            <GameActionButton icon={<FaUndo size={14} />} label={loggingOut ? 'Logging out…' : 'Log out (keep downloads)'}
              focusRef={logoutFirstRef} onClick={() => handleLogout(false)} disabled={loggingOut} />
            <GameActionButton icon={<FaTrash size={14} />} label={loggingOut ? 'Logging out…' : 'Log out & delete all downloads'}
              variant="danger" onClick={() => handleLogout(true)} disabled={loggingOut} />
            <GameActionButton icon={<FaTimes size={14} />} label="Cancel"
              onClick={() => setConfirmLogout(false)} disabled={loggingOut} />
          </div>
        )}
      </V2SettingsSection>

      <V2SettingsSection title="Debug">
        <V2SettingsRow
          icon={<FaBug size={16} />}
          title="Enable debug logging"
          subtitle="Write logs to ~/.config/ludo/debug.log"
          onClick={loading ? undefined : () => handleLoggingToggle(!loggingEnabled)}
          right={<V2Switch checked={loggingEnabled} />}
          disabled={loading}
        />
      </V2SettingsSection>

      <V2SettingsSection title="About">
        <div style={{
          display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '8px',
          padding: '20px 16px', borderRadius: V2.radiusCard, background: V2.surface,
          border: `1px solid ${V2.border}`,
        }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: '8px' }}>
            <span style={{ fontWeight: 800, fontSize: '16px' }}>Ludo</span>
            <span style={{ color: V2.fgMuted, fontSize: '12px' }}>v{version || '1.0.0'}</span>
          </div>
          <div style={{ color: V2.fgMuted, fontSize: '12px' }}>by Covin</div>
          <div style={{ display: 'flex', gap: '10px', marginTop: '6px' }}>
            {[
              { icon: <FaGithub size={13} />, label: 'GitHub', url: 'https://github.com/Covin90/ludo' },
              { icon: <FaBug size={13} />, label: 'Report Issue', url: 'https://github.com/Covin90/ludo/issues' },
            ].map(({ icon, label, url }) => (
              <V2Button key={label} variant="tonal" onClick={() => Navigation.NavigateToExternalWeb(url)}>
                {icon}<span>{label}</span>
              </V2Button>
            ))}
          </div>
        </div>
      </V2SettingsSection>
      </div>
    </Focusable>
  );
}

function Content() {
  // Slim QAM launcher: connection status + entry into the full-screen app.
  // All management (collections, BIOS, settings) now lives in-app — open it
  // with the gear here, or press Select anywhere in the browser.
  const [status, setStatus] = useState<any>({ status: 'loading', message: 'Loading…' });
  const [configured, setConfigured] = useState<boolean | null>(null);
  const configuredRef = useRef<boolean | null>(null);
  const intervalRef = useRef<any>(null);

  const getStatusColor = () => {
    // Prefer the finer-grained connection state: a cached-offline session is a
    // warning (amber), but a true disconnect with nothing to show is an error
    // (red), even though both report status === 'running'.
    switch (status.connection) {
      case 'online': return '#4ade80';
      case 'offline_cached': return '#fbbf24';
      case 'connecting': return '#9ca3af';
      case 'disconnected': return '#f87171';
    }
    switch (status.status) {
      case 'connected': return '#4ade80';
      case 'running': return '#fbbf24';
      case 'stopped': return '#f87171';
      case 'error': return '#f87171';
      default: return '#9ca3af';
    }
  };


  const checkConfigured = async () => {
    try {
      const cfg = await getConfig();
      const isConfigured = cfg?.configured ?? false;
      configuredRef.current = isConfigured;
      setConfigured(isConfigured);
      return isConfigured;
    } catch {
      setConfigured(false);
      return false;
    }
  };

  const refreshStatus = async () => {
    try {
      if (configuredRef.current === false) {
        if (!(await checkConfigured())) return;
      }
      setStatus(await getServiceStatus());
    } catch {
      setStatus({ status: 'error', message: '❌ Plugin error' });
    }
  };

  useEffect(() => {
    checkConfigured().then(refreshStatus);
    intervalRef.current = setInterval(refreshStatus, 2000);
    return () => { if (intervalRef.current) clearInterval(intervalRef.current); };
  }, []);

  if (configured === null) {
    return (
      <PanelSection>
        <PanelSectionRow>
          <div style={{ color: '#9ca3af', fontSize: '0.9em' }}>Loading…</div>
        </PanelSectionRow>
      </PanelSection>
    );
  }

  if (configured === false) {
    return (
      <PanelSection title="Ludo">
        <PanelSectionRow>
          <div style={{ fontSize: '0.85em', color: '#d1d5db', lineHeight: '1.5' }}>
            Connect your SteamOS device to your RomM server to sync ROMs and saves.
          </div>
        </PanelSectionRow>
        <PanelSectionRow>
          <ButtonItem
            layout="below"
            onClick={() => { Navigation.Navigate("/romm-sync-setup"); Navigation.CloseSideMenus(); }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
              <FaCog size={14} />
              <span>Get Started</span>
            </div>
          </ButtonItem>
        </PanelSectionRow>
      </PanelSection>
    );
  }

  return (
    <PanelSection>
      <PanelSectionRow>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '0.85em', padding: '4px 0' }}>
          <div style={{ width: '8px', height: '8px', borderRadius: '50%', backgroundColor: getStatusColor(), flexShrink: 0 }} />
          <span>{(status.message || '').replace(', ', ' - ')}</span>
        </div>
      </PanelSectionRow>

      <PanelSectionRow>
        <ButtonItem
          layout="below"
          onClick={() => { Navigation.Navigate("/romm-sync-library"); Navigation.CloseSideMenus(); }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
            <FaGamepad size={14} />
            <span>Open RomM</span>
          </div>
        </ButtonItem>
      </PanelSectionRow>

      <PanelSectionRow>
        <ButtonItem
          layout="below"
          onClick={() => { Navigation.Navigate("/romm-sync-settings"); Navigation.CloseSideMenus(); }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
            <FaCog size={14} />
            <span>Settings</span>
          </div>
        </ButtonItem>
      </PanelSectionRow>

      <PanelSectionRow>
        <div style={{ fontSize: '11px', color: '#9ca3af', padding: '4px 2px 0', lineHeight: 1.4 }}>
          Tip: press Select in the browser to open Settings.
        </div>
      </PanelSectionRow>
    </PanelSection>
  );
}

function TitleView() {
  const [isRefreshing, setIsRefreshing] = useState(false);

  const handleRefresh = async () => {
    if (isRefreshing) return;
    setIsRefreshing(true);
    try {
      // Call refresh_from_romm to fetch fresh data from server
      const result = await refreshFromRomm(false); // false = incremental refresh
      if (result?.success) {
        console.log('[REFRESH] Successfully refreshed from RomM:', result.message);
      } else {
        console.warn('[REFRESH] Refresh returned non-success:', result?.message);
      }
      // Keep spinning for at least 500ms for visual feedback
      setTimeout(() => setIsRefreshing(false), 500);
    } catch (error) {
      console.error('[REFRESH] Failed to refresh from RomM:', error);
      setIsRefreshing(false);
    }
  };

  return (
    <div style={{ display: 'flex', alignItems: 'center', width: '100%' }}>
      <div style={{ marginRight: 'auto', flex: 0.9 }}>Ludo</div>
      <DialogButton
        style={{ height: '28px', width: '28px', minWidth: 0, padding: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', marginRight: '4px' }}
        onClick={handleRefresh}
        disabled={isRefreshing}
      >
        <FaSync style={{
          display: 'block',
          animation: isRefreshing ? 'spin 1s linear infinite' : 'none'
        }} />
      </DialogButton>
      <DialogButton
        style={{ height: '28px', width: '28px', minWidth: 0, padding: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
        onClick={() => {
          Navigation.Navigate("/romm-sync-settings");
          Navigation.CloseSideMenus();
        }}
      >
        <BsGearFill style={{ display: 'block' }} />
      </DialogButton>
      <style>{`
        @keyframes spin {
          from { transform: rotate(0deg); }
          to { transform: rotate(360deg); }
        }
      `}</style>
    </div>
  );
}

// ─── Setup wizard ────────────────────────────────────────────────────────────
// Full-screen guided first-run flow (RomM v2 visual language): Welcome →
// Connect (login or pair code, with Test) → Folders → Finish. Auto-opened on
// startup when no connection is configured; also reachable from the QAM.

// RomSwitch — React port of RomM's frontend/src/v2/lib/forms/RSwitch/RSwitch.vue.
// An iOS-style 36×20px track with a 14px knob that slides on toggle, with the
// brand-purple background, inner sheen, outer glow, spring easing and active
// press squash that define the RomM v2 toggle's feel.
function RomSwitch({ checked, onChange, disabled, label, description }:
  { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean; label?: string; description?: string }) {
  const [focused, setFocused] = useState(false);
  const row = (inner: any) => (
    // Focusable (not a bare div) so the gamepad can land on it and it shows a
    // focus highlight — a plain div only reacts to :hover, which never fires
    // under controller navigation.
    <Focusable
      noFocusRing
      onActivate={() => { if (!disabled) onChange(!checked); }}
      onClick={() => { if (!disabled) onChange(!checked); }}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      onMouseEnter={() => setFocused(true)}
      onMouseLeave={() => setFocused(false)}
      style={{
        display: 'flex', alignItems: 'center', gap: '14px', width: '100%',
        // border-box: this webview defaults to content-box, so 100% width plus
        // the 14px side padding + 1px border overflowed the parent card.
        boxSizing: 'border-box',
        padding: '12px 14px', borderRadius: V2.radiusMd, cursor: disabled ? 'not-allowed' : 'pointer',
        background: focused && !disabled ? 'rgba(255,255,255,0.09)' : 'rgba(255,255,255,0.045)',
        border: `1px solid ${focused && !disabled ? V2.brand : V2.border}`,
        opacity: disabled ? 0.55 : 1,
        transition: 'background 0.2s, border-color 0.2s, box-shadow 0.15s',
        ...V2Focus.flat(focused && !disabled),
      }}
    >
      <div className={`r-switch${checked ? ' r-switch--on' : ''}${disabled ? ' r-switch--disabled' : ''}`} style={{ display: 'inline-flex', alignItems: 'center', background: 'transparent', border: 'none', padding: 0 }}>
        <span className="r-switch__track" style={{ position: 'relative', flexShrink: 0, borderRadius: '999px', background: checked ? V2.brand : V2.borderStrong, overflow: 'hidden', width: '36px', height: '20px', transition: 'background 260ms cubic-bezier(0.45,0.05,0.55,0.95), box-shadow 260ms cubic-bezier(0.45,0.05,0.55,0.95)' }}>
          <span className="r-switch__knob" style={{ position: 'absolute', top: '3px', left: '3px', // White in both states: on the brand-purple track a dark knob reads as
// unlit/disabled, which is the opposite of what "on" should look like.
borderRadius: '50%', background: V2.fg, width: '14px', height: '14px', transform: checked ? 'translateX(16px) scaleX(1)' : 'translateX(0) scaleX(1)', transformOrigin: checked ? 'right center' : 'left center', transition: 'transform 340ms cubic-bezier(0.34,1.56,0.64,1), background 200ms cubic-bezier(0.22,1,0.36,1)', boxShadow: '0 1px 2px rgba(0,0,0,0.22)' }} />
        </span>
      </div>
      {(label || description) && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '2px', flex: '1 1 auto', minWidth: 0 }}>
          {label && <span style={{ fontSize: '14px', fontWeight: 500, color: V2.fg }}>{label}</span>}
          {description && <span style={{ fontSize: '12px', color: V2.fgMuted, lineHeight: 1.45 }}>{description}</span>}
        </div>
      )}
      {inner}
    </Focusable>
  );
  // The scoped <style> block carries the box-shadow sheen/glow + hover halo +
  // active-press squash that can't be expressed as inline styles.
  return (
    <>
      <style>{`
        .r-switch--on .r-switch__track{box-shadow:inset 0 1px 0 rgba(255,255,255,0.18),0 0 12px rgba(139,116,232,0.38)}
        .r-switch:not(.r-switch--disabled){cursor:pointer}
        .r-switch--disabled{cursor:not-allowed;opacity:0.55}
        .r-switch > div:hover .r-switch__knob,.r-switch:hover:not(.r-switch--disabled) .r-switch__knob{box-shadow:0 2px 4px rgba(0,0,0,0.28),0 0 0 5px rgba(255,255,255,0.10)}
        .r-switch--on:hover .r-switch__knob,.r-switch--on:hover:not(.r-switch--disabled) .r-switch__knob{box-shadow:0 2px 4px rgba(0,0,0,0.28),0 0 0 5px rgba(139,116,232,0.22)}
        .r-switch:active:not(.r-switch--disabled) .r-switch__knob{transform:translateX(0) scaleX(1.35);transition:transform 110ms cubic-bezier(0.22,1,0.36,1)}
        .r-switch--on:active:not(.r-switch--disabled) .r-switch__knob{transform:translateX(16px) scaleX(1.35);transition:transform 110ms cubic-bezier(0.22,1,0.36,1)}
        @media(prefers-reduced-motion:reduce){.r-switch__track,.r-switch__knob{transition:none!important}.r-switch:active .r-switch__knob{transform:translateX(0) scaleX(1)!important}.r-switch--on:active .r-switch__knob{transform:translateX(16px) scaleX(1)!important}}
      `}</style>
      {row(null)}
    </>
  );
}

function SetupWizard() {
  const [step, setStep] = useState(0);
  const [mode, setMode] = useState<'login' | 'pair'>('pair');
  const [logo, setLogo] = useState<string | null>(null);
  const [url, setUrl] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [pairCode, setPairCode] = useState('');
  const [romDir, setRomDir] = useState('');
  const [saveDir, setSaveDir] = useState('');
  const [biosDir, setBiosDir] = useState('');
  const [deviceName, setDeviceName] = useState('');
  const [deviceNameDefault, setDeviceNameDefault] = useState('SteamOS');
  const [hasPassword, setHasPassword] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ success: boolean; message: string } | null>(null);
  // Pairing happens when LEAVING the Connect step, not at Finish. A pairing code
  // is short-lived, and anyone who stopped to install RetroArch or pick folders
  // was spending that life on the rest of the wizard — arriving at Finish to
  // "Invalid or expired pairing code" with the code long gone from the server's
  // screen. Redeeming it while the user is still looking at it also means the
  // error lands on the field that caused it.
  const [paired, setPaired] = useState(false);
  const [pairing, setPairing] = useState(false);
  // Desktop-only opt-in on the final step: write a "RomM" tile into Steam's
  // shortcuts.vdf. Offered here rather than as its own step because it's
  // optional system integration, not something sync needs — and it mirrors what
  // doFinish already does unconditionally on the Deck (addRommShortcut, where
  // the tile is mandatory because Play routes through it). Only shown when Steam
  // is actually installed; applied in doFinish so backing out changes nothing.
  const [tileAvailable, setTileAvailable] = useState(false);
  const [wantTile, setWantTile] = useState(true);
  const [busy, setBusy] = useState(false);
  // Emulator step — offered BEFORE Folders, because with nothing installed the
  // folder defaults are Ludo's own fallbacks: the save dir would be one
  // RetroArch never reads, and the BIOS field comes back blank (there is no
  // system/ dir to detect). Installing first means the folders step is seeded
  // from a real emulator instead.
  const emu = useEmulatorStatus();
  const emuInstall = useEmulatorInstall();
  // Whether the wizard has an Emulator step at all, decided ONCE from the first
  // status we see and then frozen. It must not depend on the live `installed`
  // flag: installing from inside the step would drop the step out from under
  // the user mid-install, shifting every index after it.
  const [hasEmuStep, setHasEmuStep] = useState<boolean | null>(null);
  useEffect(() => {
    if (emu && hasEmuStep === null) setHasEmuStep(!emu.installed);
  }, [emu, hasEmuStep]);
  // Silences the install's own toasts for as long as this screen owns them.
  useEffect(() => {
    _wizardOpen = true;
    return () => { _wizardOpen = false; };
  }, []);
  // Extra bottom scroll room, added ONLY while a field is focused (keyboard up),
  // so the resting layout stays vertically centered with normal top spacing and
  // a focused field can still scroll clear of the keyboard overlay. Turning it
  // OFF is debounced: hopping from one field straight to another fires
  // blur(false) then activate(true), and collapsing the padding in between
  // would yank the scroll position around.
  // Landing focus per step: Connect highlights the RomM URL field (mode already
  // defaults to pair-code); the final step highlights Finish & open library.
  // Steps are addressed by name, not by index: the Emulator step is conditional,
  // so every `step === 2` in here would otherwise mean a different page
  // depending on what is installed.
  const STEPS = ['welcome', 'connect', ...(hasEmuStep ? ['emulator'] : []), 'folders', 'ready'];
  const TOTAL = STEPS.length;
  const cur = STEPS[Math.min(step, TOTAL - 1)];
  const startFocusRef = useAutoFocus(cur === 'welcome', step);
  const urlFocusRef = useAutoFocus(cur === 'connect', step);
  const emuNextRef = useAutoFocus(cur === 'emulator', step);
  const foldersNextRef = useAutoFocus(cur === 'folders', step);
  const finishFocusRef = useAutoFocus(cur === 'ready', step);
  const [kbRoom, _setKbRoomRaw] = useState(false);
  const kbOffTimer = useRef<any>(null);
  const scrollHostRef = useRef<HTMLDivElement | null>(null);
  // Scroll position at rest, captured when the keyboard room first opens, so
  // collapsing the keyboard restores the page to where the user left it instead
  // of staying scrolled down at wherever the focused field was lifted to.
  const kbRestScroll = useRef(0);
  const collapseKbRoom = () => {
    _setKbRoomRaw(false);
    // After the padding collapses (next frame), glide back to the resting
    // position — clamped implicitly by the now-shorter scroll range.
    requestAnimationFrame(() => {
      try { scrollHostRef.current?.scrollTo({ top: kbRestScroll.current, behavior: 'smooth' }); } catch { }
    });
  };
  const setKbRoom = (open: boolean) => {
    if (kbOffTimer.current) { clearTimeout(kbOffTimer.current); kbOffTimer.current = null; }
    if (open) {
      _setKbRoomRaw((was) => {
        if (!was) kbRestScroll.current = scrollHostRef.current?.scrollTop ?? 0;
        return true;
      });
    } else {
      kbOffTimer.current = setTimeout(collapseKbRoom, 450);
    }
  };
  // The keyboard manager's open flag — not field events — is the source of
  // truth for the room, in BOTH directions:
  //  - close: dismissing with B keeps gamepad focus on the same field, so
  //    onBlur never fires and the page stayed scrolled down.
  //  - open: after a keyboard session, gamepad focus sits on the INNER input,
  //    so the next A press reopens the keyboard via Steam itself and the
  //    wrapper's onActivate (our onKb(true)) never runs — the room stayed
  //    closed until the user moved to a different field.
  // So poll the flag while the wizard is mounted and reconcile the room to it.
  const kbRoomRef = useRef(false);
  useEffect(() => { kbRoomRef.current = kbRoom; }, [kbRoom]);
  useEffect(() => {
    const openRoom = (doc: any) => {
      if (!kbRoomRef.current) kbRestScroll.current = scrollHostRef.current?.scrollTop ?? 0;
      _setKbRoomRaw(true);
      // Lift whichever field owns the keyboard clear of it.
      [120, 600].forEach((d) => setTimeout(() => {
        try {
          const wrap = doc?.activeElement?.closest?.('.wiz-field');
          if (wrap) wrap.scrollIntoView({ behavior: 'smooth', block: 'start' });
        } catch { /* ignore */ }
      }, d));
    };
    let last: boolean | null = null;
    const iv = setInterval(() => {
      try {
        const win: any = (Router as any)?.WindowStore?.GamepadUIMainWindowInstance;
        const open = !!win?.VirtualKeyboardManager?.m_bIsInlineVirtualKeyboardOpen?.m_currentValue;
        if (last === null) { last = open; return; }
        if (open && !kbRoomRef.current) openRoom(win?.BrowserWindow?.document);
        if (open === last) return;
        last = open;
        if (!open && kbRoomRef.current) {
          if (kbOffTimer.current) { clearTimeout(kbOffTimer.current); kbOffTimer.current = null; }
          collapseKbRoom();
        }
      } catch { /* ignore */ }
    }, 250);
    return () => clearInterval(iv);
  }, []);

  useEffect(() => {
    (async () => {
      try {
        const c = await getConfig();
        setUrl(c.url || ''); setUsername(c.username || '');
        setRomDir(c.rom_directory || ''); setSaveDir(c.save_directory || ''); setBiosDir(c.bios_directory || '');
        setDeviceName(c.device_name || ''); setDeviceNameDefault(c.device_name_default || 'SteamOS');
        setHasPassword(c.has_password || false);
      } catch { /* ignore */ }
      try { const l = await getRommLogo(); setLogo(l?.data_uri || null); } catch { /* ignore */ }
      if ((window as any).__rommDesktop) {
        try {
          const st = await getSteamTileStatus();
          setTileAvailable(!!st?.available);
          // Already there (re-running the wizard) → leave it on; the write is
          // idempotent and unticking would be read as "remove it".
          if (st?.installed) setWantTile(true);
        } catch { /* ignore */ }
      }
    })();
  }, []);

  // Folder fields the user has edited by hand — never overwritten by the
  // re-seed below, which only fills in values they haven't expressed an opinion
  // about.
  const touchedDirs = useRef<Set<string>>(new Set());
  const markDir = (key: string, set: (v: string) => void) => (v: string) => {
    touchedDirs.current.add(key); set(v);
  };
  // An emulator appearing mid-wizard re-seeds the folder fields. The wizard read
  // get_config() on mount, when there was no emulator: ROMs/saves came back as
  // Ludo's own library fallbacks and BIOS came back empty. The backend has since
  // repaired those settings (repair_emulator_paths + align_saves_with_emulator,
  // run by install_emulator before it clears `active`), so without this the
  // stale mount-time values would be written straight back over the repair by
  // doFinish's saveConfig.
  const reseeded = useRef(false);
  useEffect(() => {
    if (hasEmuStep !== true || !emu?.installed || reseeded.current) return;
    reseeded.current = true;
    (async () => {
      try {
        const c = await getConfig();
        if (!touchedDirs.current.has('roms') && c.rom_directory) setRomDir(c.rom_directory);
        if (!touchedDirs.current.has('saves') && c.save_directory) setSaveDir(c.save_directory);
        if (!touchedDirs.current.has('bios') && c.bios_directory) setBiosDir(c.bios_directory);
      } catch { /* keep what we have; the folders step is still editable */ }
    })();
  }, [hasEmuStep, emu?.installed]);

  const finish = () => {
    // The wizard must not survive under the library in history — B at the
    // library root would walk straight back into completed setup.
    //
    // On desktop the wizard IS the history floor (boot replace-navs "/" → setup,
    // depth 1), and the shim's NavigateBack is a deliberate no-op there — so the
    // pop below did nothing and the library was pushed on top of the wizard.
    // Replacing the entry is what actually retires it, and it leaves the library
    // as the floor, where root-B is correctly inert.
    if ((window as any).__rommDesktop) {
      try {
        // Cast: NavigateReplace is the desktop shim's, not in Steam's Navigation
        // type — which is exactly why this is behind the __rommDesktop guard.
        (Navigation as any).NavigateReplace("/romm-sync-library");
        Navigation.CloseSideMenus();
        return;
      } catch { /* fall through to the pop-and-push below */ }
    }
    // Deck: Steam owns the stack and the wizard was pushed onto it, so popping
    // first is right — there is a real page underneath to pop to.
    try { Navigation.NavigateBack(); } catch { /* ignore */ }
    setTimeout(() => { Navigation.Navigate("/romm-sync-library"); Navigation.CloseSideMenus(); }, 60);
  };

  const doTest = async () => {
    setTesting(true); setTestResult(null);
    try { setTestResult(await testRommConnection(url.trim(), username.trim(), password)); }
    catch { setTestResult({ success: false, message: 'Test failed unexpectedly.' }); }
    finally { setTesting(false); }
  };

  // Connect step's primary action in pair mode: redeem the code, then advance.
  // A code that paired but failed to connect still counts as paired — it is
  // single-use and already spent, so retrying it can only report "expired".
  const doPair = async () => {
    setPairing(true); setTestResult(null);
    try {
      const r = await pairDevice(url.trim(), pairCode.trim());
      if (r?.paired) {
        setPaired(true);
        if (r?.connecting) {
          // The connect now runs on the sync thread, so it is still going when
          // we get here — on a large library, for minutes. Say so rather than
          // letting the next steps imply the library is already there.
          setTestResult({ success: true, message: 'Paired — loading your library in the background.' });
        } else if (!r?.success) {
          setTestResult({ success: true, message: 'Paired — the server isn\'t answering yet, but that can settle on its own.' });
        }
        next();
      } else {
        setTestResult({ success: false, message: r?.message || 'Pairing failed.' });
      }
    } catch {
      setTestResult({ success: false, message: 'Pairing failed.' });
    } finally { setPairing(false); }
  };

  const doFinish = async () => {
    setBusy(true);
    try {
      // The "RomM" Steam library tile is mandatory — ensure it exists before
      // navigating away (create if missing; reconcile repairs an existing one).
      try {
        // force=true: this is user-initiated (store is long since loaded),
        // and a fresh install can legitimately have an empty shortcut list.
        if ((await reconcileRommTile()) == null) await addRommShortcut(true);
      } catch (e) { console.error('[RomM] wizard steam tile', e); }

      // Desktop: no SteamClient, so the tile is the opt-in shortcuts.vdf one
      // from the final step. Never fatal — a failed write must not block setup.
      if ((window as any).__rommDesktop && tileAvailable && wantTile) {
        try {
          const spec = (window as any).__rommDesktop?.launchSpec?.();
          if (spec?.exe) {
            // No toast on success: the row the user just ticked says Steam has
            // to be restarted, so repeating it is noise on a screen they are
            // already leaving.
            await setSteamTile(true, spec.exe, spec.startDir || '', spec.args || '');
          }
        } catch (e) { console.error('[RomM] wizard desktop tile', e); }
      }

      if (mode === 'pair') {
        // Belt and braces: the Connect step does not advance unless pairing
        // succeeded, so this only fires if that invariant ever breaks.
        if (!paired) {
          const r = await pairDevice(url.trim(), pairCode.trim());
          if (!r?.paired) {
            toaster.toast({ title: 'Ludo', body: r?.message || 'Pairing failed.' });
            return;
          }
        }
        // Already paired on the Connect step — all that is left is the folders
        // and the device name, which pair_device does not write. (Before pairing
        // moved earlier, these were silently discarded in pair mode: doFinish
        // called pair_device and nothing else.) Neither is worth blocking the
        // library on, so a failure is reported and setup still completes.
        try {
          await setLibraryPaths(romDir.trim(), saveDir.trim(), biosDir.trim(), undefined);
          await setDeviceNameRpc(deviceName.trim() || deviceNameDefault);
        } catch (e) {
          console.error('[RomM] wizard paired-finish', e);
          toaster.toast({ title: 'Ludo', body: 'Saved, but your folders may need checking in Settings.' });
        }
        finish();
      } else {
        const dev = deviceName.trim() || deviceNameDefault;
        const r = await saveConfig(url.trim(), username.trim(), password, romDir.trim(), saveDir.trim(), dev, biosDir.trim());
        if (r?.success) { toaster.toast({ title: 'Ludo', body: 'Connected!' }); finish(); }
        else toaster.toast({ title: 'Ludo', body: r?.error || 'Failed to save configuration.' });
      }
    } catch { toaster.toast({ title: 'Ludo', body: 'Something went wrong.' }); }
    finally { setBusy(false); }
  };

  const next = () => setStep((s) => Math.min(s + 1, TOTAL - 1));
  const back = () => setStep((s) => Math.max(s - 1, 0));
  const canConnect = mode === 'pair'
    ? (url.trim() && pairCode.trim())
    : (url.trim() && username.trim() && (password.length > 0 || hasPassword));

  const onField = (set: (v: string) => void, isPair = false) => (v: string) => { set(v); if (!isPair) setTestResult(null); };
  // Pair codes follow XXXX-XXXX — strip junk, uppercase, auto-insert the dash.
  const formatPairCode = (raw: string) => {
    const clean = (raw || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
    return clean.length > 4 ? `${clean.slice(0, 4)}-${clean.slice(4)}` : clean;
  };
  const browse = (cur: string, set: (v: string) => void) => async () => {
    try { const res = await openFilePicker(FileSelectionType.FOLDER, pickerStart(cur), false, true); if (res?.realpath) set(res.realpath); }
    catch { /* ignore */ }
  };

  // Footer: Back pinned left, Next/primary pinned right (space-between).
  // Dpad-down from the step content enters the footer at its FIRST child (Back),
  // but the primary action is what the user is walking toward — so when focus
  // arrives on Back from OUTSIDE the footer, bounce it to the primary. Moving
  // left from the primary (a deliberate trip to Back) is within-footer and
  // stays put: both buttons stamp footerTouch on focus/blur, and the redirect
  // only fires when the footer hasn't been touched in the last 250ms.
  const footerTouch = useRef(0);
  const footerPrimaryRef = useRef<any>(null);
  const footer = (primary: any) => {
    const pRef = primary?.props?.focusRef ?? footerPrimaryRef;
    const touch = () => { footerTouch.current = Date.now(); };
    const p = cloneElement(primary, { focusRef: pRef, onFocused: touch, onBlurred: touch });
    return (
      <Focusable noFocusRing flow-children="horizontal" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', width: '100%', marginTop: '8px' }}>
        <GameActionButton variant="surface" label="Back" icon={<FaChevronLeft size={13} />} onClick={back}
          onBlurred={touch}
          onFocused={() => {
            const fromOutside = Date.now() - footerTouch.current > 250;
            touch();
            // Deferred, twice: bouncing synchronously from inside Steam's focus
            // pass let it finish bookkeeping on Back afterward — the ring drew
            // on the primary but A still activated Back.
            if (fromOutside) [30, 150].forEach((d) => setTimeout(() => {
              try { if (pRef.current) _forceGamepadFocus(pRef.current); } catch { /* ignore */ }
            }, d));
          }} />
        {p}
      </Focusable>
    );
  };

  return (
    <div className="romm-ui" ref={scrollHostRef} style={{
      position: 'fixed', inset: 0, color: V2.fg, fontFamily: V2.font,
      // Not justify:center — that clips the top of tall content in a scroll
      // container. The card centers itself with margin:auto instead (below).
      // Bottom padding is only inflated while a field is focused (kbRoom), giving
      // scrollIntoView room to lift the field clear of the keyboard overlay
      // without shifting the resting (unfocused) layout upward.
      // 28px, not 40: the Folders step is the tallest and at 40px it overflowed
      // the Deck's ~533px CSS viewport — margin:auto centering collapsed (no top
      // space) and the footer clipped off-screen.
      display: 'flex', flexDirection: 'column', alignItems: 'center',
      padding: kbRoom ? '28px 24px 52vh' : '28px 24px', overflowY: 'auto',
    }}>
      <V2Bg uri={null} />
      {/* romm-ui + this rule strip the CEF :focus outline that otherwise leaves a
          stray white ring on a wizard field after the highlight moves on — the
          same treatment every in-library page gets via v2Page. */}
      <style>{V2_FOCUS_STYLE}</style>
      <style>{`
        @keyframes wizIn { from { opacity: 0; transform: translateY(16px); } to { opacity: 1; transform: none; } }
        @keyframes wizPop { 0% { opacity: 0; transform: scale(0.6); } 60% { transform: scale(1.08); } 100% { opacity: 1; transform: scale(1); } }
        @keyframes wizDot { from { transform: scale(0.6); } to { transform: scale(1); } }
        .wiz-step > div > * { animation: wizIn 0.5s cubic-bezier(.22,1,.36,1) both; }
        .wiz-step > div > *:nth-child(1) { animation-delay: 0.02s; }
        .wiz-step > div > *:nth-child(2) { animation-delay: 0.07s; }
        .wiz-step > div > *:nth-child(3) { animation-delay: 0.12s; }
        .wiz-step > div > *:nth-child(4) { animation-delay: 0.17s; }
        .wiz-step > div > *:nth-child(5) { animation-delay: 0.22s; }
        .wiz-step > div > *:nth-child(6) { animation-delay: 0.27s; }
        .wiz-step > div > *:nth-child(n+7) { animation-delay: 0.32s; }
        .wiz-logo { animation: wizPop 0.55s cubic-bezier(.22,1,.36,1) both !important; filter: drop-shadow(0 6px 24px rgba(139,116,232,0.45)); }
        .wiz-check { animation: wizPop 0.6s cubic-bezier(.34,1.56,.64,1) both !important; }
        .wiz-dot { transition: width 0.32s cubic-bezier(.22,1,.36,1), background 0.32s ease; }
        .wiz-dot--active { animation: wizDot 0.32s ease; }
      `}</style>
      <Focusable noFocusRing
        // L1/R1 flip the login ↔ pair mode on the Connect step (mirrors the
        // home page's bumper tab paging; the keycaps flank the segment pill).
        onButtonDown={(evt: any) => {
          if (cur !== 'connect') return;
          const b = evt?.detail?.button;
          if (b === GamepadButton.BUMPER_LEFT || b === GamepadButton.BUMPER_RIGHT) {
            playSteamSound('deck_ui_tab_transition_01');
            setMode((m) => (m === 'login' ? 'pair' : 'login'));
            setTestResult(null);
          }
        }}
        style={{
          position: 'relative', zIndex: 2, width: '100%', maxWidth: '440px', margin: 'auto 0',
          display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '16px', textAlign: 'center',
        }}>
        {/* Progress dots */}
        <div style={{ display: 'flex', justifyContent: 'center', gap: '8px' }}>
          {Array.from({ length: TOTAL }).map((_, i) => (
            <div key={i} className={`wiz-dot${i === step ? ' wiz-dot--active' : ''}`} style={{
              width: i === step ? '22px' : '8px', height: '8px', borderRadius: V2.radiusPill,
              background: i <= step ? V2.brand : V2.surfaceHover,
            }} />
          ))}
        </div>

        <div key={step} className="wiz-step" style={{ width: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '22px' }}>
          {cur === 'welcome' && (
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '16px', textAlign: 'center' }}>
              {logo && <img className="wiz-logo" src={logo} style={{ width: '96px', height: '96px', objectFit: 'contain' }} />}
              <div style={{ fontSize: '28px', fontWeight: 800, letterSpacing: '-0.01em' }}>Welcome to Ludo</div>
              <div style={{ fontSize: '14px', color: V2.fg2, lineHeight: 1.6, maxWidth: '420px' }}>
                Connect this device to your RomM server to browse your library, download games, and sync saves across devices.
              </div>
              <div style={{ marginTop: '8px' }}>
                <GameActionButton variant="emphasized" label="Get started" focusRef={startFocusRef} icon={<FaPlay size={13} style={{ marginLeft: '2px' }} />} onClick={next} />
              </div>
            </div>
          )}

          {cur === 'connect' && (
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '14px', width: '100%' }}>
              <div style={{ fontSize: '20px', fontWeight: 700 }}>Connect to RomM</div>
              {/* Login / Pair toggle — same segmented pill as the update channel,
                  flanked by L1/R1 keycaps like the home nav: bumpers switch mode. */}
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '10px' }}>
                <Bumper label="L1" />
                <V2Segment
                  options={[{ id: 'login', label: 'Username & password' }, { id: 'pair', label: 'Pair code' }]}
                  value={mode}
                  onChange={(m) => { setMode(m as 'login' | 'pair'); setTestResult(null); }}
                />
                <Bumper label="R1" />
              </div>
              <V2TextField label="RomM URL" value={url} onChange={onField(setUrl)} placeholder="https://romm.example.com" onKb={setKbRoom} focusRef={urlFocusRef} />
              {mode === 'login' ? (
                <>
                  <V2TextField label="Username" value={username} onChange={onField(setUsername)} onKb={setKbRoom} />
                  <V2TextField label="Password" value={password} onChange={onField(setPassword)} password
                    placeholder={hasPassword && !password ? 'Leave blank to keep saved' : undefined} onKb={setKbRoom}
                    onEnter={() => { if (canConnect) next(); }} />
                  {testResult && (
                    <div style={{ fontSize: '13px', color: testResult.success ? V2.success : V2.danger }}>
                      {testResult.success ? '✅' : '❌'} {testResult.message}
                    </div>
                  )}
                  <GameActionButton variant="surface" label={testing ? 'Testing…' : 'Test connection'} icon={null}
                    disabled={testing || !url.trim() || !username.trim()} onClick={doTest} />
                </>
              ) : (
                <>
                  <PairCodeField label="Pairing code" value={pairCode}
                    onChange={(v) => { setPairCode(formatPairCode(v)); setTestResult(null); }} onKb={setKbRoom}
                    onEnter={() => { if (canConnect && !paired) doPair(); }} />
                  {testResult && (
                    <div style={{ fontSize: '13px', color: testResult.success ? V2.success : V2.danger }}>
                      {testResult.success ? '✅' : '❌'} {testResult.message}
                    </div>
                  )}
                </>
              )}
              {footer(
                mode === 'pair' && !paired
                  ? <GameActionButton variant="emphasized" disabled={!canConnect || pairing}
                    label={pairing ? 'Pairing…' : 'Pair & continue'}
                    icon={pairing ? <FaSync size={14} style={{ animation: 'spin 1s linear infinite' }} /> : <FaChevronRight size={13} />}
                    onClick={doPair} />
                  : <GameActionButton variant="emphasized" label="Next" icon={<FaChevronRight size={13} />} disabled={!canConnect} onClick={next} />
              )}
            </div>
          )}

          {cur === 'emulator' && (() => {
            const done = !!emu?.installed;
            const active = emuInstall.active;
            const canInstall = !!emu?.install?.available;
            return (
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '14px', width: '100%', textAlign: 'center' }}>
                <div style={{ color: done ? V2.success : V2.brandHover }}>
                  {done ? <FaCheckCircle size={44} /> : <FaGamepad size={44} />}
                </div>
                <div style={{ fontSize: '20px', fontWeight: 700 }}>
                  {done ? 'Emulator ready' : active ? 'Installing RetroArch' : 'No emulator installed'}
                </div>
                <div style={{ fontSize: '13px', color: V2.fg2, lineHeight: 1.6, maxWidth: '420px' }}>
                  {done
                    ? 'RetroArch is installed. The next step is set up to use its folders.'
                    : active
                      // Leaving mid-install is safe: it runs in a backend thread,
                      // and the folder fields re-seed when it lands.
                      ? 'This takes a few minutes. You can carry on with setup while it runs.'
                      : canInstall
                        ? 'Ludo can download and sync your library without one, but playing needs RetroArch or RetroDECK.'
                        // No button we could offer would work here (Windows, no
                        // flatpak, running as root) — say why instead.
                        : `Ludo can download and sync your library without one, but playing needs RetroArch or RetroDECK — ${emu?.install?.reason || 'install one to play'}.`}
                </div>
                {active && (
                  <div style={{ width: '100%' }}>
                    <InstallProgressBar pct={emuInstall.pct} />
                    <div style={{ fontSize: '12px', color: V2.fgMuted, marginTop: '6px' }}>
                      {[emuInstall.phase, installSize(emuInstall), emuInstall.detail].filter(Boolean).join(' · ')}
                    </div>
                  </div>
                )}
                {emuInstall.error && !active && (
                  <div style={{ fontSize: '13px', color: V2.danger }}>❌ {emuInstall.error}</div>
                )}
                {!done && !active && canInstall && (
                  <GameActionButton variant="emphasized" label={emuInstall.error ? 'Try again' : 'Install RetroArch'}
                    icon={<FaDownload size={14} />} onClick={startEmulatorInstall} />
                )}
                {footer(
                  <GameActionButton variant={done ? 'emphasized' : 'surface'} focusRef={emuNextRef}
                    // Skipping is a first-class choice: collecting ROMs before
                    // owning an emulator is legitimate, and the Home banner keeps
                    // offering the install afterwards.
                    label={done || active ? 'Next' : 'Skip for now'}
                    icon={<FaChevronRight size={13} />} onClick={next} />
                )}
              </div>
            );
          })()}

          {cur === 'folders' && (
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '8px', width: '100%' }}>
              <div style={{ fontSize: '20px', fontWeight: 700 }}>Folders</div>
              <div style={{ fontSize: '13px', color: V2.fg2, lineHeight: 1.5, maxWidth: '420px' }}>
                Where ROMs, saves and BIOS files live on this device.
                {/* Without an emulator these are Ludo's own folders, not one an
                    emulator reads — worth saying, since the saves one is the
                    path that silently breaks sync later. */}
                {hasEmuStep && !emu?.installed && !emuInstall.active
                  && ' With no emulator installed these are Ludo\'s own folders — installing one later will point saves and BIOS at it.'}
              </div>
              {/* Field + Browse share a row: the stacked layout was taller than
                  the viewport, which clipped the footer buttons and killed the
                  centered spacing. flex-end aligns the button with the input box
                  (the field's label sits above it). */}
              {([
                ['ROM directory', 'roms', romDir, setRomDir],
                ['Save directory', 'saves', saveDir, setSaveDir],
                ['BIOS directory', 'bios', biosDir, setBiosDir],
              ] as [string, string, string, (v: string) => void][]).map(([lbl, key, val, raw]) => {
                const set = markDir(key, raw);
                return (
                <Focusable key={lbl} noFocusRing flow-children="horizontal"
                  style={{ display: 'flex', alignItems: 'flex-end', gap: '10px', width: '100%' }}>
                  <div style={{ flex: '1 1 auto', minWidth: 0 }}>
                    <V2TextField label={lbl} value={val} onChange={set} onKb={setKbRoom} />
                  </div>
                  <GameActionButton variant="surface" label="Browse…" icon={null} onClick={browse(val, set)} />
                </Focusable>
                );
              })}
              <V2TextField label="Device name" value={deviceName} onChange={setDeviceName} placeholder={deviceNameDefault} onKb={setKbRoom} />
              {footer(
                <GameActionButton variant="emphasized" label="Next" focusRef={foldersNextRef} icon={<FaChevronRight size={13} />} onClick={next} />
              )}
            </div>
          )}

          {cur === 'ready' && (
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '16px', textAlign: 'center', width: '100%' }}>
              <div className="wiz-check"><FaCheckCircle size={56} color={V2.success} /></div>
              <div style={{ fontSize: '24px', fontWeight: 800 }}>Ready to go</div>
              <div style={{ fontSize: '14px', color: V2.fg2, lineHeight: 1.6, maxWidth: '420px' }}>
                {mode === 'pair'
                  ? paired
                    ? 'This device is paired with your RomM server. We\'ll save your folders and open your library.'
                    : 'We\'ll pair this device with your RomM server and open your library.'
                  : 'We\'ll save your connection and open your library.'}
                {/* Finishing mid-install is fine — the backend thread carries on
                    and repoints the folders when it lands — but the user should
                    know why Play is still unavailable when they arrive. */}
                {emuInstall.active && ' RetroArch is still installing; it will be ready shortly.'}
              </div>
              {(window as any).__rommDesktop && tileAvailable && (
                <div style={{ width: '100%', textAlign: 'left' }}>
                  <V2SettingsRow
                    icon={<FaExternalLinkAlt size={16} />}
                    title="Add to Steam library"
                    subtitle='Creates a "RomM" tile that opens this app. Steam must be restarted for it to appear.'
                    onClick={() => setWantTile((v) => !v)}
                    right={<V2Switch checked={wantTile} />}
                  />
                </div>
              )}
              {footer(
                <GameActionButton variant="emphasized" disabled={busy} focusRef={finishFocusRef}
                  label={busy ? 'Connecting…' : 'Finish & open library'}
                  icon={busy ? <FaSync size={14} style={{ animation: 'spin 1s linear infinite' }} /> : <FaPlay size={13} style={{ marginLeft: '2px' }} />}
                  onClick={doFinish} />
              )}
            </div>
          )}
        </div>
      </Focusable>
    </div>
  );
}

// ─── Steam library "RomM" shortcut (mandatory) ───────────────────────────────
// A non-Steam shortcut named "RomM" is auto-created at plugin load (once RomM is
// configured) and is required: launching it from the library opens the Game
// Browser, and picking a game RunGame's this same tile so the emulator runs as a
// Steam-tracked child (working overlay). All SteamClient calls are undocumented +
// version-fragile, so every call is feature-detected and wrapped — failures
// degrade to a toast, never a crash.
const ROMM_SHORTCUT_NAME = "RomM";
// Fallback exe when the session-host script can't be resolved. With /bin/true the
// tile still opens the browser (via the launch intercept) but the Steam-overlay
// session-host launch path is unavailable, so Play falls back to a direct launch.
const ROMM_SHORTCUT_EXE = "/bin/true";
// The real exe: bin/romm-session-host. When the tile is RunGame'd after a game is
// picked, Steam launches this as a tracked game (opening the overlay session) and
// it execs the resolved emulator argv in-place — so the emulator inherits the
// overlay. Resolved lazily from the backend (absolute, plugin-dir dependent).
let _sessionHostExe: string | null = null;
async function rommShortcutExe(): Promise<string> {
  if (_sessionHostExe) return _sessionHostExe;
  try {
    const r = await getSessionHostPath();
    const p = typeof r === 'string' ? r : r?.path;
    if (p) { _sessionHostExe = p; return p; }
  } catch (e) { console.error('[RomM] getSessionHostPath', e); }
  return ROMM_SHORTCUT_EXE;
}
// Stamped into the shortcut's launch options so we can re-identify our tile
// even when Steam hasn't persisted its name (the root cause of duplicates and
// the toggle flipping off after an update).
const ROMM_TILE_SENTINEL = "ludo-tile";
let _rommAppId: number | null = null;
let _rommNavTimer: any = null;
let _rommActionReg: { unregister: () => void } | null = null;
// Set true immediately before we RunGame the tile to launch a *picked* game, so
// the launch intercept lets the session-host run (and execs the emulator) instead
// of treating it as a bare tile click (terminate + open the browser).
let _rommLaunchPending = false;
// Set true while a *picked-game* session is running (host execs the emulator as a
// Steam-tracked child). When that session ends we want to return to the Game
// Browser, not leave the user dropped on the Steam/Big-Picture library.
let _rommSessionActive = false;
// Set when the session-end watch navigates back to the Game Browser: the route
// remounts without gamepad focus (Steam parks it on its own chrome after a game
// exits), leaving the user unable to see or move a selection. The library root
// consumes this on mount and pulls focus onto the nav pill.
let _rommReturnFocusPending = false;
let _rommLifetimeReg: { unregister: () => void } | null = null;
// Guards the startup setup-wizard auto-open so it fires at most once per session.
let _setupAutoOpened = false;

const _sc = (): any => (typeof window !== 'undefined' ? (window as any).SteamClient : undefined);

// Enumerate all non-Steam shortcut overviews. This build does NOT expose
// SteamClient.Apps.GetAllShortcuts, so we read the app stores Steam keeps in
// memory and keep only entries that report themselves as shortcuts.
// AppIds of all non-Steam shortcuts. deckDesktopApps.apps is a Map keyed by
// appid on this build; the map values are not overviews, so we resolve each
// overview separately via appStore.GetAppOverviewByAppID.
function _shortcutAppIds(): number[] {
  const m = (window as any).collectionStore?.deckDesktopApps?.apps;
  try { if (m?.keys) return Array.from(m.keys()).map((k: any) => Number(k)); } catch { /* ignore */ }
  return [];
}

// True once Steam's shortcut store is actually populated. Early in Steam
// startup deckDesktopApps.apps can be missing or still empty; creating a
// shortcut then duplicates a tile that already exists on disk but isn't
// visible yet — the root cause of multiple "RomM" entries piling up.
function _shortcutStoreReady(): boolean {
  try {
    const m = (window as any).collectionStore?.deckDesktopApps?.apps;
    return !!m?.keys && Array.from(m.keys()).length > 0;
  } catch { return false; }
}

function _appName(appid: number): string {
  try { return String((window as any).appStore?.GetAppOverviewByAppID?.(appid)?.display_name ?? ''); } catch { return ''; }
}

// All our tiles carry the name "RomM"; also accept the exe-derived fallback
// names Steam uses when a name didn't persist. Real games carry their own names.
function _isRommName(nm: string): boolean {
  return nm === ROMM_SHORTCUT_NAME || nm === 'true' || nm === '/bin/true'
    || nm === 'romm-session-host';
}

function _rommAppIds(): number[] {
  return _shortcutAppIds().filter((aid) => _isRommName(_appName(aid)));
}

// Stamp "played just now" onto the RomM tile's overview so it surfaces in the
// home row's Recent Games. Steam only records last-played for sessions it ran
// to completion — bare tile clicks are terminated by the intercept before that
// happens, and opening the browser from the Decky panel never touches the tile
// at all. Writing rt_last_time_played on the in-memory overview is how Steam's
// own recents sort is fed (same approach MoonDeck uses); real picked-game
// sessions still persist it properly on exit.
function touchRommRecency() {
  try {
    const aid = _rommAppId ?? _rommAppIds()[0];
    if (aid == null) return;
    const ov = (window as any).appStore?.GetAppOverviewByAppID?.(aid);
    if (!ov) return;
    ov.rt_last_time_played = Math.floor(Date.now() / 1000);
    // The recents carousel can exclude apps with zero recorded playtime, and a
    // plain field write doesn't always notify the (MobX-backed) collections.
    // Give the tile a minute of playtime and poke the store's change hooks so
    // the home row actually re-sorts without needing a real session first.
    if (!Number(ov.minutes_playtime_forever)) ov.minutes_playtime_forever = "1";
    try { ov.OnAppOverviewChanged?.(); } catch { /* ignore */ }
    try { (window as any).appStore?.m_mapApps?.set?.(Number(aid), ov); } catch { /* ignore */ }
  } catch { /* ignore */ }
}

// Every app overview Steam knows about (installed games + non-Steam shortcuts),
// used to locate RetroDECK's library entry by name.
function _allAppOverviews(): any[] {
  try { return (window as any).collectionStore?.allAppsCollection?.allApps ?? []; }
  catch { return []; }
}

// Launch RetroDECK via its Steam library entry instead of spawning the flatpak
// ourselves. Steam runs it inside the real graphical session (correct display/
// dbus/env + overlay), sidestepping the env contamination that makes a
// daemon-spawned `flatpak run` crash. RetroDECK's installer adds a non-Steam
// shortcut named "RetroDECK"; we also scan installed apps as a fallback.
async function launchRetrodeckViaSteam(): Promise<{ ok: boolean; reason?: string }> {
  const apps = _sc()?.Apps;
  // No SteamClient at all (Electron desktop shell) — spawn RetroDECK from the
  // backend instead. Nothing here is Steam-tracked, but neither is the shell.
  if (!apps?.RunGame) {
    try { return await launchRetrodeckNative(); }
    catch (e) { return { ok: false, reason: String(e) }; }
  }
  const isRd = (nm: string) => /retrodeck/i.test(nm || '');
  const shortcutIds = _shortcutAppIds();
  let appId: number | null = null;
  for (const aid of shortcutIds) { if (isRd(_appName(aid))) { appId = aid; break; } }
  if (appId == null) {
    for (const ov of _allAppOverviews()) {
      if (isRd(ov?.display_name)) { appId = Number(ov.appid); break; }
    }
  }
  if (appId == null) {
    // Installed but never added to Steam: still launchable directly.
    try {
      const r = await launchRetrodeckNative();
      if (r.ok) return r;
    } catch { /* fall through to the library-side message */ }
    return { ok: false, reason: 'RetroDECK not found in your Steam library' };
  }
  // A non-Steam shortcut launches by its 64-bit gameID ((appid<<32)|0x02000000);
  // a real Steam app launches by its bare appid.
  const gid = shortcutIds.includes(appId)
    ? ((BigInt(appId) << 32n) | 0x2000000n).toString()
    : String(appId);
  await apps.RunGame(gid, "", -1, 100);
  return { ok: true };
}

async function findRommShortcut(): Promise<number | null> {
  if (_rommAppId != null) return _rommAppId;
  try {
    const ids = _rommAppIds();
    if (ids.length) return ids[0];
  } catch (e) { console.error('[RomM] findRommShortcut', e); }
  return null;
}

// Remove duplicate RomM tiles left behind by earlier sessions, keeping one.
// Returns the surviving appId (or null if none).
async function cleanupRommShortcuts(): Promise<number | null> {
  try {
    const apps = _sc()?.Apps;
    const mine = _rommAppIds();
    if (mine.length === 0) return null;
    // Keep the tile the user has actually used (play history / recent-games
    // placement lives on the appid), not whichever duplicate enumerates first.
    const score = (aid: number): number => {
      try {
        const ov = (window as any).appStore?.GetAppOverviewByAppID?.(aid);
        return (Number(ov?.rt_last_time_played) || 0) * 1e6
          + (Number(ov?.minutes_playtime_forever) || 0);
      } catch { return 0; }
    };
    const keep = mine.reduce((a, b) => (score(b) > score(a) ? b : a));
    for (const aid of mine.filter((x) => x !== keep)) {
      try { await apps?.RemoveShortcut?.(aid); } catch (e) { console.error('[RomM] dedup remove', e); }
    }
    return keep;
  } catch (e) { console.error('[RomM] cleanupRommShortcuts', e); return null; }
}

// Bring the RomM tile into a known-good state: collapse duplicates to one,
// repair the survivor's name + sentinel, repaint art, and bind the launch
// intercept. Safe to call repeatedly. Returns the surviving appId (or null).
// Run this when the shortcut store is ready (e.g. on Settings open), not only
// at plugin load, where GetAllShortcuts can still be empty.
async function reconcileRommTile(): Promise<number | null> {
  // Desktop has no Steam client — the shortcut/tile feature doesn't apply.
  if ((window as any).__rommDesktop) return null;
  const appId = (await cleanupRommShortcuts()) ?? (await findRommShortcut());
  if (appId == null) return null;
  _rommAppId = appId;
  const apps = _sc()?.Apps;
  try { await apps?.SetShortcutName?.(appId, ROMM_SHORTCUT_NAME); } catch { /* ignore */ }
  try { await apps?.SetShortcutLaunchOptions?.(appId, ROMM_TILE_SENTINEL); } catch { /* ignore */ }
  // Migrate the exe to the session-host script (older tiles used /bin/true).
  try {
    const exe = await rommShortcutExe();
    if (apps?.SetShortcutExe) await apps.SetShortcutExe(appId, exe);
  } catch (e) { console.error('[RomM] reconcile SetShortcutExe', e); }
  // Stamping name/launch-options can renumber the shortcut appid (it's a hash of
  // exe+name+options). Re-resolve so the cache, intercept and artwork all target
  // the live tile rather than the now-dead pre-stamp appid.
  const liveId = (_rommAppIds()[0]) ?? appId;
  _rommAppId = liveId;
  registerRommLaunchIntercept();
  ensureRommArtwork(liveId);
  // Keep the tile visible in the home row's Recent Games across restarts: the
  // recency stamp is in-memory, so re-assert it whenever we reconcile (plugin
  // load included) rather than only when the browser opens.
  touchRommRecency();
  return liveId;
}

async function ensureRommArtwork(appId: number) {
  try {
    const apps = _sc()?.Apps;
    if (!apps?.SetCustomArtworkForApp) return;
    // Steam asset types -> files this build writes:
    //   0 -> {appid}p.png   (portrait capsule)  : grid
    //   1 -> {appid}_hero   (hero background)    : hero
    //   2 -> {appid}_logo   (transparent logo)   : logo
    //   4 -> {appid}.png    (landscape capsule)  : THIS is the image Big
    //        Picture's "Recent Games" featured banner uses, so it must get the
    //        background-only landscape art, not the centered-mark icon.
    // (Type 3 is a no-op on this build, so the landscape goes through type 4.)
    const res = await getRommArtwork();
    const art = res?.art as Record<string, string> | undefined;
    if (art && Object.keys(art).length) {
      const ext = res.ext || 'png';
      // type -> source art key. Type 4 (the landscape {appid}.png) is fed the
      // header (bg-only) art instead of the icon.
      const plan: [number, string][] = [[0, '0'], [1, '1'], [2, '2'], [4, '3']];
      for (const [n, key] of plan) {
        if (!art[key]) continue;
        // Clear first: Steam won't overwrite an existing custom asset, so a
        // repaint over stale art would otherwise silently no-op.
        try { await apps.ClearCustomArtworkForApp?.(appId, n); } catch { /* ignore */ }
        try { await apps.SetCustomArtworkForApp(appId, art[key], ext, n); } catch { /* ignore */ }
      }
      return;
    }
    // Fallback to the flat logo if branded artwork is unavailable.
    const logo = await getPluginLogo();
    if (!logo?.b64) return;
    try { await apps.SetCustomArtworkForApp(appId, logo.b64, logo.ext || 'png', 0); } catch { /* ignore */ }
    try { await apps.SetCustomArtworkForApp(appId, logo.b64, logo.ext || 'png', 4); } catch { /* ignore */ }
  } catch (e) { console.error('[RomM] ensureRommArtwork', e); }
}

// Create the shortcut if missing; returns the appId (or null on failure).
// `force` skips the store-readiness gate — used only as a last resort when the
// store never reported ready (e.g. a user with zero non-Steam shortcuts, where
// the empty store is legitimate and creating cannot duplicate anything).
async function addRommShortcut(force = false): Promise<number | null> {
  // Desktop has no Steam client — never attempt to create a shortcut (this is
  // where the "Steam shortcuts API unavailable" toast came from).
  if ((window as any).__rommDesktop) return null;
  try {
    // Never create while the shortcut store is empty/unloaded: the existing
    // RomM tile may simply not be visible yet, and AddShortcut here is exactly
    // how duplicate "RomM" entries were piling up on each Steam restart.
    if (!force && !_shortcutStoreReady()) return null;
    const apps = _sc()?.Apps;
    if (!apps?.AddShortcut) { toaster.toast({ title: 'RomM', body: 'Steam shortcuts API unavailable on this build.' }); return null; }
    const exe = await rommShortcutExe();
    let appId = await findRommShortcut();
    if (appId == null) {
      appId = Number(await apps.AddShortcut(ROMM_SHORTCUT_NAME, exe, "", ""));
    } else if (apps.SetShortcutExe) {
      // Migrate older /bin/true tiles to the session-host exe so the overlay
      // launch path works. Harmless if already set.
      try { await apps.SetShortcutExe(appId, exe); } catch (e) { console.error('[RomM] SetShortcutExe', e); }
    }
    // Always (re)assert the display name. AddShortcut's name arg doesn't reliably
    // persist to the shortcut's strAppName on all Steam builds, so the tile can
    // show up blank/"true" without an explicit SetShortcutName.
    if (apps.SetShortcutName) {
      try { await apps.SetShortcutName(appId, ROMM_SHORTCUT_NAME); } catch (e) { console.error('[RomM] SetShortcutName', e); }
    }
    // Stamp the sentinel so we can always re-find this tile even if the name
    // doesn't persist — this is what prevents duplicate tiles piling up.
    if (apps.SetShortcutLaunchOptions) {
      try { await apps.SetShortcutLaunchOptions(appId, ROMM_TILE_SENTINEL); } catch (e) { console.error('[RomM] SetShortcutLaunchOptions', e); }
    }
    _rommAppId = appId;
    await ensureRommArtwork(appId);
    registerRommLaunchIntercept();
    registerRommSessionEndWatch();
    return appId;
  } catch (e) {
    console.error('[RomM] addRommShortcut', e);
    toaster.toast({ title: 'RomM', body: 'Could not add the library tile.' });
    return null;
  }
}


// Intercept the RomM tile's launch → cancel the no-op run and open the browser.
function registerRommLaunchIntercept() {
  try {
    if (_rommActionReg) return;
    const apps = _sc()?.Apps;
    if (!apps?.RegisterForGameActionStart) return;
    _rommActionReg = apps.RegisterForGameActionStart((_actionType: number, strAppId: string) => {
      const raw = Number(strAppId);
      // GameActionStart may pass the full 64-bit gameID; the 32-bit appid is its
      // high dword. Try both the raw value and the extracted appid.
      const hi = Math.floor(raw / 4294967296);
      const aid = hi > 0 ? hi : raw;
      // Identify by name/overview, not numeric id: GameActionStart's appid
      // representation (signed/unsigned/gameid) doesn't reliably equal the
      // collectionStore key, and stamping renumbers the cached id. Name match
      // sidesteps all of that.
      let mine = aid === _rommAppId || raw === _rommAppId;
      if (!mine) { try { mine = _isRommName(_appName(aid)) || _isRommName(_appName(raw)); } catch { /* ignore */ } }
      if (!mine) { try { mine = _rommAppIds().includes(aid) || _rommAppIds().includes(raw); } catch { /* ignore */ } }
      if (mine) {
        _rommAppId = aid;
        // A picked-game launch: we wrote a launch-spec and RunGame'd the tile so
        // the session-host can exec the emulator as a Steam-tracked child (overlay
        // works). Let it run — do NOT terminate or navigate.
        if (_rommLaunchPending) {
          _rommLaunchPending = false;
          // Remember this is a live emulator session so the app-lifetime
          // listener can navigate back to the Game Browser when it quits
          // (instead of leaving the user on the Steam/Big-Picture library).
          _rommSessionActive = true;
          return;
        }
        // Bare tile click: the exe is a no-op without a fresh spec. The tile
        // fires this twice (launch start type=6, then exit type=7 ~1.5s later).
        // End the launch immediately and open the Game Browser instead.
        try { _sc()?.Apps?.TerminateApp?.(String(strAppId), false); } catch { /* ignore */ }
        if (_rommNavTimer != null) { try { clearTimeout(_rommNavTimer); } catch { /* ignore */ } }
        _rommNavTimer = setTimeout(() => {
          _rommNavTimer = null;
          try { Navigation.Navigate("/romm-sync-library"); Navigation.CloseSideMenus(); } catch (e) { console.error('[RomM] nav', e); }
        }, 0);
      }
    });
  } catch (e) { console.error('[RomM] registerRommLaunchIntercept', e); }
}

// When a picked-game emulator session ends, the session-host PID exits and Steam
// returns to the library (Big Picture) — not the plugin. Register for app
// lifetime notifications so that when OUR tile stops running after a real
// session, we navigate straight back to the Game Browser.
function registerRommSessionEndWatch() {
  try {
    if (_rommLifetimeReg) return;
    const gs = _sc()?.GameSessions;
    if (!gs?.RegisterForAppLifetimeNotifications) return;
    _rommLifetimeReg = gs.RegisterForAppLifetimeNotifications((data: any) => {
      try {
        if (data?.bRunning) return;            // only care about stop events
        if (!_rommSessionActive) return;       // not our emulator session
        // Like the launch intercept, the notification may carry the 64-bit
        // gameID rather than the bare 32-bit appid — the appid is its high
        // dword. Check both representations.
        const raw = Number(data?.unAppID);
        const hi = Math.floor(raw / 4294967296);
        const candidates = hi > 0 ? [raw, hi] : [raw];
        let mine = candidates.some((a) => a === _rommAppId);
        if (!mine) { try { const ids = _rommAppIds(); mine = candidates.some((a) => ids.includes(a)); } catch { /* ignore */ } }
        if (!mine) { try { mine = candidates.some((a) => _isRommName(_appName(a))); } catch { /* ignore */ } }
        if (!mine) return;
        _rommSessionActive = false;
        if (_rommNavTimer != null) { try { clearTimeout(_rommNavTimer); } catch { /* ignore */ } }
        // Navigate back almost immediately. Steam runs its own post-exit
        // navigation to Big Picture home on its own schedule — a single early
        // Navigate can get stomped by it (that's why this used to wait 900ms).
        // Instead: go at 250ms, then for the next ~2s re-assert our route if
        // Steam moved it off. Steam's focus context also delivers NO focus
        // events for ~5.5s after an app exits (measured on-device); the
        // forced-focus + gpfocus mirror machinery bridges that gap.
        const nav = () => {
          _rommReturnFocusPending = true;
          try { Navigation.Navigate("/romm-sync-library"); Navigation.CloseSideMenus(); } catch (e) { console.error('[RomM] nav', e); }
        };
        _rommNavTimer = setTimeout(() => {
          _rommNavTimer = null;
          nav();
          [500, 1100, 1900].forEach((d) => setTimeout(() => {
            try {
              const p = (Router as any)?.WindowStore?.GamepadUIMainWindowInstance?.m_history?.location?.pathname;
              // Only reclaim the screen from STEAM's post-exit navigation. Any
              // /romm-sync-* route means the user is already navigating inside
              // the plugin (e.g. straight into Settings) — yanking them back to
              // the library here caused the "Settings opens then closes" bug.
              if (p && !p.startsWith("/romm-sync")) nav();
            } catch { /* ignore */ }
          }, d));
        }, 250);
      } catch (e) { console.error('[RomM] sessionEnd', e); }
    });
  } catch (e) { console.error('[RomM] registerRommSessionEndWatch', e); }
}

export default definePlugin(() => {
  // Every route is wrapped in RouteGuard: a page surfaced by a history POP the
  // plugin didn't initiate (Steam's own back walking into one of our entries,
  // fresh or stale) immediately pops again — see RouteGuard.
  routerHook.addRoute("/romm-sync-setup", () => <RouteGuard><SetupWizard /></RouteGuard>, { exact: true });
  routerHook.addRoute("/romm-sync-settings", () => <RouteGuard><SettingsPage /></RouteGuard>, { exact: true });
  routerHook.addRoute("/romm-sync-stats", () => <RouteGuard><StatsPage /></RouteGuard>, { exact: true });
  routerHook.addRoute("/romm-sync-cores", () => <RouteGuard><CoresPage /></RouteGuard>, { exact: true });
  routerHook.addRoute("/romm-sync-downloads", () => <RouteGuard><DownloadsPage /></RouteGuard>, { exact: true });
  routerHook.addRoute("/romm-sync-config", () => <RouteGuard><ConfigPage /></RouteGuard>, { exact: true });
  routerHook.addRoute("/romm-sync-library", () => <RouteGuard><LibraryRootPage /></RouteGuard>, { exact: true });
  routerHook.addRoute("/romm-sync-library/:key", () => <RouteGuard><LibraryGamesPage /></RouteGuard>, { exact: true });
  routerHook.addRoute("/romm-sync-game/:romId", () => <RouteGuard><GameDetailPage /></RouteGuard>, { exact: true });

  // Register the launch intercept IMMEDIATELY — independent of tile
  // reconciliation.  The intercept checks the appid/name at fire time, so it
  // is safe to bind before the shortcut store is ready.  This fixes the bug
  // where clicking the RomM tile in Big Picture did nothing until the user
  // opened the Decky panel (which triggered reconcileRommTile → register…).
  registerRommLaunchIntercept();
  registerRommSessionEndWatch();

  // OS-level connectivity bridge: the Decky frontend runs in a Chromium context,
  // so navigator's online/offline events fire the instant the Deck's network
  // drops or returns — far faster than the backend's 5-min retry probe. Forward
  // each edge to the backend (which treats 'offline' as authoritative and
  // re-probes the server on 'online'), then force an immediate status poll so
  // the banner/tiles flip without waiting for the next 1.5s tick.
  const onNetOffline = () => { notifyNetworkState(false).catch(() => { }).finally(() => refreshStatusNow()); };
  const onNetOnline = () => { notifyNetworkState(true).catch(() => { }).finally(() => refreshStatusNow()); };
  try {
    window.addEventListener('offline', onNetOffline);
    window.addEventListener('online', onNetOnline);
    // Push the CURRENT connectivity state on mount. The online/offline events
    // only fire on a TRANSITION, so a plugin that loads while the Deck is
    // already offline (e.g. wifi not connected to any network) would never
    // inform the backend — leaving _device_online at None and mislabeling the
    // outage as 'server_unreachable' instead of 'no_network'. Seed it here.
    notifyNetworkState(navigator.onLine).catch(() => { }).finally(() => refreshStatusNow());
  } catch (e) { console.error('[RomM] net listeners', e); }

  // Just self-updated? Reopen the home page — the reload dropped the user out of
  // our full-screen UI. NOTE: the install triggers TWO plugin reloads in quick
  // succession (Decky uninstall + reinstall), so we must NOT consume the flag on
  // read — the first reload would clear it and the second (final) reload would
  // never navigate. Instead we leave it set and re-attempt on every reload; the
  // library page clears it once it actually mounts (see LibraryGroupsPage). The
  // 90s freshness window keeps a stale flag from hijacking a later normal launch.
  try {
    const ts = Number(localStorage.getItem(_LS_REOPEN_HOME) || 0);
    if (ts) {
      if (Date.now() - ts < 90000) {
        // Don't reopen Home on a fixed timer — the backend was just re-imported
        // by the update and spends several seconds reconnecting + loading the
        // library. Mounting the grid during that window fetches covers against a
        // half-ready backend and they come back empty (and stick). Wait until the
        // backend reports the library is ready, then navigate — mirroring what a
        // manual reopen does. Poll up to ~30s, then go anyway as a fallback.
        (async () => {
          const deadline = Date.now() + 30000;
          while (Date.now() < deadline) {
            try {
              const s = await getServiceStatus();
              if (s?.status === 'connected' && s?.library_ready) break;
            } catch { /* backend not routing yet */ }
            await new Promise((r) => setTimeout(r, 1000));
          }
          try { Navigation.CloseSideMenus(); } catch { /* ignore */ }
          try { Navigation.Navigate("/romm-sync-library"); }
          catch (e) { console.error('[RomM] reopen home after update', e); }
          // Belt and braces: some Decky builds restore the QAM a beat later.
          setTimeout(() => { try { Navigation.CloseSideMenus(); } catch { /* ignore */ } }, 600);
        })();
      } else {
        // Stale flag from an old/abandoned update — drop it.
        localStorage.removeItem(_LS_REOPEN_HOME);
      }
    }
  } catch { /* ignore */ }

  // Passive update check on load: if enabled, look for a newer release on the
  // selected channel and toast the user (no auto-install — they install from
  // Settings ▸ Updates). The backend logs the outcome to debug.log.
  (async () => {
    try {
      if (!(await getCheckOnStartup())) return;
      const ch = await getUpdateChannel();
      const info = await checkForUpdate(ch);
      if (info?.success && info.available) {
        toaster.toast({
          title: `Update available: v${info.latest}`,
          body: '',
          duration: 6000,
        });
      }
    } catch (e) { console.error('[RomM] startup update check', e); }
  })();

  // Re-bind the launch intercept if the RomM tile was added in a prior session,
  // and auto-open the setup wizard once when no connection is configured.
  (async () => {
    let configured = false;
    try { configured = !!(await getConfig())?.configured; } catch { /* ignore */ }
    if (configured) {
      try {
        // The tile is mandatory: ensure it EXISTS (create if missing), not just
        // reconcile. The shortcut store may not be ready this early, so retry
        // with exponential backoff until it is.
        const MAX_ATTEMPTS = 8;
        const ensureTile = async (attempt: number) => {
          try {
            if ((await reconcileRommTile()) != null) return;   // found + repaired
            // Create only once the shortcut store is populated — an empty
            // store usually means "not loaded yet", and creating then
            // duplicates the tile. On the final attempt force-create so a
            // user with a genuinely empty shortcut list still gets the tile.
            if ((await addRommShortcut(attempt >= MAX_ATTEMPTS)) != null) return;
          } catch (e) { console.error('[RomM] ensure tile', e); }
          if (attempt < MAX_ATTEMPTS) {
            const delay = Math.min(4000 * Math.pow(1.5, attempt), 15000);
            setTimeout(() => { ensureTile(attempt + 1); }, delay);
          }
        };
        await ensureTile(0);
      } catch (e) { console.error('[RomM] shortcut ensure', e); }
    } else if (!_setupAutoOpened) {
      // No connection yet: auto-open the wizard once per session (the tile is
      // created on wizard finish). Never re-trap the user after setup.
      _setupAutoOpened = true;
      setTimeout(() => { try { Navigation.Navigate("/romm-sync-setup"); } catch (e) { console.error('[RomM] setup auto-open', e); } }, 1500);
    }
  })();

  return {
    name: "Ludo",
    titleView: <TitleView />,
    content: <Content />,
    icon: <FaSync />,
    onDismount: () => {
      console.log('[PLUGIN] onDismount - Stopping background monitoring');
      stopBackgroundMonitoring();
      try {
        window.removeEventListener('offline', onNetOffline);
        window.removeEventListener('online', onNetOnline);
      } catch { /* ignore */ }
      try { _rommActionReg?.unregister(); } catch { /* ignore */ }
      _rommActionReg = null;
      try { _rommLifetimeReg?.unregister(); } catch { /* ignore */ }
      _rommLifetimeReg = null;

      routerHook.removeRoute("/romm-sync-setup");
      routerHook.removeRoute("/romm-sync-settings");
      routerHook.removeRoute("/romm-sync-stats");
      routerHook.removeRoute("/romm-sync-cores");
      routerHook.removeRoute("/romm-sync-downloads");
      routerHook.removeRoute("/romm-sync-config");
      routerHook.removeRoute("/romm-sync-library");
      routerHook.removeRoute("/romm-sync-library/:key");
      routerHook.removeRoute("/romm-sync-game/:romId");
    },
  };
});