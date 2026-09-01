import { createHash } from "node:crypto";
import type { SessionStoreJsonValue, SessionStoreTransactionPayload } from "./types.ts";

const COMMIT_DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/u;

function childPath(parent: string, key: string): string {
	return /^[A-Za-z_$][A-Za-z0-9_$]*$/u.test(key) ? `${parent}.${key}` : `${parent}[${JSON.stringify(key)}]`;
}

function fail(description: string, path: string, reason: string): never {
	throw new TypeError(`${description} contains invalid JSON data at ${path}: ${reason}`);
}

function canonicalize(
	value: unknown,
	description: string,
	path: string,
	active: WeakSet<object>,
): SessionStoreJsonValue {
	if (value === null || typeof value === "string" || typeof value === "boolean") return value;
	if (typeof value === "number") {
		if (!Number.isFinite(value)) fail(description, path, "numbers must be finite");
		if (Object.is(value, -0)) fail(description, path, "negative zero is not canonical JSON");
		return value;
	}
	if (typeof value !== "object") {
		fail(description, path, `${typeof value} values are not permitted`);
	}
	if (active.has(value)) fail(description, path, "cyclic references are not permitted");

	const prototype = Object.getPrototypeOf(value);
	const descriptors = Object.getOwnPropertyDescriptors(value);
	if (Array.isArray(value)) {
		if (prototype !== Array.prototype) fail(description, path, "arrays must use the ordinary Array prototype");
		for (const key of Reflect.ownKeys(descriptors)) {
			if (typeof key === "symbol") fail(description, path, "symbol properties are not permitted");
			if (key === "length") continue;
			const index = Number(key);
			if (!Number.isInteger(index) || index < 0 || index >= value.length || String(index) !== key) {
				fail(description, childPath(path, key), "extra array properties are not permitted");
			}
		}
		active.add(value);
		try {
			const result: SessionStoreJsonValue[] = [];
			for (let index = 0; index < value.length; index += 1) {
				const descriptor = descriptors[String(index)];
				if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
					fail(description, `${path}[${index}]`, "sparse or non-data array entries are not permitted");
				}
				result.push(canonicalize(descriptor.value, description, `${path}[${index}]`, active));
			}
			return result;
		} finally {
			active.delete(value);
		}
	}

	if (prototype !== Object.prototype) fail(description, path, "objects must use the ordinary Object prototype");
	active.add(value);
	try {
		const result: Record<string, SessionStoreJsonValue> = {};
		const keys: string[] = [];
		for (const key of Reflect.ownKeys(descriptors)) {
			if (typeof key === "symbol") fail(description, path, "symbol properties are not permitted");
			keys.push(key);
		}
		keys.sort();
		for (const key of keys) {
			const descriptor = descriptors[key];
			if (!("value" in descriptor) || !descriptor.enumerable) {
				fail(description, childPath(path, key), "properties must be enumerable data properties");
			}
			Object.defineProperty(result, key, {
				value: canonicalize(descriptor.value, description, childPath(path, key), active),
				enumerable: true,
				writable: true,
				configurable: true,
			});
		}
		return result;
	} finally {
		active.delete(value);
	}
}

export function cloneCanonicalSessionStoreJson(value: unknown, description: string): SessionStoreJsonValue {
	return canonicalize(value, description, "$", new WeakSet<object>());
}

export function stringifyCanonicalSessionStoreJson(value: unknown, description: string): string {
	return JSON.stringify(cloneCanonicalSessionStoreJson(value, description));
}

export function parseCanonicalSessionStoreJson(text: string, description: string): SessionStoreJsonValue {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (error) {
		throw new TypeError(`${description} is not valid JSON`, { cause: error });
	}
	const canonical = stringifyCanonicalSessionStoreJson(parsed, description);
	if (canonical !== text) throw new TypeError(`${description} is not encoded as canonical JSON`);
	return cloneCanonicalSessionStoreJson(parsed, description);
}

export function digestSessionStoreTransactionPayload(payload: SessionStoreTransactionPayload): string {
	const canonical = stringifyCanonicalSessionStoreJson(payload, "Session store transaction payload");
	return `sha256:${createHash("sha256").update(canonical, "utf8").digest("hex")}`;
}

export function isSessionStoreCommitDigest(value: unknown): value is string {
	return typeof value === "string" && COMMIT_DIGEST_PATTERN.test(value);
}
