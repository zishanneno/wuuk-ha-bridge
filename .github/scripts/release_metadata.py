"""Check that the Git tag, Supervisor version, and GHCR image agree."""
import json
import os
from pathlib import Path
import re


root = Path(__file__).resolve().parents[2]
app = root / "wuuk_bridge"
tag = os.environ.get("GITHUB_REF_NAME", "")
repository = os.environ.get("GITHUB_REPOSITORY", "").lower()
if not re.fullmatch(r"v(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)", tag):
    raise SystemExit("Release tag must be vMAJOR.MINOR.PATCH")
if not re.fullmatch(r"[a-z0-9-]+/[a-z0-9_.-]+", repository):
    raise SystemExit("Missing or invalid GitHub repository")

config = (app / "config.yaml").read_text()
package = json.loads((app / "package.json").read_text())
lock = json.loads((app / "package-lock.json").read_text())
version = tag[1:]
image = f"ghcr.io/{repository}"

for key, value in (("version", version), ("image", image)):
    actual = re.findall(rf"^{key}:[ \t]*(.*)$", config, re.MULTILINE)
    if [line.strip() for line in actual] != [f'"{value}"']:
        raise SystemExit(f'App config must contain {key}: "{value}"')
if any(value != version for value in (package.get("version"), lock.get("version"),
                                      lock.get("packages", {}).get("", {}).get("version"))):
    raise SystemExit(f"Package and lockfile versions must match {version}")

with open(os.environ["GITHUB_OUTPUT"], "a") as output:
    print(f"image={image}", file=output)
    print(f"version={version}", file=output)
