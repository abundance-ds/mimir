#!/usr/bin/env python3
"""Small authenticated attachment service for Mimir Chat.

Authentication is delegated to Ergo over its loopback IRC listener using SASL
PLAIN. Files are stored under opaque random IDs; metadata lives in SQLite.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import mimetypes
import os
from pathlib import Path
import re
import secrets
import socket
import sqlite3
import tempfile
import threading
import time
from urllib.parse import quote, urlsplit


FILE_ID = re.compile(r"^[A-Za-z0-9_-]{32,64}$")
MAX_FILENAME_BYTES = 240
AUTH_CACHE_SECONDS = 300


def initialize_database(path: Path) -> None:
    with sqlite3.connect(path) as database:
        database.executescript(
            """
            PRAGMA journal_mode = WAL;
            CREATE TABLE IF NOT EXISTS files (
                file_id TEXT PRIMARY KEY,
                owner_account TEXT NOT NULL COLLATE NOCASE,
                filename TEXT NOT NULL,
                mime_type TEXT NOT NULL,
                size_bytes INTEGER NOT NULL,
                sha256 TEXT NOT NULL,
                created_at TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS files_created_at ON files(created_at);
            """,
        )


class SaslAuthenticator:
    def __init__(self, host: str, port: int) -> None:
        self.host = host
        self.port = port
        self.cache: dict[str, float] = {}
        self.lock = threading.Lock()

    def authenticate(self, account: str, password: str) -> bool:
        digest = hashlib.sha256(f"{account}\0{password}".encode()).hexdigest()
        now = time.monotonic()
        with self.lock:
            if self.cache.get(digest, 0) > now:
                return True
        accepted = self._authenticate_uncached(account, password)
        if accepted:
            with self.lock:
                self.cache[digest] = now + AUTH_CACHE_SECONDS
                if len(self.cache) > 100:
                    self.cache = {
                        key: expiry
                        for key, expiry in self.cache.items()
                        if expiry > now
                    }
        return accepted

    def _authenticate_uncached(self, account: str, password: str) -> bool:
        connection = socket.create_connection((self.host, self.port), timeout=5)
        connection.settimeout(0.5)
        buffer = b""

        def send(line: str) -> None:
            connection.sendall(line.encode("utf-8") + b"\r\n")

        try:
            temporary_nick = "file-auth-" + secrets.token_hex(5)
            send("CAP LS 302")
            send(f"NICK {temporary_nick}")
            send(f"USER {temporary_nick} 0 * :Mimir file authentication")
            deadline = time.monotonic() + 7
            requested = False
            sent_payload = False
            while time.monotonic() < deadline:
                try:
                    chunk = connection.recv(65536)
                except socket.timeout:
                    continue
                if not chunk:
                    return False
                buffer += chunk
                while b"\n" in buffer:
                    raw, buffer = buffer.split(b"\n", 1)
                    line = raw.rstrip(b"\r").decode("utf-8", "replace")
                    if line.startswith("PING "):
                        send("PONG " + line[5:])
                    elif " CAP " in line and " LS " in line and "sasl" in line.lower():
                        if " LS * :" not in line and not requested:
                            requested = True
                            send("CAP REQ :sasl")
                    elif " CAP " in line and " ACK " in line and "sasl" in line.lower():
                        send("AUTHENTICATE PLAIN")
                    elif line == "AUTHENTICATE +" and not sent_payload:
                        sent_payload = True
                        payload = base64.b64encode(
                            f"\0{account}\0{password}".encode(),
                        ).decode("ascii")
                        send("AUTHENTICATE " + payload)
                    elif " 903 " in line:
                        return True
                    elif any(f" {numeric} " in line for numeric in ("904", "905", "906", "907")):
                        return False
            return False
        finally:
            connection.close()


class FileStore:
    def __init__(self, data_dir: Path, database_path: Path, quota_bytes: int) -> None:
        self.data_dir = data_dir
        self.database_path = database_path
        self.quota_bytes = quota_bytes
        self.data_dir.mkdir(parents=True, exist_ok=True)
        initialize_database(database_path)

    def usage(self) -> int:
        with sqlite3.connect(self.database_path) as database:
            value = database.execute(
                "SELECT COALESCE(SUM(size_bytes), 0) FROM files",
            ).fetchone()[0]
        return int(value)

    def create(
        self,
        owner: str,
        filename: str,
        mime_type: str,
        source,
        size: int,
    ) -> dict[str, object]:
        if self.usage() + size > self.quota_bytes:
            raise ValueError("attachment storage quota is full")
        file_id = secrets.token_urlsafe(32)
        digest = hashlib.sha256()
        temporary = tempfile.NamedTemporaryFile(
            dir=self.data_dir,
            prefix=".upload-",
            delete=False,
        )
        temporary_path = Path(temporary.name)
        remaining = size
        try:
            with temporary:
                while remaining:
                    chunk = source.read(min(1024 * 1024, remaining))
                    if not chunk:
                        raise ValueError("upload ended before Content-Length")
                    temporary.write(chunk)
                    digest.update(chunk)
                    remaining -= len(chunk)
                temporary.flush()
                os.fsync(temporary.fileno())
            final_path = self.data_dir / file_id
            os.replace(temporary_path, final_path)
            os.chmod(final_path, 0o600)
            record = {
                "id": file_id,
                "name": filename,
                "mime": mime_type,
                "size": size,
                "sha256": digest.hexdigest(),
            }
            with sqlite3.connect(self.database_path) as database:
                database.execute(
                    """
                    INSERT INTO files
                        (file_id, owner_account, filename, mime_type,
                         size_bytes, sha256, created_at)
                    VALUES (?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
                    """,
                    (
                        file_id,
                        owner,
                        filename,
                        mime_type,
                        size,
                        record["sha256"],
                    ),
                )
            return record
        except Exception:
            temporary_path.unlink(missing_ok=True)
            (self.data_dir / file_id).unlink(missing_ok=True)
            raise

    def get(self, file_id: str) -> dict[str, object] | None:
        with sqlite3.connect(self.database_path) as database:
            row = database.execute(
                """
                SELECT owner_account, filename, mime_type, size_bytes, sha256
                FROM files WHERE file_id = ?
                """,
                (file_id,),
            ).fetchone()
        if row is None:
            return None
        return {
            "id": file_id,
            "owner": row[0],
            "name": row[1],
            "mime": row[2],
            "size": row[3],
            "sha256": row[4],
            "path": self.data_dir / file_id,
        }

    def delete(self, file_id: str, account: str) -> bool:
        record = self.get(file_id)
        if record is None or str(record["owner"]).lower() != account.lower():
            return False
        with sqlite3.connect(self.database_path) as database:
            database.execute("DELETE FROM files WHERE file_id = ?", (file_id,))
        Path(record["path"]).unlink(missing_ok=True)
        return True


class AttachmentServer(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(
        self,
        address,
        handler,
        store: FileStore,
        authenticator: SaslAuthenticator,
        max_file_bytes: int,
        public_base_url: str,
    ) -> None:
        super().__init__(address, handler)
        self.store = store
        self.authenticator = authenticator
        self.max_file_bytes = max_file_bytes
        self.public_base_url = public_base_url.rstrip("/")


class Handler(BaseHTTPRequestHandler):
    server: AttachmentServer

    def do_GET(self) -> None:
        if urlsplit(self.path).path == "/healthz":
            self.send_json(
                HTTPStatus.OK,
                {
                    "ok": True,
                    "storedBytes": self.server.store.usage(),
                    "quotaBytes": self.server.store.quota_bytes,
                },
            )
            return
        identity = self.identity()
        if identity is None:
            return
        record = self.file_record()
        if record is None:
            return
        self.send_response(HTTPStatus.OK)
        self.file_headers(record)
        self.end_headers()
        with Path(record["path"]).open("rb") as source:
            while chunk := source.read(1024 * 1024):
                self.wfile.write(chunk)

    def do_HEAD(self) -> None:
        identity = self.identity()
        if identity is None:
            return
        record = self.file_record()
        if record is None:
            return
        self.send_response(HTTPStatus.OK)
        self.file_headers(record)
        self.end_headers()

    def do_POST(self) -> None:
        if urlsplit(self.path).path != "/files":
            self.send_error(HTTPStatus.NOT_FOUND)
            return
        identity = self.identity()
        if identity is None:
            return
        length = self.content_length()
        if length is None:
            return
        filename = self.decoded_filename()
        if filename is None:
            return
        mime_type = self.headers.get("Content-Type", "").split(";", 1)[0].strip()
        if not mime_type:
            mime_type = mimetypes.guess_type(filename)[0] or "application/octet-stream"
        try:
            record = self.server.store.create(
                identity,
                filename,
                mime_type[:120],
                self.rfile,
                length,
            )
        except ValueError as error:
            self.send_json(HTTPStatus.INSUFFICIENT_STORAGE, {"error": str(error)})
            return
        record["url"] = f"{self.server.public_base_url}/{record['id']}"
        self.send_json(HTTPStatus.CREATED, record)

    def do_DELETE(self) -> None:
        identity = self.identity()
        if identity is None:
            return
        file_id = self.requested_file_id()
        if file_id is None:
            return
        if not self.server.store.delete(file_id, identity):
            self.send_error(HTTPStatus.NOT_FOUND)
            return
        self.send_response(HTTPStatus.NO_CONTENT)
        self.end_headers()

    def content_length(self) -> int | None:
        try:
            value = int(self.headers.get("Content-Length", ""))
        except ValueError:
            value = -1
        if value < 0:
            self.send_json(HTTPStatus.LENGTH_REQUIRED, {"error": "Content-Length is required"})
            return None
        if value == 0 or value > self.server.max_file_bytes:
            self.send_json(
                HTTPStatus.REQUEST_ENTITY_TOO_LARGE,
                {"error": f"files must be 1–{self.server.max_file_bytes} bytes"},
            )
            return None
        return value

    def decoded_filename(self) -> str | None:
        encoded = self.headers.get("X-Mimir-Filename", "")
        try:
            padding = "=" * (-len(encoded) % 4)
            filename = base64.urlsafe_b64decode(encoded + padding).decode("utf-8")
        except (ValueError, UnicodeDecodeError):
            filename = ""
        filename = Path(filename.replace("\0", "")).name.strip()
        if (
            not filename
            or len(filename.encode("utf-8")) > MAX_FILENAME_BYTES
            or filename in {".", ".."}
        ):
            self.send_json(HTTPStatus.BAD_REQUEST, {"error": "invalid filename"})
            return None
        return filename

    def identity(self) -> str | None:
        authorization = self.headers.get("Authorization", "")
        if not authorization.startswith("Basic "):
            self.require_authentication()
            return None
        try:
            decoded = base64.b64decode(
                authorization.removeprefix("Basic "),
                validate=True,
            ).decode("utf-8")
            account, password = decoded.split(":", 1)
        except (ValueError, UnicodeDecodeError):
            self.require_authentication()
            return None
        if (
            not account
            or not password
            or not self.server.authenticator.authenticate(account, password)
        ):
            self.require_authentication()
            return None
        return account

    def require_authentication(self) -> None:
        self.send_response(HTTPStatus.UNAUTHORIZED)
        self.send_header("WWW-Authenticate", 'Basic realm="Mimir Chat"')
        self.send_header("Content-Length", "0")
        self.end_headers()

    def requested_file_id(self) -> str | None:
        path = urlsplit(self.path).path
        if not path.startswith("/files/"):
            self.send_error(HTTPStatus.NOT_FOUND)
            return None
        file_id = path.removeprefix("/files/")
        if not FILE_ID.fullmatch(file_id):
            self.send_error(HTTPStatus.NOT_FOUND)
            return None
        return file_id

    def file_record(self) -> dict[str, object] | None:
        file_id = self.requested_file_id()
        if file_id is None:
            return None
        record = self.server.store.get(file_id)
        if record is None:
            self.send_error(HTTPStatus.NOT_FOUND)
            return None
        return record

    def file_headers(self, record: dict[str, object]) -> None:
        disposition = "attachment" if "download=1" in urlsplit(self.path).query else "inline"
        filename = quote(str(record["name"]), safe="")
        self.send_header("Content-Type", str(record["mime"]))
        self.send_header("Content-Length", str(record["size"]))
        self.send_header("ETag", f'"{record["sha256"]}"')
        self.send_header(
            "Content-Disposition",
            f"{disposition}; filename*=UTF-8''{filename}",
        )
        self.send_header("Cache-Control", "private, max-age=31536000, immutable")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Content-Security-Policy", "sandbox")

    def send_json(self, status: HTTPStatus, value: object) -> None:
        body = json.dumps(value, separators=(",", ":")).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, format: str, *args) -> None:
        # BaseHTTPRequestHandler never logs request headers; retain its concise
        # method/path/status line for journald diagnostics.
        super().log_message(format, *args)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--listen", default="127.0.0.1:8069")
    parser.add_argument("--ergo", default="127.0.0.1:16667")
    parser.add_argument("--data-dir", type=Path, required=True)
    parser.add_argument("--database", type=Path, required=True)
    parser.add_argument("--public-base-url", required=True)
    parser.add_argument("--max-file-bytes", type=int, default=25 * 1024 * 1024)
    parser.add_argument("--quota-bytes", type=int, default=5 * 1024 * 1024 * 1024)
    args = parser.parse_args()
    listen_host, listen_port = args.listen.rsplit(":", 1)
    ergo_host, ergo_port = args.ergo.rsplit(":", 1)
    store = FileStore(args.data_dir, args.database, args.quota_bytes)
    authenticator = SaslAuthenticator(ergo_host, int(ergo_port))
    server = AttachmentServer(
        (listen_host, int(listen_port)),
        Handler,
        store,
        authenticator,
        args.max_file_bytes,
        args.public_base_url,
    )
    server.serve_forever()


if __name__ == "__main__":
    main()
