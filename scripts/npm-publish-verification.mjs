import { BOOTSTRAP_VERSION, INITIAL_BETA_VERSION } from "./verify-npm-package-bootstrap.mjs";

export const NPM_PROVENANCE_PREDICATE_TYPE = "https://slsa.dev/provenance/v1";
export const NPM_PUBLISHED_METADATA_FIELDS = ["name", "version", "gitHead", "repository", "dist-tags", "dist"];
const DEFAULT_POST_PUBLISH_VERIFICATION_ATTEMPTS = 61;
const DEFAULT_POST_PUBLISH_VERIFICATION_DELAY_MS = 5_000;

export function assertPublishedPackageMatchesRelease({
	name,
	version,
	directory,
	sourceCommit,
	packed,
	metadata,
}) {
	if (metadata.name !== name || metadata.version !== version) {
		throw new Error(`npm returned unexpected package identity for ${name}@${version}`);
	}
	// npm provenance packages can omit gitHead. When present it must match; the
	// tarball integrity comparison below remains the authoritative byte binding.
	if (metadata.gitHead !== undefined && metadata.gitHead !== sourceCommit) {
		throw new Error(`${name}@${version} was published from git commit ${metadata.gitHead ?? "unknown"}, expected ${sourceCommit}`);
	}
	if (
		metadata.repository?.url !== "git+https://github.com/volt-hq/Volt.git" ||
		metadata.repository?.directory !== directory
	) {
		throw new Error(`${name}@${version} has unexpected repository metadata`);
	}
	if (metadata["dist-tags"]?.latest !== version) {
		throw new Error(`${name}@${version} is published but the latest dist-tag does not point to it`);
	}
	if (metadata["dist-tags"]?.bootstrap !== BOOTSTRAP_VERSION) {
		throw new Error(`${name}@${version} must keep bootstrap on the inert placeholder`);
	}
	if (metadata["dist-tags"]?.beta !== INITIAL_BETA_VERSION) {
		throw new Error(`${name}@${version} must preserve the historical beta dist-tag on ${INITIAL_BETA_VERSION}`);
	}
	if (typeof packed.integrity !== "string" || metadata.dist?.integrity !== packed.integrity) {
		throw new Error(`${name}@${version} registry tarball does not match the package built from the release tag`);
	}
	const attestations = metadata.dist?.attestations;
	if (
		typeof attestations?.url !== "string" ||
		!attestations.url.startsWith("https://registry.npmjs.org/") ||
		attestations.provenance?.predicateType !== NPM_PROVENANCE_PREDICATE_TYPE
	) {
		throw new Error(`${name}@${version} has no valid npm provenance attestation`);
	}
}

function sleepSync(milliseconds) {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

export function verifyPublishedPackageAfterPublish(release, getMetadata, options = {}) {
	const attempts = options.attempts ?? DEFAULT_POST_PUBLISH_VERIFICATION_ATTEMPTS;
	const delayMs = options.delayMs ?? DEFAULT_POST_PUBLISH_VERIFICATION_DELAY_MS;
	const sleep = options.sleep ?? sleepSync;
	const log = options.log ?? ((message) => process.stdout.write(`${message}\n`));

	for (let attempt = 1; attempt <= attempts; attempt += 1) {
		const metadata = getMetadata(release.name, release.version);
		if (metadata) {
			assertPublishedPackageMatchesRelease({ ...release, metadata });
			return metadata;
		}
		if (attempt === attempts) break;
		if (attempt === 1) {
			log(`${release.name}@${release.version} publish accepted; waiting for npm registry metadata to become visible...`);
		}
		sleep(delayMs);
	}

	throw new Error(`${release.name}@${release.version} is not visible on npm after ${attempts} verification attempts`);
}
