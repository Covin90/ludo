#!/usr/bin/env bash
# Confirm a published release is actually reachable by the in-app updater.
#
# CI runs the same check (release.yml's verify-updater job), but this is the
# version you can run by hand — after a manual publish, after deleting a bad
# release, or when a user reports "no update available" and you need to know
# whether the release or the client is at fault.
#
# Usage: scripts/verify-release.sh [version]   (default: desktop/package.json)
set -euo pipefail

ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT"

VERSION="${1:-$(node -p "require('./desktop/package.json').version")}"
VERSION="${VERSION#v}"

# Import the shipping module rather than reimplementing its selection rules,
# so this tests the code users actually run.
VERSION="$VERSION" python3 - <<'PY'
import os, sys, logging
logging.basicConfig(level=logging.WARNING)
sys.path.insert(0, 'decky_plugin')
import main

version = os.environ['VERSION']
channel = 'beta' if '-' in version else 'stable'
print(f'checking v{version} on the {channel} channel\n')

failures = []
for suffix in ('-decky.zip', '-x86_64.AppImage'):
    rel = main.select_release(channel, suffix)
    if not rel:
        failures.append(f'{suffix}: updater resolves no release at all')
        print(f'FAIL {suffix}: no release carries this asset')
        continue
    asset = main._release_asset(rel, suffix)
    tag = rel['tag_name'].lstrip('v')
    status = 'OK  ' if tag == version else 'FAIL'
    print(f'{status} {suffix} -> v{tag} / {asset["name"]} '
          f'({asset.get("size", 0) / 1e6:.1f} MB)')
    if tag != version:
        # Resolving an older tag means this release is not the semver max, or
        # it is missing the asset — either way the updater will never offer it.
        failures.append(f'{suffix}: resolved v{tag}, expected v{version}')

if failures:
    raise SystemExit('\n' + '\n'.join(failures))
print('\nboth front-ends can see this release')
PY
