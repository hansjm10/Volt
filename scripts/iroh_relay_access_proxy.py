#!/usr/bin/env python3
"""Add HTTP/1.1 framing required by the fixed managed-relay callback."""

from __future__ import annotations

import http.server
import re
import ssl
import urllib.error
import urllib.request
UPSTREAM_URL = "https://iroh-enrollment-us-central.volt-cli.dev/v1/relay-access"
LISTEN_ADDRESS = ("127.0.0.1", 9081)
CALLBACK_PATH = "/v1/relay-access"
MAX_UPSTREAM_BODY_BYTES = 16 * 1024
UPSTREAM_TIMEOUT_SECONDS = 10
ENDPOINT_ID_PATTERN = re.compile(r"^[0-9a-f]{64}$")


class NoRedirectHandler(urllib.request.HTTPRedirectHandler):
    """Never forward the relay bearer to a redirected origin."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


UPSTREAM_OPENER = urllib.request.build_opener(
    urllib.request.ProxyHandler({}),
    urllib.request.HTTPSHandler(context=ssl.create_default_context()),
    NoRedirectHandler(),
)


class RelayAccessProxyHandler(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def do_POST(self) -> None:
        if self.path != CALLBACK_PATH or not self._has_empty_body():
            self._respond(400, b"false")
            return
        try:
            authorization = self._single_header("Authorization", required=True)
            endpoint_id = self._single_header("X-Iroh-NodeId", required=False)
        except ValueError:
            self._respond(400, b"false")
            return
        if endpoint_id is not None and ENDPOINT_ID_PATTERN.fullmatch(endpoint_id) is None:
            self._respond(400, b"false")
            return

        assert authorization is not None
        headers: dict[str, str] = {
            "Authorization": authorization,
            "Content-Length": "0",
        }
        if endpoint_id is not None:
            headers["X-Iroh-NodeId"] = endpoint_id
        request = urllib.request.Request(
            UPSTREAM_URL,
            data=b"",
            headers=headers,
            method="POST",
        )
        try:
            response = UPSTREAM_OPENER.open(
                request,
                timeout=UPSTREAM_TIMEOUT_SECONDS,
            )
        except urllib.error.HTTPError as error:
            response = error
        except (OSError, urllib.error.URLError, TimeoutError):
            self._respond(502, b"false")
            return

        with response:
            status = getattr(response, "status", None)
            if not isinstance(status, int):
                status = response.getcode()
            body = response.read(MAX_UPSTREAM_BODY_BYTES + 1)
            if not isinstance(status, int) or not 100 <= status <= 599 or len(body) > MAX_UPSTREAM_BODY_BYTES:
                self._respond(502, b"false")
                return
            self._respond(status, body)

    def do_GET(self) -> None:
        self._respond(405, b"false")

    def log_message(self, format: str, *args: object) -> None:
        # Do not place endpoint identities or callback headers in service logs.
        return

    def _has_empty_body(self) -> bool:
        if self.headers.get_all("Transfer-Encoding", []) != []:
            return False
        content_lengths = self.headers.get_all("Content-Length", [])
        return content_lengths == [] or content_lengths == ["0"]

    def _single_header(self, name: str, *, required: bool) -> str | None:
        values = self.headers.get_all(name, [])
        if values == [] and not required:
            return None
        if len(values) != 1:
            raise ValueError(f"invalid {name} header count")
        value = values[0]
        if not 1 <= len(value) <= 1024 or any(ord(character) < 0x20 or ord(character) > 0x7E for character in value):
            raise ValueError(f"invalid {name} header")
        return value

    def _respond(self, status: int, body: bytes) -> None:
        self.send_response(status)
        self.send_header("Content-Type", "text/plain")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Connection", "close")
        self.end_headers()
        try:
            self.wfile.write(body)
        except BrokenPipeError:
            pass
        self.close_connection = True


class RelayAccessProxyServer(http.server.ThreadingHTTPServer):
    allow_reuse_address = True
    daemon_threads = True


def main() -> None:
    with RelayAccessProxyServer(LISTEN_ADDRESS, RelayAccessProxyHandler) as server:
        server.serve_forever()


if __name__ == "__main__":
    main()
