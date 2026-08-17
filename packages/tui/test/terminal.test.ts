import assert from "node:assert";
import { describe, it, mock } from "node:test";
import { setKittyProtocolActive } from "../src/keys.ts";
import { hasNativeModifierSupport } from "../src/native-modifiers.ts";
import {
	normalizeAppleTerminalInput,
	normalizeNativeShiftEnterInput,
	ProcessTerminal,
	parseFocusEvent,
	parseKeyboardProtocolNegotiationSequence,
	resolveEscapeTimeoutMs,
} from "../src/terminal.ts";

describe("resolveEscapeTimeoutMs", () => {
	it("uses VOLT_TUI_ESC_TIMEOUT when configured", () => {
		assert.equal(resolveEscapeTimeoutMs({ VOLT_TUI_ESC_TIMEOUT: "80" }), 80);
		assert.equal(resolveEscapeTimeoutMs({ VOLT_TUI_ESC_TIMEOUT: "80", SSH_TTY: "/dev/pts/1" }), 80);
	});

	it("ignores invalid VOLT_TUI_ESC_TIMEOUT values", () => {
		assert.equal(resolveEscapeTimeoutMs({ VOLT_TUI_ESC_TIMEOUT: "abc" }), 10);
		assert.equal(resolveEscapeTimeoutMs({ VOLT_TUI_ESC_TIMEOUT: "0" }), 10);
		assert.equal(resolveEscapeTimeoutMs({ VOLT_TUI_ESC_TIMEOUT: "-5" }), 10);
		assert.equal(resolveEscapeTimeoutMs({ VOLT_TUI_ESC_TIMEOUT: "" }), 10);
	});

	it("defaults to 100ms over SSH", () => {
		assert.equal(resolveEscapeTimeoutMs({ SSH_CONNECTION: "10.0.0.1 22" }), 100);
		assert.equal(resolveEscapeTimeoutMs({ SSH_TTY: "/dev/pts/1" }), 100);
	});

	it("defaults to 10ms otherwise", () => {
		assert.equal(resolveEscapeTimeoutMs({}), 10);
	});
});

describe("native modifier support", () => {
	it(
		"loads the native modifier helper on supported Windows architectures",
		{ skip: process.platform !== "win32" || (process.arch !== "x64" && process.arch !== "arm64") },
		() => {
			assert.equal(hasNativeModifierSupport(), true);
		},
	);
});

describe("normalizeNativeShiftEnterInput", () => {
	it("rewrites Return to CSI-u Shift+Enter when native Shift detection is enabled and Shift is pressed", () => {
		assert.equal(normalizeNativeShiftEnterInput("\r", true, true), "\x1b[13;2u");
	});

	it("leaves Return unchanged when native Shift detection is disabled", () => {
		assert.equal(normalizeNativeShiftEnterInput("\r", false, true), "\r");
	});

	it("leaves Return unchanged when Shift is not pressed", () => {
		assert.equal(normalizeNativeShiftEnterInput("\r", true, false), "\r");
	});

	it("leaves non-Return input unchanged", () => {
		assert.equal(normalizeNativeShiftEnterInput("\x1b[13;2u", true, true), "\x1b[13;2u");
		assert.equal(normalizeNativeShiftEnterInput("a", true, true), "a");
	});
});

describe("normalizeAppleTerminalInput", () => {
	it("rewrites Apple Terminal Return to CSI-u Shift+Enter when Shift is pressed", () => {
		assert.equal(normalizeAppleTerminalInput("\r", true, true), "\x1b[13;2u");
	});

	it("leaves Apple Terminal Return unchanged when Shift is not pressed", () => {
		assert.equal(normalizeAppleTerminalInput("\r", true, false), "\r");
	});

	it("leaves non-Apple Terminal Return unchanged when Shift is pressed", () => {
		assert.equal(normalizeAppleTerminalInput("\r", false, true), "\r");
	});

	it("leaves non-Return input unchanged", () => {
		assert.equal(normalizeAppleTerminalInput("\x1b[13;2u", true, true), "\x1b[13;2u");
		assert.equal(normalizeAppleTerminalInput("a", true, true), "a");
	});
});

describe("parseKeyboardProtocolNegotiationSequence", () => {
	it("preserves primary device attributes for capability negotiation", () => {
		assert.deepStrictEqual(parseKeyboardProtocolNegotiationSequence("\x1b[?62;4;52c"), {
			type: "device-attributes",
			attributes: [62, 4, 52],
		});
		assert.deepStrictEqual(parseKeyboardProtocolNegotiationSequence("\x1b[?c"), {
			type: "device-attributes",
			attributes: [],
		});
	});
});

describe("ProcessTerminal Kitty keyboard protocol negotiation", () => {
	type NegotiationHarness = {
		terminal: ProcessTerminal;
		writes: string[];
		send(data: string): void;
		getInput(): string | undefined;
		cleanup(): void;
	};

	function setupNegotiation(): NegotiationHarness {
		const terminal = new ProcessTerminal();
		const writes: string[] = [];
		let input: string | undefined;
		let dataHandler: ((data: string) => void) | undefined;
		let cleaned = false;
		const previousWrite = process.stdout.write;
		const previousOn = process.stdin.on;

		process.stdout.write = ((chunk: string | Uint8Array) => {
			writes.push(String(chunk));
			return true;
		}) as typeof process.stdout.write;
		process.stdin.on = ((event: string | symbol, listener: (...args: unknown[]) => void) => {
			if (event === "data") dataHandler = listener as (data: string) => void;
			return process.stdin;
		}) as typeof process.stdin.on;

		(
			terminal as unknown as {
				inputHandler?: (data: string) => void;
				queryAndEnableKittyProtocol(): void;
			}
		).inputHandler = (data) => {
			input = data;
		};
		(terminal as unknown as { queryAndEnableKittyProtocol(): void }).queryAndEnableKittyProtocol();

		return {
			terminal,
			writes,
			send(data: string): void {
				dataHandler?.(data);
			},
			getInput(): string | undefined {
				return input;
			},
			cleanup(): void {
				if (cleaned) return;
				cleaned = true;
				try {
					terminal.stop();
				} finally {
					process.stdout.write = previousWrite;
					process.stdin.on = previousOn;
					setKittyProtocolActive(false);
				}
			},
		};
	}

	it("queries Kitty mode before enabling modifyOtherKeys fallback", () => {
		const harness = setupNegotiation();
		try {
			assert.equal(harness.writes[0], "\x1b[>7u\x1b[?u\x1b[c");
			assert.equal(harness.writes.includes("\x1b[>4;2m"), false);
			assert.equal(harness.terminal.kittyProtocolActive, false);
		} finally {
			harness.cleanup();
		}
	});

	it("activates Kitty mode for non-zero negotiated flags", () => {
		const harness = setupNegotiation();
		try {
			harness.send("\x1b[?7u");

			assert.equal(harness.getInput(), undefined);
			assert.equal(harness.terminal.kittyProtocolActive, true);
			assert.equal(harness.writes.includes("\x1b[>4;2m"), false);
			assert.equal(harness.writes.includes("\x1b[>4;0m"), false);

			harness.cleanup();
			assert.equal(harness.writes.filter((write) => write === "\x1b[<u").length, 1);
			assert.equal(harness.writes.includes("\x1b[>4;0m"), false);
		} finally {
			harness.cleanup();
		}
	});

	it("falls back to modifyOtherKeys for zero Kitty flags", () => {
		const harness = setupNegotiation();
		try {
			harness.send("\x1b[?0u");

			assert.equal(harness.getInput(), undefined);
			assert.equal(harness.terminal.kittyProtocolActive, false);
			assert.equal(harness.writes.filter((write) => write === "\x1b[>4;2m").length, 1);

			harness.cleanup();
			assert.equal(harness.writes.filter((write) => write === "\x1b[>4;0m").length, 1);
		} finally {
			harness.cleanup();
		}
	});

	it("reports device attributes before falling back to modifyOtherKeys", () => {
		const harness = setupNegotiation();
		let attributes: readonly number[] | undefined;
		harness.terminal.onDeviceAttributes = (reported) => {
			attributes = reported;
		};
		try {
			harness.send("\x1b[?62;4;52c");

			assert.equal(harness.getInput(), undefined);
			assert.deepStrictEqual(attributes, [62, 4, 52]);
			assert.equal(harness.terminal.kittyProtocolActive, false);
			assert.equal(harness.writes.filter((write) => write === "\x1b[>4;2m").length, 1);
		} finally {
			harness.cleanup();
		}
	});

	it("forwards normal input while waiting for Kitty response", () => {
		const harness = setupNegotiation();
		try {
			harness.send("a");

			assert.equal(harness.getInput(), "a");
			assert.equal(harness.terminal.kittyProtocolActive, false);
		} finally {
			harness.cleanup();
		}
	});

	it("tracks split Kitty confirmation", () => {
		mock.timers.enable({ apis: ["setTimeout"] });
		const harness = setupNegotiation();
		try {
			harness.send("\x1b[?7");
			mock.timers.tick(10);

			assert.equal(harness.getInput(), undefined);

			harness.send("u");

			assert.equal(harness.terminal.kittyProtocolActive, true);
			assert.equal(harness.writes.includes("\x1b[>4;2m"), false);
		} finally {
			harness.cleanup();
			mock.timers.reset();
		}
	});

	it("replays buffered CSI-prefix input when it is not a Kitty response", () => {
		mock.timers.enable({ apis: ["setTimeout"] });
		const harness = setupNegotiation();
		try {
			harness.send("\x1b[");
			mock.timers.tick(50); // StdinBuffer sequence timeout, not the lone-ESC timeout

			assert.equal(harness.getInput(), undefined);

			mock.timers.tick(150);

			assert.equal(harness.getInput(), "\x1b[");
		} finally {
			harness.cleanup();
			mock.timers.reset();
		}
	});
});

describe("parseFocusEvent", () => {
	it("parses focus-in and focus-out events", () => {
		assert.equal(parseFocusEvent("\x1b[I"), "in");
		assert.equal(parseFocusEvent("\x1b[O"), "out");
	});

	it("ignores other sequences", () => {
		assert.equal(parseFocusEvent("I"), undefined);
		assert.equal(parseFocusEvent("\x1b[1I"), undefined);
		assert.equal(parseFocusEvent("\x1b[Ix"), undefined);
		assert.equal(parseFocusEvent("\x1b[A"), undefined);
		assert.equal(parseFocusEvent(""), undefined);
	});
});

describe("ProcessTerminal focus reporting", () => {
	type FocusHarness = {
		terminal: ProcessTerminal;
		writes: string[];
		inputs: string[];
		focusChanges: boolean[];
		send(data: string): void;
		cleanup(): void;
	};

	function setupFocusHarness(): FocusHarness {
		const terminal = new ProcessTerminal();
		const writes: string[] = [];
		const inputs: string[] = [];
		const focusChanges: boolean[] = [];
		let dataHandler: ((data: string) => void) | undefined;
		let cleaned = false;
		const previousWrite = process.stdout.write;
		const previousOn = process.stdin.on;

		process.stdout.write = ((chunk: string | Uint8Array) => {
			writes.push(String(chunk));
			return true;
		}) as typeof process.stdout.write;
		process.stdin.on = ((event: string | symbol, listener: (...args: unknown[]) => void) => {
			if (event === "data") dataHandler = listener as (data: string) => void;
			return process.stdin;
		}) as typeof process.stdin.on;

		terminal.onFocusChange = (focused) => {
			focusChanges.push(focused);
		};
		(terminal as unknown as { inputHandler?: (data: string) => void }).inputHandler = (data) => {
			inputs.push(data);
		};
		(terminal as unknown as { queryAndEnableKittyProtocol(): void }).queryAndEnableKittyProtocol();

		return {
			terminal,
			writes,
			inputs,
			focusChanges,
			send(data: string): void {
				dataHandler?.(data);
			},
			cleanup(): void {
				if (cleaned) return;
				cleaned = true;
				try {
					terminal.stop();
				} finally {
					process.stdout.write = previousWrite;
					process.stdin.on = previousOn;
					setKittyProtocolActive(false);
				}
			},
		};
	}

	it("starts with unknown focus state", () => {
		const harness = setupFocusHarness();
		try {
			assert.equal(harness.terminal.focusState, "unknown");
		} finally {
			harness.cleanup();
		}
	});

	it("tracks focus events without forwarding them as input", () => {
		const harness = setupFocusHarness();
		try {
			harness.send("\x1b[O");
			assert.equal(harness.terminal.focusState, "unfocused");

			harness.send("\x1b[I");
			assert.equal(harness.terminal.focusState, "focused");

			assert.deepEqual(harness.focusChanges, [false, true]);
			assert.deepEqual(harness.inputs, []);
		} finally {
			harness.cleanup();
		}
	});

	it("does not fire onFocusChange for repeated focus events", () => {
		const harness = setupFocusHarness();
		try {
			harness.send("\x1b[I");
			harness.send("\x1b[I");
			assert.deepEqual(harness.focusChanges, [true]);
		} finally {
			harness.cleanup();
		}
	});

	it("still forwards normal input", () => {
		const harness = setupFocusHarness();
		try {
			harness.send("\x1b[I");
			harness.send("a");
			assert.deepEqual(harness.inputs, ["a"]);
		} finally {
			harness.cleanup();
		}
	});

	it("disables focus reporting and resets state on stop", () => {
		const harness = setupFocusHarness();
		try {
			harness.send("\x1b[I");
			harness.cleanup();
			assert.equal(harness.writes.includes("\x1b[?1004l"), true);
			assert.equal(harness.terminal.focusState, "unknown");
		} finally {
			harness.cleanup();
		}
	});
});

describe("ProcessTerminal alerts", () => {
	it("writes a BEL sequence", () => {
		const terminal = new ProcessTerminal();
		const writes: string[] = [];
		const previousWrite = process.stdout.write;

		process.stdout.write = ((chunk: string | Uint8Array) => {
			writes.push(String(chunk));
			return true;
		}) as typeof process.stdout.write;

		try {
			terminal.alert();
			assert.deepEqual(writes, ["\x07"]);
		} finally {
			process.stdout.write = previousWrite;
		}
	});
});

describe("ProcessTerminal dimensions", () => {
	it("falls back to COLUMNS and LINES before default dimensions", () => {
		const previousColumnsDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "columns");
		const previousRowsDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "rows");
		const { COLUMNS: previousColumns, LINES: previousLines } = process.env;

		try {
			Object.defineProperty(process.stdout, "columns", { value: undefined, configurable: true });
			Object.defineProperty(process.stdout, "rows", { value: undefined, configurable: true });
			Object.assign(process.env, { COLUMNS: "123", LINES: "45" });

			const terminal = new ProcessTerminal();

			assert.equal(terminal.columns, 123);
			assert.equal(terminal.rows, 45);
		} finally {
			if (previousColumnsDescriptor) {
				Object.defineProperty(process.stdout, "columns", previousColumnsDescriptor);
			} else {
				Reflect.deleteProperty(process.stdout, "columns");
			}
			if (previousRowsDescriptor) {
				Object.defineProperty(process.stdout, "rows", previousRowsDescriptor);
			} else {
				Reflect.deleteProperty(process.stdout, "rows");
			}
			if (previousColumns === undefined) {
				Reflect.deleteProperty(process.env, "COLUMNS");
			} else {
				Object.assign(process.env, { COLUMNS: previousColumns });
			}
			if (previousLines === undefined) {
				Reflect.deleteProperty(process.env, "LINES");
			} else {
				Object.assign(process.env, { LINES: previousLines });
			}
		}
	});
});
