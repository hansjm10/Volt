let buffer = Buffer.alloc(0);

function send(message) {
	const body = JSON.stringify(message);
	process.stdout.write(`Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n${body}`);
}

function handle(message) {
	const { id, method } = message;
	if (method === "initialize") {
		send({
			jsonrpc: "2.0",
			id,
			result: { capabilities: { textDocumentSync: 1, hoverProvider: true } },
		});
		return;
	}
	if (method === "textDocument/hover") {
		send({
			jsonrpc: "2.0",
			id,
			result: { contents: { kind: "markdown", value: "benchmark hover" } },
		});
		return;
	}
	if (method === "shutdown") {
		send({ jsonrpc: "2.0", id, result: null });
		return;
	}
	if (method === "exit") {
		process.exit(0);
	}
	if (id !== undefined) send({ jsonrpc: "2.0", id, result: null });
}

process.stdin.on("data", (chunk) => {
	buffer = Buffer.concat([buffer, chunk]);
	while (true) {
		const headerEnd = buffer.indexOf("\r\n\r\n");
		if (headerEnd === -1) break;
		const match = /Content-Length:\s*(\d+)/i.exec(buffer.subarray(0, headerEnd).toString("ascii"));
		if (!match) {
			buffer = buffer.subarray(headerEnd + 4);
			continue;
		}
		const length = Number.parseInt(match[1], 10);
		const bodyStart = headerEnd + 4;
		if (buffer.length < bodyStart + length) break;
		const body = buffer.subarray(bodyStart, bodyStart + length).toString("utf8");
		buffer = buffer.subarray(bodyStart + length);
		try {
			handle(JSON.parse(body));
		} catch {
			// Ignore malformed benchmark fixture input.
		}
	}
});
