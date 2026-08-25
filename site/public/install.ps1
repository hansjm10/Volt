# Volt installer for Windows — https://volt-cli.dev
#
# Usage:
#   irm https://volt-cli.dev/install.ps1 | iex
#
# Options (environment variables):
#   VOLT_INSTALL_METHOD=npm      Full Node.js install (default), including daemon/remote.
#   VOLT_INSTALL_METHOD=binary   Standalone local CLI/TUI only; no daemon/remote/iOS access.
#   VOLT_VERSION=latest          Install the npm beta channel (default) or latest binary.
#   VOLT_VERSION=v0.1.0          Pin a canonical release for either method.

$ErrorActionPreference = "Stop"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$package = "@hansjm10/volt-coding-agent"
$repo = "volt-hq/Volt"
$method = if ([string]::IsNullOrWhiteSpace($env:VOLT_INSTALL_METHOD)) { "npm" } else { $env:VOLT_INSTALL_METHOD }
$version = if ([string]::IsNullOrWhiteSpace($env:VOLT_VERSION)) { "latest" } else { $env:VOLT_VERSION }

function Fail([string]$message) {
    Write-Host "volt install: $message" -ForegroundColor Red
    exit 1
}

if ($version -ne "latest" -and $version -notmatch '^v?(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$') {
    Fail "VOLT_VERSION must be 'latest' or a canonical version such as v0.1.0"
}

function Install-NpmVolt {
    if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
        Fail "Node.js not found. The full Volt install requires Node.js >= 22.19. Install it from https://nodejs.org. For a local CLI/TUI without daemon or remote/iOS support, set VOLT_INSTALL_METHOD=binary."
    }

    $nodeSupported = node -p 'const [major, minor] = process.versions.node.split(".").map(Number); Number(major > 22 || (major === 22 && minor >= 19))'
    if ($LASTEXITCODE -ne 0 -or $nodeSupported -ne "1") {
        Fail "Node.js $(node --version) is too old. Volt requires Node.js >= 22.19."
    }
    if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
        Fail "npm not found. It normally ships with Node.js; install Node.js from https://nodejs.org."
    }

    $npmSpec = "$package@beta"
    if ($version -ne "latest") {
        $npmSpec = "$package@$($version.TrimStart('v'))"
    }
    Write-Host "Installing $npmSpec globally (lifecycle scripts disabled)..."
    npm install -g --ignore-scripts $npmSpec
    if ($LASTEXITCODE -ne 0) {
        Fail "npm install failed (exit code $LASTEXITCODE)"
    }

    Write-Host ""
    if (Get-Command volt -ErrorAction SilentlyContinue) {
        Write-Host "Installed. Run 'volt' in a project directory to get started."
        Write-Host "This npm install supports 'volt daemon' and remote/iOS access."
    } else {
        $npmBin = npm prefix -g
        Write-Host "Installed, but '$npmBin' is not on your PATH. Add it and restart your terminal."
    }
}

function Install-BinaryVolt {
    $architecture = [Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString().ToLowerInvariant()
    switch ($architecture) {
        "x64" { $platform = "windows-x64" }
        "arm64" { $platform = "windows-arm64" }
        default { Fail "unsupported Windows architecture '$architecture'" }
    }

    $asset = "volt-$platform.zip"
    if ($version -eq "latest") {
        $baseUrl = "https://github.com/$repo/releases/latest/download"
    } else {
        $releaseTag = "v$($version.TrimStart('v'))"
        $baseUrl = "https://github.com/$repo/releases/download/$releaseTag"
    }

    $temporaryDirectory = Join-Path ([IO.Path]::GetTempPath()) "volt-install-$([Guid]::NewGuid().ToString('N'))"
    $archivePath = Join-Path $temporaryDirectory $asset
    $checksumsPath = Join-Path $temporaryDirectory "SHA256SUMS"
    $extractedDirectory = Join-Path $temporaryDirectory "release"
    $stagedDirectory = $null
    New-Item -ItemType Directory -Path $temporaryDirectory | Out-Null
    try {
        Write-Host "Downloading $baseUrl/$asset ..."
        Invoke-WebRequest -UseBasicParsing -Uri "$baseUrl/$asset" -OutFile $archivePath
        Invoke-WebRequest -UseBasicParsing -Uri "$baseUrl/SHA256SUMS" -OutFile $checksumsPath

        $escapedAsset = [Regex]::Escape($asset)
        $checksumMatches = @()
        foreach ($line in Get-Content -LiteralPath $checksumsPath) {
            if ($line -match "^([0-9A-Fa-f]{64})\s+$escapedAsset$") {
                $checksumMatches += $Matches[1].ToLowerInvariant()
            }
        }
        if ($checksumMatches.Count -ne 1) {
            Fail "SHA256SUMS must contain exactly one checksum for $asset"
        }
        $actualChecksum = (Get-FileHash -Algorithm SHA256 -LiteralPath $archivePath).Hash.ToLowerInvariant()
        if ($actualChecksum -ne $checksumMatches[0]) {
            Fail "SHA-256 verification failed for $asset"
        }

        Add-Type -AssemblyName System.IO.Compression.FileSystem
        $archive = [IO.Compression.ZipFile]::OpenRead($archivePath)
        try {
            foreach ($entry in $archive.Entries) {
                $entryName = $entry.FullName
                $unixFileType = (($entry.ExternalAttributes -shr 16) -band 0xF000)
                $windowsAttributes = ($entry.ExternalAttributes -band 0xFFFF)
                if (
                    [string]::IsNullOrWhiteSpace($entryName) -or
                    $entryName.Contains('\') -or
                    $entryName.StartsWith('/') -or
                    $entryName.Contains(':') -or
                    $entryName -match '(^|/)\.\.(/|$)' -or
                    $entryName -match '(^|/)\.(/|$)' -or
                    $unixFileType -eq 0xA000 -or
                    ($windowsAttributes -band [IO.FileAttributes]::ReparsePoint) -ne 0
                ) {
                    Fail "release archive contains an unsafe path or link"
                }
            }
            $entries = @($archive.Entries | Where-Object { $_.FullName -eq "volt.exe" -and $_.Name -eq "volt.exe" })
            if ($entries.Count -ne 1) {
                Fail "release archive must contain exactly one root volt.exe"
            }
        } finally {
            $archive.Dispose()
        }
        [IO.Compression.ZipFile]::ExtractToDirectory($archivePath, $extractedDirectory)

        $requiredFiles = @(
            "volt.exe",
            "package.json",
            "image-resize-worker.cjs",
            "binary-metafile.json",
            "binary-license-manifest.json",
            "standalone-build-manifest.json",
            "standalone-file-manifest.json",
            "LICENSES\node-v22.23.1-LICENSE.txt"
        )
        foreach ($required in $requiredFiles) {
            if (-not (Test-Path -LiteralPath (Join-Path $extractedDirectory $required) -PathType Leaf)) {
                Fail "release archive is missing $required"
            }
        }
        foreach ($requiredDirectory in @("theme", "export-html")) {
            if (-not (Test-Path -LiteralPath (Join-Path $extractedDirectory $requiredDirectory) -PathType Container)) {
                Fail "release archive is missing $requiredDirectory"
            }
        }
        $reparsePoint = Get-ChildItem -Force -Recurse -LiteralPath $extractedDirectory | Where-Object {
            ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0
        } | Select-Object -First 1
        if ($null -ne $reparsePoint) {
            Fail "release archive must not contain links or reparse points"
        }

        $voltHome = Join-Path $HOME ".volt"
        $binDirectory = Join-Path $voltHome "bin"
        $stagedDirectory = Join-Path $voltHome ".bin.install-$([Guid]::NewGuid().ToString('N'))"
        $backupDirectory = Join-Path $voltHome ".bin.backup-$([Guid]::NewGuid().ToString('N'))"
        New-Item -ItemType Directory -Force -Path $voltHome | Out-Null
        if (
            (Test-Path -LiteralPath $binDirectory) -and
            (((Get-Item -Force -LiteralPath $binDirectory).Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0)
        ) {
            Fail "refusing link or reparse-point install directory: $binDirectory"
        }
        New-Item -ItemType Directory -Path $stagedDirectory | Out-Null
        Get-ChildItem -Force -LiteralPath $extractedDirectory | Copy-Item -Recurse -Force -Destination $stagedDirectory

        $movedExistingInstall = $false
        try {
            if (Test-Path -LiteralPath $binDirectory) {
                Move-Item -LiteralPath $binDirectory -Destination $backupDirectory
                $movedExistingInstall = $true
            }
            Move-Item -LiteralPath $stagedDirectory -Destination $binDirectory
            if ($movedExistingInstall) {
                Remove-Item -Recurse -Force -LiteralPath $backupDirectory
            }
        } catch {
            if ($movedExistingInstall -and -not (Test-Path -LiteralPath $binDirectory)) {
                Move-Item -LiteralPath $backupDirectory -Destination $binDirectory
            }
            throw
        }
        Write-Host ""
        Write-Host "Installed verified standalone release to $binDirectory"
        Write-Host "Capability: local CLI/TUI only. 'volt daemon' and remote/iOS access are unavailable."
        Write-Host "For those features, use the default npm install."
        if (($env:PATH -split ';') -notcontains $binDirectory) {
            Write-Host "Add '$binDirectory' to your PATH and restart your terminal."
        }
    } finally {
        if ($null -ne $stagedDirectory -and (Test-Path -LiteralPath $stagedDirectory)) {
            Remove-Item -Recurse -Force -ErrorAction SilentlyContinue -LiteralPath $stagedDirectory
        }
        Remove-Item -Recurse -Force -ErrorAction SilentlyContinue -LiteralPath $temporaryDirectory
    }
}

switch ($method) {
    "npm" { Install-NpmVolt }
    "binary" { Install-BinaryVolt }
    default { Fail "unknown VOLT_INSTALL_METHOD '$method' (expected 'npm' or 'binary')" }
}

Write-Host "Windows setup notes: https://volt-cli.dev/docs/windows/"
Write-Host "Docs: https://volt-cli.dev/docs/quickstart/"
