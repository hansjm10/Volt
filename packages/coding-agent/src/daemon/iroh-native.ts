import type { IrohBiStreamLike } from "../core/rpc/iroh-transport.ts";
import nativeAdapter from "../remote/iroh-native-adapter.cjs";

/** Minimal structural typings for the Volt-owned Iroh binding surface. */

export interface IrohNodeIdLike {
	toString(): string;
}

export interface IrohWatchHandleLike {
	stop(): Promise<void>;
}

export type IrohHomeRelayWatchCallback = (errorOrRelayUrls: unknown, relayUrls?: string[]) => void;

export interface IrohSecretKeyLike {
	toBytes(): number[];
}

export interface IrohEndpointLike {
	id(): IrohNodeIdLike;
	addr(): unknown;
	online(): Promise<void>;
	close(): Promise<void>;
	insertRelay?(config: IrohRelayConfigLike): Promise<void>;
	reconnectRelay?(config: IrohRelayConfigLike): Promise<void>;
	removeRelay?(url: string): Promise<boolean>;
	watchHomeRelay?(callback: IrohHomeRelayWatchCallback): IrohWatchHandleLike;
	acceptNext(): Promise<IrohIncomingLike | null | undefined>;
	secretKey(): IrohSecretKeyLike;
}

export interface IrohIncomingLike {
	accept(): Promise<IrohAcceptingLike>;
	refuse(): Promise<void>;
}

export interface IrohAcceptingLike {
	connect(): Promise<IrohConnectionLike>;
}

export interface IrohConnectionLike {
	remoteId(): IrohNodeIdLike;
	acceptBi(): Promise<IrohBiStreamLike>;
	setMaxConcurrentBiStreams(count: bigint): void;
	close(errorCode: bigint, reason: number[]): void;
	closed(): Promise<unknown>;
}

export interface IrohEndpointBuilderLike {
	relayMode(mode: unknown): void;
	secretKey(key: number[]): void;
	alpns(alpns: number[][]): void;
	bind(): Promise<IrohEndpointLike>;
}

export interface IrohRelayConfigLike {
	url: string;
	quicPort?: number;
	authToken?: string;
}

export interface IrohRelayMapLike {
	insert(config: IrohRelayConfigLike): void;
}

export interface IrohBindingCapabilities {
	connectedHomeRelayWatch: boolean;
	reconnectRelay: boolean;
}

export interface IrohModuleLike {
	bindingCapabilities(): IrohBindingCapabilities;
	Endpoint: { builder(): IrohEndpointBuilderLike };
	EndpointTicket: { fromAddr(addr: unknown): { toString(): string } };
	RelayMap: { empty(): IrohRelayMapLike };
	RelayMode: { disabled(): unknown; custom(map: IrohRelayMapLike): unknown; customFromUrls(urls: string[]): unknown };
	presetMinimal(builder: IrohEndpointBuilderLike): void;
	presetN0(builder: IrohEndpointBuilderLike): void;
	presetN0DisableRelay(builder: IrohEndpointBuilderLike): void;
}

export interface IrohNativeLoadResult {
	iroh?: IrohModuleLike;
	packageVersion?: string;
	capabilities?: IrohBindingCapabilities;
	error?: unknown;
}

export function loadIrohModule(): IrohNativeLoadResult {
	const { iroh, irohLoadError, irohPackageVersion } = nativeAdapter.loadIroh() as {
		iroh?: unknown;
		irohLoadError?: unknown;
		irohPackageVersion?: unknown;
	};
	const packageVersion = typeof irohPackageVersion === "string" ? irohPackageVersion : undefined;
	if (!iroh) {
		return {
			error: irohLoadError,
			...(packageVersion === undefined ? {} : { packageVersion }),
		};
	}
	const typedIroh = iroh as IrohModuleLike;
	let capabilities: IrohBindingCapabilities;
	try {
		capabilities = typedIroh.bindingCapabilities();
	} catch (error) {
		return {
			error: new Error("the installed Volt Iroh binding does not expose relay recovery capabilities", {
				cause: error,
			}),
		};
	}
	if (!capabilities.connectedHomeRelayWatch || !capabilities.reconnectRelay) {
		return { error: new Error("the installed Volt Iroh binding lacks required relay recovery capabilities") };
	}
	return {
		iroh: typedIroh,
		capabilities,
		...(packageVersion === undefined ? {} : { packageVersion }),
	};
}

export function formatIrohLoadError(error: unknown): string {
	const detail = error instanceof Error ? error.message : error ? String(error) : "unknown native adapter error";
	return [
		"The required @hansjm10/volt-iroh wrapper could not load its platform-native binding.",
		`Native binding error: ${detail}`,
		"Reinstall Volt with optional dependencies enabled on a supported platform, then retry.",
		"If optional dependencies were omitted, reinstall without `--omit=optional`.",
	].join("\n");
}
