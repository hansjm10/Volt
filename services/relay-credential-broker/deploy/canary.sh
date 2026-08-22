#!/usr/bin/env bash
set -euo pipefail

MODE="${1:-preflight}"
PROJECT_ID="${VOLT_CREDENTIAL_CANARY_PROJECT_ID:-volt-3fae7}"
EXPECTED_PROJECT_NUMBER="546623825529"
REGION="${VOLT_CREDENTIAL_CANARY_REGION:-us-central1}"
SERVICE_NAME="relay-credential-broker-canary"
SERVICE_ACCOUNT_NAME="relay-credential-broker-canary"
SQL_INSTANCE="volt-relay-credentials-canary"
SQL_DATABASE="relay_credentials"
SQL_USER="relay_broker"
DATABASE_SECRET="relay-credential-database-url-canary"
ARTIFACT_REPOSITORY="relay-services"
RELAY_ARTIFACT_REPOSITORY="relay-artifacts"
KMS_KEYRING="relay"
KMS_KEY="signing"
ISSUER="https://credentials.volt-cli.dev"
AUDIENCE="volt-iroh-relay-canary"
FIREBASE_APP_ID="1:546623825529:ios:9f5a707e3f4ef89154d6a8"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVICE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPOSITORY_ROOT="$(git -C "$SERVICE_DIR" rev-parse --show-toplevel)"
IMAGE_TAG="${VOLT_CREDENTIAL_CANARY_IMAGE_TAG:-$(git -C "$REPOSITORY_ROOT" rev-parse --short=12 HEAD)}"
IMAGE="${REGION}-docker.pkg.dev/${PROJECT_ID}/${ARTIFACT_REPOSITORY}/${SERVICE_NAME}:${IMAGE_TAG}"
SERVICE_ACCOUNT="${SERVICE_ACCOUNT_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"
CONNECTION_NAME="${PROJECT_ID}:${REGION}:${SQL_INSTANCE}"

usage() {
	cat >&2 <<'USAGE'
Usage: deploy/canary.sh <preflight|provision|build|deploy|describe|all>

Environment overrides:
  VOLT_CREDENTIAL_CANARY_PROJECT_ID  GCP project (default: volt-3fae7)
  VOLT_CREDENTIAL_CANARY_REGION      GCP region (default: us-central1)
  VOLT_CREDENTIAL_CANARY_IMAGE_TAG   image tag (default: current commit)
  VOLT_CREDENTIAL_CANARY_PUBLIC      set to 1 only after public-edge controls are ready
USAGE
}

require_command() {
	command -v "$1" >/dev/null || {
		echo "required command not found: $1" >&2
		exit 1
	}
}

preflight() {
	require_command gcloud
	require_command git
	require_command openssl
	local project_number billing_enabled account
	project_number="$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')"
	if [[ "$project_number" != "$EXPECTED_PROJECT_NUMBER" ]]; then
		echo "refusing project $PROJECT_ID: expected project number $EXPECTED_PROJECT_NUMBER, got $project_number" >&2
		exit 1
	fi
	billing_enabled="$(gcloud billing projects describe "$PROJECT_ID" --format='value(billingEnabled)')"
	if [[ "$billing_enabled" != "True" && "$billing_enabled" != "true" ]]; then
		echo "billing is not enabled for $PROJECT_ID" >&2
		exit 1
	fi
	account="$(gcloud auth list --filter=status:ACTIVE --format='value(account)' | head -1)"
	if [[ -z "$account" ]]; then
		echo "no active gcloud account" >&2
		exit 1
	fi
	printf 'project=%s (%s) region=%s account=%s image=%s\n' \
		"$PROJECT_ID" "$project_number" "$REGION" "$account" "$IMAGE"
}

provision() {
	preflight
	gcloud services enable \
		artifactregistry.googleapis.com \
		cloudbuild.googleapis.com \
		cloudkms.googleapis.com \
		iam.googleapis.com \
		run.googleapis.com \
		secretmanager.googleapis.com \
		sqladmin.googleapis.com \
		--project "$PROJECT_ID" --quiet

	if ! gcloud iam service-accounts describe "$SERVICE_ACCOUNT" --project "$PROJECT_ID" >/dev/null 2>&1; then
		gcloud iam service-accounts create "$SERVICE_ACCOUNT_NAME" \
			--project "$PROJECT_ID" \
			--display-name 'Relay credential broker canary'
	fi
	if ! gcloud artifacts repositories describe "$ARTIFACT_REPOSITORY" \
		--project "$PROJECT_ID" --location "$REGION" >/dev/null 2>&1; then
		gcloud artifacts repositories create "$ARTIFACT_REPOSITORY" \
			--project "$PROJECT_ID" --location "$REGION" \
			--repository-format docker \
			--description 'Volt relay service containers'
	fi
	if ! gcloud artifacts repositories describe "$RELAY_ARTIFACT_REPOSITORY" \
		--project "$PROJECT_ID" --location "$REGION" >/dev/null 2>&1; then
		gcloud artifacts repositories create "$RELAY_ARTIFACT_REPOSITORY" \
			--project "$PROJECT_ID" --location "$REGION" \
			--repository-format generic \
			--description 'Attested Volt relay binaries and manifests'
	fi
	if ! gcloud kms keyrings describe "$KMS_KEYRING" \
		--project "$PROJECT_ID" --location "$REGION" >/dev/null 2>&1; then
		gcloud kms keyrings create "$KMS_KEYRING" \
			--project "$PROJECT_ID" --location "$REGION"
	fi
	if ! gcloud kms keys describe "$KMS_KEY" \
		--project "$PROJECT_ID" --location "$REGION" \
		--keyring "$KMS_KEYRING" >/dev/null 2>&1; then
		gcloud kms keys create "$KMS_KEY" \
			--project "$PROJECT_ID" --location "$REGION" \
			--keyring "$KMS_KEYRING" \
			--purpose asymmetric-signing \
			--default-algorithm ec-sign-ed25519 \
			--protection-level software
	fi

	if ! gcloud sql instances describe "$SQL_INSTANCE" --project "$PROJECT_ID" >/dev/null 2>&1; then
		gcloud sql instances create "$SQL_INSTANCE" \
			--project "$PROJECT_ID" --region "$REGION" \
			--database-version POSTGRES_17 \
			--edition ENTERPRISE \
			--tier db-f1-micro \
			--availability-type zonal \
			--storage-type SSD \
			--storage-size 10 \
			--storage-auto-increase \
			--backup-start-time 04:00 \
			--deletion-protection \
			--quiet
	fi
	if ! gcloud sql databases describe "$SQL_DATABASE" \
		--project "$PROJECT_ID" --instance "$SQL_INSTANCE" >/dev/null 2>&1; then
		gcloud sql databases create "$SQL_DATABASE" \
			--project "$PROJECT_ID" --instance "$SQL_INSTANCE"
	fi

	if ! gcloud secrets describe "$DATABASE_SECRET" --project "$PROJECT_ID" >/dev/null 2>&1; then
		local password database_url
		password="$(openssl rand -hex 32)"
		if gcloud sql users list --project "$PROJECT_ID" --instance "$SQL_INSTANCE" \
			--filter="name=${SQL_USER}" --format='value(name)' | grep -qx "$SQL_USER"; then
			gcloud sql users set-password "$SQL_USER" \
				--project "$PROJECT_ID" --instance "$SQL_INSTANCE" \
				--password "$password"
		else
			gcloud sql users create "$SQL_USER" \
				--project "$PROJECT_ID" --instance "$SQL_INSTANCE" \
				--password "$password"
		fi
		database_url="postgresql://${SQL_USER}:${password}@/${SQL_DATABASE}?host=%2Fcloudsql%2F${CONNECTION_NAME}&sslmode=disable"
		gcloud secrets create "$DATABASE_SECRET" \
			--project "$PROJECT_ID" --replication-policy automatic
		printf '%s' "$database_url" | gcloud secrets versions add "$DATABASE_SECRET" \
			--project "$PROJECT_ID" --data-file=- >/dev/null
	fi

	gcloud projects add-iam-policy-binding "$PROJECT_ID" \
		--member "serviceAccount:${SERVICE_ACCOUNT}" \
		--role roles/cloudsql.client --condition=None --quiet >/dev/null
	gcloud secrets add-iam-policy-binding "$DATABASE_SECRET" \
		--project "$PROJECT_ID" \
		--member "serviceAccount:${SERVICE_ACCOUNT}" \
		--role roles/secretmanager.secretAccessor --quiet >/dev/null
	gcloud kms keys add-iam-policy-binding "$KMS_KEY" \
		--project "$PROJECT_ID" --location "$REGION" --keyring "$KMS_KEYRING" \
		--member "serviceAccount:${SERVICE_ACCOUNT}" \
		--role roles/cloudkms.signerVerifier --condition=None --quiet >/dev/null
	gcloud kms keys add-iam-policy-binding "$KMS_KEY" \
		--project "$PROJECT_ID" --location "$REGION" --keyring "$KMS_KEYRING" \
		--member "serviceAccount:${SERVICE_ACCOUNT}" \
		--role roles/cloudkms.publicKeyViewer --condition=None --quiet >/dev/null

	echo 'canary infrastructure provisioned'
}

build_image() {
	preflight
	gcloud builds submit "$SERVICE_DIR" \
		--project "$PROJECT_ID" \
		--tag "$IMAGE" \
		--quiet
	printf 'built %s\n' "$IMAGE"
}

deploy_service() {
	preflight
	local kms_version public_flag
	kms_version="$(gcloud kms keys versions list \
		--project "$PROJECT_ID" --location "$REGION" --keyring "$KMS_KEYRING" \
		--key "$KMS_KEY" --filter='state=ENABLED' --sort-by='~name' --limit=1 \
		--format='value(name)')"
	if [[ -z "$kms_version" ]]; then
		echo 'no enabled KMS signing key version found' >&2
		exit 1
	fi
	if [[ "$kms_version" != projects/* ]]; then
		kms_version="projects/${PROJECT_ID}/locations/${REGION}/keyRings/${KMS_KEYRING}/cryptoKeys/${KMS_KEY}/cryptoKeyVersions/${kms_version}"
	fi
	public_flag='--no-allow-unauthenticated'
	if [[ "${VOLT_CREDENTIAL_CANARY_PUBLIC:-0}" == '1' ]]; then
		public_flag='--allow-unauthenticated'
	fi
	gcloud run deploy "$SERVICE_NAME" \
		--project "$PROJECT_ID" --region "$REGION" --platform managed \
		--image "$IMAGE" \
		--service-account "$SERVICE_ACCOUNT" \
		--port 8080 \
		--cpu 1 --memory 512Mi \
		--concurrency 16 \
		--min-instances 0 --max-instances 1 \
		--timeout 15s \
		--execution-environment gen2 \
		--add-cloudsql-instances "$CONNECTION_NAME" \
		--set-secrets "VOLT_CREDENTIAL_DATABASE_URL=${DATABASE_SECRET}:latest" \
		--set-env-vars "VOLT_CREDENTIAL_LISTEN=0.0.0.0:8080,VOLT_CREDENTIAL_ISSUER=${ISSUER},VOLT_CREDENTIAL_AUDIENCE=${AUDIENCE},VOLT_CREDENTIAL_SIGNING_MODE=kms,VOLT_CREDENTIAL_KMS_ACTIVE_KEY_VERSION=${kms_version},VOLT_APP_CHECK_MODE=firebase,VOLT_FIREBASE_PROJECT_NUMBER=${EXPECTED_PROJECT_NUMBER},VOLT_ALLOWED_FIREBASE_APP_IDS=${FIREBASE_APP_ID},VOLT_CREDENTIAL_MAX_CLAIMS=500,VOLT_CREDENTIAL_MAX_ENDPOINTS=5000,VOLT_CREDENTIAL_MAX_APP_ENDPOINTS_PER_GRANT=8,VOLT_CREDENTIAL_MAX_CONCURRENT_REQUESTS=32" \
		--labels 'service=relay-credential-broker,environment=canary' \
		"$public_flag" \
		--quiet
	printf 'deployed %s (%s)\n' "$SERVICE_NAME" "$public_flag"
}

describe() {
	preflight
	gcloud run services describe "$SERVICE_NAME" \
		--project "$PROJECT_ID" --region "$REGION" \
		--format='yaml(metadata.name,status.url,status.latestReadyRevisionName,spec.template.spec.serviceAccountName,spec.template.metadata.annotations,spec.template.spec.containers[0].image)'
	gcloud sql instances describe "$SQL_INSTANCE" --project "$PROJECT_ID" \
		--format='yaml(name,region,databaseVersion,state,settings.tier,settings.dataDiskSizeGb,settings.backupConfiguration.enabled,settings.deletionProtectionEnabled)'
	gcloud kms keys versions list \
		--project "$PROJECT_ID" --location "$REGION" --keyring "$KMS_KEYRING" \
		--key "$KMS_KEY" --format='table(name,state,algorithm,protectionLevel)'
}

case "$MODE" in
	preflight) preflight ;;
	provision) provision ;;
	build) build_image ;;
	deploy) deploy_service ;;
	describe) describe ;;
	all)
		provision
		build_image
		deploy_service
		describe
		;;
	*)
		usage
		exit 2
		;;
esac
