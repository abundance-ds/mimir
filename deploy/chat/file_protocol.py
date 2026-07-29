#!/usr/bin/env python3
"""Verify authenticated upload/download/delete through the public Caddy edge.

The owner passphrase is read from stdin and is never logged.
"""

from __future__ import annotations

import base64
import hashlib
import http.client
import json
import sys
from urllib.error import HTTPError
from urllib.parse import urlsplit
from urllib.request import Request, urlopen


BASE_URL = "https://chat.shoulde.rs/files"
ACCOUNT = "waqr"
MAX_FILE_BYTES = 25 * 1024 * 1024


def request(url: str, password: str, method: str = "GET", body: bytes | None = None, headers=None):
    authorization = base64.b64encode(f"{ACCOUNT}:{password}".encode()).decode()
    request_headers = {
        "Authorization": "Basic " + authorization,
        **(headers or {}),
    }
    return urlopen(
        Request(url, data=body, headers=request_headers, method=method),
        timeout=10,
    )


def oversized_upload_is_rejected(password: str) -> None:
    """An over-limit Content-Length must be refused from the header alone,
    before any body bytes are accepted."""
    parts = urlsplit(BASE_URL)
    # The first authenticated request may pay an uncached Ergo SASL check
    # (up to ~7s) before any HTTP response exists.
    connection = http.client.HTTPSConnection(parts.netloc, timeout=30)
    try:
        authorization = base64.b64encode(f"{ACCOUNT}:{password}".encode()).decode()
        connection.putrequest("POST", parts.path)
        connection.putheader("Authorization", "Basic " + authorization)
        connection.putheader("Content-Type", "text/plain")
        connection.putheader(
            "X-Mimir-Filename",
            base64.urlsafe_b64encode(b"too-big.txt").decode().rstrip("="),
        )
        connection.putheader("Content-Length", str(MAX_FILE_BYTES + 1))
        connection.endheaders()
        response = connection.getresponse()
        if response.status != 413:
            raise SystemExit(
                f"oversized upload returned HTTP {response.status}, expected 413",
            )
    finally:
        connection.close()


def main() -> None:
    password = sys.stdin.read().strip()
    if not password:
        raise SystemExit(f"expected the {ACCOUNT} passphrase on stdin")
    try:
        urlopen(BASE_URL + "/not-authenticated", timeout=10)
    except HTTPError as error:
        if error.code != 401:
            raise
    else:
        raise SystemExit("attachment route accepted an unauthenticated request")
    oversized_upload_is_rejected(password)
    content = b"Mimir attachment transport verified.\n"
    filename = base64.urlsafe_b64encode(b"mimir-protocol.txt").decode().rstrip("=")
    with request(
        BASE_URL,
        password,
        method="POST",
        body=content,
        headers={
            "Content-Type": "text/plain",
            "X-Mimir-Filename": filename,
        },
    ) as response:
        if response.status != 201:
            raise SystemExit(f"upload returned HTTP {response.status}")
        record = json.load(response)
    expected = {
        "name": "mimir-protocol.txt",
        "mime": "text/plain",
        "size": len(content),
        "sha256": hashlib.sha256(content).hexdigest(),
    }
    for key, value in expected.items():
        if record.get(key) != value:
            raise SystemExit(f"upload metadata mismatch for {key}")
    file_url = record.get("url")
    if not isinstance(file_url, str) or not file_url.startswith(BASE_URL + "/"):
        raise SystemExit("upload did not return the canonical public URL")
    with request(file_url, password) as response:
        downloaded = response.read()
    if downloaded != content:
        raise SystemExit("download did not reproduce the uploaded bytes")
    with request(file_url, password, method="DELETE") as response:
        if response.status != 204:
            raise SystemExit(f"delete returned HTTP {response.status}")
    try:
        request(file_url, password)
    except HTTPError as error:
        if error.code != 404:
            raise
    else:
        raise SystemExit("deleted attachment is still retrievable")
    print(
        "production attachment protocol passed: auth boundary, size limit, "
        "upload, metadata, download, delete",
    )


if __name__ == "__main__":
    main()
