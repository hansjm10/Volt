type StructuredClonePrimitive = string | number | bigint | boolean | null | undefined;
type StructuredCloneAtomic = Date | RegExp | Error | ArrayBuffer | SharedArrayBuffer | ArrayBufferView;

/**
 * Recursively rejects values that are known not to be supported by the
 * structured clone algorithm while preserving the caller's concrete shape.
 * Runtime validation remains authoritative because platform objects cannot be
 * classified exhaustively by TypeScript.
 */
export type StructuredCloneable<T> = T extends symbol | CallableFunction
	? never
	: T extends Promise<unknown> | WeakMap<object, unknown> | WeakSet<object>
		? never
		: T extends StructuredClonePrimitive | StructuredCloneAtomic
			? T
			: T extends ReadonlyMap<infer Key, infer Value>
				? Map<StructuredCloneable<Key>, StructuredCloneable<Value>>
				: T extends ReadonlySet<infer Value>
					? Set<StructuredCloneable<Value>>
					: T extends readonly unknown[]
						? { [Index in keyof T]: StructuredCloneable<T[Index]> }
						: T extends object
							? { [Key in keyof T]: StructuredCloneable<T[Key]> }
							: never;

/** A value whose concrete type is statically checked for structured-clone safety. */
export type StructuredCloneableInput<T> = T & StructuredCloneable<T>;

function structuredCloneError(description: string, cause: unknown): TypeError {
	const detail = cause instanceof Error && cause.message ? `: ${cause.message}` : "";
	return new TypeError(`${description} must contain only structured-cloneable data${detail}`, { cause });
}

/** Clone a value or throw a descriptive admission/invariant error. */
export function cloneStructuredData<T>(value: T, description: string): T {
	try {
		return structuredClone(value);
	} catch (error) {
		throw structuredCloneError(description, error);
	}
}

/** Assert that a value can cross a structured-clone boundary. */
export function assertStructuredCloneable(value: unknown, description: string): void {
	try {
		structuredClone(value);
	} catch (error) {
		throw structuredCloneError(description, error);
	}
}
