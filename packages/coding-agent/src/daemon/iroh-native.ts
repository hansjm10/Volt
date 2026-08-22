import type { IrohBiStreamLike } from "../core/rpc/iroh-transport.ts";
import nativeAdapter from "../remote/iroh-native-adapter.cjs";

/**
 * Minimal structural typings for the @number0/iroh surface the daemon touches.
 * The native module ships without TypeScript types; these interfaces mirror the
 * members exercised by the dissolved iroh-host.mjs.
 */

export interface IrohNodeIdLike {
	toString(): string;
}

export interface IrohSecretKeyLike {
	toBytes(): number[];
}

export interface IrohEndpointLike {
	id(): IrohNodeIdLike;
	addr(): unknown;
	online(): Promise<void>;
	close(): Promise<void>;
	insertRelay?(config: IrohRelayConfigLike): Promise<void>;
	removeRelay?(url: string): Promise<boolean>;
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

export interface IrohModuleLike {
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
	error?: unknown;
}

export function loadIrohModule(): IrohNativeLoadResult {
	const { iroh, irohLoadError } = nativeAdapter.loadIroh();
	if (!iroh) {
		return { error: irohLoadError };
	}
	return { iroh: iroh as IrohModuleLike };
}

export function formatIrohLoadError(error: unknown): string {
	const detail = error instanceof Error ? error.message : error ? String(error) : "unknown native adapter error";
	return [
		"The optional @number0/iroh native adapter is not available.",
		`Native adapter error: ${detail}`,
		"Install Volt with optional dependencies enabled for this platform, then retry.",
		"If optional dependencies were omitted, reinstall without `--omit=optional`.",
	].join("\n");
}
