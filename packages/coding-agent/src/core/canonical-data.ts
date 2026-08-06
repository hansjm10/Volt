import type { JsonValue } from "@hansjm10/volt-ai";

/** Typed admission failure for values outside Volt's lossless JSON data grammar. */
export class CanonicalDataError extends TypeError {
	readonly path: string;

	constructor(description: string, path: string, reason: string, options?: ErrorOptions) {
		super(`${description} must contain only JSON-compatible data; invalid value at ${path}: ${reason}`, options);
		this.name = "CanonicalDataError";
		this.path = path;
	}
}

function propertyPath(parent: string, key: string): string {
	return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key) ? `${parent}.${key}` : `${parent}[${JSON.stringify(key)}]`;
}

function fail(description: string, path: string, reason: string): never {
	throw new CanonicalDataError(description, path, reason);
}

function cloneValue(value: unknown, description: string, path: string, active: WeakSet<object>): JsonValue {
	if (value === null || typeof value === "string" || typeof value === "boolean") {
		return value;
	}
	if (typeof value === "number") {
		if (!Number.isFinite(value)) {
			fail(description, path, "numbers must be finite");
		}
		if (Object.is(value, -0)) {
			fail(description, path, "negative zero does not round-trip through JSON");
		}
		return value;
	}
	if (typeof value === "undefined") {
		fail(description, path, "undefined is not permitted; omit optional properties");
	}
	if (typeof value === "bigint") {
		fail(description, path, "bigint is not permitted");
	}
	if (typeof value === "symbol") {
		fail(description, path, "symbols are not permitted");
	}
	if (typeof value === "function") {
		fail(description, path, "functions are not permitted");
	}
	if (active.has(value)) {
		fail(description, path, "cyclic references are not permitted");
	}

	const prototype = Object.getPrototypeOf(value);
	if (Array.isArray(value)) {
		if (prototype !== Array.prototype) {
			fail(description, path, "arrays must use the ordinary Array prototype");
		}
		const descriptors = Object.getOwnPropertyDescriptors(value);
		for (const key of Reflect.ownKeys(descriptors)) {
			if (typeof key === "symbol") {
				fail(description, path, "symbol-keyed properties are not permitted");
			}
			if (key === "length") continue;
			const index = Number(key);
			if (!Number.isInteger(index) || index < 0 || index >= value.length || String(index) !== key) {
				fail(description, propertyPath(path, key), "extra array properties are not permitted");
			}
		}

		active.add(value);
		try {
			const clone: JsonValue[] = [];
			for (let index = 0; index < value.length; index++) {
				const descriptor = descriptors[String(index)];
				if (!descriptor) {
					fail(description, `${path}[${index}]`, "sparse arrays are not permitted");
				}
				if (!("value" in descriptor) || !descriptor.enumerable) {
					fail(description, `${path}[${index}]`, "array entries must be enumerable data properties");
				}
				clone.push(cloneValue(descriptor.value, description, `${path}[${index}]`, active));
			}
			return clone;
		} finally {
			active.delete(value);
		}
	}

	if (prototype !== Object.prototype) {
		fail(description, path, "objects must use the ordinary Object prototype");
	}
	const descriptors = Object.getOwnPropertyDescriptors(value);
	active.add(value);
	try {
		const clone: Record<string, JsonValue> = {};
		for (const key of Reflect.ownKeys(descriptors)) {
			if (typeof key === "symbol") {
				fail(description, path, "symbol-keyed properties are not permitted");
			}
			const descriptor = descriptors[key];
			const childPath = propertyPath(path, key);
			if (!("value" in descriptor)) {
				fail(description, childPath, "accessor properties are not permitted");
			}
			if (!descriptor.enumerable) {
				fail(description, childPath, "non-enumerable properties are not permitted");
			}
			Object.defineProperty(clone, key, {
				value: cloneValue(descriptor.value, description, childPath, active),
				enumerable: true,
				writable: true,
				configurable: true,
			});
		}
		return clone;
	} finally {
		active.delete(value);
	}
}

/** Clone and own a value after proving that JSON persistence preserves its data exactly. */
export function cloneCanonicalData<T>(value: T, description: string): T {
	try {
		return cloneValue(value, description, "$", new WeakSet<object>()) as T;
	} catch (error) {
		if (error instanceof CanonicalDataError) throw error;
		const reason = error instanceof Error && error.message ? error.message : String(error);
		throw new CanonicalDataError(description, "$", `validation failed: ${reason}`, { cause: error });
	}
}
