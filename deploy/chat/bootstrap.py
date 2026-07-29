#!/usr/bin/env python3
"""Idempotently provision the first Ergo account and #general."""

from __future__ import annotations

import argparse
import base64
import secrets
import socket
import time
from pathlib import Path


class Irc:
    def __init__(self, host: str, port: int) -> None:
        self.socket = socket.create_connection((host, port), timeout=5)
        self.socket.settimeout(0.5)
        self.buffer = b""

    def send(self, line: str) -> None:
        self.socket.sendall(line.encode("utf-8") + b"\r\n")

    def buffered_lines(self) -> list[str]:
        lines: list[str] = []
        while b"\n" in self.buffer:
            raw, self.buffer = self.buffer.split(b"\n", 1)
            line = raw.rstrip(b"\r").decode("utf-8", "replace")
            if line.startswith("PING "):
                self.send("PONG " + line[5:])
            lines.append(line)
        return lines

    def lines(self, timeout: float = 8) -> list[str]:
        deadline = time.monotonic() + timeout
        lines: list[str] = []
        while time.monotonic() < deadline:
            lines.extend(self.buffered_lines())
            try:
                chunk = self.socket.recv(65536)
            except socket.timeout:
                continue
            if not chunk:
                break
            self.buffer += chunk
        lines.extend(self.buffered_lines())
        return lines

    def wait_for(self, needles: tuple[str, ...], timeout: float = 8) -> list[str]:
        deadline = time.monotonic() + timeout
        lines: list[str] = []
        lowered_needles = tuple(needle.lower() for needle in needles)
        while time.monotonic() < deadline:
            for line in self.buffered_lines():
                lines.append(line)
                lowered = line.lower()
                if any(needle in lowered for needle in lowered_needles):
                    return lines
            try:
                chunk = self.socket.recv(65536)
            except socket.timeout:
                continue
            if not chunk:
                break
            self.buffer += chunk
        lines.extend(self.buffered_lines())
        return lines

    def close(self) -> None:
        try:
            try:
                self.send("QUIT :bootstrap complete")
            except OSError:
                pass
        finally:
            self.socket.close()


def has(lines: list[str], *needles: str) -> bool:
    lowered = "\n".join(lines).lower()
    return any(needle.lower() in lowered for needle in needles)


def authenticate_owner(irc: Irc, password: str) -> bool:
    nick = "mimir-bootstrap-" + secrets.token_hex(3)
    irc.send("CAP LS 302")
    irc.send(f"NICK {nick}")
    irc.send(f"USER {nick} 0 * :Mimir bootstrap")
    capabilities = irc.wait_for(("sasl",))
    if not has(capabilities, "sasl"):
        return False
    irc.send("CAP REQ :sasl")
    acknowledged = irc.wait_for((" ack ", " nak "))
    if not has(acknowledged, " ack ") or not has(acknowledged, "sasl"):
        return False
    irc.send("AUTHENTICATE PLAIN")
    challenge = irc.wait_for(("authenticate +",))
    if not has(challenge, "authenticate +"):
        return False
    payload = base64.b64encode(f"\0waqr\0{password}".encode()).decode("ascii")
    irc.send("AUTHENTICATE " + payload)
    authenticated = irc.wait_for((" 903 ", " 904 ", " 905 ", " 906 ", " 907 "))
    if not has(authenticated, " 903 "):
        return False
    irc.send("CAP END")
    welcome = irc.wait_for((" 001 ",))
    return has(welcome, " 001 ")


def provision_account(password: str) -> None:
    authenticated = Irc("127.0.0.1", 16667)
    try:
        if authenticate_owner(authenticated, password):
            return
    finally:
        authenticated.close()

    irc = Irc("127.0.0.1", 16667)
    try:
        nick = "mimir-bootstrap-" + secrets.token_hex(3)
        irc.send(f"NICK {nick}")
        irc.send(f"USER {nick} 0 * :Mimir bootstrap")
        welcome = irc.wait_for((" 001 ",))
        if not has(welcome, " 001 "):
            raise RuntimeError("bootstrap client did not complete IRC registration")

        irc.send(f"OPER waqr {password}")
        oper = irc.wait_for((" 381 ", "you are now an irc operator"))
        if not has(oper, " 381 ", "you are now an irc operator"):
            raise RuntimeError("bootstrap client could not obtain the limited owner role")

        irc.send(f"PRIVMSG NickServ :SAREGISTER waqr {password}")
        result = irc.wait_for(
            (
                "successfully registered account",
                "already exists",
                "already registered",
                "prior registration",
            )
        )
        if not has(
            result,
            "successfully registered account",
            "already exists",
            "already registered",
            "prior registration",
        ):
            raise RuntimeError("NickServ did not confirm account creation or prior existence")
    finally:
        irc.close()


def provision_channel(password: str) -> None:
    irc = Irc("127.0.0.1", 16667)
    try:
        irc.send(f"PASS waqr:{password}")
        irc.send("NICK waqr")
        irc.send("USER waqr 0 * :Waqr")
        welcome = irc.wait_for((" 001 waqr ",))
        if not has(welcome, " 001 waqr "):
            raise RuntimeError("waqr could not authenticate after provisioning")

        irc.send("JOIN #general")
        joined = irc.wait_for((" join #general",))
        if not has(joined, " join #general"):
            raise RuntimeError("waqr could not join #general")

        irc.send("PRIVMSG ChanServ :REGISTER #general")
        registered = irc.wait_for(
            (
                "successfully registered channel",
                "already registered",
                "channel is already registered",
            )
        )
        if not has(
            registered,
            "successfully registered channel",
            "already registered",
            "channel is already registered",
        ):
            raise RuntimeError("ChanServ did not confirm channel registration or prior existence")

        irc.send("TOPIC #general :Company chat")
        irc.lines(timeout=1)
    finally:
        irc.close()


def provision_service_account(owner_password: str, admin_password: str) -> None:
    irc = Irc("127.0.0.1", 16667)
    try:
        if not authenticate_owner(irc, owner_password):
            raise RuntimeError("owner must exist before the administration account")
        irc.send(f"OPER waqr {owner_password}")
        oper = irc.wait_for(
            (
                " 381 ",
                "you are now an irc operator",
                "already opered-up",
            ),
        )
        if not has(
            oper,
            " 381 ",
            "you are now an irc operator",
            "already opered-up",
        ):
            raise RuntimeError("owner could not provision the administration account")
        irc.send(f"PRIVMSG NickServ :SAREGISTER mimir-admin {admin_password}")
        result = irc.wait_for(
            (
                "successfully registered account",
                "already exists",
                "already registered",
                "prior registration",
            ),
        )
        if not has(
            result,
            "successfully registered account",
            "already exists",
            "already registered",
            "prior registration",
        ):
            raise RuntimeError("NickServ did not confirm the administration account")
    finally:
        irc.close()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--password-file", required=True, type=Path)
    parser.add_argument("--admin-password-file", required=True, type=Path)
    args = parser.parse_args()
    password = args.password_file.read_text(encoding="utf-8").strip()
    admin_password = args.admin_password_file.read_text(encoding="utf-8").strip()
    if not password:
        raise SystemExit("password file is empty")
    if not admin_password:
        raise SystemExit("administration password file is empty")
    provision_account(password)
    provision_service_account(password, admin_password)
    provision_channel(password)
    print("waqr, mimir-admin, and #general are ready")


if __name__ == "__main__":
    main()
