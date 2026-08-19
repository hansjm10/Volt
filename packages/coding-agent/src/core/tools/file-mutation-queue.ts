import { realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

interface PendingMutation {
	keys: readonly string[];
	completion: Promise<void>;
	release: () => void;
}

const pendingMutations = new Set<PendingMutation>();
let registrationQueue = Promise.resolve();

function isMissingPathError(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		(error.code === "ENOENT" || error.code === "ENOTDIR")
	);
}

async function getMutationQueueKey(filePath: string): Promise<string> {
	const resolvedPath = resolve(filePath);
	let existingPath = resolvedPath;
	while (true) {
		try {
			const canonicalParent = await realpath(existingPath);
			const suffix = relative(existingPath, resolvedPath);
			return suffix ? join(canonicalParent, suffix) : canonicalParent;
		} catch (error) {
			if (!isMissingPathError(error)) {
				throw error;
			}
			const parent = dirname(existingPath);
			if (parent === existingPath) {
				return resolvedPath;
			}
			existingPath = parent;
		}
	}
}

function isSameOrDescendant(path: string, parent: string): boolean {
	const suffix = relative(parent, path);
	return suffix === "" || (suffix !== ".." && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix));
}

function pathsOverlap(first: string, second: string): boolean {
	return isSameOrDescendant(first, second) || isSameOrDescendant(second, first);
}

function collapseHierarchicalKeys(keys: readonly string[]): string[] {
	const collapsed: string[] = [];
	for (const key of new Set(keys)) {
		if (collapsed.some((existing) => isSameOrDescendant(key, existing))) continue;
		for (let index = collapsed.length - 1; index >= 0; index--) {
			if (isSameOrDescendant(collapsed[index], key)) collapsed.splice(index, 1);
		}
		collapsed.push(key);
	}
	return collapsed.sort();
}

function keySetsOverlap(first: readonly string[], second: readonly string[]): boolean {
	return first.some((firstKey) => second.some((secondKey) => pathsOverlap(firstKey, secondKey)));
}

/**
 * Serialize mutation operations whose canonical paths are equal or have an
 * ancestor/descendant relationship. Each collapsed key set is registered as
 * one record before it waits, preserving registration order without coupling
 * disjoint sibling paths.
 */
export async function withFileMutationQueues<T>(filePaths: readonly string[], fn: () => Promise<T>): Promise<T> {
	const registration = registrationQueue.then(async () => {
		const keys = collapseHierarchicalKeys(await Promise.all(filePaths.map(getMutationQueueKey)));
		const predecessors = [...pendingMutations]
			.filter((pending) => keySetsOverlap(keys, pending.keys))
			.map((pending) => pending.completion);
		let release!: () => void;
		const completion = new Promise<void>((resolveCompletion) => {
			release = resolveCompletion;
		});
		const record: PendingMutation = { keys, completion, release };
		pendingMutations.add(record);
		return { predecessors, record };
	});
	registrationQueue = registration.then(
		() => undefined,
		() => undefined,
	);

	const { predecessors, record } = await registration;
	await Promise.all(predecessors);
	try {
		return await fn();
	} finally {
		record.release();
		pendingMutations.delete(record);
	}
}

/**
 * Serialize file mutation operations targeting the same path hierarchy.
 * Operations for disjoint paths still run in parallel.
 */
export function withFileMutationQueue<T>(filePath: string, fn: () => Promise<T>): Promise<T> {
	return withFileMutationQueues([filePath], fn);
}
