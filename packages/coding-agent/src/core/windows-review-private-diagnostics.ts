import { Buffer } from "node:buffer";
import { execFile } from "node:child_process";
import { dirname, join } from "node:path";

// Windows PowerShell uses .NET Framework's ACL-aware creation overloads. Paths
// and diagnostic text travel only as JSON on stdin, never as executable code or
// command-line arguments. The file DACL is installed atomically at CreateNew.
const WRITE_DIAGNOSTIC_SCRIPT = `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
$stream = $null
$created = $false
try {
    $request = ConvertFrom-Json ([Console]::In.ReadToEnd())
    $directory = [IO.DirectoryInfo]::new([string]$request.directory)
    $filePath = [IO.Path]::GetFullPath([string]$request.path)
    if ([IO.Path]::GetDirectoryName($filePath) -ne $directory.FullName) { throw 'Invalid diagnostic path.' }
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    try { $sid = $identity.User } finally { $identity.Dispose() }

    $directorySecurity = [Security.AccessControl.DirectorySecurity]::new()
    $directorySecurity.SetOwner($sid)
    $directorySecurity.SetAccessRuleProtection($true, $false)
    $directorySecurity.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new(
        $sid, [Security.AccessControl.FileSystemRights]::FullControl,
        [Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit',
        [Security.AccessControl.PropagationFlags]::None, [Security.AccessControl.AccessControlType]::Allow))
    $directory.Refresh()
    if ($directory.Exists) {
        if (($directory.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Linked diagnostic directory.' }
        if ($directory.GetAccessControl().GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $sid.Value) {
            throw 'Diagnostic directory belongs to another account.'
        }
        $directory.SetAccessControl($directorySecurity)
    } else {
        $directory.Create($directorySecurity)
    }
    $directory.Refresh()
    if (($directory.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Linked diagnostic directory.' }
    $actualDirectorySecurity = $directory.GetAccessControl()
    $directoryRules = @($actualDirectorySecurity.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))
    if (-not $actualDirectorySecurity.AreAccessRulesProtected -or
        $actualDirectorySecurity.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $sid.Value -or
        $directoryRules.Count -ne 1 -or $directoryRules[0].IdentityReference.Value -ne $sid.Value -or
        $directoryRules[0].AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow -or
        $directoryRules[0].FileSystemRights -ne [Security.AccessControl.FileSystemRights]::FullControl) {
        throw 'Could not establish private directory access.'
    }

    $fileSecurity = [Security.AccessControl.FileSecurity]::new()
    $fileSecurity.SetOwner($sid)
    $fileSecurity.SetAccessRuleProtection($true, $false)
    $fileSecurity.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new(
        $sid, [Security.AccessControl.FileSystemRights]::FullControl, [Security.AccessControl.AccessControlType]::Allow))
    $stream = [IO.FileStream]::new($filePath, [IO.FileMode]::CreateNew,
        [Security.AccessControl.FileSystemRights]::FullControl, [IO.FileShare]::None,
        4096, [IO.FileOptions]::None, $fileSecurity)
    $created = $true
    $actualFileSecurity = $stream.GetAccessControl()
    $fileRules = @($actualFileSecurity.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))
    if (-not $actualFileSecurity.AreAccessRulesProtected -or
        $actualFileSecurity.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $sid.Value -or
        $fileRules.Count -ne 1 -or $fileRules[0].IdentityReference.Value -ne $sid.Value -or
        $fileRules[0].AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow -or
        $fileRules[0].FileSystemRights -ne [Security.AccessControl.FileSystemRights]::FullControl) {
        throw 'Could not establish private file access.'
    }
    $bytes = [Text.UTF8Encoding]::new($false).GetBytes([string]$request.content)
    $stream.Write($bytes, 0, $bytes.Length)
    $stream.Flush($true)
} catch {
    if ($null -ne $stream) { $stream.Dispose(); $stream = $null }
    if ($created) { try { [IO.File]::Delete($filePath) } catch {} }
    [Console]::Error.WriteLine('Could not retain private Windows review diagnostics.')
    exit 1
} finally {
    if ($null -ne $stream) { $stream.Dispose() }
}
`;

/** Review-only Windows sink; failure must never fall back to chmod-only storage. */
export async function writeWindowsReviewDiagnostic(filePath: string, content: string): Promise<void> {
	const systemRoot = process.env.SystemRoot;
	if (!systemRoot) throw new Error("Windows system directory is unavailable.");
	await new Promise<void>((resolve, reject) => {
		const child = execFile(
			join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
			[
				"-NoLogo",
				"-NoProfile",
				"-NonInteractive",
				"-EncodedCommand",
				Buffer.from(WRITE_DIAGNOSTIC_SCRIPT, "utf16le").toString("base64"),
			],
			{ windowsHide: true, timeout: 10_000, maxBuffer: 8_192 },
			(error) => {
				if (error) reject(new Error("Could not retain private Windows review diagnostics."));
				else resolve();
			},
		);
		// Startup/timeout errors are reported by execFile's callback; don't let an
		// early pipe closure become an unhandled event or expose its raw diagnostic.
		child.stdin?.on("error", () => {});
		child.stdin?.end(JSON.stringify({ directory: dirname(filePath), path: filePath, content }), "utf8");
	});
}
