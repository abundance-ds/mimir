#!/usr/bin/env python3
"""Exercise the public WebSocket, SASL, echo, and CHATHISTORY path.

The account passphrase is read from stdin and is never logged.
Requires the small `websockets` Python package.
"""

from __future__ import annotations

import base64
import sys
import time

from websockets.sync.client import connect


def verify_auth_boundary() -> None:
    transcript: list[str] = []
    with connect(
        "wss://chat.shoulde.rs/webirc",
        origin="https://chat.shoulde.rs",
        open_timeout=5,
    ) as socket:
        socket.send("NICK mimir-unauthenticated\r\n")
        socket.send("USER mimir-unauthenticated 0 * :Mimir auth boundary\r\n")
        socket.send("JOIN #general\r\n")
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            try:
                frame = socket.recv(timeout=0.5)
            except TimeoutError:
                continue
            if isinstance(frame, bytes):
                frame = frame.decode("utf-8", "replace")
            transcript.extend(frame.splitlines())
            if any("ACCOUNT_REQUIRED" in line for line in transcript):
                break

    if any(" JOIN #general" in line or " 001 " in line for line in transcript):
        raise SystemExit("unauthenticated public session entered chat")
    if not any("ACCOUNT_REQUIRED" in line for line in transcript):
        raise SystemExit("unauthenticated public session was not rejected")


def main() -> None:
    password = sys.stdin.read().strip()
    if not password:
        raise SystemExit("expected the waqr passphrase on stdin")

    verify_auth_boundary()
    socket = connect(
        "wss://chat.shoulde.rs/webirc",
        origin="https://chat.shoulde.rs",
        open_timeout=5,
    )
    checks = {
        "auth_boundary": True,
        "cap_ls": False,
        "cap_ack": False,
        "sasl": False,
        "welcome": False,
        "general": False,
        "echo": False,
        "chathistory": False,
    }
    sent_smoke = False
    requested_history = False
    deadline = time.monotonic() + 15
    transcript: list[str] = []

    def send(line: str) -> None:
        socket.send(line + "\r\n")

    send("CAP LS 302")
    send("NICK waqr")
    send("USER waqr 0 * :Waqr")
    while time.monotonic() < deadline:
        try:
            frame = socket.recv(timeout=0.5)
        except TimeoutError:
            continue
        if isinstance(frame, bytes):
            frame = frame.decode("utf-8", "replace")
        for line in frame.splitlines():
            transcript.append(line)
            if line.startswith("PING "):
                send("PONG " + line[5:])
            if " CAP " in line and " LS " in line and "sasl" in line.lower():
                checks["cap_ls"] = True
                send(
                    "CAP REQ :sasl message-tags server-time batch echo-message "
                    "account-tag draft/chathistory draft/multiline"
                )
            elif " CAP " in line and " ACK " in line and "sasl" in line.lower():
                checks["cap_ack"] = True
                send("AUTHENTICATE PLAIN")
            elif line == "AUTHENTICATE +":
                payload = base64.b64encode(("\0waqr\0" + password).encode()).decode()
                send("AUTHENTICATE " + payload)
            elif " 903 " in line and "authentication successful" in line.lower():
                checks["sasl"] = True
                send("CAP END")
            elif " 001 waqr " in line:
                checks["welcome"] = True
            elif " JOIN #general" in line:
                checks["general"] = True
                if not sent_smoke:
                    send("PRIVMSG #general :Mimir production transport verified.")
                    sent_smoke = True
            elif "PRIVMSG #general :Mimir production transport verified." in line:
                checks["echo"] = True
                if not requested_history:
                    send("CHATHISTORY LATEST #general * 20")
                    requested_history = True
            elif " BATCH +" in line and "chathistory" in line.lower():
                checks["chathistory"] = True
        if all(checks.values()):
            break

    send("QUIT :production protocol test complete")
    socket.close()
    failed = [name for name, passed in checks.items() if not passed]
    if failed:
        for line in transcript[-80:]:
            if not line.startswith("AUTHENTICATE "):
                print(line, file=sys.stderr)
        raise SystemExit("protocol checks failed: " + ", ".join(failed))
    print("production protocol checks passed: " + ", ".join(checks))


if __name__ == "__main__":
    main()
