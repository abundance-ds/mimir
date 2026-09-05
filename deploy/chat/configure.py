#!/usr/bin/env python3
"""Generate Mimir's pinned Ergo configuration from Ergo's default config.

The release default remains the compatibility baseline. Every replacement is
counted so an upstream layout change fails closed instead of silently producing
an unsafe or partially configured server.
"""

from __future__ import annotations

import argparse
import os
import re
from pathlib import Path


def replace_once(text: str, pattern: str, replacement: str, label: str) -> str:
    updated, count = re.subn(pattern, replacement, text, count=1, flags=re.MULTILINE | re.DOTALL)
    if count != 1:
        raise SystemExit(f"could not apply {label}: expected one match, found {count}")
    return updated


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument(
        "--bootstrap-local-only",
        action="store_true",
        help="Temporarily expose only plaintext loopback and exempt localhost for first-account bootstrap",
    )
    args = parser.parse_args()

    oper_hash = os.environ.get("MIMIR_CHAT_OPER_HASH", "").strip()
    if not oper_hash.startswith("$2"):
        raise SystemExit("MIMIR_CHAT_OPER_HASH must contain an Ergo bcrypt password hash")
    admin_oper_hash = os.environ.get("MIMIR_CHAT_ADMIN_OPER_HASH", "").strip()
    if not admin_oper_hash.startswith("$2"):
        raise SystemExit(
            "MIMIR_CHAT_ADMIN_OPER_HASH must contain an Ergo bcrypt password hash",
        )

    text = args.source.read_text(encoding="utf-8")
    text = replace_once(text, r"(?m)^    name: ErgoTest$", "    name: Abundance Decision Systems", "network name")
    text = replace_once(text, r"(?m)^    name: ergo\.test$", "    name: chat.abundanceds.com", "server name")
    text = replace_once(
        text,
        r"(?ms)^    # addresses to listen on\n    listeners:\n.*?^    # sets the permissions for Unix listen sockets\.",
        """    # Only loopback listeners are exposed. Caddy owns the public TLS edge.
    listeners:
        "127.0.0.1:16667":
        "127.0.0.1:8067":
            websocket: true

    # sets the permissions for Unix listen sockets.""",
        "loopback listeners",
    )
    text = replace_once(
        text,
        r"(?ms)^    websockets:\n.*?^    # casemapping controls",
        """    websockets:
        allowed-origins:
            - "https://chat.abundanceds.com"

    # casemapping controls""",
        "websocket origin",
    )
    text = replace_once(
        text,
        r"(?m)^    motd: ergo\.motd$",
        "    motd: /opt/mimir-chat/current/ergo.motd",
        "MOTD path",
    )
    text = replace_once(
        text,
        r"(?ms)^(    registration:\n        # can users register new accounts for themselves\?.*?\n)        enabled: true",
        r"\g<1>        enabled: false",
        "closed account registration",
    )
    text = replace_once(
        text,
        r"(?ms)^(    require-sasl:\n.*?\n)        enabled: false",
        r"\g<1>        enabled: true",
        "SASL requirement",
    )
    text = replace_once(
        text,
        r'(?ms)^(    require-sasl:\n.*?)(        exempted:\n            - "localhost")',
        r"\g<1>        exempted: []",
        "no SASL exemptions",
    )
    if args.bootstrap_local_only:
        text = replace_once(
            text,
            r'(?m)^        "127\.0\.0\.1:8067":\n            websocket: true\n',
            "",
            "bootstrap-only WebSocket removal",
        )
        text = replace_once(
            text,
            r"(?ms)^(    require-sasl:\n.*?)(        exempted: \[\])",
            r'\g<1>        exempted:\n            - "localhost"',
            "bootstrap-only localhost SASL exemption",
        )
    text = replace_once(
        text,
        r'(?m)^        always-on: "opt-in"$',
        '        always-on: "mandatory"',
        "always-on accounts",
    )
    text = replace_once(
        text,
        r'(?m)^        auto-away: "opt-in"$',
        '        auto-away: "mandatory"',
        "meaningful presence",
    )
    text = replace_once(
        text,
        r'(?m)^        enabled: false\n        # path to the SQLite database file\n        database-path: "ergo_history\.db"$',
        '        enabled: true\n        # path to the SQLite database file\n        database-path: "ergo_history.db"',
        "SQLite history backend",
    )
    text = replace_once(
        text,
        r"(?m)^    path: languages$",
        "    path: /opt/mimir-chat/current/languages",
        "language path",
    )
    text = replace_once(
        text,
        r"(?m)^        expire-time: 1w$",
        "        expire-time: 365d",
        "history retention",
    )
    text = replace_once(
        text,
        r"(?ms)^(    persistent:\n)        enabled: false",
        r"\g<1>        enabled: true",
        "persistent history",
    )
    text = replace_once(
        text,
        r"(?m)^        unregistered-channels: false$",
        "        unregistered-channels: true",
        "unregistered channel history",
    )
    text = replace_once(
        text,
        r'(?m)^        registered-channels: "opt-out"$',
        '        registered-channels: "mandatory"',
        "registered channel history",
    )
    text = replace_once(
        text,
        r'(?m)^        direct-messages: "opt-out"$',
        '        direct-messages: "mandatory"',
        "direct message history",
    )
    text = replace_once(
        text,
        r"(?m)^        allow-individual-delete: false$",
        "        allow-individual-delete: true",
        "own-message deletion",
    )
    text = replace_once(
        text,
        r'(?m)^            - "\+draft/react"\n            - "\+react"$',
        '            - "+draft/react"\n'
        '            - "+draft/unreact"\n'
        '            - "+react"\n'
        '            - "+unreact"',
        "reaction history",
    )
    text = replace_once(
        text,
        r'(?ms)^    # channels that new clients will automatically join\..*?^    #auto-join:\n    #    - "#lounge"$',
        """    # A single shared room is present from the first successful login.
    auto-join:
        - "#general"
""".rstrip(),
        "default channel",
    )
    text = replace_once(
        text,
        r"(?ms)^oper-classes:\n.*?^# ircd operators\nopers:\n.*?^# logging,",
        f"""oper-classes:
    "mimir-owner":
        title: Mimir Owner
        capabilities:
            - "accreg"
            - "relaymsg"
    "mimir-admin":
        title: Mimir Chat Administration
        capabilities:
            - "accreg"
            - "ban"
            - "chanreg"
            - "samode"
            - "nofakelag"

# The initial owner uses the same passphrase for SASL and the narrowly scoped
# OPER elevation. The hash is generated on the host and never committed.
opers:
    waqr:
        class: "mimir-owner"
        hidden: true
        whois-line: owns this Mimir chat
        password: "{oper_hash}"
    mimir-admin:
        class: "mimir-admin"
        hidden: true
        whois-line: administers this Mimir chat
        password: "{admin_oper_hash}"

# logging,""",
        "operator policy",
    )

    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(text, encoding="utf-8")


if __name__ == "__main__":
    main()
