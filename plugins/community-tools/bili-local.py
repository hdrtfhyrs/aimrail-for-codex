"""Local read-only entry for bilibili-cli; never extracts browser cookies."""
from pathlib import Path
import sys
import os

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

auth.CONFIG_DIR = Path(os.environ.get("COMMUNITY_TOOLS_STATE_DIR", str(Path(os.environ.get("AI_WORK_HOME", str(Path(__file__).resolve().parents[2] / "workspace"))) / "community-tools"))) / "bilibili"
auth.CREDENTIAL_FILE = auth.CONFIG_DIR / "credential.json"
auth._extract_browser_credential = lambda: None

from bili_cli.cli import cli
cli(args=args, prog_name="bili")
