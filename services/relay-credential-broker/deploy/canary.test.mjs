import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

test("canary deployment preserves both App Store products in one environment value", () => {
	const dir = mkdtempSync(join(tmpdir(), "volt-canary-env-"));
	try {
		writeFileSync(
			join(dir, "gcloud"),
			`#!/usr/bin/env bash
set -euo pipefail
case "$*" in
  'projects describe '*) printf '546623825529\\n' ;;
  'billing projects describe '*) printf 'True\\n' ;;
  'auth list '*) printf 'fixture@example.invalid\\n' ;;
  'secrets describe '*) ;;
  'kms keys versions list '*) printf '1\\n' ;;
  'run deploy '*) printf '%s\\0' "$@" > "$CAPTURE_PATH" ;;
  *) printf 'unexpected gcloud invocation: %s\\n' "$*" >&2; exit 1 ;;
esac
`,
			{ mode: 0o755 },
		);
		const capturePath = join(dir, "args");
		const env = Object.fromEntries(
			Object.entries(process.env).filter(
				([key]) => !key.startsWith("VOLT_CREDENTIAL_CANARY_") && !key.startsWith("VOLT_APP_STORE_CANARY_"),
			),
		);
		const result = spawnSync("bash", [fileURLToPath(new URL("./canary.sh", import.meta.url)), "deploy"], {
			encoding: "utf8",
			env: {
				...env,
				PATH: `${dir}:${process.env.PATH}`,
				CAPTURE_PATH: capturePath,
				VOLT_CREDENTIAL_CANARY_IMAGE_TAG: "fixture",
				VOLT_APP_STORE_CANARY_APP_APPLE_ID: "123456789",
				VOLT_APP_STORE_CANARY_KEY_ID: "TESTKEY123",
				VOLT_APP_STORE_CANARY_ISSUER_ID: "test-issuer",
				VOLT_APP_STORE_CANARY_SUBSCRIPTION_GROUP_ID: "987654321",
			},
		});
		assert.equal(result.status, 0, result.error?.message || result.stderr || result.stdout);
		const args = readFileSync(capturePath, "utf8").split("\0").slice(0, -1);
		assert.equal(args.filter((arg) => arg === "--set-env-vars").length, 1);
		const value = args[args.indexOf("--set-env-vars") + 1];
		// gcloud dictionaries default to commas, with ^DELIMITER^ selecting an alternate separator.
		const prefix = /^\^([^\^]+)\^/.exec(value);
		const entries = value.slice(prefix?.[0].length ?? 0).split(prefix?.[1] ?? ",");
		const parsed = {};
		for (const entry of entries) {
			const equals = entry.indexOf("=");
			assert.ok(equals > 0, `Invalid gcloud dictionary entry: ${entry}`);
			const key = entry.slice(0, equals);
			assert.ok(!Object.hasOwn(parsed, key), `Duplicate environment key: ${key}`);
			parsed[key] = entry.slice(equals + 1);
		}
		assert.deepEqual(parsed, {
			VOLT_CREDENTIAL_LISTEN: "0.0.0.0:8080",
			VOLT_CREDENTIAL_ISSUER: "https://credentials-canary.volt-cli.dev",
			VOLT_CREDENTIAL_AUDIENCE: "volt-iroh-relay-canary",
			VOLT_CREDENTIAL_SIGNING_MODE: "kms",
			VOLT_CREDENTIAL_KMS_ACTIVE_KEY_VERSION:
				"projects/volt-3fae7/locations/us-central1/keyRings/relay/cryptoKeys/signing/cryptoKeyVersions/1",
			VOLT_APP_CHECK_MODE: "firebase",
			VOLT_FIREBASE_PROJECT_NUMBER: "546623825529",
			VOLT_ALLOWED_FIREBASE_APP_IDS: "1:546623825529:ios:9f5a707e3f4ef89154d6a8",
			VOLT_APP_STORE_MODE: "apple",
			VOLT_APP_STORE_BUNDLE_ID: "com.hansjm10.volt",
			VOLT_APP_STORE_APP_APPLE_ID: "123456789",
			VOLT_APP_STORE_KEY_ID: "TESTKEY123",
			VOLT_APP_STORE_ISSUER_ID: "test-issuer",
			VOLT_APP_STORE_SUBSCRIPTION_GROUP_ID: "987654321",
			VOLT_APP_STORE_PRODUCT_IDS: "com.hansjm10.volt.pro.monthly,com.hansjm10.volt.pro.annual",
			VOLT_APP_STORE_ENVIRONMENTS: "Sandbox",
			VOLT_CREDENTIAL_MAX_CLAIMS: "500",
			VOLT_CREDENTIAL_MAX_ENDPOINTS: "5000",
			VOLT_CREDENTIAL_MAX_APP_ENDPOINTS_PER_GRANT: "8",
			VOLT_CREDENTIAL_MAX_CONCURRENT_REQUESTS: "32",
			VOLT_CREDENTIAL_MAX_BOOTSTRAP_REQUESTS_PER_MINUTE: "30",
			VOLT_CREDENTIAL_MAX_APPROVAL_REQUESTS_PER_MINUTE: "60",
			VOLT_CREDENTIAL_MAX_EXCHANGE_REQUESTS_PER_MINUTE: "300",
		});
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
