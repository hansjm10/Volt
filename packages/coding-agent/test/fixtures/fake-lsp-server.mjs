// Fake LSP server for tests. Speaks JSON-RPC over stdio.
//
// Behavior:
// - Responds to initialize with full-text sync (and a diagnostic provider when
//   started with --pull).
// - On didOpen/didChange, scans document text and publishes one diagnostic per
//   line containing "ERROR" (severity 1) or "WARN" (severity 2), after a short
//   delay to exercise the publish wait path. Like real servers, it republishes
//   for all open documents on every change.
// - Cross-file rule: a document containing "CROSS" gets an error when any
//   other open document contains "ERROR", mimicking dependency breakage.
// - In pull mode, answers textDocument/diagnostic from the same scan.
// - Answers definition/references/hover/documentSymbol with fixed shapes so
//   navigation formatting can be tested.
// - Publishes after a delay (default 50ms, configurable via --delay <ms>) to
//   exercise the publish wait paths.
// - Answers the custom "fake/state" request with observed notifications so
//   tests can assert sync behavior.
// - Exits on the exit notification.

const pullMode = process.argv.includes("--pull");
const configMode = process.argv.includes("--config");
const delayIndex = process.argv.indexOf("--delay");
const publishDelayMs = delayIndex !== -1 ? Number.parseInt(process.argv[delayIndex + 1], 10) : 50;
const documents = new Map();
const state = { opens: [], changes: [], closes: [], watched: [], configChanges: [], configResponses: undefined };
let buffer = Buffer.alloc(0);
let nextServerRequestId = 1000;
const pendingServerRequests = new Map();

function serverRequest(method, params, callback) {
	const id = nextServerRequestId++;
	pendingServerRequests.set(id, callback);
	send({ jsonrpc: "2.0", id, method, params });
}

function wordAt(lineText, character) {
	let start = character;
	let end = character;
	while (start > 0 && /\w/.test(lineText[start - 1])) start--;
	while (end < lineText.length && /\w/.test(lineText[end])) end++;
	return start < end ? lineText.slice(start, end) : undefined;
}

function buildReplaceEdit(uri, text, find, replace) {
	const lines = text.split("\n");
	for (let i = 0; i < lines.length; i++) {
		const index = lines[i].indexOf(find);
		if (index !== -1) {
			return {
				changes: {
					[uri]: [
						{
							range: { start: { line: i, character: index }, end: { line: i, character: index + find.length } },
							newText: replace,
						},
					],
				},
			};
		}
	}
	return { changes: {} };
}

function send(message) {
	const body = JSON.stringify(message);
	process.stdout.write(`Content-Length: ${Buffer.byteLength(body, "utf-8")}\r\n\r\n${body}`);
}

function scan(text, uri) {
	const diagnostics = [];
	if (text.includes("CROSS")) {
		for (const [otherUri, otherText] of documents) {
			if (otherUri !== uri && otherText.includes("ERROR")) {
				diagnostics.push({
					range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
					severity: 1,
					source: "fake",
					message: "cross-file ERROR detected",
				});
				break;
			}
		}
	}
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
	if (method === undefined) {
		// Response to a server-initiated request (e.g. workspace/applyEdit).
		const pending = pendingServerRequests.get(id);
		if (pending) {
			pendingServerRequests.delete(id);
			pending(message);
		}
		return;
	}
	if (method === "initialize") {
		send({
			jsonrpc: "2.0",
			id,
			result: {
				capabilities: {
					textDocumentSync: 1,
					definitionProvider: true,
					implementationProvider: true,
					typeDefinitionProvider: true,
					referencesProvider: true,
					hoverProvider: true,
					documentSymbolProvider: true,
					renameProvider: true,
					callHierarchyProvider: true,
					codeActionProvider: true,
					executeCommandProvider: { commands: ["fake.fix"] },
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
	if (method === "initialized") {
		if (configMode) {
			serverRequest(
				"workspace/configuration",
				{ items: [{ section: "foo.bar" }, { section: "missing.path" }, {}] },
				(response) => {
					state.configResponses = response.result;
				},
			);
		}
		return;
	}
	if (method === "workspace/didChangeConfiguration") {
		state.configChanges.push(params.settings);
		return;
	}
	if (method === "workspace/symbol") {
		const query = params.query ?? "";
		const symbols = [];
		if (query) {
			for (const [uri, text] of documents) {
				const lines = text.split("\n");
				for (let i = 0; i < lines.length; i++) {
					const index = lines[i].indexOf(query);
					if (index !== -1) {
						symbols.push({
							name: query,
							kind: 13,
							containerName: "fakeContainer",
							location: {
								uri,
								range: {
									start: { line: i, character: index },
									end: { line: i, character: index + query.length },
								},
							},
						});
						break;
					}
				}
			}
		}
		send({ jsonrpc: "2.0", id, result: symbols });
		return;
	}
	if (method === "exit") {
		process.exit(0);
	}
	if (method === "textDocument/didOpen") {
		documents.set(params.textDocument.uri, params.textDocument.text);
		state.opens.push(params.textDocument.uri);
		publishLater();
		return;
	}
	if (method === "textDocument/didChange") {
		documents.set(params.textDocument.uri, params.contentChanges[0].text);
		state.changes.push({ uri: params.textDocument.uri, version: params.textDocument.version });
		publishLater();
		return;
	}
	if (method === "textDocument/didClose") {
		documents.delete(params.textDocument.uri);
		state.closes.push(params.textDocument.uri);
		return;
	}
	if (method === "workspace/didChangeWatchedFiles") {
		state.watched.push(...params.changes);
		return;
	}
	if (method === "fake/state") {
		send({ jsonrpc: "2.0", id, result: state });
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
	if (method === "textDocument/implementation") {
		// Location[] form.
		send({
			jsonrpc: "2.0",
			id,
			result: [
				{ uri: params.textDocument.uri, range: { start: { line: 1, character: 0 }, end: { line: 1, character: 5 } } },
			],
		});
		return;
	}
	if (method === "textDocument/typeDefinition") {
		// Bare single-Location form to exercise normalization.
		send({
			jsonrpc: "2.0",
			id,
			result: { uri: params.textDocument.uri, range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } } },
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
	if (method === "textDocument/prepareCallHierarchy") {
		const text = documents.get(params.textDocument.uri) ?? "";
		const lines = text.split("\n");
		const word = wordAt(lines[params.position.line] ?? "", params.position.character);
		if (!word) {
			send({ jsonrpc: "2.0", id, result: null });
			return;
		}
		send({
			jsonrpc: "2.0",
			id,
			result: [
				{
					name: word,
					kind: 12,
					uri: params.textDocument.uri,
					range: { start: { line: params.position.line, character: 0 }, end: { line: params.position.line, character: 10 } },
					selectionRange: {
						start: { line: params.position.line, character: params.position.character },
						end: { line: params.position.line, character: params.position.character + word.length },
					},
				},
			],
		});
		return;
	}
	if (method === "callHierarchy/incomingCalls") {
		send({
			jsonrpc: "2.0",
			id,
			result: [
				{
					from: {
						name: "callerOne",
						kind: 12,
						uri: params.item.uri,
						range: { start: { line: 0, character: 0 }, end: { line: 0, character: 9 } },
						selectionRange: { start: { line: 0, character: 0 }, end: { line: 0, character: 9 } },
					},
					fromRanges: [{ start: { line: 0, character: 0 }, end: { line: 0, character: 9 } }],
				},
			],
		});
		return;
	}
	if (method === "callHierarchy/outgoingCalls") {
		send({
			jsonrpc: "2.0",
			id,
			result: [
				{
					to: {
						name: "calleeOne",
						kind: 6,
						uri: params.item.uri,
						range: { start: { line: 1, character: 0 }, end: { line: 1, character: 9 } },
						selectionRange: { start: { line: 1, character: 2 }, end: { line: 1, character: 11 } },
					},
					fromRanges: [{ start: { line: 1, character: 0 }, end: { line: 1, character: 9 } }],
				},
			],
		});
		return;
	}
	if (method === "textDocument/rename") {
		const text = documents.get(params.textDocument.uri) ?? "";
		const lines = text.split("\n");
		const word = wordAt(lines[params.position.line] ?? "", params.position.character);
		if (!word) {
			send({ jsonrpc: "2.0", id, result: null });
			return;
		}
		const changes = {};
		for (const [uri, docText] of documents) {
			const edits = [];
			docText.split("\n").forEach((lineText, lineIndex) => {
				const pattern = new RegExp(`\\b${word}\\b`, "g");
				let match = pattern.exec(lineText);
				while (match) {
					edits.push({
						range: {
							start: { line: lineIndex, character: match.index },
							end: { line: lineIndex, character: match.index + word.length },
						},
						newText: params.newName,
					});
					match = pattern.exec(lineText);
				}
			});
			if (edits.length > 0) changes[uri] = edits;
		}
		send({ jsonrpc: "2.0", id, result: { changes } });
		return;
	}
	if (method === "textDocument/codeAction") {
		const uri = params.textDocument.uri;
		const text = documents.get(uri) ?? "";
		const only = params.context?.only;
		if (Array.isArray(only) && only.includes("source.organizeImports")) {
			const actions = text.includes("UNSORTED")
				? [
						{
							title: "Organize imports",
							kind: "source.organizeImports",
							edit: buildReplaceEdit(uri, text, "UNSORTED", "SORTED"),
						},
					]
				: [];
			send({ jsonrpc: "2.0", id, result: actions });
			return;
		}
		const actions = [];
		if (text.includes("ERROR")) {
			actions.push({
				title: "Replace ERROR with FIXED",
				kind: "quickfix",
				edit: buildReplaceEdit(uri, text, "ERROR", "FIXED"),
			});
		}
		if (text.includes("CMDFIX")) {
			actions.push({
				title: "Fix via command",
				kind: "quickfix",
				command: { title: "Fix via command", command: "fake.fix", arguments: [uri] },
			});
		}
		if (text.includes("MULTI")) {
			actions.push({
				title: "Replace MULTI with CHOSEN",
				kind: "refactor",
				edit: buildReplaceEdit(uri, text, "MULTI", "CHOSEN"),
			});
		}
		send({ jsonrpc: "2.0", id, result: actions });
		return;
	}
	if (method === "workspace/executeCommand") {
		if (params.command === "fake.fix") {
			const uri = params.arguments[0];
			const edit = buildReplaceEdit(uri, documents.get(uri) ?? "", "CMDFIX", "FIXED");
			serverRequest("workspace/applyEdit", { edit }, () => {
				send({ jsonrpc: "2.0", id, result: null });
			});
			return;
		}
		send({ jsonrpc: "2.0", id, result: null });
		return;
	}
	if (method === "textDocument/diagnostic") {
		send({
			jsonrpc: "2.0",
			id,
			result: {
				kind: "full",
				items: scan(documents.get(params.textDocument.uri) ?? "", params.textDocument.uri),
			},
		});
		return;
	}
	if (id !== undefined) {
		send({ jsonrpc: "2.0", id, result: null });
	}
}

function publishLater() {
	if (pullMode) return;
	setTimeout(() => {
		for (const [uri, text] of documents) {
			send({
				jsonrpc: "2.0",
				method: "textDocument/publishDiagnostics",
				params: { uri, diagnostics: scan(text, uri) },
			});
		}
	}, publishDelayMs);
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
