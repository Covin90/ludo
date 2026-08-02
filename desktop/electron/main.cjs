// Ludo — Electron desktop shell (Linux + Windows).
//
// Replaces the GTK3/WebKit2GTK shell (desktop/app.py). Same lifecycle: spawn the
// existing Python backend (backend/server.py) on a free localhost port at launch,
// load a BrowserWindow at it, and stop the backend cleanly on window close — no
// background daemon. See desktop/README.md for the architecture.
//
// Differences from app.py, on purpose:
//   • Gamepad input uses Chromium's native Gamepad API (see preload.js), not the
//     libmanette bridge — that native workaround existed only for a WebKitGTK
//     Bluetooth-pad bug that Chromium doesn't share.
//   • No __NV_DISABLE_EXPLICIT_SYNC: that's a WebKitGTK/NVIDIA-Wayland bug and
//     doesn't apply to Electron's Chromium renderer.

const { app, BrowserWindow, dialog, ipcMain, protocol, net: enet } = require("electron");
const { spawn } = require("child_process");
const net = require("net");
const path = require("path");
const fs = require("fs");
const { listNativePads } = require("./native-pads.cjs");
const { startNativeInput } = require("./native-input.cjs");

// The name Electron reports for itself — window titles it derives, the shell's
// window list, notifications. It comes from the packaged package.json, and
// electron-builder writes only `name` there ("ludo-desktop"); `productName`,
// which is what we'd want, stays behind in the source manifest as build config.
// So without this the app introduces itself as "ludo-desktop".
//
// setName also moves userData (~/.config/<name>), which is where Chromium keeps
// this app's cookies and localStorage — renaming it would silently strand every
// existing install's stored UI state. Pin the path to what it resolved to before
// the rename so only the display name changes.
const userDataPath = app.getPath("userData");
app.setName("Ludo");
app.setPath("userData", userDataPath);

// ── GPU / compositing (Linux) ────────────────────────────────────────────────
//
// Chromium (and so Steam Big Picture, which is CEF) performs badly on Linux when
// its GPU process fails to initialize: it either drops to the software
// rasterizer or renders through XWayland, where a hardcoded 60Hz vsync path
// stutters. On a Wayland session we ask Ozone to run NATIVELY on Wayland
// (`auto` = Wayland when in a Wayland session, X11 otherwise), which restores
// GPU compositing and proper frame pacing instead of the XWayland fallback.
// Opt out with ROMM_OZONE=0 (or force a backend, e.g. ROMM_OZONE=x11) if a
// specific driver misbehaves.
if (process.platform === "linux") {
  const ozone = process.env.ROMM_OZONE ?? "auto";
  if (ozone && !["0", "false", "no"].includes(ozone.toLowerCase())) {
    app.commandLine.appendSwitch("ozone-platform-hint", ozone);
    app.commandLine.appendSwitch("enable-features", "WaylandWindowDecorations");
  }

  // A desktop's shell doesn't take the window's icon from BrowserWindow's `icon`
  // on Wayland — it identifies the window by its app_id (WM_CLASS on X11), looks
  // up the .desktop entry that claims that id, and draws *that* entry's Icon.
  // Chromium derives the id from the executable name, which electron-builder
  // takes from package.json's `name` ("ludo-desktop"), while the entry it
  // generates advertises StartupWMClass from `productName` ("Ludo"). Nothing
  // claims "ludo-desktop", so GNOME finds no entry and falls back to a generic
  // icon in the dock and Alt-Tab — even though the entry in the app grid, which
  // is read straight off the file, looks correct.
  //
  // Pin the id to the name the entry already advertises rather than the other
  // way round: exported entries are copies sitting in users' home directories
  // that we can't retroactively edit, so the shipped binary has to match them.
  app.commandLine.appendSwitch("class", "Ludo");
}

// Chromium blocks audio until the document has been "activated" by a real
// click/keypress. The UI's navigation sounds are triggered by the CONTROLLER,
// which is injected programmatically and never counts as activation — so on a
// pad-only session the app would stay mute forever. This is a kiosk-style app
// the user launched deliberately, not a web page that might autoplay an ad.
app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");

// ── Stable app origin ────────────────────────────────────────────────────────
//
// The backend binds a random free port each launch, so loading it directly gives
// the page a different origin every time (http://127.0.0.1:<random>) — and
// localStorage/sessionStorage/IndexedDB are keyed by origin. Every launch
// therefore started with empty web storage, which silently defeated all the
// renderer's caches (the account-identity pill, platform icons, the browse
// lists): they wrote to a bucket nothing would ever read again.
//
// So the window loads `ludo://app/` instead, and this scheme proxies every
// request through to whatever port the backend actually got. The origin is now
// constant across launches, web storage persists, and the renderer needs no
// changes — its requests are all same-origin relative paths (/api/…).
const APP_SCHEME = "ludo";
const APP_ORIGIN = `${APP_SCHEME}://app`;
// Must be declared before `ready`. `standard` is what makes it a real origin
// (and makes relative URLs and history.pushState resolve); the rest let fetch,
// XHR and streamed media work as they do over http.
protocol.registerSchemesAsPrivileged([
  {
    scheme: APP_SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true },
  },
]);

// Point the scheme at the live backend. Called once the port is known.
function registerAppScheme(host, port) {
  protocol.handle(APP_SCHEME, async (request) => {
    const src = new URL(request.url);
    const target = `http://${host}:${port}${src.pathname}${src.search}`;
    // Forward only the headers the backend cares about. Passing the request's own
    // headers wholesale fails: they carry ludo:// values (Referer, Origin) that
    // Chromium's network stack rejects on an http request, and every subresource
    // came back ERR_FAILED.
    const headers = {};
    for (const name of ["accept", "accept-language", "content-type", "range", "cache-control"]) {
      const v = request.headers.get(name);
      if (v) headers[name] = v;
    }
    const init = { method: request.method, headers, redirect: "follow" };
    if (request.body) {
      init.body = request.body;
      // Required when a request body is a stream, which it always is here.
      init.duplex = "half";
    }
    try {
      return await enet.fetch(target, init);
    } catch (err) {
      // The backend died or hasn't finished binding. A 502 surfaces as a failed
      // fetch in the renderer (which already handles RPC failures) instead of a
      // silently hanging request.
      console.error(`[proxy] ${request.method} ${src.pathname} failed:`, err);
      return new Response("backend unavailable", { status: 502 });
    }
  });
}

const DESKTOP_DIR = path.resolve(__dirname, "..");

// Packaged builds carry their own interpreter and a mirror of the repo layout
// under resources/ (see tools/prepare-runtime.sh). From source we use the tree
// we are sitting in. Everything below branches on this one flag.
const PACKAGED = app.isPackaged;
const RES = process.resourcesPath || "";
const SRC_ROOT = PACKAGED ? path.join(RES, "app-src", "desktop") : DESKTOP_DIR;
const SERVER_PY = path.join(SRC_ROOT, "backend", "server.py");

// Window icon. This is separate from the AppImage's icon (build.linux.icon in
// package.json, which feeds the .desktop entry): the desktop entry is what most
// launchers read, but some Wayland/X11 setups take the icon from the window
// itself rather than matching StartupWMClass, and would otherwise fall back to
// Electron's stock logo. Both point at the same file — electron-builder copies
// it to resources/icon.png via extraResources.
const ICON = PACKAGED
  ? path.join(RES, "icon.png")
  : path.join(DESKTOP_DIR, "..", "assets", "icons", "romm_icon.png");

// The plugin UI is authored against the Deck's fixed 1280x800 gamepad viewport,
// where SteamOS scales the whole design to the screen. We reproduce that by
// zooming the page so the 800px design height fills the window height.
const DESIGN_HEIGHT = 800;
const MIN_ZOOM = 0.5;

let backend = null; // the Python child process
let win = null;
let stopNativeInput = null; // teardown for the kernel pad reader (native-input.cjs)

// ── Backend lifecycle ────────────────────────────────────────────────────────

// Grab an ephemeral port from the OS and hand it back (same approach as
// app.py._free_port). Tiny TOCTOU window, but on loopback with a random high
// port a collision is vanishingly unlikely and a failed bind is loud, not silent.
function freePort(host = "127.0.0.1") {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on("error", reject);
    srv.listen(0, host, () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

// Locate the Python interpreter. A packaged build must never fall back to the
// user's system Python: it would be missing the engine and the backend deps,
// and would fail confusingly at import time rather than here.
function pythonExe() {
  if (process.env.ROMM_PYTHON) return process.env.ROMM_PYTHON;

  if (PACKAGED) {
    const bundled = path.join(RES, "python", "bin", "python3");
    if (fs.existsSync(bundled)) return bundled;
    throw new Error(
      `Bundled Python runtime missing at ${bundled}. The build is incomplete; ` +
      `run desktop/tools/prepare-runtime.sh before packaging.`);
  }

  const venv = process.platform === "win32"
    ? path.join(DESKTOP_DIR, ".venv", "Scripts", "python.exe")
    : path.join(DESKTOP_DIR, ".venv", "bin", "python");
  if (fs.existsSync(venv)) return venv;
  return process.platform === "win32" ? "python" : "python3";
}

// Mirroring the backend's output is a convenience for terminal launches. When
// the app is started from a desktop entry or a file manager, stdout is a pipe
// with no reader: it closes, the write throws EPIPE, and an uncaught exception
// in the main process takes the whole app down. Logging is never worth
// crashing over, so failures here are swallowed.
function mirror(stream, text) {
  try { stream.write(text); } catch { /* no reader; drop it */ }
}

// write() can also surface EPIPE asynchronously, which bypasses the try/catch
// above and would reach the uncaught-exception handler.
for (const stream of [process.stdout, process.stderr]) {
  stream.on("error", (err) => {
    if (err && (err.code === "EPIPE" || err.code === "ERR_STREAM_DESTROYED")) return;
    console.error("stdio error:", err);
  });
}

// Start backend/server.py on `host:port` and resolve once it announces it's
// listening. server.serve() binds the socket only after the engine is ready, so
// the "[server] listening" line means the URL is loadable.
function startBackend(host, port) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, ROMM_HOST: host, ROMM_PORT: String(port) };
    const child = spawn(pythonExe(), [SERVER_PY], {
      env,
      // Line-buffered pipes so we can watch for the readiness banner.
      stdio: ["ignore", "pipe", "pipe"],
    });
    backend = child;

    let ready = false;
    const onData = (buf) => {
      const text = buf.toString();
      mirror(process.stdout, text); // engine logs, when anyone is listening
      if (!ready && text.includes("[server] listening")) {
        ready = true;
        resolve();
      }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", (b) => mirror(process.stderr, b.toString()));

    child.on("error", reject);
    child.on("exit", (code) => {
      backend = null;
      if (!ready) {
        reject(new Error(`backend exited before ready (code ${code})`));
      } else if (win) {
        // Engine died while the window is up — nothing to show; quit.
        app.quit();
      }
    });
  });
}

// Stop the backend the way app.py does on window close: cleanly, so the engine's
// _unload() runs. server.py's main() calls engine.stop() on KeyboardInterrupt /
// normal exit, so on POSIX we send SIGINT to trigger that path; Windows has no
// usable SIGINT-to-child, so we terminate and let the daemon threads die.
function stopBackend() {
  if (!backend) return;
  const child = backend;
  backend = null;
  try {
    child.kill(process.platform === "win32" ? undefined : "SIGINT");
  } catch { /* already gone */ }
  // Hard-stop if it doesn't exit promptly.
  setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, 3000).unref();
}

// ── Window ───────────────────────────────────────────────────────────────────

// Reproduce app.py._on_size_allocate: zoom so the 800px design height fills the
// actual content height, re-applied on every resize/(un)fullscreen/monitor move.
function applyZoom() {
  if (!win) return;
  const [, height] = win.getContentSize();
  const zoom = Math.max(MIN_ZOOM, height / DESIGN_HEIGHT);
  win.webContents.setZoomFactor(zoom);
}

function createWindow(url, fullscreen) {
  win = new BrowserWindow({
    width: 1280,
    height: 800,
    title: "Ludo",
    icon: ICON,
    backgroundColor: "#0b0e14",
    fullscreen,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      // The page and preload share one world so the gamepad poller can call the
      // window.__rommGamepad API the app installs. This is a local, first-party
      // bundle over loopback — no remote content — so it's a safe trade.
      contextIsolation: false,
      nodeIntegration: false,
      // setZoomFactor must not be clamped/undone by pinch or Ctrl+wheel.
      zoomFactor: 1,
    },
  });

  win.setMenuBarVisibility(false);

  // Keep zoom tracking the height. setZoomFactor only sticks once a document is
  // committed, so (re)apply on load and on every resize.
  win.webContents.on("did-finish-load", applyZoom);
  win.on("resize", applyZoom);
  win.on("enter-full-screen", applyZoom);
  win.on("leave-full-screen", applyZoom);

  // F11 toggles fullscreen — matching app.py._on_key. before-input-event fires
  // ahead of the renderer, so anything preventDefault'd here never reaches the
  // UI; Escape is the UI's back/cancel key, so the window must not claim it.
  win.webContents.on("before-input-event", (event, input) => {
    if (input.type !== "keyDown") return;
    if (input.key === "F11") {
      win.setFullScreen(!win.isFullScreen());
      event.preventDefault();
    }
  });

  // Kernel-level pad reading, for controllers Chromium refuses to expose to the
  // renderer (see native-input.cjs — a pad switched on after launch never reaches
  // navigator.getGamepads()). preload.cjs MERGES these with Chromium's own poll by
  // union instead of picking a winner, so a pad both paths can see still produces
  // a single press, and a pad only one path can see still works.
  //
  // Focus gating lives in the renderer, not here: preload.cjs already drops input
  // while the window is unfocused (a running game owns the pad) and, crucially,
  // releases everything it had held when focus goes — a button that happens to be
  // down at that moment would otherwise stay stuck down forever.
  stopNativeInput = startNativeInput({
    button(id, down, node) { sendPadEvent(win, "button", { id, down, node }); },
    direction(dir, node) { sendPadEvent(win, "direction", { dir, node }); },
    gone(node) { sendPadEvent(win, "gone", { node }); },
  });
  win.on("closed", () => {
    win = null;
    if (stopNativeInput) { stopNativeInput(); stopNativeInput = null; }
  });
  win.loadURL(url);
}

function sendPadEvent(target, kind, payload) {
  if (!target || target.isDestroyed()) return;
  try { target.webContents.send("romm:native-pad", kind, payload); }
  catch { /* renderer went away mid-send */ }
}

// ── Boot ─────────────────────────────────────────────────────────────────────

// ── Launcher entry upkeep ────────────────────────────────────────────────────

/** Refresh the exported .desktop entry this AppImage was launched from.
 *
 * AppImage managers (Gear Lever, AppImageLauncher, `--install` style scripts)
 * copy the image's internal .desktop into ~/.local/share/applications and
 * extract its icon alongside, both at install time. They never look at the file
 * again — but the in-app updater swaps the image underneath them, so the entry
 * keeps advertising the version and icon of whatever was installed originally.
 * Gear Lever's own config stores only the file path, so the .desktop is the one
 * place its version display comes from.
 *
 * Doing this at startup rather than in apply_appimage_update is deliberate: the
 * process applying an update is the OLD build, and would have to dig the new
 * version and icon out of a file it has not run yet. Here they are simply ours.
 *
 * Conservative by construction — it only rewrites entries that already point at
 * our own $APPIMAGE and were exported by a manager (they carry X-AppImage-*
 * keys), and only ever touches those keys. Every failure is silent: a launcher
 * showing a stale version is a blemish, not a reason to disturb a working start.
 */
function syncLauncherEntry() {
  try {
    const appImage = process.env.APPIMAGE;
    if (!appImage) return; // running from source, or an unpacked build

    const appsDir = path.join(app.getPath("home"), ".local", "share", "applications");
    if (!fs.existsSync(appsDir)) return;

    // Managers record the path they installed from, which can spell the same
    // file differently than the runtime reports it — /home vs /var/home on an
    // ostree system like this one. Compare resolved paths, not strings.
    const real = (p) => { try { return fs.realpathSync(p); } catch { return p; } };
    const target = real(appImage);
    const version = app.getVersion();

    for (const name of fs.readdirSync(appsDir)) {
      if (!name.endsWith(".desktop")) continue;
      const entryPath = path.join(appsDir, name);
      let text;
      try { text = fs.readFileSync(entryPath, "utf8"); } catch { continue; }

      // Must be a manager's export of *this* image. The X-AppImage-Version key
      // is what marks it as managed; without it this is somebody else's
      // launcher that merely mentions the path, and not ours to rewrite.
      if (!/^X-AppImage-Version=/m.test(text)) continue;
      const exec = text.match(/^(?:Exec|TryExec)=.*$/gm) || [];
      if (!exec.some((line) => line.includes(appImage) || line.includes(target))) continue;

      let out = text.replace(/^X-AppImage-Version=.*$/m, `X-AppImage-Version=${version}`);

      // The icon is a copy taken at install time, so a changed icon needs the
      // bytes replaced, not the path rewritten. Only overwrite a plain file the
      // entry points at absolutely: a bare name is a themed icon we don't own.
      const icon = (text.match(/^Icon=(.*)$/m) || [])[1];
      if (icon && path.isAbsolute(icon) && fs.existsSync(ICON)) {
        try {
          if (fs.statSync(icon).isFile()) fs.copyFileSync(ICON, icon);
        } catch { /* icon left as-is */ }
      }

      if (out !== text) {
        fs.writeFileSync(entryPath, out);
        console.log(`[launcher] refreshed ${name} to v${version}`);
      }
    }
  } catch (e) {
    console.log(`[launcher] entry refresh skipped: ${e.message}`);
  }
}

async function boot() {
  // Cheap, best-effort, and independent of everything below.
  syncLauncherEntry();

  const host = process.env.ROMM_HOST || "127.0.0.1";
  const port = process.env.ROMM_PORT
    ? parseInt(process.env.ROMM_PORT, 10)
    : await freePort(host);

  await startBackend(host, port);

  // Fullscreen by default (matches the Deck feel); ROMM_FULLSCREEN=0 for a normal
  // window. F11 toggles fullscreen at runtime.
  const fullscreen = !["0", "false", "no"].includes(
    (process.env.ROMM_FULLSCREEN || "1").toLowerCase()
  );

  // ROMM_URL lets a dev point at the Vite server (which proxies /api to the
  // backend on ROMM_PORT) — that's already a stable origin, so it skips the
  // proxy scheme. Default loads the backend-served built UI through ludo://,
  // for an origin that survives the port changing between launches.
  let url = process.env.ROMM_URL;
  if (!url) {
    registerAppScheme(host, port);
    url = `${APP_ORIGIN}/`;
  }
  createWindow(url, fullscreen);
}

// Single instance: a second launch focuses the existing window rather than
// spawning a rival backend.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  // Renderer's Exit row (desktop-only UserMenu item) asks the shell to quit.
  ipcMain.on("romm:quit", () => app.quit());

  // Restart after a self-update. The AppImage on disk has already been
  // swapped, so relaunching picks up the new build. app.relaunch() re-execs
  // $APPIMAGE rather than the mounted binary, whose mountpoint disappears the
  // moment we exit.
  ipcMain.on("romm:restart", () => {
    const appImage = process.env.APPIMAGE;
    console.log(`[restart] APPIMAGE=${appImage || "(unset)"}`);

    if (appImage) {
      // app.relaunch() is unreliable here: it re-execs as this process exits,
      // which is exactly when the AppImage's FUSE mount is being torn down —
      // the new process can end up pointing at a mountpoint that is going
      // away. Spawning a fully detached child first, and only then exiting,
      // keeps the two lifetimes independent. The child mounts its own copy.
      try {
        stopBackend();
        const child = spawn(appImage, [], {
          detached: true,
          stdio: "ignore",
          env: { ...process.env },
        });
        child.unref();
        console.log(`[restart] spawned replacement pid=${child.pid}`);
        // Give the child a moment to exec before this process (and its mount)
        // goes away.
        setTimeout(() => app.exit(0), 500);
        return;
      } catch (err) {
        console.error("[restart] detached spawn failed, falling back:", err);
      }
    }

    app.relaunch();
    app.quit();
  });

  // The OS file chooser. The renderer has an in-app picker as a fallback (the
  // GTK shell has no Electron IPC and a browser can't enumerate the FS), but
  // when we're running under Electron the real GTK dialog is better in every
  // way: bookmarks, typed paths, hidden files, mounted drives.
  ipcMain.handle("romm:pick-folder", async (_e, opts) => {
    const o = opts || {};
    try {
      const res = await dialog.showOpenDialog(BrowserWindow.getFocusedWindow(), {
        title: o.title || "Choose a folder",
        defaultPath: o.startPath || app.getPath("home"),
        buttonLabel: "Select",
        // showHiddenFiles: RetroArch and RetroDECK keep saves and BIOS under
        // dotted directories, so hiding them would hide the useful answers.
        properties: [
          o.includeFiles ? "openFile" : "openDirectory",
          "createDirectory",
          "showHiddenFiles",
        ],
      });
      if (res.canceled || !res.filePaths.length) return null;
      return res.filePaths[0];
    } catch (err) {
      console.error("[pick-folder]", err);
      return null;
    }
  });

  // Physically-attached gamepads, which the renderer can't discover itself
  // (Chromium hides pads until one is pressed). Synchronous: it's a handful of
  // small sysfs reads and the renderer needs it during startup. Returns null on
  // platforms that can't answer — "unknown", never "no pad".
  ipcMain.on("romm:list-pads", (e) => {
    try { e.returnValue = listNativePads(); }
    catch { e.returnValue = null; }
  });

  // How to relaunch this shell, for the backend's Steam shortcut writer. Only
  // the main process knows how it was started, and the three cases launch
  // differently:
  //   • AppImage      — $APPIMAGE is the single file to run.
  //   • packaged app  — process.execPath IS the app binary, no args.
  //   • dev checkout  — execPath is the electron binary and the app dir must be
  //                     passed as an argument (same as electron/launch.cjs).
  // Steam stores Exe quoted when it contains spaces, and derives the artwork
  // appid from exe+name, so the quoting here has to match what Steam expects.
  ipcMain.on("romm:launch-spec", (e) => {
    try {
      const quote = (p) => (/\s/.test(p) ? `"${p}"` : p);
      const appImage = process.env.APPIMAGE;
      if (appImage) {
        e.returnValue = { exe: quote(appImage), startDir: path.dirname(appImage), args: "" };
      } else if (app.isPackaged) {
        e.returnValue = { exe: quote(process.execPath), startDir: path.dirname(process.execPath), args: "" };
      } else {
        const appDir = path.resolve(__dirname, "..");
        e.returnValue = { exe: quote(process.execPath), startDir: appDir, args: quote(appDir) };
      }
    } catch { e.returnValue = null; }
  });

  app.on("second-instance", () => {
    if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
  });

  app.whenReady().then(boot).catch((err) => {
    console.error("[electron] failed to start:", err);
    app.quit();
  });

  app.on("window-all-closed", () => {
    stopBackend();
    app.quit();
  });

  // Ensure the backend is reaped even on unusual exit paths.
  app.on("before-quit", stopBackend);
  process.on("exit", stopBackend);
}
