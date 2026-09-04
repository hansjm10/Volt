import { type SessionStoreInfo, SQLiteSessionStoreClient } from "../../src/core/session-store/index.ts";

export type OpenStoreChildRequest =
	| { readonly kind: "open"; readonly sessionDirectory: string }
	| { readonly kind: "close" };

export type OpenStoreChildResponse =
	| { readonly kind: "ready" }
	| { readonly kind: "opening" }
	| { readonly kind: "opened"; readonly info: SessionStoreInfo }
	| { readonly kind: "error"; readonly code?: string; readonly message: string }
	| { readonly kind: "closed" };

let client: SQLiteSessionStoreClient | undefined;
let opening = false;
let finishing = false;

function send(response: OpenStoreChildResponse): void {
	if (!process.send) throw new Error("Session store child fixture requires an IPC channel");
	process.send(response);
}

function finish(response: Extract<OpenStoreChildResponse, { kind: "error" | "closed" }>): void {
	if (finishing) return;
	finishing = true;
	if (!process.send) {
		process.exit();
		return;
	}
	process.send(response, () => process.disconnect());
}

function errorResponse(error: unknown): Extract<OpenStoreChildResponse, { kind: "error" }> {
	const code = error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : undefined;
	return {
		kind: "error",
		...(code === undefined ? {} : { code }),
		message: error instanceof Error ? error.message : String(error),
	};
}

function parseRequest(message: unknown): OpenStoreChildRequest {
	if (!message || typeof message !== "object" || !("kind" in message)) {
		throw new TypeError("Invalid session store child request");
	}
	if (message.kind === "close") return { kind: "close" };
	if (message.kind === "open" && "sessionDirectory" in message && typeof message.sessionDirectory === "string") {
		return { kind: "open", sessionDirectory: message.sessionDirectory };
	}
	throw new TypeError("Invalid session store child request");
}

async function handleRequest(message: unknown): Promise<void> {
	const request = parseRequest(message);
	if (request.kind === "open") {
		if (opening || client) throw new Error("Session store child fixture already opened a client");
		opening = true;
		send({ kind: "opening" });
		try {
			client = await SQLiteSessionStoreClient.open(request.sessionDirectory);
			send({ kind: "opened", info: client.info });
		} finally {
			opening = false;
		}
		return;
	}

	const openedClient = client;
	client = undefined;
	if (openedClient) await openedClient.close();
	finish({ kind: "closed" });
}

process.on("message", (message: unknown) => {
	void handleRequest(message).catch(async (error: unknown) => {
		const openedClient = client;
		client = undefined;
		if (openedClient) await openedClient.close().catch(() => undefined);
		process.exitCode = 1;
		finish(errorResponse(error));
	});
});

process.on("disconnect", () => {
	const openedClient = client;
	client = undefined;
	if (openedClient) void openedClient.close();
});

send({ kind: "ready" });
