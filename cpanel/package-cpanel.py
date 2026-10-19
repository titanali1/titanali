#!/usr/bin/env python3
"""Create a minimal, secret-free XsayaTrade deployment archive for cPanel Node.js apps."""
from __future__ import annotations

import argparse
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile

ROOT = Path(__file__).resolve().parent.parent
FILES = [
    "package.json", "package-lock.json", "server.js", "index.html",
    "styles.css", "exchange.css", "extra.css", "backend-ui.css", "i18n.css",
    "i18n.js", "app.js", "manifest.webmanifest", "icon.svg", "sw.js",
    "xsayatrade-logo.png", "xsayatrade-logo.svg", "xsayatrade-logo-192.png",
    "xsayatrade-logo-512.png", ".env.example",
]
DOCS = [
    ("cpanel/README-fa.md", "CPANEL-INSTALL-FA.md"),
    ("cpanel/cpanel-env.example", "cpanel-env.example"),
]


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=ROOT / "xsayatrade-cpanel.zip")
    args = parser.parse_args()
    output = args.output if args.output.is_absolute() else ROOT / args.output
    output.parent.mkdir(parents=True, exist_ok=True)
    missing = [str(ROOT / name) for name in FILES if not (ROOT / name).is_file()]
    missing += [str(ROOT / source) for source, _ in DOCS if not (ROOT / source).is_file()]
    if missing:
        parser.error("missing deployment files: " + ", ".join(missing))

    output_resolved = output.resolve()
    with ZipFile(output_resolved, "w", compression=ZIP_DEFLATED, compresslevel=8) as archive:
        for name in FILES:
            archive.write(ROOT / name, arcname=name)
        for source, target in DOCS:
            archive.write(ROOT / source, arcname=target)
    print(f"Created {output_resolved} ({output_resolved.stat().st_size:,} bytes)")
    print("Archive contains source and placeholders only; no .env, .git, Android build, or data vault.")


if __name__ == "__main__":
    main()
