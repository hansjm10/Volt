function attachJsonlReader(readable, onLine) {
	let buffer = "";
	readable.setEncoding("utf8");
	readable.on("data", (chunk) => {
		buffer += chunk;
		while (true) {
			const newlineIndex = buffer.indexOf("\n");
			if (newlineIndex === -1) break;
			let line = buffer.slice(0, newlineIndex);
			buffer = buffer.slice(newlineIndex + 1);
			if (line.endsWith("\r")) line = line.slice(0, -1);
			onLine(line);
		}
	});
	readable.on("end", () => {
		if (buffer.length === 0) return;
		const line = buffer.endsWith("\r") ? buffer.slice(0, -1) : buffer;
		onLine(line);
	});
}

function write(value) {
	process.stdout.write(`${JSON.stringify(value)}\n`);
}

function usage() {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function textMessage(text) {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "fake-rpc",
		provider: "iroh-poc",
		model: "fake",
		usage: usage(),
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

async function writePromptResponse(command) {
	const responseText = `fake RPC response over Iroh: ${command.message}`;
	const message = textMessage(responseText);

	write({ id: command.id, type: "response", command: "prompt", success: true });
	write({ type: "agent_start" });
	write({ type: "turn_start" });
	write({ type: "message_start", message });

	for (const word of responseText.split(/(\s+)/)) {
		if (word.length === 0) continue;
		write({
			type: "message_update",
			message,
			assistantMessageEvent: {
				type: "text_delta",
				contentIndex: 0,
				delta: word,
				partial: message,
			},
		});
		await new Promise((resolve) => setTimeout(resolve, 20));
	}

	write({ type: "message_end", message });
	write({ type: "turn_end", message, toolResults: [] });
	write({ type: "agent_end", messages: [message] });
}

function writeStateResponse(command) {
	write({
		id: command.id,
		type: "response",
		command: "get_state",
		success: true,
		data: {
			model: { provider: "iroh-poc", id: "fake", name: "Fake RPC" },
			thinkingLevel: "off",
			isStreaming: false,
			isCompacting: false,
			steeringMode: "one-at-a-time",
			followUpMode: "one-at-a-time",
			sessionId: "fake-session",
			sessionName: "Iroh PoC fake RPC",
			autoCompactionEnabled: false,
			messageCount: 0,
			pendingMessageCount: 0,
		},
	});
}

async function handleLine(line) {
	if (line.trim().length === 0) return;

	let command;
	try {
		command = JSON.parse(line);
	} catch (error) {
		write({
			type: "response",
			command: "parse",
			success: false,
			error: error instanceof Error ? error.message : String(error),
		});
		return;
	}

	if (command.type === "get_state") {
		writeStateResponse(command);
		return;
	}

	if (command.type === "prompt") {
		await writePromptResponse(command);
		return;
	}

	if (command.type === "abort") {
		write({ id: command.id, type: "response", command: "abort", success: true });
		return;
	}

	write({
		id: command.id,
		type: "response",
		command: command.type ?? "unknown",
		success: false,
		error: `fake-rpc does not implement ${command.type}`,
	});
}

attachJsonlReader(process.stdin, (line) => {
	void handleLine(line);
});
