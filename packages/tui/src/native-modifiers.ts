import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { loadNativeAddon } from "./native-loader.ts";

const moduleUrl: string | undefined = import.meta.url;

export type ModifierKey = "shift" | "command" | "control" | "option";

type NativeModifiersHelper = {
	isModifierPressed: (name: ModifierKey) => boolean;
};

let nativeModifiersHelper: NativeModifiersHelper | null | undefined;

function isNativeModifiersHelper(value: unknown): value is NativeModifiersHelper {
	if (typeof value !== "object" || value === null) return false;
	const candidate = (value as { isModifierPressed?: unknown }).isModifierPressed;
	return typeof candidate === "function";
}

function loadNativeModifiersHelper(): NativeModifiersHelper | undefined {
	if (nativeModifiersHelper !== undefined) return nativeModifiersHelper ?? undefined;
	nativeModifiersHelper = null;
	const arch = process.arch;
	if (arch !== "x64" && arch !== "arm64") return undefined;

	let nativePath: string;
	if (process.platform === "darwin") {
		nativePath = path.join("native", "darwin", "prebuilds", `darwin-${arch}`, "darwin-modifiers.node");
	} else if (process.platform === "win32") {
		nativePath = path.join("native", "win32", "prebuilds", `win32-${arch}`, "win32-console-mode.node");
	} else {
		return undefined;
	}

	const moduleDir = moduleUrl ? path.dirname(fileURLToPath(moduleUrl)) : path.dirname(process.execPath);
	const candidates = [
		path.join(moduleDir, "..", nativePath),
		path.join(moduleDir, nativePath),
		path.join(path.dirname(process.execPath), nativePath),
	];

	const helper = loadNativeAddon(candidates, isNativeModifiersHelper);
	if (!helper) return undefined;
	nativeModifiersHelper = helper;
	return helper;
}

export function hasNativeModifierSupport(): boolean {
	return loadNativeModifiersHelper() !== undefined;
}

export function isNativeModifierPressed(key: ModifierKey): boolean {
	const helper = loadNativeModifiersHelper();
	if (!helper) return false;
	try {
		return helper.isModifierPressed(key) === true;
	} catch {
		return false;
	}
}
