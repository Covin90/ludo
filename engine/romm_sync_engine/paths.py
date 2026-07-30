"""Per-application filesystem locations.

The engine is shared by more than one frontend, and each one owns its own
state directory: the GTK app keeps ``~/.config/romm-retroarch-sync`` while
Ludo uses ``~/.config/ludo``. Nothing is shared between them.

Frontends call :func:`set_app_id` once, before touching anything else in the
engine. The default keeps the GTK app working without any changes on its side.
"""

from pathlib import Path

DEFAULT_APP_ID = "romm-retroarch-sync"
DEFAULT_CLIENT_NAME = "RomM-RetroArch-Sync"
# The GTK app's library folder, and the name every build used before Ludo
# existed. Kept as the default so the GTK side needs no change.
DEFAULT_LIBRARY_DIR_NAME = "RomMSync"

_app_id = DEFAULT_APP_ID
_client_name = DEFAULT_CLIENT_NAME
_library_dir_name = DEFAULT_LIBRARY_DIR_NAME
_locked = False


def set_app_id(app_id: str) -> None:
    """Point the engine at ``~/.config/<app_id>``.

    Must be called before the first :func:`config_dir` call. Calling it after
    the fact means some state has already been read from or written to the
    wrong directory, so that raises rather than silently splitting an app's
    files across two locations.
    """
    global _app_id
    if not app_id or "/" in app_id:
        raise ValueError(f"invalid app id: {app_id!r}")
    if _locked and app_id != _app_id:
        raise RuntimeError(
            f"set_app_id({app_id!r}) called after paths were already resolved "
            f"as {_app_id!r}; move the call earlier in startup"
        )
    _app_id = app_id


def app_id() -> str:
    return _app_id


def set_client_name(name: str) -> None:
    """Set how this app identifies itself to the RomM server.

    Sent as the ``client`` field when registering a device and as the
    User-Agent, so RomM shows each frontend as a distinct client.
    """
    global _client_name
    _client_name = name


def client_name() -> str:
    return _client_name


def set_library_dir_name(name: str) -> None:
    """Name of the home-directory folder holding downloads, covers and icons.

    Ludo calls this with "Ludo"; the GTK app leaves it alone and keeps
    ``~/RomMSync``.
    """
    global _library_dir_name
    if not name or "/" in name:
        raise ValueError(f"invalid library dir name: {name!r}")
    _library_dir_name = name


def library_dir() -> Path:
    """Default home for downloaded ROMs, covers and generated icons.

    An existing ``~/RomMSync`` wins over this app's own name: renaming the app
    must not strand a library that is already on disk. Only a user with no
    legacy folder gets ``~/<name>``, so the change is invisible to everyone
    who has been using either app.

    Not created here — callers that write make their own subdirectory, and a
    folder conjured up just by asking the question would defeat the check above.
    """
    legacy = Path.home() / DEFAULT_LIBRARY_DIR_NAME
    if _library_dir_name != DEFAULT_LIBRARY_DIR_NAME and legacy.is_dir():
        return legacy
    return Path.home() / _library_dir_name


def config_dir() -> Path:
    """The app's state directory. Created on first use."""
    global _locked
    _locked = True
    d = Path.home() / ".config" / _app_id
    d.mkdir(parents=True, exist_ok=True)
    return d


def cache_dir() -> Path:
    return config_dir() / "cache"
