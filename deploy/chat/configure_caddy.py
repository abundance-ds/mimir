#!/usr/bin/env python3
"""Upgrade an existing Mimir Chat Caddy block to files and administration."""

from __future__ import annotations

import argparse
from pathlib import Path


BEFORE = """\
\thandle_path /webirc {
\t\treverse_proxy 127.0.0.1:8067
\t}

\trespond "Mimir Chat" 200
"""

WITH_FILES = """\
\thandle_path /webirc {
\t\treverse_proxy 127.0.0.1:8067
\t}

\thandle /files* {
\t\treverse_proxy 127.0.0.1:8069
\t}

\trespond "Mimir Chat" 200
"""

WITH_ADMIN = """\
\thandle_path /webirc {
\t\treverse_proxy 127.0.0.1:8067
\t}

\thandle /files* {
\t\treverse_proxy 127.0.0.1:8069
\t}

\tredir /admin /admin/ 308

\thandle_path /admin/* {
\t\treverse_proxy 127.0.0.1:8070
\t}

\trespond "Mimir Chat" 200
"""


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    text = args.source.read_text(encoding="utf-8")
    if text.count(WITH_ADMIN) == 1:
        args.output.write_text(text, encoding="utf-8")
        return
    if text.count(WITH_FILES) == 1:
        args.output.write_text(text.replace(WITH_FILES, WITH_ADMIN, 1), encoding="utf-8")
        return
    if text.count(BEFORE) == 1:
        args.output.write_text(text.replace(BEFORE, WITH_ADMIN, 1), encoding="utf-8")
        return
    raise SystemExit("expected exactly one supported Mimir Chat Caddy block")


if __name__ == "__main__":
    main()
