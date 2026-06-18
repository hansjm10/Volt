import { Buffer } from "node:buffer";
import { StringDecoder } from "node:string_decoder";
import { once } from "node:events";
import {
	decodeIrohRemoteTicketPayload,
	encodeIrohRemoteTicketPayload,
	IROH_REMOTE_ALPN,
	IROH_REMOTE_TICKET_PREFIX,
} from "@earendil-works/volt-coding-agent";

export const ALPN_TEXT = IROH_REMOTE_ALPN;
export const ALPN = Array.from(Buffer.from(ALPN_TEXT, "utf8"));
export const TICKET_PREFIX = IROH_REMOTE_TICKET_PREFIX;
export const DEFAULT_READ_LIMIT = 64 * 1024;

export function toBytes(text) {
	return Array.from(Buffer.from(text, "utf8"));
}

export function fromBytes(bytes) {
	return Buffer.from(bytes).toString("utf8");
}

export function serializeJsonLine(value) {
	return `${JSON.stringify(value)}\n`;
}

export function encodeTicketPayload(payload) {
	return encodeIrohRemoteTicketPayload(payload);
}

export function decodeTicketPayload(ticket) {
	return decodeIrohRemoteTicketPayload(ticket);
}

export function parseFlags(argv) {
	const flags = new Map();
	const positionals = [];

	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		if (!arg.startsWith("--")) {
			positionals.push(arg);
			continue;
		}

		const equalsIndex = arg.indexOf("=");
		if (equalsIndex !== -1) {
			flags.set(arg.slice(2, equalsIndex), arg.slice(equalsIndex + 1));
			continue;
		}

		const name = arg.slice(2);
		const next = argv[index + 1];
		if (next !== undefined && !next.startsWith("--")) {
			flags.set(name, next);
			index += 1;
			continue;
		}

		flags.set(name, "true");
	}

	return { flags, positionals };
}

export function getFlag(flags, name, fallback) {
	return flags.get(name) ?? fallback;
}

export function hasFlag(flags, name) {
	return flags.has(name) && flags.get(name) !== "false";
}

export function attachNodeJsonlReader(readable, onLine) {
	const decoder = new StringDecoder("utf8");
	let buffer = "";

	const handleData = (chunk) => {
		buffer += typeof chunk === "string" ? chunk : decoder.write(chunk);

		while (true) {
			const newlineIndex = buffer.indexOf("\n");
			if (newlineIndex === -1) break;

			let line = buffer.slice(0, newlineIndex);
			buffer = buffer.slice(newlineIndex + 1);
			if (line.endsWith("\r")) line = line.slice(0, -1);
			onLine(line);
		}
	};

	const handleEnd = () => {
		buffer += decoder.end();
		if (buffer.length === 0) return;
		const line = buffer.endsWith("\r") ? buffer.slice(0, -1) : buffer;
		onLine(line);
	};

	readable.on("data", handleData);
	readable.on("end", handleEnd);

	return () => {
		readable.off("data", handleData);
		readable.off("end", handleEnd);
	};
}

export async function writeNodeStream(writable, chunk) {
	if (writable.write(chunk)) return;
	await once(writable, "drain");
}

export async function writeIrohStream(send, chunk) {
	if (chunk.length === 0) return;
	await send.writeAll(Array.from(Buffer.from(chunk)));
}

export async function readLineFromIroh(recv, initial = Buffer.alloc(0), options = {}) {
	const maxLineBytes = options.maxLineBytes;
	const readLimit = Math.min(DEFAULT_READ_LIMIT, maxLineBytes === undefined ? DEFAULT_READ_LIMIT : maxLineBytes + 1);
	let buffer = Buffer.from(initial);

	while (true) {
		const newlineIndex = buffer.indexOf(10);
		if (newlineIndex !== -1) {
			let lineBuffer = buffer.subarray(0, newlineIndex);
			if (lineBuffer.length > 0 && lineBuffer[lineBuffer.length - 1] === 13) {
				lineBuffer = lineBuffer.subarray(0, lineBuffer.length - 1);
			}
			if (maxLineBytes !== undefined && lineBuffer.length > maxLineBytes) {
				throw new Error(`Line exceeds maximum size of ${maxLineBytes} bytes`);
			}
			return {
				line: lineBuffer.toString("utf8"),
				rest: buffer.subarray(newlineIndex + 1),
			};
		}

		if (maxLineBytes !== undefined && buffer.length > maxLineBytes) {
			throw new Error(`Line exceeds maximum size of ${maxLineBytes} bytes`);
		}

		const chunk = await recv.read(readLimit);
		if (!chunk || chunk.length === 0) {
			return { line: undefined, rest: buffer };
		}
		buffer = Buffer.concat([buffer, Buffer.from(chunk)]);
	}
}

export async function readJsonlFromIroh(recv, onLine, initial = Buffer.alloc(0)) {
	let buffer = Buffer.from(initial);

	while (true) {
		while (true) {
			const newlineIndex = buffer.indexOf(10);
			if (newlineIndex === -1) break;

			let lineBuffer = buffer.subarray(0, newlineIndex);
			buffer = buffer.subarray(newlineIndex + 1);
			if (lineBuffer.length > 0 && lineBuffer[lineBuffer.length - 1] === 13) {
				lineBuffer = lineBuffer.subarray(0, lineBuffer.length - 1);
			}
			onLine(lineBuffer.toString("utf8"));
		}

		const chunk = await recv.read(DEFAULT_READ_LIMIT);
		if (!chunk || chunk.length === 0) break;
		buffer = Buffer.concat([buffer, Buffer.from(chunk)]);
	}

	if (buffer.length > 0) {
		onLine(buffer.toString("utf8"));
	}
}

export async function pipeIrohRecvToNodeWritable(recv, writable, initial = Buffer.alloc(0)) {
	if (initial.length > 0) {
		await writeNodeStream(writable, initial);
	}

	while (true) {
		const chunk = await recv.read(DEFAULT_READ_LIMIT);
		if (!chunk || chunk.length === 0) break;
		await writeNodeStream(writable, Buffer.from(chunk));
	}
}

export async function pipeNodeReadableToIrohSend(readable, send) {
	for await (const chunk of readable) {
		await writeIrohStream(send, chunk);
	}
	await send.finish();
}
