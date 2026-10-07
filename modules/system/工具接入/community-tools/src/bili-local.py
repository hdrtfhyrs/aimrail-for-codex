"""Local read-only entry for bilibili-cli; never extracts browser cookies."""
import pathlib as _public_pathlib
import importlib.util as _public_importutil
_public_root = next(p for p in _public_pathlib.Path(__file__).resolve().parents if (p/'public_paths.py').is_file())
_public_spec = _public_importutil.spec_from_file_location('ai_work_public_paths', _public_root/'public_paths.py')
_public_module = _public_importutil.module_from_spec(_public_spec)
_public_spec.loader.exec_module(_public_module)
_public_path = _public_module.public_path
from pathlib import Path
import sys

allowed = {
    "video", "user", "user-videos", "search", "hot", "rank", "status", "whoami",
    "favorites", "following", "history", "watch-later", "feed", "my-dynamics",
    "--help", "-h", "--version",
}
args = sys.argv[1:]
manual_login = args == ["login"] and sys.stdin.isatty() and sys.stdout.isatty()
if args and args[0] not in allowed and not manual_login:
    raise SystemExit("Read commands only. For QR login, run the documented login command yourself in an interactive local terminal.")

import bili_cli.auth as auth

auth.CONFIG_DIR = Path(__file__).resolve().parent / "state" / "bilibili"
auth.CREDENTIAL_FILE = auth.CONFIG_DIR / "credential.json"
auth._extract_browser_credential = lambda: None

from bili_cli.cli import cli
cli(args=args, prog_name="bili")
