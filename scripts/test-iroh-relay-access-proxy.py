#!/usr/bin/env python3

from __future__ import annotations

import http.client
import http.server
import socket
import sys
import threading
import unittest
import urllib.request
from typing import cast

sys.dont_write_bytecode = True
import iroh_relay_access_proxy as PROXY  # noqa: E402  # pyright: ignore[reportMissingImports]


class UpstreamHandler(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    requests: list[dict[str, object]] = []

    def do_POST(self) -> None:
        content_length = self.headers.get("Content-Length")
        body = self.rfile.read(int(content_length or "0"))
        self.requests.append(
            {
                "authorization": self.headers.get("Authorization"),
                "content_lengths": self.headers.get_all("Content-Length", []),
                "endpoint_id": self.headers.get("X-Iroh-NodeId"),
                "body": body,
            }
        )
        status = 200 if self.headers.get("X-Iroh-NodeId") is not None else 400
        response = b"true" if status == 200 else b'{"error":"endpoint_id_invalid"}'
        self.send_response(status)
        self.send_header("Content-Length", str(len(response)))
        self.end_headers()
        self.wfile.write(response)

    def log_message(self, format: str, *args: object) -> None:
        return


class RelayAccessProxyTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.upstream = http.server.ThreadingHTTPServer(("127.0.0.1", 0), UpstreamHandler)
        cls.upstream_thread = threading.Thread(target=cls.upstream.serve_forever, daemon=True)
        cls.upstream_thread.start()
        host = cls.upstream.server_address[0]
        port = cls.upstream.server_address[1]
        assert isinstance(host, str) and isinstance(port, int)
        PROXY.UPSTREAM_URL = f"http://{host}:{port}/v1/relay-access"
        PROXY.UPSTREAM_OPENER = urllib.request.build_opener(
            urllib.request.ProxyHandler({}),
            PROXY.NoRedirectHandler(),
        )
        cls.proxy = PROXY.RelayAccessProxyServer(("127.0.0.1", 0), PROXY.RelayAccessProxyHandler)
        cls.proxy_thread = threading.Thread(target=cls.proxy.serve_forever, daemon=True)
        cls.proxy_thread.start()

    @classmethod
    def tearDownClass(cls) -> None:
        cls.proxy.shutdown()
        cls.proxy.server_close()
        cls.upstream.shutdown()
        cls.upstream.server_close()

    def setUp(self) -> None:
        UpstreamHandler.requests.clear()

    def request(self, raw_request: bytes) -> tuple[int, bytes]:
        address = cast(tuple[str, int], self.proxy.server_address)
        with socket.create_connection(address, timeout=2) as connection:
            connection.sendall(raw_request)
            response = http.client.HTTPResponse(connection)
            response.begin()
            return response.status, response.read()

    def test_adds_zero_content_length_and_forwards_only_required_headers(self) -> None:
        endpoint_id = "a" * 64
        status, body = self.request(
            (
                "POST /v1/relay-access HTTP/1.1\r\n"
                "Host: 127.0.0.1\r\n"
                "Authorization: Bearer test-secret\r\n"
                f"X-Iroh-NodeId: {endpoint_id}\r\n"
                "X-Untrusted: do-not-forward\r\n"
                "Connection: close\r\n\r\n"
            ).encode()
        )
        self.assertEqual((status, body), (200, b"true"))
        self.assertEqual(
            UpstreamHandler.requests,
            [
                {
                    "authorization": "Bearer test-secret",
                    "content_lengths": ["0"],
                    "endpoint_id": endpoint_id,
                    "body": b"",
                }
            ],
        )

    def test_missing_endpoint_header_reaches_upstream_health_contract(self) -> None:
        status, _ = self.request(
            b"POST /v1/relay-access HTTP/1.1\r\n"
            b"Host: 127.0.0.1\r\n"
            b"Authorization: Bearer test-secret\r\n"
            b"Connection: close\r\n\r\n"
        )
        self.assertEqual(status, 400)
        self.assertEqual(len(UpstreamHandler.requests), 1)

    def test_rejects_nonempty_requests_without_contacting_upstream(self) -> None:
        status, body = self.request(
            b"POST /v1/relay-access HTTP/1.1\r\n"
            b"Host: 127.0.0.1\r\n"
            b"Authorization: Bearer test-secret\r\n"
            b"Content-Length: 1\r\n"
            b"Connection: close\r\n\r\nx"
        )
        self.assertEqual((status, body), (400, b"false"))
        self.assertEqual(UpstreamHandler.requests, [])


if __name__ == "__main__":
    unittest.main()
