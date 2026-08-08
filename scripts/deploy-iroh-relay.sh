#!/usr/bin/env bash
# Deploy (or update) a self-hosted iroh relay for Volt on a fresh Ubuntu/Debian
# VPS. Idempotent: re-running upgrades the binary, rewrites managed files, and
# restarts the service. See docs/self-hosted-relay.md for the operator runbook.
#
# Prereqs: root SSH access; DNS A record for HOSTNAME; nftables installed and
# usable. Managed relays also require Python 3.10+ and a pre-provisioned
# root-owned bearer-token file on the server. The token is never accepted on
# this script's command line.
#
# Usage:
#   scripts/deploy-iroh-relay.sh <ssh-target> <hostname> <access-mode> [options]
#   scripts/deploy-iroh-relay.sh <ssh-target> --add-allow <endpoint-id>
#
# Access modes (choose exactly one for deployment):
#   --access-http-url <url>  authorize registrations with Volt's exact fixed
#                            production access.http endpoint (managed mode)
#   --allowlist <id,id,..>   allow only these endpoint ids (custom relay mode)
#   --open                    allow every endpoint (custom relay mode)
#
# Options:
#   --access-http-token-file <remote-path>
#                            root-owned mode 0400/0600 raw bearer-token file
#                            (default: /etc/iroh-relay/http-bearer-token)
#   --contact <email>        required Let's Encrypt contact email
#   --version <vX.Y.Z>       release tag with a checksum pinned below
#                            (currently/default: v1.0.3)
#   --egress-bytes-per-second <n>
#                            aggregate relay-user egress ceiling
#                            (default: 67108864)
#   --egress-burst-bytes <n> aggregate egress burst allowance
#                            (default: 134217728)
#   --add-allow <id>         append one endpoint id to an existing custom
#                            allowlist and restart (no other changes)
set -euo pipefail

VOLT_MANAGED_ACCESS_HTTP_URL="https://iroh-enrollment-us-central.volt-cli.dev/v1/relay-access"
MANAGED_ACCESS_PROXY_URL="http://127.0.0.1:9081/v1/relay-access"
SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
ACCESS_PROXY_SOURCE="$SCRIPT_DIR/iroh_relay_access_proxy.py"

usage() {
	printf '%s\n' "usage: deploy-iroh-relay.sh <ssh-target> <hostname> (--access-http-url <url> | --allowlist <ids> | --open) [options]" >&2
	exit 2
}

require_value() {
	if [[ $# -lt 2 || -z "$2" ]]; then
		echo "error: $1 requires a value" >&2
		exit 2
	fi
}

[[ $# -ge 1 ]] || usage
SSH_TARGET=$1
shift

HOSTNAME_ARG=""
if [[ "${1:-}" != --* ]]; then
	HOSTNAME_ARG=${1:-}
	shift || true
fi

VERSION="v1.0.3"
CONTACT=""
ALLOWLIST=""
OPEN=false
ACCESS_HTTP_URL=""
ACCESS_HTTP_TOKEN_FILE="/etc/iroh-relay/http-bearer-token"
ACCESS_HTTP_TOKEN_FILE_SET=false
ADD_ALLOW=""
EGRESS_BYTES_PER_SECOND=67108864
EGRESS_BURST_BYTES=134217728

while [[ $# -gt 0 ]]; do
	case "$1" in
		--contact)
			require_value "$@"
			CONTACT=$2
			shift 2
			;;
		--access-http-url)
			require_value "$@"
			ACCESS_HTTP_URL=$2
			shift 2
			;;
		--access-http-token-file)
			require_value "$@"
			ACCESS_HTTP_TOKEN_FILE=$2
			ACCESS_HTTP_TOKEN_FILE_SET=true
			shift 2
			;;
		--allowlist)
			require_value "$@"
			ALLOWLIST=$2
			shift 2
			;;
		--open)
			OPEN=true
			shift
			;;
		--version)
			require_value "$@"
			VERSION=$2
			shift 2
			;;
		--egress-bytes-per-second)
			require_value "$@"
			EGRESS_BYTES_PER_SECOND=$2
			shift 2
			;;
		--egress-burst-bytes)
			require_value "$@"
			EGRESS_BURST_BYTES=$2
			shift 2
			;;
		--add-allow)
			require_value "$@"
			ADD_ALLOW=$2
			shift 2
			;;
		--shared-token)
			echo "error: --shared-token was removed; use --access-http-url and a root-owned --access-http-token-file" >&2
			exit 2
			;;
		*)
			echo "unknown option: $1" >&2
			exit 2
			;;
	esac
done

run() { ssh "$SSH_TARGET" "$@"; }

# --add-allow changes only an existing custom allowlist. ---------------------
if [[ -n "$ADD_ALLOW" ]]; then
	if [[ -n "$HOSTNAME_ARG" || -n "$ACCESS_HTTP_URL" || -n "$ALLOWLIST" || "$OPEN" == true ]]; then
		echo "error: --add-allow cannot be combined with deployment arguments" >&2
		exit 2
	fi
	if ! [[ "$ADD_ALLOW" =~ ^[0-9a-f]{64}$ ]]; then
		echo "error: --add-allow expects a 64-character lowercase-hex endpoint id" >&2
		exit 2
	fi
	run "set -eu
		test -f /etc/iroh-relay/config.toml || { echo 'no relay config on server' >&2; exit 1; }
		grep -q '^allowlist = \[' /etc/iroh-relay/config.toml || { echo 'relay does not use a custom allowlist' >&2; exit 1; }
		if grep -q '$ADD_ALLOW' /etc/iroh-relay/config.toml; then
			echo 'endpoint id already allowed'
		else
			sed -i 's/^allowlist = \[/allowlist = [\n  \"$ADD_ALLOW\",/' /etc/iroh-relay/config.toml
			systemctl restart iroh-relay
			echo 'endpoint id added; relay restarted'
		fi"
	exit 0
fi

[[ -n "$HOSTNAME_ARG" ]] || { echo "error: hostname required for deploy" >&2; exit 2; }

ACCESS_MODE_COUNT=0
[[ -n "$ACCESS_HTTP_URL" ]] && ((ACCESS_MODE_COUNT += 1))
[[ -n "$ALLOWLIST" ]] && ((ACCESS_MODE_COUNT += 1))
[[ "$OPEN" == true ]] && ((ACCESS_MODE_COUNT += 1))
if [[ $ACCESS_MODE_COUNT -ne 1 ]]; then
	echo "error: choose exactly one of --access-http-url, --allowlist, or --open" >&2
	exit 2
fi
if [[ -z "$ACCESS_HTTP_URL" && "$ACCESS_HTTP_TOKEN_FILE_SET" == true ]]; then
	echo "error: --access-http-token-file is only valid with --access-http-url" >&2
	exit 2
fi
if [[ -z "$CONTACT" ]]; then
	echo "error: --contact is required for Let's Encrypt certificate issuance" >&2
	exit 2
fi

if ! [[ "$VERSION" =~ ^v([0-9]+)\.([0-9]+)\.([0-9]+)$ ]]; then
	echo "error: --version must be a release tag like v1.0.3" >&2
	exit 2
fi
VERSION_MAJOR=${BASH_REMATCH[1]}
VERSION_MINOR=${BASH_REMATCH[2]}
VERSION_PATCH=${BASH_REMATCH[3]}
if ((VERSION_MAJOR < 1 || (VERSION_MAJOR == 1 && VERSION_MINOR == 0 && VERSION_PATCH < 3))); then
	echo "error: iroh-relay v1.0.3 or newer is required for external access.http authorization" >&2
	exit 2
fi
if ! [[ "$EGRESS_BYTES_PER_SECOND" =~ ^[1-9][0-9]*$ && "$EGRESS_BURST_BYTES" =~ ^[1-9][0-9]*$ ]]; then
	echo "error: egress rate and burst must be positive integer byte counts" >&2
	exit 2
fi
if ((${#EGRESS_BYTES_PER_SECOND} > 10 || ${#EGRESS_BURST_BYTES} > 10)); then
	echo "error: egress rate and burst must not exceed 4294967295 bytes" >&2
	exit 2
fi
if ((EGRESS_BYTES_PER_SECOND > 4294967295 || EGRESS_BURST_BYTES > 4294967295)); then
	echo "error: egress rate and burst must not exceed 4294967295 bytes" >&2
	exit 2
fi

if ! [[ "$HOSTNAME_ARG" =~ ^[A-Za-z0-9][A-Za-z0-9.-]*[A-Za-z0-9]$ ]] || [[ "$HOSTNAME_ARG" == *..* ]]; then
	echo "error: hostname contains unsupported characters" >&2
	exit 2
fi
if [[ -n "$CONTACT" ]] && { [[ "$CONTACT" == *['"\\']* ]] || [[ "$CONTACT" =~ [[:space:]] ]]; }; then
	echo "error: contact contains unsupported characters" >&2
	exit 2
fi
if [[ -n "$ACCESS_HTTP_URL" ]]; then
	if [[ "$ACCESS_HTTP_URL" != "$VOLT_MANAGED_ACCESS_HTTP_URL" ]]; then
		echo "error: --access-http-url must exactly match Volt's pinned managed relay callback" >&2
		exit 2
	fi
	if ! [[ "$ACCESS_HTTP_TOKEN_FILE" =~ ^/[A-Za-z0-9._/-]+$ ]] || [[ "$ACCESS_HTTP_TOKEN_FILE" == *'/../'* || "$ACCESS_HTTP_TOKEN_FILE" == */.. ]]; then
		echo "error: --access-http-token-file must be a simple absolute path without '..'" >&2
		exit 2
	fi
fi

ALLOWLIST_IDS=()
if [[ -n "$ALLOWLIST" ]]; then
	IFS=',' read -ra RAW_IDS <<<"$ALLOWLIST"
	for raw_id in "${RAW_IDS[@]}"; do
		id=$(printf '%s' "$raw_id" | tr -d '[:space:]')
		if ! [[ "$id" =~ ^[0-9a-f]{64}$ ]]; then
			echo "error: --allowlist entries must be 64-character lowercase-hex endpoint ids" >&2
			exit 2
		fi
		ALLOWLIST_IDS+=("$id")
	done
	[[ ${#ALLOWLIST_IDS[@]} -gt 0 ]] || { echo "error: --allowlist must not be empty" >&2; exit 2; }
fi

# Sanity: DNS must already point at the server. ------------------------------
SERVER_IP=$(run 'curl -s -4 --max-time 10 ifconfig.me || true')
DNS_IPS=$(dig +short "$HOSTNAME_ARG" A)
if [[ -z "$SERVER_IP" || -z "$DNS_IPS" ]] || ! grep -Fqx "$SERVER_IP" <<<"$DNS_IPS"; then
	echo "error: DNS for $HOSTNAME_ARG does not include server IPv4 '${SERVER_IP:-<unknown>}'." >&2
	echo "Create/fix the A record first; Let's Encrypt issuance will fail without it." >&2
	exit 1
fi

# The egress guard is mandatory. If nftables cannot enforce the owner rule,
# deployment stops before the relay is started.
echo "==> checking nftables egress prerequisite"
run 'set -eu
	test "$(id -u)" -eq 0 || { echo "ssh target must be root" >&2; exit 1; }
	if ! command -v nft >/dev/null || ! nft list ruleset >/dev/null; then
		systemctl stop iroh-relay.service 2>/dev/null || true
		echo "nft is required and must be usable; relay stopped fail-closed" >&2
		exit 1
	fi'

if [[ -n "$ACCESS_HTTP_URL" ]]; then
	echo "==> checking root-owned backend credential file"
	run "set -eu
		path='$ACCESS_HTTP_TOKEN_FILE'
		test -f \"\$path\" && test ! -L \"\$path\" || { echo 'backend token must be a regular, non-symlink file' >&2; exit 1; }
		owner_mode=\$(stat -c '%u:%a' \"\$path\")
		case \"\$owner_mode\" in 0:400|0:600) ;; *) echo 'backend token file must be owned by root with mode 0400 or 0600' >&2; exit 1 ;; esac
		test \"\$(awk 'END { print NR }' \"\$path\")\" -eq 1 || { echo 'backend token file must contain exactly one line' >&2; exit 1; }
		LC_ALL=C grep -Eq '^[!-~]{32,512}$' \"\$path\" || { echo 'backend token must be 32-512 printable non-space ASCII characters' >&2; exit 1; }
		systemd_version=\$(systemctl --version | awk 'NR == 1 { print \$2 }')
		test \"\$systemd_version\" -ge 247 || { echo 'systemd 247 or newer is required for LoadCredential' >&2; exit 1; }
		command -v python3 >/dev/null || { echo 'Python 3.10 or newer is required for managed access HTTP framing' >&2; exit 1; }
		python3 -c 'import sys; raise SystemExit(sys.version_info < (3, 10))' || { echo 'Python 3.10 or newer is required for managed access HTTP framing' >&2; exit 1; }"
	test -f "$ACCESS_PROXY_SOURCE" || { echo "error: managed access proxy source is missing: $ACCESS_PROXY_SOURCE" >&2; exit 1; }
fi

# Map server arch to the release artifact. -----------------------------------
ARCH=$(run 'uname -m')
case "$ARCH" in
	x86_64) TARGET="x86_64-unknown-linux-gnu" ;;
	aarch64) TARGET="aarch64-unknown-linux-gnu" ;;
	*) echo "error: unsupported server arch: $ARCH" >&2; exit 1 ;;
esac
case "$VERSION:$TARGET" in
	v1.0.3:x86_64-unknown-linux-gnu)
		ARTIFACT_SHA256="ad7de882c4825a851b38869a3f1622b674cb65f344304e432f862ddf72d6b39a"
		;;
	v1.0.3:aarch64-unknown-linux-gnu)
		ARTIFACT_SHA256="278010f9757e70e077ded3b1d2893b9b1f66cce6076603b7f0eebc175cd116f1"
		;;
	*)
		echo "error: no reviewed SHA-256 is pinned for iroh-relay $VERSION ($TARGET)" >&2
		exit 1
		;;
esac
ARTIFACT="iroh-relay-$VERSION-$TARGET.tar.gz"
URL="https://github.com/n0-computer/iroh/releases/download/$VERSION/$ARTIFACT"

echo "==> installing iroh-relay $VERSION ($TARGET) on $SSH_TARGET"
run "set -eu
	tmpdir=\$(mktemp -d)
	trap 'rm -rf \"\$tmpdir\"' EXIT
	cd \"\$tmpdir\"
	curl -sfLO '$URL'
	printf '%s  %s\n' '$ARTIFACT_SHA256' '$ARTIFACT' | sha256sum --check --strict -
	tar xzf '$ARTIFACT'
	install -m 0755 iroh-relay /usr/local/bin/iroh-relay
	useradd --system --home /var/lib/iroh-relay --create-home --shell /usr/sbin/nologin iroh-relay 2>/dev/null || true
	usermod --shell /usr/sbin/nologin iroh-relay
	mkdir -p /etc/iroh-relay /var/lib/iroh-relay/certs /usr/local/libexec
	chown -R iroh-relay:iroh-relay /var/lib/iroh-relay
	chmod 0750 /var/lib/iroh-relay
	/usr/local/bin/iroh-relay --version"

echo "==> writing /etc/iroh-relay/config.toml"
CONFIG="# Managed by Volt scripts/deploy-iroh-relay.sh — edits may be overwritten.
# Plain HTTP serves iroh's captive-portal probe.
http_bind_addr = \"[::]:80\"
enable_quic_addr_discovery = true
enable_metrics = true
metrics_bind_addr = \"127.0.0.1:9090\"
# Bound cache memory; this is not an endpoint concurrency limit.
key_cache_capacity = 16384"
if [[ "$OPEN" == true ]]; then
	CONFIG+=$'\n'"# Explicitly open only for an owner-operated custom relay."$'\n'"access = \"everyone\""
fi
CONFIG+=$'\n\n'"# Bound each client's ingress into the relay.
# iroh-relay v1.0.3 parses accept_conn_* but does not enforce it, so the
# systemd file-descriptor ceiling below is the aggregate connection backstop.
[limits.client.rx]
bytes_per_second = 16777216
max_burst_bytes = 33554432

[tls]
https_bind_addr = \"[::]:443\"
quic_bind_addr = \"[::]:7824\"
hostname = \"$HOSTNAME_ARG\"
cert_mode = \"LetsEncrypt\"
prod_tls = true
cert_dir = \"/var/lib/iroh-relay/certs\""
if [[ -n "$CONTACT" ]]; then
	CONFIG+=$'\n'"contact = \"$CONTACT\""
fi
if [[ -n "$ACCESS_HTTP_URL" ]]; then
	CONFIG+=$'\n\n'"# Authorize endpoint registration through the loopback framing proxy.
# The proxy forwards only to Volt's fixed enrollment backend. The bearer token
# is supplied only through IROH_RELAY_HTTP_BEARER_TOKEN.
[access.http]
url = \"$MANAGED_ACCESS_PROXY_URL\""
elif [[ -n "$ALLOWLIST" ]]; then
	CONFIG+=$'\n\n'"# Owner-maintained endpoint IDs for a custom uncredentialed relay.
[access]
allowlist = ["
	for id in "${ALLOWLIST_IDS[@]}"; do
		CONFIG+=$'\n'"  \"$id\","
	done
	CONFIG+=$'\n'']'
fi
printf '%s\n' "$CONFIG" | run 'set -eu
	umask 077
	tmp=$(mktemp /etc/iroh-relay/config.toml.XXXXXX)
	trap '\''rm -f "$tmp"'\'' EXIT
	cat > "$tmp"
	chown root:root "$tmp"
	chmod 0644 "$tmp"
	mv "$tmp" /etc/iroh-relay/config.toml
	trap - EXIT'

printf 'https://%s\n' "$HOSTNAME_ARG" | run 'set -eu
	umask 077
	tmp=$(mktemp /etc/iroh-relay/relay-origin.XXXXXX)
	trap '\''rm -f "$tmp"'\'' EXIT
	cat > "$tmp"
	chown root:root "$tmp"
	chmod 0644 "$tmp"
	mv "$tmp" /etc/iroh-relay/relay-origin
	trap - EXIT'
if [[ -n "$ACCESS_HTTP_URL" ]]; then
	printf '%s\n' "$ACCESS_HTTP_URL" | run 'set -eu
		umask 077
		tmp=$(mktemp /etc/iroh-relay/access-http-url.XXXXXX)
		trap '\''rm -f "$tmp"'\'' EXIT
		cat > "$tmp"
		chown root:root "$tmp"
		chmod 0600 "$tmp"
		mv "$tmp" /etc/iroh-relay/access-http-url
		trap - EXIT'
else
	run 'rm -f /etc/iroh-relay/access-http-url'
fi

if [[ -n "$ACCESS_HTTP_URL" ]]; then
	echo "==> installing managed access HTTP framing proxy"
	run 'install -o root -g root -m 0755 /dev/stdin /usr/local/libexec/iroh-relay-access-proxy.py' <"$ACCESS_PROXY_SOURCE"
else
	run 'systemctl disable --now iroh-relay-access-proxy.service 2>/dev/null || true
		rm -f /etc/systemd/system/iroh-relay-access-proxy.service /usr/local/libexec/iroh-relay-access-proxy.py'
fi

echo "==> installing service wrappers and health monitor"
run 'install -o root -g root -m 0755 /dev/stdin /usr/local/libexec/iroh-relay-start' <<'START'
#!/usr/bin/env bash
set -euo pipefail
export LC_ALL=C
credential_name=iroh-relay-http-bearer-token
if [[ -n "${CREDENTIALS_DIRECTORY:-}" ]]; then
	credential_path="$CREDENTIALS_DIRECTORY/$credential_name"
	[[ -r "$credential_path" ]] || { echo "missing iroh relay HTTP credential" >&2; exit 1; }
	IROH_RELAY_HTTP_BEARER_TOKEN=$(<"$credential_path")
	if ! [[ "$IROH_RELAY_HTTP_BEARER_TOKEN" =~ ^[!-~]{32,512}$ ]]; then
		echo "invalid iroh relay HTTP credential" >&2
		exit 1
	fi
	export IROH_RELAY_HTTP_BEARER_TOKEN
fi
exec /usr/local/bin/iroh-relay --config-path /etc/iroh-relay/config.toml
START

run 'install -o root -g root -m 0755 /dev/stdin /usr/local/sbin/iroh-relay-egress' <<EGRESS
#!/usr/bin/env bash
set -euo pipefail
table=volt_iroh_relay
case "\${1:-}" in
	apply)
		command -v nft >/dev/null || { echo "nft is required" >&2; exit 1; }
		uid=\$(id -u iroh-relay)
		nft delete table inet "\$table" 2>/dev/null || true
		rules=\$(mktemp)
		trap 'rm -f "\$rules"' EXIT
		cat >"\$rules" <<NFT
table inet volt_iroh_relay {
	counter egress_rate_dropped {}
	chain output {
		type filter hook output priority 0; policy accept;
		meta skuid \$uid limit rate over $EGRESS_BYTES_PER_SECOND bytes/second burst $EGRESS_BURST_BYTES bytes counter name egress_rate_dropped drop
	}
}
NFT
		nft -f "\$rules"
		nft list counter inet "\$table" egress_rate_dropped >/dev/null
		;;
	remove)
		nft delete table inet "\$table" 2>/dev/null || true
		;;
	*)
		echo "usage: iroh-relay-egress {apply|remove}" >&2
		exit 2
		;;
esac
EGRESS

run 'install -o root -g root -m 0755 /dev/stdin /usr/local/sbin/iroh-relay-healthcheck' <<'HEALTH'
#!/usr/bin/env bash
set -euo pipefail

state_dir=${STATE_DIRECTORY:-/var/lib/iroh-relay-monitor}
hook=/etc/iroh-relay/alert-hook
mkdir -p "$state_dir"

transition() {
	local key=$1 state=$2 detail=$3 old=""
	[[ -f "$state_dir/$key" ]] && old=$(<"$state_dir/$key")
	printf '%s\n' "$state" >"$state_dir/$key"
	if [[ "$state" != "$old" && ( -n "$old" || "$state" != "ok" ) ]]; then
		logger -t iroh-relay-monitor -- "$key: $state: $detail"
		if [[ -x "$hook" ]] && ! "$hook" "$key" "$state" "$detail"; then
			logger -t iroh-relay-monitor -- "alert hook failed for $key"
		fi
	fi
}

failed=0
relay_body=""
relay_origin=$(</etc/iroh-relay/relay-origin)
relay_hostname=${relay_origin#https://}
if relay_body=$(curl --disable --noproxy '*' --silent --fail --max-time 10 \
	--resolve "$relay_hostname:443:127.0.0.1" "$relay_origin/healthz" 2>/dev/null) \
	|| relay_body=$(curl --disable --noproxy '*' --silent --fail --max-time 10 \
		--resolve "$relay_hostname:443:[::1]" "$relay_origin/healthz" 2>/dev/null); then
	if [[ "$relay_body" == *'"status":"ok"'* ]]; then
		transition relay-health ok "local TLS /healthz is healthy"
	else
		transition relay-health failed "local TLS /healthz returned an invalid body"
		failed=1
	fi
else
	transition relay-health failed "local TLS /healthz is unreachable"
	failed=1
fi

if [[ -f /etc/iroh-relay/access-http-url ]]; then
	credential_path=${CREDENTIALS_DIRECTORY:-}/iroh-relay-http-bearer-token
	if [[ -r "$credential_path" ]]; then
		token=$(<"$credential_path")
		# A fixed valid-shaped, deliberately ungranted endpoint ID must reach the
		# backend and return exact false. Unknown endpoint probes create no record.
		response=$(mktemp)
		status=$(printf 'Authorization: Bearer %s\nX-Iroh-NodeId: %064d\n' "$token" 0 | curl --disable \
			--noproxy '*' --silent --output "$response" --write-out '%{http_code}' --max-time 10 \
			--request POST --data '' --header @- \
			--url 'http://127.0.0.1:9081/v1/relay-access' 2>/dev/null || true)
		unset token
		body=$(cat "$response")
		rm -f "$response"
	else
		status=missing-credential
		body=""
	fi
	if [[ "$status" == 200 && "$body" == false ]]; then
		transition backend-health ok "authenticated callback proxy/backend probe returned expected denial"
	else
		transition backend-health failed "authenticated backend probe failed"
		failed=1
	fi
fi

counter_output=""
if counter_output=$(nft list counter inet volt_iroh_relay egress_rate_dropped 2>/dev/null); then
	transition egress-guard ok "nftables relay-user ceiling is installed"
	dropped_bytes=$(awk '{ for (i = 1; i <= NF; i++) if ($i == "bytes") { print $(i + 1); exit } }' <<<"$counter_output")
	if ! [[ "$dropped_bytes" =~ ^[0-9]+$ ]]; then
		transition egress-guard failed "nftables drop counter is unreadable"
		systemctl stop iroh-relay.service || true
		failed=1
	else
		previous=0
		[[ -f "$state_dir/egress-drop-bytes" ]] && previous=$(<"$state_dir/egress-drop-bytes")
		[[ "$previous" =~ ^[0-9]+$ ]] || previous=0
		if ((dropped_bytes < previous)); then
			previous=0
		fi
		printf '%s\n' "$dropped_bytes" >"$state_dir/egress-drop-bytes"
		if ((dropped_bytes > previous)); then
			transition egress-pressure limited "nftables dropped relay egress above the configured rate"
			failed=1
		else
			transition egress-pressure ok "no new egress rate-limit drops"
		fi
	fi
else
	transition egress-guard failed "nftables relay-user ceiling is missing; stopping relay fail-closed"
	systemctl stop iroh-relay.service || true
	failed=1
fi

exit "$failed"
HEALTH

run 'install -o root -g root -m 0644 /dev/stdin /etc/iroh-relay/alert-hook.example' <<'HOOK'
#!/usr/bin/env bash
# Copy to /etc/iroh-relay/alert-hook, customize, make root-owned mode 0755.
# Arguments are: <check-name> <ok|failed|limited> <non-secret detail>.
logger -t iroh-relay-alert -- "$1: $2: $3"
HOOK

RELAY_CREDENTIAL_LINE=""
HEALTH_CREDENTIAL_LINE=""
RELAY_PROXY_AFTER=""
RELAY_PROXY_REQUIRES=""
HEALTH_PROXY_AFTER=""
if [[ -n "$ACCESS_HTTP_URL" ]]; then
	RELAY_CREDENTIAL_LINE="LoadCredential=iroh-relay-http-bearer-token:$ACCESS_HTTP_TOKEN_FILE"
	HEALTH_CREDENTIAL_LINE="LoadCredential=iroh-relay-http-bearer-token:$ACCESS_HTTP_TOKEN_FILE"
	RELAY_PROXY_AFTER=" iroh-relay-access-proxy.service"
	RELAY_PROXY_REQUIRES=" iroh-relay-access-proxy.service"
	HEALTH_PROXY_AFTER=" iroh-relay-access-proxy.service"
fi

SYSTEMD_UNIT="[Unit]
Description=iroh relay
After=network-online.target iroh-relay-egress.service$RELAY_PROXY_AFTER
Wants=network-online.target
Requires=iroh-relay-egress.service$RELAY_PROXY_REQUIRES

[Service]
User=iroh-relay
$RELAY_CREDENTIAL_LINE
ExecStart=/usr/local/libexec/iroh-relay-start
AmbientCapabilities=CAP_NET_BIND_SERVICE
CapabilityBoundingSet=CAP_NET_BIND_SERVICE
NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=/var/lib/iroh-relay
ProtectHome=true
PrivateTmp=true
PrivateDevices=true
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
RestrictSUIDSGID=true
LockPersonality=true
Restart=always
RestartSec=2
UMask=0077
LimitCORE=0
LimitNOFILE=16384
TasksMax=256
MemoryHigh=640M
MemoryMax=768M
CPUQuota=100%
IPAccounting=true

[Install]
WantedBy=multi-user.target"
printf '%s\n' "$SYSTEMD_UNIT" | run 'cat > /etc/systemd/system/iroh-relay.service'

if [[ -n "$ACCESS_HTTP_URL" ]]; then
	run 'cat > /etc/systemd/system/iroh-relay-access-proxy.service' <<'PROXY_UNIT'
[Unit]
Description=iroh managed relay access HTTP framing proxy
After=network-online.target
Wants=network-online.target
Before=iroh-relay.service

[Service]
User=iroh-relay
ExecStart=/usr/bin/python3 -I /usr/local/libexec/iroh-relay-access-proxy.py
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
PrivateDevices=true
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
RestrictSUIDSGID=true
LockPersonality=true
RestrictAddressFamilies=AF_INET AF_INET6
CapabilityBoundingSet=
Restart=always
RestartSec=2
UMask=0077
LimitCORE=0
LimitNOFILE=128
TasksMax=32
MemoryHigh=64M
MemoryMax=96M
CPUQuota=25%
IPAccounting=true

[Install]
WantedBy=multi-user.target
PROXY_UNIT
fi

run 'cat > /etc/systemd/system/iroh-relay-egress.service' <<'EGRESS_UNIT'
[Unit]
Description=iroh relay aggregate egress ceiling
After=nftables.service ufw.service
Before=iroh-relay.service

[Service]
Type=oneshot
ExecStart=/usr/local/sbin/iroh-relay-egress apply
ExecStop=/usr/local/sbin/iroh-relay-egress remove
RemainAfterExit=true

[Install]
WantedBy=multi-user.target
EGRESS_UNIT

HEALTH_UNIT="[Unit]
Description=iroh relay and enrollment backend health check
After=network-online.target iroh-relay.service iroh-relay-egress.service$HEALTH_PROXY_AFTER
Wants=network-online.target

[Service]
Type=oneshot
$HEALTH_CREDENTIAL_LINE
ExecStart=/usr/local/sbin/iroh-relay-healthcheck
StateDirectory=iroh-relay-monitor
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
PrivateDevices=true
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
CapabilityBoundingSet=CAP_NET_ADMIN
TimeoutStartSec=30"
printf '%s\n' "$HEALTH_UNIT" | run 'cat > /etc/systemd/system/iroh-relay-healthcheck.service'

run 'cat > /etc/systemd/system/iroh-relay-healthcheck.timer' <<'TIMER'
[Unit]
Description=periodic iroh relay health and egress checks

[Timer]
OnBootSec=1min
OnUnitActiveSec=1min
RandomizedDelaySec=10
Persistent=true
Unit=iroh-relay-healthcheck.service

[Install]
WantedBy=timers.target
TIMER

echo "==> configuring firewall (ufw)"
run 'if command -v ufw >/dev/null; then
	ufw allow OpenSSH >/dev/null
	ufw allow 80/tcp >/dev/null
	ufw allow 443/tcp >/dev/null
	ufw allow 7824/udp >/dev/null
	ufw --force enable >/dev/null
	ufw status | head -2
else
	echo "ufw not present; open 80/tcp 443/tcp 7824/udp in the provider firewall"
fi'

echo "==> applying fail-closed egress guard and starting services"
if [[ -n "$ACCESS_HTTP_URL" ]]; then
	run 'set -eu
		systemctl daemon-reload
		systemctl stop iroh-relay.service 2>/dev/null || true
		systemctl enable iroh-relay-access-proxy.service iroh-relay-egress.service iroh-relay.service iroh-relay-healthcheck.timer >/dev/null
		systemctl restart iroh-relay-egress.service
		systemctl restart iroh-relay-access-proxy.service
		systemctl start iroh-relay.service
		systemctl restart iroh-relay-healthcheck.timer'
else
	run 'set -eu
		systemctl daemon-reload
		systemctl stop iroh-relay.service 2>/dev/null || true
		systemctl enable iroh-relay-egress.service iroh-relay.service iroh-relay-healthcheck.timer >/dev/null
		systemctl restart iroh-relay-egress.service
		systemctl start iroh-relay.service
		systemctl restart iroh-relay-healthcheck.timer'
fi

echo "==> waiting for HTTPS (Let's Encrypt issuance can take a minute on first deploy)"
for _ in $(seq 1 30); do
	if curl -sfo /dev/null --max-time 10 "https://$HOSTNAME_ARG/healthz"; then
		if run 'systemctl start iroh-relay-healthcheck.service'; then
			echo "==> relay is live: https://$HOSTNAME_ARG"
			if [[ -n "$ACCESS_HTTP_URL" ]]; then
				echo "    endpoint registration is authorized by the external backend; clients receive no bearer token"
			else
				echo "    custom relay URL: VOLT_IROH_RELAY_URLS=https://$HOSTNAME_ARG"
			fi
			exit 0
		fi
		echo "error: local relay/backend/egress health check failed" >&2
		echo "check: ssh $SSH_TARGET journalctl -u iroh-relay-healthcheck -u iroh-relay -n 100" >&2
		exit 1
	fi
	sleep 5
done
echo "error: relay did not serve HTTPS within 150s; check: ssh $SSH_TARGET journalctl -u iroh-relay -n 50" >&2
exit 1
