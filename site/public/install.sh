#!/bin/sh
# Volt installer — https://volt-cli.dev
#
# Usage:
#   curl -fsSL https://volt-cli.dev/install.sh | sh
#
# Options (environment variables):
#   VOLT_INSTALL_METHOD=npm      Node.js install (default). Supports the local
#                                CLI/TUI and, where the pinned native Iroh
#                                adapter is available, daemon/remote/iOS access.
#   VOLT_INSTALL_METHOD=binary   Standalone local CLI/TUI only. The binary does
#                                not bundle Iroh and rejects `volt daemon`.
#   VOLT_VERSION=latest          Install the npm beta channel (default) or latest binary.
#   VOLT_VERSION=v0.1.0          Pin a canonical release for either method.
set -eu

PACKAGE="@hansjm10/volt-coding-agent"
REPO="volt-hq/Volt"
MIN_NODE_MAJOR=26
MIN_NODE_MINOR=0
METHOD="${VOLT_INSTALL_METHOD:-npm}"
VERSION="${VOLT_VERSION:-latest}"

say() { printf '%s\n' "$*"; }
fail() { printf 'volt install: %s\n' "$*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }

validate_version() {
    [ "$VERSION" = "latest" ] && return
    printf '%s\n' "$VERSION" | grep -Eq '^v?(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$' || \
        fail "VOLT_VERSION must be 'latest' or a canonical version such as v0.1.0"
}

install_npm() {
    have node || fail "Node.js not found. The full Volt install requires Node.js >= 26.0.
Install it from https://nodejs.org, then re-run this installer.
For a local CLI/TUI without daemon or remote/iOS support:
  curl -fsSL https://volt-cli.dev/install.sh | VOLT_INSTALL_METHOD=binary sh"

    node_supported=$(node -p "const [major, minor] = process.versions.node.split('.').map(Number); Number(major > $MIN_NODE_MAJOR || (major === $MIN_NODE_MAJOR && minor >= $MIN_NODE_MINOR))")
    [ "$node_supported" = "1" ] || fail "Node.js $(node --version) is too old. Volt requires Node.js >= 26.0."
    have npm || fail "npm not found. It normally ships with Node.js; install Node.js from https://nodejs.org."

    npm_spec="$PACKAGE@beta"
    if [ "$VERSION" != "latest" ]; then
        npm_spec="$PACKAGE@${VERSION#v}"
    fi

    say "Installing $npm_spec globally (lifecycle scripts disabled)..."
    npm install -g --ignore-scripts "$npm_spec"
    node_runtime=$(node -p '`${process.platform}-${process.arch}`')

    if have volt; then
        say ""
        say "Installed: $(volt --version 2>/dev/null || say volt)"
        say "Run 'volt' in a project directory to get started."
    else
        npm_bin=$(npm prefix -g)/bin
        say ""
        say "Installed, but '$npm_bin' is not on your PATH."
        say "Add it to your shell profile, e.g.:"
        say "  export PATH=\"$npm_bin:\$PATH\""
    fi
    if [ "$node_runtime" = "darwin-x64" ]; then
        say "This install supports the local CLI/TUI."
        say "Daemon and remote/iOS access are unavailable on Intel macOS because the pinned Iroh adapter has no Darwin x64 binding."
    else
        say "This npm install supports 'volt daemon' and remote/iOS access."
    fi
    say "Docs: https://volt-cli.dev/docs/quickstart/"
}

sha256_file() {
    if have sha256sum; then
        sha256sum "$1" | awk '{print $1}'
    elif have shasum; then
        shasum -a 256 "$1" | awk '{print $1}'
    elif have openssl; then
        openssl dgst -sha256 "$1" | awk '{print $NF}'
    else
        fail "no SHA-256 tool found (need sha256sum, shasum, or openssl)"
    fi
}

install_binary() {
    have curl || fail "curl is required for the standalone binary install"
    have tar || fail "tar is required for the standalone binary install"

    os=$(uname -s)
    arch=$(uname -m)
    case "$os" in
        Darwin) platform="darwin" ;;
        Linux) platform="linux" ;;
        *) fail "unsupported OS '$os'. On Windows, run: irm https://volt-cli.dev/install.ps1 | iex" ;;
    esac
    case "$arch" in
        arm64 | aarch64) platform="$platform-arm64" ;;
        x86_64 | amd64) platform="$platform-x64" ;;
        *) fail "unsupported architecture '$arch'" ;;
    esac

    asset="volt-$platform.tar.gz"
    if [ "$VERSION" = "latest" ]; then
        base_url="https://github.com/$REPO/releases/latest/download"
    else
        release_tag="v${VERSION#v}"
        base_url="https://github.com/$REPO/releases/download/$release_tag"
    fi

    umask 077
    volt_home="$HOME/.volt"
    bin_dir="$volt_home/bin"
    mkdir -p "$volt_home"
    chmod 700 "$volt_home" 2>/dev/null || true
    tmp=$(mktemp -d "${TMPDIR:-/tmp}/volt-install.XXXXXX")
    trap 'rm -rf "$tmp"' EXIT
    trap 'exit 1' HUP INT TERM

    say "Downloading $base_url/$asset ..."
    curl -fSL --proto '=https' --tlsv1.2 -o "$tmp/$asset" "$base_url/$asset"
    curl -fSL --proto '=https' --tlsv1.2 -o "$tmp/SHA256SUMS" "$base_url/SHA256SUMS"

    checksum_count=$(awk -v asset="$asset" '$2 == asset { count += 1 } END { print count + 0 }' "$tmp/SHA256SUMS")
    [ "$checksum_count" = "1" ] || fail "SHA256SUMS must contain exactly one checksum for $asset"
    expected=$(awk -v asset="$asset" '$2 == asset { print $1 }' "$tmp/SHA256SUMS")
    printf '%s\n' "$expected" | grep -Eq '^[0-9A-Fa-f]{64}$' || fail "invalid checksum for $asset"
    actual=$(sha256_file "$tmp/$asset")
    expected=$(printf '%s' "$expected" | tr 'A-F' 'a-f')
    actual=$(printf '%s' "$actual" | tr 'A-F' 'a-f')
    [ "$actual" = "$expected" ] || fail "SHA-256 verification failed for $asset"

    tar -tzf "$tmp/$asset" > "$tmp/archive-entries"
    [ -s "$tmp/archive-entries" ] || fail "release archive is empty"
    while IFS= read -r entry; do
        case "$entry" in
            volt | volt/ | volt/*) ;;
            *) fail "release archive contains a path outside volt/" ;;
        esac
        case "/$entry/" in
            */../* | */./*) fail "release archive contains a non-canonical path" ;;
        esac
    done < "$tmp/archive-entries"
    tar -tvzf "$tmp/$asset" > "$tmp/archive-details"
    if awk 'substr($1, 1, 1) != "-" && substr($1, 1, 1) != "d" { found = 1 } END { exit !found }' "$tmp/archive-details"; then
        fail "release archive must contain only regular files and directories"
    fi

    mkdir "$tmp/extract"
    tar -xzf "$tmp/$asset" -C "$tmp/extract"
    release_dir="$tmp/extract/volt"
    for required in \
        volt package.json image-resize-worker.cjs binary-metafile.json \
        binary-license-manifest.json standalone-build-manifest.json \
        standalone-file-manifest.json LICENSES/node-v26.8.1-LICENSE.txt; do
        [ -f "$release_dir/$required" ] || fail "release archive is missing volt/$required"
    done
    [ -d "$release_dir/theme" ] || fail "release archive is missing volt/theme"
    [ -d "$release_dir/export-html" ] || fail "release archive is missing volt/export-html"
    [ -z "$(find "$release_dir" -type l -print -quit)" ] || fail "release archive must not contain symlinks"

    staged="$volt_home/.bin.install.$$"
    backup="$volt_home/.bin.backup.$$"
    rm -rf "$staged" "$backup"
    mkdir "$staged"
    cp -R "$release_dir/." "$staged/"
    chmod 700 "$staged" "$staged/volt" 2>/dev/null || true

    if [ -e "$bin_dir" ] || [ -L "$bin_dir" ]; then
        [ ! -L "$bin_dir" ] || fail "refusing symlink install directory: $bin_dir"
        mv "$bin_dir" "$backup"
    fi
    if mv "$staged" "$bin_dir"; then
        rm -rf "$backup"
    else
        [ ! -e "$backup" ] || mv "$backup" "$bin_dir"
        fail "could not replace $bin_dir"
    fi

    say ""
    say "Installed verified standalone release to $bin_dir"
    say "Capability: local CLI/TUI only. 'volt daemon' and remote/iOS access are unavailable."
    say "For those features, use the default npm install:"
    say "  curl -fsSL https://volt-cli.dev/install.sh | sh"
    case ":$PATH:" in
        *":$bin_dir:"*) ;;
        *)
            say ""
            say "Add volt to your PATH, e.g.:"
            say "  export PATH=\"\$HOME/.volt/bin:\$PATH\""
            ;;
    esac
    say "Docs: https://volt-cli.dev/docs/quickstart/"
}

validate_version
case "$METHOD" in
    npm) install_npm ;;
    binary) install_binary ;;
    *) fail "unknown VOLT_INSTALL_METHOD '$METHOD' (expected 'npm' or 'binary')" ;;
esac
