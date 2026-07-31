#!/usr/bin/env bash
# Build the Volt standalone archive for the current native platform.
#
# Usage:
#   ./scripts/build-binaries.sh [--skip-install] [--skip-build] [--platform <target>] [--out <dir>] [--node-archive <file>]

set -euo pipefail

cd "$(dirname "$0")/.."
REPO_ROOT=$(pwd -P)
DEFAULT_OUTPUT_DIR="$REPO_ROOT/packages/coding-agent/binaries"

if [[ -z "${VOLT_PYTHON:-}" ]]; then
	if command -v python3 >/dev/null 2>&1 && python3 --version >/dev/null 2>&1; then
		VOLT_PYTHON=python3
	elif command -v python >/dev/null 2>&1 && python --version >/dev/null 2>&1; then
		VOLT_PYTHON=python
	else
		echo "Python 3 is required to create deterministic release archives" >&2
		exit 1
	fi
fi
export VOLT_PYTHON

SKIP_INSTALL=false
SKIP_BUILD=false
PLATFORM=""
OUTPUT_DIR=""
NODE_ARCHIVE=""

while [[ $# -gt 0 ]]; do
	case "$1" in
		--skip-install)
			SKIP_INSTALL=true
			shift
			;;
		--skip-build)
			SKIP_BUILD=true
			shift
			;;
		--platform)
			if [[ $# -lt 2 || "$2" == -* ]]; then
				echo "--platform requires a value" >&2
				exit 1
			fi
			PLATFORM="$2"
			shift 2
			;;
		--out)
			if [[ $# -lt 2 || -z "$2" || "$2" == -* ]]; then
				echo "--out requires a directory" >&2
				exit 1
			fi
			OUTPUT_DIR="$2"
			shift 2
			;;
		--node-archive)
			if [[ $# -lt 2 || -z "$2" || "$2" == -* ]]; then
				echo "--node-archive requires a file" >&2
				exit 1
			fi
			NODE_ARCHIVE="$2"
			shift 2
			;;
		*)
			echo "Unknown option: $1" >&2
			exit 1
			;;
	esac
done

NATIVE_PLATFORM=$(node -p '`${process.platform === "win32" ? "windows" : process.platform}-${process.arch}`')
case "$NATIVE_PLATFORM" in
	darwin-arm64|darwin-x64|linux-arm64|linux-x64|windows-arm64|windows-x64) ;;
	*)
		echo "Unsupported native platform: $NATIVE_PLATFORM" >&2
		exit 1
		;;
esac
if [[ -z "$PLATFORM" ]]; then
	PLATFORM="$NATIVE_PLATFORM"
fi
case "$PLATFORM" in
	darwin-arm64|darwin-x64|linux-arm64|linux-x64|windows-arm64|windows-x64) ;;
	*)
		echo "Invalid platform: $PLATFORM" >&2
		exit 1
		;;
esac
if [[ "$PLATFORM" != "$NATIVE_PLATFORM" ]]; then
	echo "Standalone builds are native-only: requested $PLATFORM, current platform is $NATIVE_PLATFORM" >&2
	exit 1
fi

if [[ -z "$OUTPUT_DIR" ]]; then
	OUTPUT_DIR="$DEFAULT_OUTPUT_DIR"
fi

if [[ "$SKIP_INSTALL" == "false" ]]; then
	echo "==> Installing dependencies..."
	npm ci --ignore-scripts
else
	echo "==> Skipping npm ci (--skip-install)"
fi

if [[ "$SKIP_BUILD" == "false" ]]; then
	echo "==> Building all packages..."
	npm run build
else
	echo "==> Skipping package build (--skip-build)"
fi

if [[ -z "${SOURCE_DATE_EPOCH:-}" ]]; then
	SOURCE_DATE_EPOCH=$(git show -s --format=%ct HEAD)
fi

args=(
	--target "$PLATFORM"
	--out "$OUTPUT_DIR"
	--source-date-epoch "$SOURCE_DATE_EPOCH"
)
if [[ -n "$NODE_ARCHIVE" ]]; then
	args+=(--node-archive "$NODE_ARCHIVE")
fi

echo "==> Building Node.js SEA for $PLATFORM..."
node scripts/build-standalone.mjs "${args[@]}"

echo "==> Build complete"
echo "Archive: $OUTPUT_DIR/volt-$PLATFORM.$([[ $PLATFORM == windows-* ]] && echo zip || echo tar.gz)"
echo "Executable: $OUTPUT_DIR/$PLATFORM/$([[ $PLATFORM == windows-* ]] && echo volt.exe || echo volt)"
