#!/usr/bin/env bash
set -euo pipefail

PROJECT_ID="volt-3fae7"
EXPECTED_PROJECT_NUMBER="546623825529"
REGION="us-central1"
SERVICE_NAME="relay-credential-broker-production"
SQL_INSTANCE="volt-relay-credentials-production"
READINESS_URL="https://credentials.volt-cli.dev/readyz"
ACTION="${1:-status}"
ASSUME_YES=0

usage() {
	cat >&2 <<'USAGE'
Usage: deploy/production-database.sh <status|on|off> [--yes]

Controls the production Cloud SQL activation policy without deleting data or
changing Cloud Run, load-balancer, Cloud Armor, KMS, or relay resources.

  status  Show database activation and broker readiness (default)
  on      Start Cloud SQL and wait for broker readiness
  off     Stop Cloud SQL after confirmation; pass --yes for non-interactive use

Stopping Cloud SQL makes pairing, refresh, and revocation unavailable. Already
issued relay JWTs can remain valid until their short expiry. Storage, backups,
the load balancer, and Cloud Armor continue to incur charges while SQL is off.
USAGE
}

require_command() {
	command -v "$1" >/dev/null || {
		echo "required command not found: $1" >&2
		exit 1
	}
}

preflight() {
	require_command curl
	require_command gcloud
	local account project_number
	account="$(gcloud auth list --filter=status:ACTIVE --format='value(account)' | head -1)"
	if [[ -z "$account" ]]; then
		echo 'no active gcloud account' >&2
		exit 1
	fi
	project_number="$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')"
	if [[ "$project_number" != "$EXPECTED_PROJECT_NUMBER" ]]; then
		echo "refusing project $PROJECT_ID: expected project number $EXPECTED_PROJECT_NUMBER, got $project_number" >&2
		exit 1
	fi
	gcloud run services describe "$SERVICE_NAME" \
		--project "$PROJECT_ID" --region "$REGION" >/dev/null
	gcloud sql instances describe "$SQL_INSTANCE" --project "$PROJECT_ID" >/dev/null
	printf 'project=%s (%s) account=%s\n' "$PROJECT_ID" "$project_number" "$account"
}

sql_field() {
	gcloud sql instances describe "$SQL_INSTANCE" \
		--project "$PROJECT_ID" --format="value($1)"
}

readiness_code() {
	curl --silent --output /dev/null --write-out '%{http_code}' \
		--max-time 10 "$READINESS_URL" 2>/dev/null || true
}

status() {
	local activation_policy availability_type http_code state tier
	activation_policy="$(sql_field settings.activationPolicy)"
	availability_type="$(sql_field settings.availabilityType)"
	state="$(sql_field state)"
	tier="$(sql_field settings.tier)"
	http_code="$(readiness_code)"
	printf 'cloud_sql_instance=%s activation_policy=%s state=%s tier=%s availability=%s\n' \
		"$SQL_INSTANCE" "$activation_policy" "$state" "$tier" "$availability_type"
	if [[ "$http_code" == '200' ]]; then
		printf 'broker_readiness=ready url=%s http_status=%s\n' "$READINESS_URL" "$http_code"
	else
		printf 'broker_readiness=unavailable url=%s http_status=%s\n' \
			"$READINESS_URL" "${http_code:-none}"
	fi
}

confirm_off() {
	if [[ "$ASSUME_YES" == '1' ]]; then
		return
	fi
	if [[ ! -t 0 ]]; then
		echo 'refusing to stop production without an interactive terminal or --yes' >&2
		exit 1
	fi
	cat >&2 <<'WARNING'
This stops the production credential database. Pairing, token refresh, and
revocation will fail, and existing relay JWTs will expire within about 15 minutes.
Type "off volt-relay-credentials-production" to continue:
WARNING
	local confirmation
	IFS= read -r confirmation
	if [[ "$confirmation" != 'off volt-relay-credentials-production' ]]; then
		echo 'production stop cancelled' >&2
		exit 1
	fi
}

turn_off() {
	local activation_policy
	activation_policy="$(sql_field settings.activationPolicy)"
	if [[ "$activation_policy" == 'NEVER' ]]; then
		echo 'production Cloud SQL is already off'
		status
		return
	fi
	confirm_off
	gcloud sql instances patch "$SQL_INSTANCE" \
		--project "$PROJECT_ID" --activation-policy=NEVER --quiet
	echo 'production Cloud SQL is off; persistent storage and edge resources remain deployed'
	status
}

turn_on() {
	local activation_policy attempt http_code
	activation_policy="$(sql_field settings.activationPolicy)"
	if [[ "$activation_policy" != 'ALWAYS' ]]; then
		gcloud sql instances patch "$SQL_INSTANCE" \
			--project "$PROJECT_ID" --activation-policy=ALWAYS --quiet
	else
		echo 'production Cloud SQL is already configured to run'
	fi
	for ((attempt = 1; attempt <= 36; attempt++)); do
		http_code="$(readiness_code)"
		if [[ "$http_code" == '200' ]]; then
			echo 'production credential broker is ready'
			status
			return
		fi
		sleep 5
	done
	echo "production Cloud SQL was started, but $READINESS_URL did not become ready within 3 minutes" >&2
	status >&2
	exit 1
}

if (( $# > 2 )); then
	usage
	exit 2
fi
if [[ "${2:-}" == '--yes' ]]; then
	ASSUME_YES=1
elif [[ -n "${2:-}" ]]; then
	usage
	exit 2
fi

case "$ACTION" in
	status)
		[[ "$ASSUME_YES" == '0' ]] || {
			usage
			exit 2
		}
		preflight
		status
		;;
	on)
		[[ "$ASSUME_YES" == '0' ]] || {
			usage
			exit 2
		}
		preflight
		turn_on
		;;
	off)
		preflight
		turn_off
		;;
	-h|--help|help)
		usage
		;;
	*)
		usage
		exit 2
		;;
esac
