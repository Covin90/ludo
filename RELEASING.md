# Releasing Ludo

One release carries **two** artifacts, built from the same tag:

| Front-end | Asset | Consumed by |
|---|---|---|
| Decky plugin | `Ludo-v<version>-decky.zip` | Decky Loader's `install_plugin` |
| Desktop | `Ludo-v<version>-x86_64.AppImage` | `apply_appimage_update` in `decky_plugin/main.py` |

**The two are never released separately, and never at different versions.** There
is no such thing as an AppImage-only or Decky-only release, and no such thing as
"desktop is on 1.0.1 while Decky is on 1.0.0". They are one product built from
one tag: both front-ends run the same `main.py` and the same `sync_core.py`, so a
version number identifies one set of shared code. A fix that only visibly affects
one front-end still ships to both.

This is enforced, not just agreed:

* `scripts/release.sh` bumps both `package.json` files in a single commit — there
  is no supported way to bump one.
* CI fails the build if either version disagrees with the tag.
* CI refuses to publish unless **both** assets built and are over 1 MB.
* Even if a half-release were published, `select_release` skips releases missing
  the asset a client wants — and because it picks the semver *maximum*, that
  release would also outrank the last complete one, leaving the other front-end
  permanently on "no update available".

---

## The short version

```bash
scripts/release.sh --check          # pre-flight, changes nothing
scripts/release.sh 1.0.0-beta.8     # bump both package.json, commit, tag, push
gh run watch $(gh run list --workflow=release.yml --limit 1 --json databaseId -q '.[0].databaseId')
scripts/verify-release.sh 1.0.0-beta.8
```

Everything after the tag push is CI ([release.yml](.github/workflows/release.yml)):
it builds both artifacts, refuses to publish unless both exist and are over 1 MB,
marks any `-beta.N` version as a prerelease, and then re-imports the real
`select_release` to prove the published release is reachable by the updater.

---

## The four rules that actually matter

**1. The tag is the source of truth, and both `package.json` files must agree.**
`decky_plugin/package.json` and `desktop/package.json` are separate files with
independent version fields; the desktop backend reads its own
(`desktop/backend/server.py`), the plugin reads the plugin's. CI fails the build
if either disagrees with the tag. `scripts/release.sh` bumps both together so
they cannot drift.

**2. Versions must only ever go up — the updater picks the semver *maximum*, not
the newest by date.** `select_release` explicitly sorts by parsed semver because
GitHub's release order is roughly lexicographic. Publishing a version that does
not exceed the highest already-published one produces a release nobody is ever
offered. The release script refuses to do this. (This is also why the repo still
has old local `v1.7.0-beta.*` tags with no GitHub releases behind them — they are
inert precisely because no release carries them. Never publish a release for one.)

**3. Never re-tag or re-upload over a published version.** Users who already
updated are on the old bits with the new version number, and they will never be
offered a fix at that version. Roll forward with a new patch/beta instead.

**4. Prerelease flag is the channel.** Stable users get the newest
non-prerelease release; beta users get the newest of either. CI derives the flag
from the version string (a `-` means prerelease), so this only breaks if a
release is published by hand.

---

## AppImage-specific concerns

The AppImage updater path is `download_update` → `apply_appimage_update` →
`romm:restart` (in [electron/main.cjs](desktop/electron/main.cjs)). Things worth
knowing when changing anything near it:

* **`artifactName` in `desktop/package.json` is a contract.** The updater matches
  the asset by the `-x86_64.AppImage` suffix (`DESKTOP_SUFFIX` in the workflow).
  Renaming the artifact without changing both makes every future release
  invisible to existing installs — which cannot be fixed by a later release,
  since old clients look for the old name.
* **The update is a `rename` over the running file, not a write into it.** So
  the image must live somewhere the user can write. `apply_appimage_update`
  reports this rather than failing obscurely, but it is why the recommended
  install location is `~/Applications`.
* **The runtime is downloaded at build time.** `tools/prepare-runtime.sh` pins a
  python-build-standalone release and installs the engine into it. Bumping that
  pin changes the interpreter every user gets on their next update — treat it as
  a release-worthy change, not a build detail.
* **Size is the cheap smoke test.** A healthy image is ~170 MB; CI's >1 MB floor
  only catches catastrophic failures. If an image comes out dramatically smaller,
  the runtime almost certainly failed to bundle.

---

## Before tagging

Blocking:

* `cd desktop && npm run typecheck`
* `scripts/release.sh --check` — clean tree, in sync with the remote, `gh`
  authenticated.

Worth doing for anything touching sync, launching, or the updater — there is no
test suite, so this is the real safety net:

* `cd desktop && npm run dist`, then run `desktop/release/Ludo-v*.AppImage` and
  exercise the changed path.
* To test the update path end to end, publish a beta, install the *previous*
  beta into `~/Applications`, and let the in-app updater pull the new one. This
  is the only way to exercise rename-over-running-file, the ELF check, and the
  detached-respawn restart together.

---

## When something goes wrong

**CI failed after the tag was pushed.** The tag exists but nothing was published,
so no user is affected. Fix, then delete the tag locally and remotely
(`git tag -d v… && git push origin :refs/tags/v…`) and re-run the script with
the same version — it was never published, so reusing it is safe.

**A bad release was published.** Delete the GitHub release *and* its tag
(`gh release delete v… --cleanup-tag`). Deleting the release is what matters:
`select_release` only ever sees published releases, so removing it makes the
previous one the max again, and clients silently fall back. Then roll forward.

**A user reports "no update available".** Run
`scripts/verify-release.sh <version>`. It resolves both assets through the
shipping `select_release`, so it distinguishes "the release is unreachable" from
"this client is already current".
