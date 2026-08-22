#!/usr/bin/env bash
set -euo pipefail

UPSTREAM_URL="https://github.com/n0-computer/iroh.git"
UPSTREAM_COMMIT="f2eb930dda3779c6d852b72f3712aacd6e573ab1" # v1.0.3
RUST_TOOLCHAIN="1.97.1"
ZIG_VERSION="0.16.0"
CARGO_ZIGBUILD_VERSION="0.23.0"
LLVM_VERSION="22.1.8"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PATCH_PATH="$SCRIPT_DIR/iroh-relay-1.0.3-jwt-access.patch"
MODE="${1:-test}"
OUTPUT_PATH="${2:-/tmp/iroh-relay-1.0.3-volt-jwt}"
WORK_DIR="$(mktemp -d)"
OUTPUT_TEMP=""
MANIFEST_TEMP=""

cleanup() {
	rm -rf "$WORK_DIR"
	[[ -z "$OUTPUT_TEMP" ]] || rm -f "$OUTPUT_TEMP"
	[[ -z "$MANIFEST_TEMP" ]] || rm -f "$MANIFEST_TEMP"
}
trap cleanup EXIT

case "$MODE" in
	test | linux-x86_64) ;;
	*)
		echo "usage: $0 [test|linux-x86_64] [output-path]" >&2
		exit 2
		;;
esac

command -v git >/dev/null
command -v rustup >/dev/null
if ! rustup toolchain list | grep -Eq "^${RUST_TOOLCHAIN}(-|[[:space:]])"; then
	echo "Rust toolchain $RUST_TOOLCHAIN is required" >&2
	exit 1
fi

export CARGO_INCREMENTAL=0
export LC_ALL=C
export TZ=UTC

git clone --quiet --filter=blob:none --no-checkout "$UPSTREAM_URL" "$WORK_DIR/iroh"
git -C "$WORK_DIR/iroh" checkout --quiet --detach "$UPSTREAM_COMMIT"
actual_commit="$(git -C "$WORK_DIR/iroh" rev-parse HEAD)"
if [[ "$actual_commit" != "$UPSTREAM_COMMIT" ]]; then
	echo "unexpected upstream commit: $actual_commit" >&2
	exit 1
fi
export SOURCE_DATE_EPOCH="$(git -C "$WORK_DIR/iroh" show -s --format=%ct HEAD)"

git -C "$WORK_DIR/iroh" apply --check "$PATCH_PATH"
git -C "$WORK_DIR/iroh" apply "$PATCH_PATH"

(
	cd "$WORK_DIR/iroh"
	rustup run "$RUST_TOOLCHAIN" cargo fmt --all -- --check
	rustup run "$RUST_TOOLCHAIN" cargo test --locked -p iroh-relay --features server --bin iroh-relay
	rustup run "$RUST_TOOLCHAIN" cargo clippy --locked -p iroh-relay --features server --bin iroh-relay -- -D warnings
)

if [[ "$MODE" == "test" ]]; then
	echo "relay JWT patch validated against iroh-relay 1.0.3"
	exit 0
fi

command -v zig >/dev/null
if [[ "$(zig version)" != "$ZIG_VERSION" ]]; then
	echo "Zig $ZIG_VERSION is required" >&2
	exit 1
fi
CARGO_ZIGBUILD="${CARGO_ZIGBUILD:-$HOME/.cargo/bin/cargo-zigbuild}"
if [[ ! -x "$CARGO_ZIGBUILD" ]]; then
	echo "cargo-zigbuild is required at $CARGO_ZIGBUILD" >&2
	exit 1
fi
if ! cargo install --list | grep -q "^cargo-zigbuild v${CARGO_ZIGBUILD_VERSION}:"; then
	echo "cargo-zigbuild $CARGO_ZIGBUILD_VERSION is required" >&2
	exit 1
fi
rustup target add --toolchain "$RUST_TOOLCHAIN" x86_64-unknown-linux-gnu >/dev/null

LLVM_STRIP="${LLVM_STRIP:-}"
if [[ -z "$LLVM_STRIP" ]] && command -v llvm-strip >/dev/null; then
	LLVM_STRIP="$(command -v llvm-strip)"
elif [[ -z "$LLVM_STRIP" ]] && [[ -x /opt/homebrew/opt/llvm@22/bin/llvm-strip ]]; then
	LLVM_STRIP="/opt/homebrew/opt/llvm@22/bin/llvm-strip"
fi
if [[ -z "$LLVM_STRIP" ]] || ! "$LLVM_STRIP" --version | grep -q "LLVM version $LLVM_VERSION"; then
	echo "llvm-strip from LLVM $LLVM_VERSION is required" >&2
	exit 1
fi

(
	cd "$WORK_DIR/iroh"
	RUSTC="$(rustup which --toolchain "$RUST_TOOLCHAIN" rustc)" \
	RUSTDOC="$(rustup which --toolchain "$RUST_TOOLCHAIN" rustdoc)" \
		"$CARGO_ZIGBUILD" zigbuild \
			--locked \
			--release \
			--target x86_64-unknown-linux-gnu.2.28 \
			-p iroh-relay \
			--features server \
			--bin iroh-relay
)

binary="$WORK_DIR/iroh/target/x86_64-unknown-linux-gnu/release/iroh-relay"
output_dir="$(dirname "$OUTPUT_PATH")"
mkdir -p "$output_dir"
OUTPUT_TEMP="$(mktemp "$output_dir/.iroh-relay.tmp.XXXXXX")"
cp "$binary" "$OUTPUT_TEMP"
"$LLVM_STRIP" "$OUTPUT_TEMP"
chmod 0755 "$OUTPUT_TEMP"
if ! file "$OUTPUT_TEMP" | grep -q 'ELF 64-bit LSB pie executable, x86-64.*stripped'; then
	echo "cross-built relay binary has an unexpected format" >&2
	exit 1
fi
binary_hash="$(shasum -a 256 "$OUTPUT_TEMP" | awk '{print $1}')"
patch_hash="$(shasum -a 256 "$PATCH_PATH" | awk '{print $1}')"
MANIFEST_TEMP="$(mktemp "$output_dir/.iroh-relay-manifest.tmp.XXXXXX")"
cat >"$MANIFEST_TEMP" <<MANIFEST
upstream_commit=$UPSTREAM_COMMIT
patch_sha256=$patch_hash
rust_toolchain=$RUST_TOOLCHAIN
zig_version=$ZIG_VERSION
cargo_zigbuild_version=$CARGO_ZIGBUILD_VERSION
llvm_version=$LLVM_VERSION
target=x86_64-unknown-linux-gnu.2.28
source_date_epoch=$SOURCE_DATE_EPOCH
binary_sha256=$binary_hash
MANIFEST
mv -f "$OUTPUT_TEMP" "$OUTPUT_PATH"
OUTPUT_TEMP=""
mv -f "$MANIFEST_TEMP" "$OUTPUT_PATH.manifest"
MANIFEST_TEMP=""
printf '%s  %s\n' "$binary_hash" "$OUTPUT_PATH"
file "$OUTPUT_PATH"
cat "$OUTPUT_PATH.manifest"
