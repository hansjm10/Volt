import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(scriptsDir);
const powerShellCandidates = process.platform === "win32" ? ["powershell.exe", "pwsh.exe"] : ["pwsh"];
const powerShell = powerShellCandidates.find((candidate) => {
	const result = spawnSync(candidate, ["-NoProfile", "-Command", "exit 0"], { windowsHide: true });
	return result.status === 0;
});

test(
	"PowerShell source launcher restores the private diagnostics environment setting",
	{ skip: powerShell === undefined ? "PowerShell is unavailable" : false },
	() => {
		const tempDir = mkdtempSync(join(tmpdir(), "volt-source-launcher-"));
		const testScript = join(tempDir, "verify-private-diagnostics.ps1");

		try {
			writeFileSync(
				testScript,
				`param([string]$RepoRoot)
$ErrorActionPreference = "Stop"
$global:SimulateNodeFailure = $false

function node {
	if ($env:VOLT_REVIEW_PRIVATE_DIAGNOSTICS -notin @("1", "0")) {
		throw "Unexpected diagnostics value: $env:VOLT_REVIEW_PRIVATE_DIAGNOSTICS"
	}
	if ($global:SimulateNodeFailure) {
		throw "Simulated node failure"
	}
	$global:LASTEXITCODE = 0
}

$launcher = Join-Path $RepoRoot "volt-test.ps1"
Remove-Item Env:VOLT_REVIEW_PRIVATE_DIAGNOSTICS -ErrorAction SilentlyContinue
& $launcher
if (Test-Path Env:VOLT_REVIEW_PRIVATE_DIAGNOSTICS) {
	throw "Launcher leaked a newly set diagnostics value"
}

$env:VOLT_REVIEW_PRIVATE_DIAGNOSTICS = "0"
& $launcher
if ($env:VOLT_REVIEW_PRIVATE_DIAGNOSTICS -ne "0") {
	throw "Launcher changed an existing diagnostics value"
}

Remove-Item Env:VOLT_REVIEW_PRIVATE_DIAGNOSTICS
$global:SimulateNodeFailure = $true
try {
	& $launcher
	throw "Expected simulated node failure"
} catch {
	if ($_.Exception.Message -ne "Simulated node failure") {
		throw
	}
}
if (Test-Path Env:VOLT_REVIEW_PRIVATE_DIAGNOSTICS) {
	throw "Launcher leaked the diagnostics value after failure"
}

Write-Output "PowerShell launcher diagnostics scoping verified"
`,
			);

			const result = spawnSync(
				powerShell,
				["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", testScript, repoRoot],
				{ encoding: "utf8", windowsHide: true },
			);

			assert.equal(result.status, 0, result.stderr || result.stdout);
			assert.match(result.stdout, /PowerShell launcher diagnostics scoping verified/);
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	},
);
