#!/usr/bin/env python3
"""Add or remove one Mimir Chat account from the Ergo host.

The owner passphrase is read from a root-only file. A generated teammate
passphrase is printed exactly once so the operator can hand it to that person.
"""

from __future__ import annotations

import argparse
import base64
import re
import secrets
import socket
import time
from pathlib import Path


ACCOUNT = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_\-\[\]{}^`]{0,31}$")


class Irc:
    def __init__(self) -> None:
        self.socket = socket.create_connection(("127.0.0.1", 16667), timeout=5)
        self.socket.settimeout(0.5)
        self.buffer = b""

    def send(self, line: str) -> None:
        self.socket.sendall(line.encode("utf-8") + b"\r\n")

    def wait_for(self, needles: tuple[str, ...], timeout: float = 8) -> list[str]:
        deadline = time.monotonic() + timeout
        lines: list[str] = []
        lowered_needles = tuple(needle.lower() for needle in needles)
        while time.monotonic() < deadline:
            try:
                chunk = self.socket.recv(65536)
            except socket.timeout:
                continue
            if not chunk:
                break
            self.buffer += chunk
            while b"\n" in self.buffer:
                raw, self.buffer = self.buffer.split(b"\n", 1)
                line = raw.rstrip(b"\r").decode("utf-8", "replace")
                if line.startswith("PING "):
                    self.send("PONG " + line[5:])
                lines.append(line)
                if any(needle in line.lower() for needle in lowered_needles):
                    return lines
        return lines

    def close(self) -> None:
        try:
            try:
                self.send("QUIT :account administration complete")
            except OSError:
                pass
        finally:
            self.socket.close()


def contains(lines: list[str], *needles: str) -> bool:
    text = "\n".join(lines).lower()
    return any(needle.lower() in text for needle in needles)


def authenticate_owner(irc: Irc, account: str, password: str) -> None:
    nick = "mimir-admin-" + secrets.token_hex(3)
    irc.send("CAP LS 302")
    irc.send(f"NICK {nick}")
    irc.send(f"USER {nick} 0 * :Mimir account admin")
    capabilities = irc.wait_for(("sasl",))
    if not contains(capabilities, "sasl"):
        raise RuntimeError("chat server did not offer SASL to the account administrator")

    irc.send("CAP REQ :sasl")
    acknowledged = irc.wait_for((" ack ", " nak "))
    if not contains(acknowledged, " ack ") or not contains(acknowledged, "sasl"):
        raise RuntimeError("chat server did not acknowledge SASL")

    irc.send("AUTHENTICATE PLAIN")
    challenge = irc.wait_for(("authenticate +",))
    if not contains(challenge, "authenticate +"):
        raise RuntimeError("chat server did not start SASL authentication")
    payload = base64.b64encode(f"\0{account}\0{password}".encode()).decode("ascii")
    irc.send("AUTHENTICATE " + payload)
    authenticated = irc.wait_for((" 903 ", " 904 ", " 905 ", " 906 ", " 907 "))
    if not contains(authenticated, " 903 "):
        raise RuntimeError("owner SASL authentication failed")

    irc.send("CAP END")
    welcome = irc.wait_for((" 001 ",))
    if not contains(welcome, " 001 "):
        raise RuntimeError("account administrator did not complete IRC registration")


def obtain_owner_role(irc: Irc, password: str) -> None:
    irc.send(f"OPER waqr {password}")
    oper = irc.wait_for(
        (
            " 381 ",
            "you are now an irc operator",
            "already opered-up",
            " 464 ",
            " 481 ",
            " 491 ",
        ),
    )
    if not contains(
        oper,
        " 381 ",
        "you are now an irc operator",
        "already opered-up",
    ):
        reply = next((line for line in reversed(oper) if " 00" not in line), "")
        detail = f": {reply}" if reply else ""
        raise RuntimeError(
            "account administrator could not obtain the limited owner role" + detail,
        )


def add_account(irc: Irc, account: str, passphrase: str) -> None:
    irc.send(f"PRIVMSG NickServ :SAREGISTER {account} {passphrase}")
    result = irc.wait_for(
        (
            "successfully registered account",
            "already exists",
            "already registered",
        ),
    )
    if contains(result, "already exists", "already registered"):
        raise SystemExit(f"account '{account}' already exists; nothing changed")
    if not contains(result, "successfully registered account"):
        raise RuntimeError("NickServ did not confirm account creation")


def remove_account(irc: Irc, account: str) -> None:
    irc.send(f"PRIVMSG NickServ :UNREGISTER {account}")
    challenge = irc.wait_for(
        (
            "to confirm, run this command",
            "invalid account name",
            "insufficient oper privs",
        ),
    )
    transcript = "\n".join(challenge)
    if contains(challenge, "invalid account name"):
        raise SystemExit(f"account '{account}' does not exist; nothing changed")
    match = re.search(
        rf"/NS\s+UNREGISTER\s+{re.escape(account)}\s+([A-Za-z0-9]+)",
        transcript,
        re.IGNORECASE,
    )
    if not match:
        raise RuntimeError("NickServ did not provide an account-removal confirmation code")

    irc.send(f"PRIVMSG NickServ :UNREGISTER {account} {match.group(1)}")
    result = irc.wait_for(
        (
            f"successfully unregistered account {account}",
            "error while unregistering account",
            "invalid account name",
            "to confirm, run this command",
        ),
    )
    if not contains(result, f"successfully unregistered account {account}"):
        reply = next((line for line in reversed(result) if "nickserv" in line.lower()), "")
        detail = f": {reply}" if reply else ""
        raise RuntimeError("NickServ did not confirm account removal" + detail)


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Add or remove one Mimir Chat teammate account.",
    )
    parser.add_argument(
        "operation_or_account",
        help="'add', 'remove', or an account name (legacy shorthand for add)",
    )
    parser.add_argument("account", nargs="?", help="Stable login, nick, and DM address")
    parser.add_argument(
        "--owner-password-file",
        type=Path,
        default=Path("/etc/mimir-chat/waqr.pass"),
    )
    parser.add_argument(
        "--passphrase",
        help="Use an explicit passphrase instead of generating one",
    )
    parser.add_argument(
        "--confirm",
        metavar="ACCOUNT",
        help="Required for removal; repeat the exact account name",
    )
    args = parser.parse_args()

    if args.operation_or_account in {"add", "remove"}:
        operation = args.operation_or_account
        if not args.account:
            parser.error(f"{operation} requires an account")
        raw_account = args.account
    else:
        operation = "add"
        if args.account:
            parser.error("use 'mimir-chat-user add ACCOUNT' or the legacy 'mimir-chat-user ACCOUNT'")
        raw_account = args.operation_or_account

    account = raw_account.strip().lower()
    if not ACCOUNT.fullmatch(account):
        raise SystemExit(
            "account must be 1–32 characters: letters, numbers, dashes, "
            "underscores, brackets, braces, ^, or `",
        )
    if account in {"waqr", "mimir-admin", "mimir-bootstrap"}:
        raise SystemExit(f"{account} is reserved or already provisioned")
    if operation == "remove" and args.confirm != account:
        raise SystemExit(f"removing '{account}' requires --confirm {account}")
    if operation == "remove" and args.passphrase:
        raise SystemExit("--passphrase applies only when adding an account")

    owner_password = args.owner_password_file.read_text(encoding="utf-8").strip()
    if not owner_password:
        raise SystemExit("owner password file is empty")
    passphrase = None
    if operation == "add":
        passphrase = args.passphrase or secrets.token_urlsafe(24)
        if len(passphrase) < 12 or any(character.isspace() for character in passphrase):
            raise SystemExit("passphrase must be at least 12 characters without whitespace")

    irc = Irc()
    try:
        authenticate_owner(irc, "waqr", owner_password)
        obtain_owner_role(irc, owner_password)
        if operation == "add":
            add_account(irc, account, passphrase)
        else:
            remove_account(irc, account)
    finally:
        irc.close()

    if operation == "add":
        print(f"account: {account}")
        print(f"passphrase: {passphrase}")
        print("Give these two values to the teammate; they can choose their display name in Mimir.")
    else:
        print(f"removed account: {account}")
        print("The account name remains reserved so historical identity cannot be reassigned.")


if __name__ == "__main__":
    main()
