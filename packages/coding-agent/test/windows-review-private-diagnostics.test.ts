import { Buffer } from "node:buffer";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	createReviewPrivateDiagnostics,
	getReviewPrivateDiagnosticsDirectory,
	REVIEW_PRIVATE_DIAGNOSTICS_ENV,
} from "../src/core/review-private-diagnostics.ts";
import { writeWindowsReviewDiagnostic } from "../src/core/windows-review-private-diagnostics.ts";

const roots: string[] = [];

function createRoot(): string {
	const root = mkdtempSync(join(tmpdir(), "volt-windows-review-diagnostics-"));
	roots.push(root);
	return root;
}

function powershell(script: string, input: Record<string, string>): string {
	const systemRoot = process.env.SystemRoot;
	if (!systemRoot) throw new Error("Expected Windows system directory");
	const command = `$ErrorActionPreference = 'Stop'\n$ProgressPreference = 'SilentlyContinue'\n[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)\n$request = ConvertFrom-Json ([Console]::In.ReadToEnd())\n${script}`;
	return execFileSync(
		join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
		[
			"-NoLogo",
			"-NoProfile",
			"-NonInteractive",
			"-EncodedCommand",
			Buffer.from(command, "utf16le").toString("base64"),
		],
		{ input: JSON.stringify(input), encoding: "utf8", windowsHide: true, timeout: 10_000 },
	).trim();
}

interface AclSnapshot {
	currentSid: string;
	owner: string;
	protected: boolean;
	rules: Array<{ sid: string; rights: string; type: string; inherited: boolean }>;
}

function readAcl(path: string): AclSnapshot {
	return JSON.parse(
		powershell(
			`
$acl = if ([IO.Directory]::Exists($request.path)) { [IO.Directory]::GetAccessControl($request.path) }
       else { [IO.File]::GetAccessControl($request.path) }
$rules = @($acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]) | ForEach-Object {
    @{ sid = $_.IdentityReference.Value; rights = [string]$_.FileSystemRights;
       type = [string]$_.AccessControlType; inherited = $_.IsInherited }
})
@{ currentSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value;
   owner = $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value;
   protected = $acl.AreAccessRulesProtected; rules = $rules } | ConvertTo-Json -Depth 5 -Compress
`,
			{ path },
		),
	) as AclSnapshot;
}

function expectOwnerOnly(path: string): void {
	const acl = readAcl(path);
	expect(acl).toEqual({
		currentSid: expect.any(String),
		owner: acl.currentSid,
		protected: true,
		rules: [{ sid: acl.currentSid, rights: "FullControl", type: "Allow", inherited: false }],
	});
}

afterEach(() => {
	vi.unstubAllEnvs();
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe.skipIf(process.platform !== "win32")("Windows private review diagnostics", () => {
	it("hardens a permissive diagnostic directory without changing its shared parent", async () => {
		vi.stubEnv(REVIEW_PRIVATE_DIAGNOSTICS_ENV, "1");
		const agentDir = createRoot();
		powershell(
			`
$directory = [IO.DirectoryInfo]::new($request.path)
$acl = $directory.GetAccessControl()
$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new(
    [Security.Principal.SecurityIdentifier]::new('S-1-1-0'),
    [Security.AccessControl.FileSystemRights]::FullControl,
    [Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit',
    [Security.AccessControl.PropagationFlags]::None, [Security.AccessControl.AccessControlType]::Allow))
$directory.SetAccessControl($acl)
`,
			{ path: agentDir },
		);
		const directory = getReviewPrivateDiagnosticsDirectory(agentDir);
		mkdirSync(directory);
		const parentBefore = readAcl(agentDir);
		expect(readAcl(directory).rules).toContainEqual(expect.objectContaining({ sid: "S-1-1-0" }));
		const diagnostics = createReviewPrivateDiagnostics({
			agentDir,
			workflowId: "review:windows-acl",
			workflowAction: "review.pr",
		});
		diagnostics.recordVerificationAssessment({ assessment: "incomplete", challenge: "Private concern." });

		const file = await diagnostics.flush();
		expect(file).toBeDefined();
		expectOwnerOnly(directory);
		expectOwnerOnly(file!);
		expect(readAcl(agentDir)).toEqual(parentBefore);
		expect(readFileSync(file!, "utf8")).toContain("Private concern.");
	});

	it("creates protected files with literal Unicode paths and diagnostic content", async () => {
		const path = join(createRoot(), "review '$(); 界", "record.jsonl");
		const content = '$(throw \'not executable\'); 界\n{"challenge":"private"}\n';
		await writeWindowsReviewDiagnostic(path, content);

		expect(readFileSync(path, "utf8")).toBe(content);
		expectOwnerOnly(path);
	});

	it("does not replace an existing file", async () => {
		const path = join(createRoot(), "review", "record.jsonl");
		await writeWindowsReviewDiagnostic(path, "original");

		await expect(writeWindowsReviewDiagnostic(path, "replacement")).rejects.toThrow(
			"Could not retain private Windows review diagnostics.",
		);
		expect(readFileSync(path, "utf8")).toBe("original");
	});

	it.each([false, true])("rejects a junction without changing its target (exists=%s)", async (targetExists) => {
		const root = createRoot();
		const target = join(root, "target");
		if (targetExists) mkdirSync(target);
		const targetBefore = targetExists ? readAcl(target) : undefined;
		const junction = join(root, "review-link");
		symlinkSync(target, junction, "junction");

		await expect(writeWindowsReviewDiagnostic(join(junction, "record.jsonl"), "private")).rejects.toThrow();
		expect(existsSync(join(target, "record.jsonl"))).toBe(false);
		if (targetExists) expect(readAcl(target)).toEqual(targetBefore);
		else expect(existsSync(target)).toBe(false);
	});

	it("fails closed when PowerShell cannot start, without leaking its error or using chmod-only storage", async () => {
		vi.stubEnv(REVIEW_PRIVATE_DIAGNOSTICS_ENV, "1");
		const agentDir = createRoot();
		vi.stubEnv("SystemRoot", join(agentDir, "private-path-marker"));
		const diagnostics = createReviewPrivateDiagnostics({
			agentDir,
			workflowId: "review:missing-powershell",
			workflowAction: "review.pr",
		});
		diagnostics.recordVerificationAssessment({ assessment: "incomplete", challenge: "private-content-marker" });

		const flush = diagnostics.flush();
		await expect(flush).rejects.toThrow(/^Could not retain private Windows review diagnostics\.$/);
		expect(diagnostics.flush()).toBe(flush);
		expect(existsSync(getReviewPrivateDiagnosticsDirectory(agentDir))).toBe(false);
	});
});
