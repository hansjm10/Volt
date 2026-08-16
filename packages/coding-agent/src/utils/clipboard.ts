import { execFileSync, execSync, spawn } from "child_process";
import { platform } from "os";
import { isWaylandSession } from "./clipboard-image.ts";

type NativeClipboardExecOptions = {
	input: string;
	timeout: number;
	stdio: ["pipe", "ignore", "ignore"];
};

function copyToX11Clipboard(options: NativeClipboardExecOptions): void {
	try {
		execSync("xclip -selection clipboard", options);
	} catch {
		execSync("xsel --clipboard --input", options);
	}
}

const MAX_OSC52_ENCODED_LENGTH = 100_000;
const READ_CLIPBOARD_OPTIONS = {
	encoding: "utf8" as const,
	maxBuffer: 50 * 1024 * 1024,
	timeout: 5000,
};

function readClipboardCommand(command: string, args: string[]): string | null {
	try {
		return execFileSync(command, args, READ_CLIPBOARD_OPTIONS) || null;
	} catch {
		return null;
	}
}

/** Read plain text from the system clipboard without invoking a shell. */
export async function readClipboardText(): Promise<string | null> {
	const currentPlatform = platform();
	if (currentPlatform === "darwin") return readClipboardCommand("pbpaste", []);
	if (currentPlatform === "win32") {
		return readClipboardCommand("powershell.exe", [
			"-NoProfile",
			"-NonInteractive",
			"-Command",
			"Get-Clipboard -Raw",
		]);
	}
	if (process.env.TERMUX_VERSION) {
		const text = readClipboardCommand("termux-clipboard-get", []);
		if (text !== null) return text;
	}
	if (isWaylandSession() && process.env.WAYLAND_DISPLAY) {
		const text = readClipboardCommand("wl-paste", ["--no-newline", "--type", "text"]);
		if (text !== null) return text;
	}
	return (
		readClipboardCommand("xclip", ["-selection", "clipboard", "-o"]) ??
		readClipboardCommand("xsel", ["--clipboard", "--output"])
	);
}

function isRemoteSession(env: NodeJS.ProcessEnv = process.env): boolean {
	return Boolean(env.SSH_CONNECTION || env.SSH_CLIENT || env.MOSH_CONNECTION);
}

function emitOsc52(text: string): boolean {
	const encoded = Buffer.from(text).toString("base64");
	if (encoded.length > MAX_OSC52_ENCODED_LENGTH) {
		return false;
	}
	process.stdout.write(`\x1b]52;c;${encoded}\x07`);
	return true;
}

export async function copyToClipboard(text: string): Promise<void> {
	let copied = false;

	const p = platform();

	const remote = isRemoteSession();

	const options: NativeClipboardExecOptions = { input: text, timeout: 5000, stdio: ["pipe", "ignore", "ignore"] };

	if (!copied) {
		try {
			if (p === "darwin") {
				execSync("pbcopy", options);
				copied = true;
			} else if (p === "win32") {
				execSync("clip", options);
				copied = true;
			} else {
				// Linux. Try Termux, Wayland, or X11 clipboard tools.
				if (process.env.TERMUX_VERSION) {
					try {
						execSync("termux-clipboard-set", options);
						copied = true;
					} catch {
						// Fall back to Wayland or X11 tools.
					}
				}

				if (!copied) {
					const hasWaylandDisplay = Boolean(process.env.WAYLAND_DISPLAY);
					const hasX11Display = Boolean(process.env.DISPLAY);
					const isWayland = isWaylandSession();
					if (isWayland && hasWaylandDisplay) {
						try {
							// Verify wl-copy exists (spawn errors are async and won't be caught)
							execSync("which wl-copy", { stdio: "ignore" });
							// wl-copy with execSync hangs due to fork behavior; use spawn instead
							const proc = spawn("wl-copy", [], { stdio: ["pipe", "ignore", "ignore"] });
							proc.stdin.on("error", () => {
								// Ignore EPIPE errors if wl-copy exits early
							});
							proc.stdin.write(text);
							proc.stdin.end();
							proc.unref();
							copied = true;
						} catch {
							if (hasX11Display) {
								copyToX11Clipboard(options);
								copied = true;
							}
						}
					} else if (hasX11Display) {
						copyToX11Clipboard(options);
						copied = true;
					}
				}
			}
		} catch {
			// Fall through to OSC 52 fallback.
		}
	}

	if (remote || !copied) {
		const osc52Copied = emitOsc52(text);
		copied = copied || osc52Copied;
	}

	if (!copied) {
		throw new Error("Failed to copy to clipboard");
	}
}
