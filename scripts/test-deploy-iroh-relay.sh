#!/usr/bin/env bash
set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
deploy="$repo_root/scripts/deploy-iroh-relay.sh"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
mock_bin="$tmp/bin"
mkdir -p "$mock_bin"

cat >"$mock_bin/ssh" <<'MOCK_SSH'
#!/usr/bin/env bash
set -euo pipefail
capture=${DEPLOY_TEST_CAPTURE:?}
count_file="$capture/count"
count=0
[[ -f "$count_file" ]] && count=$(<"$count_file")
count=$((count + 1))
printf '%s\n' "$count" >"$count_file"
shift
remote_command=$*
printf '%s\n' "$remote_command" >"$capture/command.$count"
if [[ "$remote_command" == *'cat >'* || "$remote_command" == *'/dev/stdin'* ]]; then
	cat >"$capture/stdin.$count"
fi
case "$remote_command" in
	*ifconfig.me*) printf '%s\n' '192.0.2.10' ;;
	*'uname -m'*) printf '%s\n' 'x86_64' ;;
esac
MOCK_SSH

cat >"$mock_bin/dig" <<'MOCK_DIG'
#!/usr/bin/env bash
printf '%s\n' '192.0.2.10'
MOCK_DIG

cat >"$mock_bin/curl" <<'MOCK_CURL'
#!/usr/bin/env bash
exit 0
MOCK_CURL
chmod +x "$mock_bin/ssh" "$mock_bin/dig" "$mock_bin/curl"

fail() {
	echo "FAIL: $1" >&2
	exit 1
}

expect_failure_without_secret_echo() {
	local output
	if output=$(PATH="$mock_bin:$PATH" "$deploy" "$@" 2>&1); then
		fail "expected deployment arguments to fail: $*"
	fi
	[[ "$output" != *'fixture-secret-must-not-be-echoed'* ]] || fail "removed secret option echoed its value"
}

expect_failure_without_secret_echo root@relay relay.example.com --shared-token fixture-secret-must-not-be-echoed
expect_failure_without_secret_echo root@relay relay.example.com
expect_failure_without_secret_echo root@relay relay.example.com --open --version v1.0.2
expect_failure_without_secret_echo root@relay relay.example.com --open --version v1.0.4
expect_failure_without_secret_echo root@relay relay.example.com \
	--access-http-url https://attacker.example/v1/relay-access \
	--contact ops@example.com

run_fixture() {
	local name=$1
	shift
	local capture="$tmp/$name"
	mkdir -p "$capture"
	DEPLOY_TEST_CAPTURE="$capture" PATH="$mock_bin:$PATH" "$deploy" root@relay relay.example.com --contact ops@example.com "$@" >"$capture/output"
	cat "$capture"/stdin.* >"$capture/payloads"
}

run_fixture managed \
	--access-http-url https://us-central1-volt-3fae7.cloudfunctions.net/irohEnrollment/v1/relay-access \
	--access-http-token-file /etc/iroh-relay/backend-token

managed="$tmp/managed/payloads"
config_file=$(grep -l '^\[access\.http\]$' "$tmp/managed"/stdin.* | head -1)
[[ -n "$config_file" ]] || fail "managed relay config was not written"
grep -q '^url = "https://us-central1-volt-3fae7.cloudfunctions.net/irohEnrollment/v1/relay-access"$' "$config_file" || fail "access.http URL missing"
grep -q 'sha256sum --check --strict' "$tmp/managed"/command.* || fail "release checksum verification missing"
grep -q 'ad7de882c4825a851b38869a3f1622b674cb65f344304e432f862ddf72d6b39a' "$tmp/managed"/command.* || fail "x86_64 release checksum missing"
! grep -q 'bearer_token\|shared_token' "$config_file" || fail "relay TOML contains a bearer or shared token"
grep -q 'LoadCredential=iroh-relay-http-bearer-token:/etc/iroh-relay/backend-token' "$managed" || fail "systemd credential loading missing"
! grep -q '^accept_conn_' "$config_file" || fail "unimplemented connection limits must not be configured"
grep -q '^LimitNOFILE=16384$' "$managed" || fail "file descriptor ceiling missing"
grep -q '^MemoryMax=768M$' "$managed" || fail "memory ceiling missing"
grep -q 'limit rate over 67108864 bytes/second burst 134217728 bytes' "$managed" || fail "nftables egress ceiling missing"
grep -q 'IROH_RELAY_HTTP_BEARER_TOKEN' "$managed" || fail "relay environment handoff missing"
grep -q 'backend-health' "$managed" || fail "backend health probe missing"
grep -q 'egress-pressure' "$managed" || fail "egress alert transition missing"
for payload in "$tmp/managed"/stdin.*; do
	if [[ $(head -1 "$payload") == '#!/usr/bin/env bash' ]]; then
		bash -n "$payload" || fail "generated shell helper has invalid syntax: $payload"
	fi
done

run_fixture custom --open
custom="$tmp/custom/payloads"
custom_config=$(grep -l '^access = "everyone"$' "$tmp/custom"/stdin.* | head -1)
[[ -n "$custom_config" ]] || fail "explicit custom-open config was not written"
! grep -q '^\[access\.http\]$' "$custom_config" || fail "custom relay unexpectedly uses managed backend"
! grep -q '^LoadCredential=iroh-relay-http-bearer-token:' "$custom" || fail "custom relay unexpectedly loads backend credential"

echo "deploy-iroh-relay fixtures passed"
