import { execFile, spawn } from "child_process";
import { platform } from "os";
import { isWaylandSession } from "./clipboard-image.ts";

const CLIPBOARD_COMMAND_TIMEOUT_MS = 5000;
const MAX_OSC52_ENCODED_LENGTH = 100_000;
const READ_CLIPBOARD_OPTIONS = {
	encoding: "utf8" as const,
	maxBuffer: 50 * 1024 * 1024,
	timeout: CLIPBOARD_COMMAND_TIMEOUT_MS,
};

function execClipboardCommand(command: string, args: string[]): Promise<string> {
	return new Promise((resolve, reject) => {
		try {
			execFile(command, args, READ_CLIPBOARD_OPTIONS, (error, stdout) => {
				if (error) {
					reject(error);
					return;
				}
				resolve(stdout);
			});
		} catch (error) {
			reject(error);
		}
	});
}

async function readClipboardCommand(command: string, args: string[]): Promise<string | null> {
	try {
		return (await execClipboardCommand(command, args)) || null;
	} catch {
		return null;
	}
}

function writeClipboardCommand(command: string, args: string[], text: string): Promise<void> {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, {
			stdio: ["pipe", "ignore", "ignore"],
			timeout: CLIPBOARD_COMMAND_TIMEOUT_MS,
		});
		let settled = false;

		const cleanup = () => {
			child.removeListener("error", onError);
			child.removeListener("close", onClose);
			child.stdin.removeListener("error", onStdinError);
		};
		const finish = (error?: Error) => {
			if (settled) return;
			settled = true;
			cleanup();
			if (error) {
				child.stdin.destroy();
				reject(error);
			} else {
				resolve();
			}
		};
		const onError = (error: Error) => finish(error);
		const onClose = (code: number | null, signal: NodeJS.Signals | null) => {
			if (code === 0) {
				finish();
			} else {
				finish(new Error(`Clipboard command exited with code ${code ?? "null"} and signal ${signal ?? "none"}`));
			}
		};
		const onStdinError = (error: Error) => {
			try {
				child.kill();
			} catch {
				// The process may already have exited.
			}
			finish(error);
		};

		child.once("error", onError);
		child.once("close", onClose);
		child.stdin.once("error", onStdinError);
		try {
			child.stdin.end(text);
		} catch (error) {
			try {
				child.kill();
			} catch {
				// The process may already have exited.
			}
			finish(error instanceof Error ? error : new Error(String(error)));
		}
	});
}

async function copyToX11Clipboard(text: string): Promise<void> {
	try {
		await writeClipboardCommand("xclip", ["-selection", "clipboard"], text);
	} catch {
		await writeClipboardCommand("xsel", ["--clipboard", "--input"], text);
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
			"[Console]::Out.Write((Get-Clipboard -Raw))",
		]);
	}
	if (process.env.TERMUX_VERSION) {
		const text = await readClipboardCommand("termux-clipboard-get", []);
		if (text !== null) return text;
	}
	if (isWaylandSession() && process.env.WAYLAND_DISPLAY) {
		const text = await readClipboardCommand("wl-paste", ["--no-newline", "--type", "text"]);
		if (text !== null) return text;
	}
	const xclipText = await readClipboardCommand("xclip", ["-selection", "clipboard", "-o"]);
	if (xclipText !== null) return xclipText;
	return readClipboardCommand("xsel", ["--clipboard", "--output"]);
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

	if (!copied) {
		try {
			if (p === "darwin") {
				await writeClipboardCommand("pbcopy", [], text);
				copied = true;
			} else if (p === "win32") {
				await writeClipboardCommand("clip", [], text);
				copied = true;
			} else {
				// Linux. Try Termux, Wayland, or X11 clipboard tools.
				if (process.env.TERMUX_VERSION) {
					try {
						await writeClipboardCommand("termux-clipboard-set", [], text);
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
							await execClipboardCommand("which", ["wl-copy"]);
							await writeClipboardCommand("wl-copy", [], text);
							copied = true;
						} catch {
							if (hasX11Display) {
								await copyToX11Clipboard(text);
								copied = true;
							}
						}
					} else if (hasX11Display) {
						await copyToX11Clipboard(text);
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
