#!/usr/bin/env bash
set -euo pipefail

PROJECT_ID="volt-3fae7"
EXPECTED_PROJECT_NUMBER="546623825529"
METRIC_NAME="relay_credential_pairing_requests"
DASHBOARD_ID="relay-credential-broker-canary"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
METRIC_CONFIG="$SCRIPT_DIR/monitoring/relay-credential-pairing-requests.json"
DASHBOARD_CONFIG="$SCRIPT_DIR/monitoring/relay-credential-broker-canary-dashboard.json"
TEMP_DASHBOARD=""

cleanup() {
	if [[ -n "$TEMP_DASHBOARD" ]]; then
		rm -f "$TEMP_DASHBOARD"
	fi
}
trap cleanup EXIT

for command in gcloud jq; do
	command -v "$command" >/dev/null || {
		echo "required command not found: $command" >&2
		exit 1
	}
done

project_number="$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')"
if [[ "$project_number" != "$EXPECTED_PROJECT_NUMBER" ]]; then
	echo "refusing project $PROJECT_ID: expected project number $EXPECTED_PROJECT_NUMBER, got $project_number" >&2
	exit 1
fi

if gcloud logging metrics describe "$METRIC_NAME" --project "$PROJECT_ID" >/dev/null 2>&1; then
	gcloud logging metrics update "$METRIC_NAME" \
		--project "$PROJECT_ID" \
		--config-from-file "$METRIC_CONFIG" \
		--quiet
else
	gcloud logging metrics create "$METRIC_NAME" \
		--project "$PROJECT_ID" \
		--config-from-file "$METRIC_CONFIG" \
		--quiet
fi

gcloud monitoring dashboards create \
	--project "$PROJECT_ID" \
	--config-from-file "$DASHBOARD_CONFIG" \
	--validate-only \
	--quiet >/dev/null

if current_dashboard="$(gcloud monitoring dashboards describe "$DASHBOARD_ID" --project "$PROJECT_ID" --format=json 2>/dev/null)"; then
	etag="$(jq -r '.etag' <<<"$current_dashboard")"
	if [[ -z "$etag" || "$etag" == "null" ]]; then
		echo "dashboard $DASHBOARD_ID has no etag" >&2
		exit 1
	fi
	TEMP_DASHBOARD="$(mktemp)"
	jq --arg etag "$etag" '.etag = $etag' "$DASHBOARD_CONFIG" >"$TEMP_DASHBOARD"
	gcloud monitoring dashboards update "$DASHBOARD_ID" \
		--project "$PROJECT_ID" \
		--config-from-file "$TEMP_DASHBOARD" \
		--quiet >/dev/null
else
	gcloud monitoring dashboards create \
		--project "$PROJECT_ID" \
		--config-from-file "$DASHBOARD_CONFIG" \
		--quiet >/dev/null
fi

printf 'dashboard=https://console.cloud.google.com/monitoring/dashboards/custom/%s?project=%s\n' \
	"$DASHBOARD_ID" "$PROJECT_ID"
