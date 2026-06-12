// Fake LSP server for tests. Speaks JSON-RPC over stdio.
//
// Behavior:
// - Responds to initialize with full-text sync (and a diagnostic provider when
//   started with --pull).
// - On didOpen/didChange, scans the document text and publishes one diagnostic
//   per line containing "ERROR" (severity 1) or "WARN" (severity 2), after a
//   short delay to exercise the publish wait path.
// - In pull mode, answers textDocument/diagnostic from the same scan.
// - Answers definition/references/hover/documentSymbol with fixed shapes so
//   navigation formatting can be tested.
// - Exits on the exit notification.

const pullMode = process.argv.includes("--pull");
const documents = new Map();
let buffer = Buffer.alloc(0);

function send(message) {
	const body = JSON.stringify(message);
	process.stdout.write(`Content-Length: ${Buffer.byteLength(body, "utf-8")}\r\n\r\n${body}`);
}

function scan(text) {
	const diagnostics = [];
	const lines = text.split("\n");
	for (let i = 0; i < lines.length; i++) {
		const errorIndex = lines[i].indexOf("ERROR");
		if (errorIndex !== -1) {
			diagnostics.push({
				range: { start: { line: i, character: errorIndex }, end: { line: i, character: errorIndex + 5 } },
				severity: 1,
				code: 1234,
				source: "fake",
				message: `found ERROR on line ${i + 1}`,
			});
		}
		const warnIndex = lines[i].indexOf("WARN");
		if (warnIndex !== -1) {
			diagnostics.push({
				range: { start: { line: i, character: warnIndex }, end: { line: i, character: warnIndex + 4 } },
				severity: 2,
				source: "fake",
				message: `found WARN on line ${i + 1}`,
			});
		}
	}
	return diagnostics;
}

function handle(message) {
	const { id, method, params } = message;
	if (method === "initialize") {
		send({
			jsonrpc: "2.0",
			id,
			result: {
				capabilities: {
					textDocumentSync: 1,
					definitionProvider: true,
					referencesProvider: true,
					hoverProvider: true,
					documentSymbolProvider: true,
					...(pullMode ? { diagnosticProvider: { interFileDependencies: false, workspaceDiagnostics: false } } : {}),
				},
			},
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
	if (method === "textDocument/didOpen") {
		documents.set(params.textDocument.uri, params.textDocument.text);
		publishLater(params.textDocument.uri);
		return;
	}
	if (method === "textDocument/didChange") {
		documents.set(params.textDocument.uri, params.contentChanges[0].text);
		publishLater(params.textDocument.uri);
		return;
	}
	if (method === "textDocument/definition") {
		// LocationLink form to exercise link normalization.
		send({
			jsonrpc: "2.0",
			id,
			result: [
				{
					targetUri: params.textDocument.uri,
					targetRange: { start: { line: 0, character: 0 }, end: { line: 0, character: 10 } },
					targetSelectionRange: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
				},
			],
		});
		return;
	}
	if (method === "textDocument/references") {
		send({
			jsonrpc: "2.0",
			id,
			result: [
				{ uri: params.textDocument.uri, range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } } },
				{ uri: params.textDocument.uri, range: { start: { line: 1, character: 2 }, end: { line: 1, character: 7 } } },
			],
		});
		return;
	}
	if (method === "textDocument/hover") {
		send({
			jsonrpc: "2.0",
			id,
			result: { contents: { kind: "markdown", value: "fake hover text" } },
		});
		return;
	}
	if (method === "textDocument/documentSymbol") {
		send({
			jsonrpc: "2.0",
			id,
			result: [
				{
					name: "FakeClass",
					kind: 5,
					range: { start: { line: 0, character: 0 }, end: { line: 5, character: 0 } },
					selectionRange: { start: { line: 0, character: 6 }, end: { line: 0, character: 15 } },
					children: [
						{
							name: "fakeMethod",
							kind: 6,
							range: { start: { line: 1, character: 0 }, end: { line: 2, character: 0 } },
							selectionRange: { start: { line: 1, character: 2 }, end: { line: 1, character: 12 } },
						},
					],
				},
			],
		});
		return;
	}
	if (method === "textDocument/diagnostic") {
		send({
			jsonrpc: "2.0",
			id,
			result: { kind: "full", items: scan(documents.get(params.textDocument.uri) ?? "") },
		});
		return;
	}
	if (id !== undefined) {
		send({ jsonrpc: "2.0", id, result: null });
	}
}

function publishLater(uri) {
	if (pullMode) return;
	setTimeout(() => {
		send({
			jsonrpc: "2.0",
			method: "textDocument/publishDiagnostics",
			params: { uri, diagnostics: scan(documents.get(uri) ?? "") },
		});
	}, 50);
}

process.stdin.on("data", (chunk) => {
	buffer = Buffer.concat([buffer, chunk]);
	while (true) {
		const headerEnd = buffer.indexOf("\r\n\r\n");
		if (headerEnd === -1) return;
		const match = /Content-Length:\s*(\d+)/i.exec(buffer.subarray(0, headerEnd).toString("ascii"));
		if (!match) {
			buffer = buffer.subarray(headerEnd + 4);
			continue;
		}
		const length = Number.parseInt(match[1], 10);
		const start = headerEnd + 4;
		if (buffer.length < start + length) return;
		const body = buffer.subarray(start, start + length).toString("utf-8");
		buffer = buffer.subarray(start + length);
		try {
			handle(JSON.parse(body));
		} catch {
			// Ignore malformed messages.
		}
	}
});
