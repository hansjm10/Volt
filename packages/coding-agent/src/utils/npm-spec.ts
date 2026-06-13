export interface ParsedNpmSpec {
	spec: string;
	name: string;
	version?: string;
	exactVersion: boolean;
}

export function parseNpmSpec(spec: string): ParsedNpmSpec {
	const match = spec.match(/^(@?[^@]+(?:\/[^@]+)?)(?:@(.+))?$/);
	const name = match?.[1] ?? spec;
	const version = match?.[2];
	return {
		spec,
		name,
		...(version !== undefined ? { version } : {}),
		exactVersion:
			version !== undefined ? /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version) : false,
	};
}

export function getNpmUpdateSpec(spec: Pick<ParsedNpmSpec, "spec" | "name" | "version">): string {
	return spec.version !== undefined ? spec.spec : `${spec.name}@latest`;
}
