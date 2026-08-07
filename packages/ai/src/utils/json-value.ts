/** Primitive values preserved exactly by Volt's JSON data contract. */
export type JsonPrimitive = string | number | boolean | null;

/** A plain JSON object. Runtime admission additionally rejects non-ordinary object shapes. */
export type JsonObject = { [key: string]: JsonValue };

/** Values that round-trip through JSON without type or value loss. */
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];

/**
 * Preserve a caller's concrete shape while rejecting statically known non-JSON values.
 * Runtime admission remains authoritative for cycles, prototypes, sparse arrays, and number values.
 */
export type JsonCompatible<T> = [T] extends [JsonValue]
	? T
	: T extends JsonPrimitive
		? T
		: T extends undefined | bigint | symbol | CallableFunction
			? never
			: T extends readonly unknown[]
				? { [Index in keyof T]: JsonCompatible<T[Index]> }
				: T extends object
					? { [Key in keyof T]: Key extends string ? JsonCompatible<T[Key]> : never }
					: never;

/** A concrete value statically checked against the JSON data grammar. */
export type JsonCompatibleInput<T> = T & JsonCompatible<T>;
