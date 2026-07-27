#!/usr/bin/env bash
# Assemble everything the packaged desktop app needs at runtime.
#
# The AppImage has no venv and no source tree, so the Python side has to ship
# with it: a standalone interpreter, the engine, and the backend's deps. This
# script builds two directories that electron-builder copies into resources/:
#
#   runtime/python/   a relocatable CPython with all deps installed
#   runtime/app-src/  a mirror of the repo layout the backend expects
#
# The mirror matters: backend/server.py resolves REPO_ROOT as parents[2] and
# reads decky_plugin/ next to desktop/. Reproducing that shape keeps the
# packaged and source layouts identical, so there is no packaged-only path
# branch in the Python to get wrong.
#
# Idempotent: re-running reuses the downloaded interpreter unless FORCE=1.
set -euo pipefail

DESKTOP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_ROOT="$(cd "$DESKTOP_DIR/.." && pwd)"
RUNTIME="$DESKTOP_DIR/runtime"
PY_DIR="$RUNTIME/python"
SRC_DIR="$RUNTIME/app-src"

# Pinned so a build is reproducible; 3.11 matches the Deck's cpython-311.
PBS_TAG="20260718"
PBS_VER="3.11.15"
PBS_FILE="cpython-${PBS_VER}+${PBS_TAG}-x86_64-unknown-linux-gnu-install_only_stripped.tar.gz"
PBS_URL="https://github.com/astral-sh/python-build-standalone/releases/download/${PBS_TAG}/${PBS_FILE//+/%2B}"

echo "==> Preparing runtime in $RUNTIME"
mkdir -p "$RUNTIME"

# ── 1. Standalone interpreter ────────────────────────────────────────────────
if [ "${FORCE:-0}" = "1" ]; then rm -rf "$PY_DIR"; fi
if [ ! -x "$PY_DIR/bin/python3" ]; then
    echo "==> Fetching CPython ${PBS_VER}"
    rm -rf "$PY_DIR" "$RUNTIME/_dl"
    mkdir -p "$RUNTIME/_dl"
    curl -fsSL "$PBS_URL" -o "$RUNTIME/_dl/python.tar.gz"
    tar -xzf "$RUNTIME/_dl/python.tar.gz" -C "$RUNTIME/_dl"
    mv "$RUNTIME/_dl/python" "$PY_DIR"
    rm -rf "$RUNTIME/_dl"
else
    echo "==> Reusing existing interpreter ($("$PY_DIR/bin/python3" -V))"
fi

PY="$PY_DIR/bin/python3"

# ── 2. Dependencies + the shared engine ──────────────────────────────────────
# --no-compile keeps .pyc out of the image; the AppImage is read-only at run
# time anyway, so precompiled bytecode would only inflate the download.
echo "==> Installing backend dependencies"
"$PY" -m pip install --quiet --upgrade pip
"$PY" -m pip install --quiet --no-compile -r "$DESKTOP_DIR/backend/requirements.txt"

echo "==> Installing romm-sync-engine (non-editable: the AppImage must be self-contained)"
"$PY" -m pip install --quiet --no-compile "$REPO_ROOT/engine"

# ── 2b. Trim the interpreter ─────────────────────────────────────────────────
# A standalone CPython ships a full development install. The app only ever
# runs already-written code, so the build-time and interactive parts are dead
# weight in a file every user has to download on every update.
#
# Deliberately kept: Cryptodome and backports (py7zr), cryptography (settings
# encryption), PIL (cover art).
echo "==> Trimming interpreter"
PYLIB="$PY_DIR/lib/python3.11"
SP="$PYLIB/site-packages"

# Packaging tooling: only needed to build this runtime, never to run it.
rm -rf "$SP/pip" "$SP/pip-"*.dist-info "$SP/setuptools" "$SP/setuptools-"*.dist-info \
       "$SP/pkg_resources" "$SP/_distutils_hack" "$PYLIB/ensurepip"
# setuptools leaves a .pth that imports _distutils_hack at every interpreter
# start; without the module it prints a traceback on each launch.
rm -f "$SP/distutils-precedence.pth"

# Interactive / development stdlib the backend never imports.
rm -rf "$PYLIB/idlelib" "$PYLIB/tkinter" "$PYLIB/turtledemo" "$PYLIB/pydoc_data" \
       "$PYLIB/lib2to3" "$PYLIB/test" "$PYLIB/distutils" "$PY_DIR/include" \
       "$PY_DIR/share/man" "$PY_DIR/share/terminfo"

# Test suites vendored inside dependencies.
find "$SP" -type d \( -name tests -o -name test -o -name testing \) -prune -exec rm -rf {} + 2>/dev/null || true

# Bytecode caches: --no-compile covers what pip installs, but the interpreter
# tarball ships its own, and the AppImage is read-only so they never get reused
# from a writable location anyway.
find "$PY_DIR" -name '__pycache__' -type d -prune -exec rm -rf {} + 2>/dev/null || true
find "$PY_DIR" -name '*.pyc' -delete 2>/dev/null || true

# Static library, only useful for compiling C extensions against this build.
find "$PY_DIR" -name 'libpython*.a' -delete 2>/dev/null || true

echo "    trimmed to $(du -sh "$PY_DIR" | cut -f1)"

# ── 3. Source mirror ─────────────────────────────────────────────────────────
echo "==> Staging application sources"
rm -rf "$SRC_DIR"
mkdir -p "$SRC_DIR/desktop/backend" "$SRC_DIR/decky_plugin"

cp "$DESKTOP_DIR/backend/server.py"   "$SRC_DIR/desktop/backend/"
cp "$DESKTOP_DIR/package.json"        "$SRC_DIR/desktop/"

# The window loads from the backend's HTTP server, not from a file:// URL, so
# the built UI has to sit next to server.py where STATIC_ROOT points — not
# inside the asar, which Python cannot read.
if [ ! -f "$DESKTOP_DIR/dist/index.html" ]; then
    echo "❌ desktop/dist/index.html missing — run 'npm run build' first"
    exit 1
fi
cp -r "$DESKTOP_DIR/dist" "$SRC_DIR/desktop/dist"

# The plugin supplies the Plugin class the backend drives. py_modules is
# deliberately NOT copied: those are Deck-only cpython-311 binary builds that
# would shadow the interpreter's own working copies.
cp "$REPO_ROOT/decky_plugin/main.py"      "$SRC_DIR/decky_plugin/"
cp "$REPO_ROOT/decky_plugin/package.json" "$SRC_DIR/decky_plugin/"
cp "$REPO_ROOT/decky_plugin/plugin.json"  "$SRC_DIR/decky_plugin/"
cp -r "$REPO_ROOT/decky_plugin/assets"    "$SRC_DIR/decky_plugin/"

# ── 4. Verify before packaging ───────────────────────────────────────────────
# Import the backend exactly as the packaged app will, so a missing dependency
# fails here rather than in a shipped AppImage.
echo "==> Verifying bundled runtime"
( cd "$SRC_DIR/desktop/backend" && PYTHONDONTWRITEBYTECODE=1 "$PY" -c "
import sys
sys.path.insert(0, '.')
import server
from romm_sync_engine import paths
assert server.plugin_module.asset_suffix() == '-x86_64.AppImage', 'wrong update asset'
print('    backend imports OK, suffix =', server.plugin_module.asset_suffix())
print('    engine  =', paths.__file__)
" )

# Importing during verification recreates caches the trim removed, so sweep
# once more now that nothing else will run the interpreter.
find "$PY_DIR" -name '__pycache__' -type d -prune -exec rm -rf {} + 2>/dev/null || true
find "$PY_DIR" -name '*.pyc' -delete 2>/dev/null || true

[ -f "$SRC_DIR/desktop/dist/index.html" ] || { echo "❌ staged UI missing"; exit 1; }
echo "    UI      = $(du -sh "$SRC_DIR/desktop/dist" | cut -f1) staged"

du -sh "$PY_DIR" "$SRC_DIR" 2>/dev/null | sed 's/^/    /'
echo "==> Runtime ready"
