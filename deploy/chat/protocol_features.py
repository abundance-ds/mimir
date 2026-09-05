#!/usr/bin/env python3
"""Verify Mimir's complete IRC event contract against the public server.

The owner passphrase is read from stdin and is never logged. The test uses an
isolated channel, verifies live delivery plus replay, then redacts every stored
test event so production history remains clean.

Requires the small `websockets` Python package.
"""

from __future__ import annotations

import base64
from collections import deque
import re
import sys
import time
import uuid

from websockets.sync.client import connect


ENDPOINT = "wss://chat.abundanceds.com/webirc"
ORIGIN = "https://chat.abundanceds.com"
ACCOUNT = "waqr"
CHANNEL = "#mimir-protocol"
CAPABILITIES = (
    "sasl",
    "message-tags",
    "server-time",
    "batch",
    "echo-message",
    "account-tag",
    "account-notify",
    "away-notify",
    "extended-join",
    "draft/chathistory",
    "draft/event-playback",
    "draft/message-redaction",
)
TAG_PATTERN = re.compile(r"^@([^ ]+) ")


def tags(line: str) -> dict[str, str]:
    match = TAG_PATTERN.match(line)
    if not match:
        return {}
    parsed: dict[str, str] = {}
    for raw in match.group(1).split(";"):
        name, separator, value = raw.partition("=")
        parsed[name] = value if separator else ""
    return parsed


class Session:
    def __init__(self, password: str) -> None:
        self.password = password
        self.socket = connect(
            ENDPOINT,
            origin=ORIGIN,
            open_timeout=5,
        )
        self.pending: deque[str] = deque()
        self.transcript: list[str] = []

    def send(self, line: str) -> None:
        self.socket.send(line + "\r\n")

    def next_line(self, deadline: float) -> str:
        while time.monotonic() < deadline:
            if self.pending:
                return self.pending.popleft()
            try:
                frame = self.socket.recv(timeout=min(0.5, deadline - time.monotonic()))
            except TimeoutError:
                continue
            if isinstance(frame, bytes):
                frame = frame.decode("utf-8", "replace")
            for line in frame.splitlines():
                self.transcript.append(line)
                if line.startswith("PING "):
                    self.send("PONG " + line[5:])
                else:
                    self.pending.append(line)
        raise TimeoutError("timed out waiting for IRC response")

    def wait_for(self, predicate, timeout: float = 8) -> str:
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            line = self.next_line(deadline)
            if predicate(line):
                return line
        raise TimeoutError("timed out waiting for matching IRC response")

    def register(self) -> None:
        self.send("CAP LS 302")
        self.send(f"NICK {ACCOUNT}")
        self.send(f"USER {ACCOUNT} 0 * :Mimir protocol test")
        advertised: set[str] = set()
        while True:
            line = self.wait_for(lambda value: " CAP " in value and " LS " in value)
            payload = line.rsplit(" :", 1)[-1]
            advertised.update(item.split("=", 1)[0] for item in payload.split())
            if " LS * :" not in line:
                break
        missing = [capability for capability in CAPABILITIES if capability not in advertised]
        if missing:
            raise RuntimeError("server is missing capabilities: " + ", ".join(missing))
        self.send("CAP REQ :" + " ".join(CAPABILITIES))
        ack = self.wait_for(lambda value: " CAP " in value and " ACK " in value)
        if not all(capability in ack for capability in CAPABILITIES):
            raise RuntimeError("server did not acknowledge the complete capability set")
        self.send("AUTHENTICATE PLAIN")
        self.wait_for(lambda value: value == "AUTHENTICATE +")
        payload = base64.b64encode(
            f"\0{ACCOUNT}\0{self.password}".encode("utf-8"),
        ).decode("ascii")
        self.send("AUTHENTICATE " + payload)
        self.wait_for(lambda value: " 903 " in value)
        self.send("CAP END")
        self.wait_for(lambda value: f" 001 {ACCOUNT} " in value)

    def join(self) -> None:
        self.send(f"JOIN {CHANNEL}")
        self.wait_for(
            lambda value: f" JOIN {CHANNEL}" in value
            and f" :{ACCOUNT}!" in value.lower(),
        )

    def history(self, limit: int = 50) -> list[str]:
        self.send(f"CHATHISTORY LATEST {CHANNEL} * {limit}")
        opening = self.wait_for(
            lambda value: " BATCH +" in value and "chathistory" in value.lower(),
        )
        batch = opening.split(" BATCH +", 1)[1].split(" ", 1)[0]
        replay: list[str] = []
        deadline = time.monotonic() + 8
        while time.monotonic() < deadline:
            line = self.next_line(deadline)
            if f" BATCH -{batch}" in line:
                return replay
            replay.append(line)
        raise TimeoutError("history batch did not close")

    def close(self) -> None:
        try:
            self.send("QUIT :Mimir protocol feature test complete")
        finally:
            self.socket.close()


def event_id(session: Session, command: str, marker: str) -> str:
    line = session.wait_for(
        lambda value: f" {command} {CHANNEL}" in value and marker in value,
    )
    identifier = tags(line).get("msgid")
    if not identifier:
        raise RuntimeError(f"{command} event did not receive a server message ID")
    return identifier


def main() -> None:
    password = sys.stdin.read().strip()
    if not password:
        raise SystemExit(f"expected the {ACCOUNT} passphrase on stdin")

    marker = "mimir-" + uuid.uuid4().hex
    session = Session(password)
    stored_ids: list[str] = []
    checks: list[str] = []
    try:
        session.register()
        checks.append("capabilities")
        session.join()
        checks.append("join")

        session.send(f"PRIVMSG {CHANNEL} :{marker}-message")
        message_id = event_id(session, "PRIVMSG", f"{marker}-message")
        stored_ids.append(message_id)
        checks.append("message")

        session.send(
            f"@+reply={message_id};+draft/react=👍 TAGMSG {CHANNEL}",
        )
        reaction_line = session.wait_for(
            lambda value: f" TAGMSG {CHANNEL}" in value
            and tags(value).get("+reply") == message_id
            and tags(value).get("+draft/react") == "👍",
        )
        reaction_id = tags(reaction_line).get("msgid")
        if not reaction_id:
            raise RuntimeError("reaction did not receive a server message ID")
        stored_ids.append(reaction_id)
        checks.append("reaction")

        session.send(
            f"@+reply={message_id};+draft/unreact=👍 TAGMSG {CHANNEL}",
        )
        unreaction_line = session.wait_for(
            lambda value: f" TAGMSG {CHANNEL}" in value
            and tags(value).get("+reply") == message_id
            and tags(value).get("+draft/unreact") == "👍",
        )
        unreaction_id = tags(unreaction_line).get("msgid")
        if not unreaction_id:
            raise RuntimeError("unreaction did not receive a server message ID")
        stored_ids.append(unreaction_id)
        checks.append("unreaction")

        session.send(f"@+typing=active TAGMSG {CHANNEL}")
        session.wait_for(
            lambda value: f" TAGMSG {CHANNEL}" in value
            and tags(value).get("+typing") == "active",
        )
        session.send(f"@+typing=done TAGMSG {CHANNEL}")
        checks.append("typing")

        session.send(
            f"@+abundanceds.com/edit={message_id} "
            f"PRIVMSG {CHANNEL} :{marker}-edited",
        )
        edit_id = event_id(session, "PRIVMSG", f"{marker}-edited")
        stored_ids.append(edit_id)
        checks.append("edit-event")

        session.send(
            "@+abundanceds.com/file=protocol-test;"
            "+abundanceds.com/file-name=protocol.txt;"
            "+abundanceds.com/file-size=7;"
            "+abundanceds.com/file-type=text/plain;"
            "+abundanceds.com/file-sha256="
            "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa "
            f"PRIVMSG {CHANNEL} :{marker}-attachment",
        )
        attachment_id = event_id(session, "PRIVMSG", f"{marker}-attachment")
        stored_ids.append(attachment_id)
        checks.append("attachment-metadata")

        replay = session.history()
        replay_text = "\n".join(replay)
        for expected in (
            f"{marker}-message",
            f"{marker}-edited",
            f"{marker}-attachment",
            "+draft/react=👍",
            "+draft/unreact=👍",
            f"+reply={message_id}",
            "+abundanceds.com/file=protocol-test",
            "+abundanceds.com/file-sha256=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        ):
            if expected not in replay_text:
                raise RuntimeError(f"history did not preserve {expected}")
        if "+typing=" in replay_text:
            raise RuntimeError("ephemeral typing state leaked into persistent history")
        checks.append("history")

        for identifier in reversed(stored_ids):
            session.send(f"REDACT {CHANNEL} {identifier} :protocol test cleanup")
            session.wait_for(
                lambda value, expected=identifier: (
                    f" REDACT {CHANNEL} {expected}" in value
                ),
            )
        checks.append("redaction")

        replay_after_cleanup = "\n".join(session.history())
        if marker in replay_after_cleanup:
            raise RuntimeError("redacted protocol events remain in history")
        checks.append("clean-history")
        session.send(f"PART {CHANNEL} :protocol test complete")
        session.wait_for(lambda value: f" PART {CHANNEL}" in value)
        checks.append("channel-cleanup")
    except Exception as error:
        for line in session.transcript[-100:]:
            if not line.startswith("AUTHENTICATE "):
                print(line, file=sys.stderr)
        completed = ", ".join(checks) if checks else "none"
        raise SystemExit(
            f"protocol feature checks failed after [{completed}]: {error}",
        ) from error
    finally:
        session.close()

    print("production feature protocol passed: " + ", ".join(checks))


if __name__ == "__main__":
    main()
