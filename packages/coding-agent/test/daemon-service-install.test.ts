import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import {
	getDaemonServiceInvocation,
	getLaunchdPlistPath,
	getSystemdUnitPath,
	installDaemonService,
	LAUNCHD_SERVICE_LABEL,
	type RunServiceCommand,
	renderLaunchdPlist,
	renderSystemdUnit,
	SYSTEMD_SERVICE_NAME,
	uninstallDaemonService,
} from "../src/daemon/service-install.ts";

function createCommandRecorder(exitCode = 0) {
	const calls: Array<{ command: string; args: string[] }> = [];
	const run: RunServiceCommand = async (command, args) => {
		calls.push({ command, args });
		return { code: exitCode, output: "" };
	};
	return { calls, run };
}

describe("daemon service install (M9)", () => {
	let home: string;
	let agentDir: string;

	beforeEach(() => {
		home = mkdtempSync(join(tmpdir(), "volt-svc-home-"));
		agentDir = mkdtempSync(join(tmpdir(), "volt-svc-agent-"));
	});

	afterEach(() => {
		rmSync(home, { recursive: true, force: true });
		rmSync(agentDir, { recursive: true, force: true });
	});

	it("renders a launchd plist that runs the daemon in the foreground with the agent dir pinned", () => {
		expect(LAUNCHD_SERVICE_LABEL).toBe("com.github.hansjm10.voltd");
		const invocation = getDaemonServiceInvocation(agentDir);
		expect(invocation.programArguments[0]).toBe(process.execPath);
		expect(invocation.programArguments).toContain("--optimize-for-size");
		expect(invocation.programArguments.slice(-3)).toEqual(["daemon", "run", "--foreground"]);

		const plist = renderLaunchdPlist(invocation);
		expect(plist).toContain(`<string>${LAUNCHD_SERVICE_LABEL}</string>`);
		for (const argument of invocation.programArguments) {
			expect(plist).toContain(`<string>${argument}</string>`);
		}
		expect(plist).toContain(`<key>${ENV_AGENT_DIR}</key>`);
		expect(plist).toContain(`<string>${agentDir}</string>`);
		expect(plist).toContain("<key>RunAtLoad</key>\n\t<true/>");
		// A graceful `volt daemon stop` must stay stopped: no KeepAlive restart.
		expect(plist).toContain("<key>KeepAlive</key>\n\t<false/>");
	});

	it("escapes XML-special characters in launchd plist strings", () => {
		const plist = renderLaunchdPlist({
			programArguments: ["/usr/local/bin/node", '/tmp/we<ird & "dir"/cli.js', "daemon", "run", "--foreground"],
			agentDir: "/tmp/agent & dir",
			serviceLogPath: "/tmp/log",
		});
		expect(plist).toContain("<string>/tmp/we&lt;ird &amp; &quot;dir&quot;/cli.js</string>");
		expect(plist).toContain("<string>/tmp/agent &amp; dir</string>");
	});

	it("renders a systemd user unit with quoted exec args and no auto-restart", () => {
		const unit = renderSystemdUnit({
			programArguments: ["/usr/bin/node", "/opt/volt dir/cli.js", "daemon", "run", "--foreground"],
			agentDir: "/home/user/agent dir",
			serviceLogPath: "/home/user/agent/daemon/voltd.service.log",
		});
		expect(unit).toContain('ExecStart=/usr/bin/node "/opt/volt dir/cli.js" daemon run --foreground');
		expect(unit).toContain(`Environment=${ENV_AGENT_DIR}="/home/user/agent dir"`);
		expect(unit).toContain("Restart=no");
		expect(unit).toContain("WantedBy=default.target");
	});

	it("install on macOS writes the plist and loads it via launchctl", async () => {
		const recorder = createCommandRecorder();
		const result = await installDaemonService({
			platform: "darwin",
			agentDir,
			home,
			runCommand: recorder.run,
		});
		expect(result.ok).toBe(true);
		const plistPath = getLaunchdPlistPath(home);
		expect(result.definitionPath).toBe(plistPath);
		expect(existsSync(plistPath)).toBe(true);
		expect(readFileSync(plistPath, "utf8")).toContain(LAUNCHD_SERVICE_LABEL);
		expect(recorder.calls.some((call) => call.command === "launchctl" && call.args[0] === "bootstrap")).toBe(true);

		const removal = await uninstallDaemonService({ platform: "darwin", home, runCommand: recorder.run });
		expect(removal.ok).toBe(true);
		expect(existsSync(plistPath)).toBe(false);
	});

	it("install on Linux writes the unit and enables it via systemctl --user", async () => {
		const recorder = createCommandRecorder();
		const result = await installDaemonService({
			platform: "linux",
			agentDir,
			home,
			runCommand: recorder.run,
		});
		expect(result.ok).toBe(true);
		const unitPath = getSystemdUnitPath(home);
		expect(existsSync(unitPath)).toBe(true);
		expect(
			recorder.calls.some(
				(call) =>
					call.command === "systemctl" && call.args.join(" ") === `--user enable --now ${SYSTEMD_SERVICE_NAME}`,
			),
		).toBe(true);

		const removal = await uninstallDaemonService({ platform: "linux", home, runCommand: recorder.run });
		expect(removal.ok).toBe(true);
		expect(existsSync(unitPath)).toBe(false);
	});

	it("reports failure with a manual fallback when loading fails, and rejects unsupported platforms", async () => {
		const failing = createCommandRecorder(1);
		const result = await installDaemonService({
			platform: "darwin",
			agentDir,
			home,
			runCommand: failing.run,
		});
		expect(result.ok).toBe(false);
		expect(result.messages.some((message) => message.includes("launchctl bootstrap"))).toBe(true);
		// The definition is still on disk for manual loading.
		expect(existsSync(getLaunchdPlistPath(home))).toBe(true);

		const unsupported = await installDaemonService({ platform: "win32", agentDir, home, runCommand: failing.run });
		expect(unsupported.ok).toBe(false);
	});
});
