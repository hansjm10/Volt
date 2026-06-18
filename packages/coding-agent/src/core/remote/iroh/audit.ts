import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

export interface IrohRemoteAuditEvent {
	type: string;
	timestamp: number;
	clientNodeId?: string;
	workspace?: string;
	success?: boolean;
	error?: string;
	details?: Record<string, unknown>;
}

export type IrohRemoteAuditEventInput = Omit<IrohRemoteAuditEvent, "timestamp"> & { timestamp?: number };

export interface IrohRemoteAuditSink {
	write(event: IrohRemoteAuditEvent): void | Promise<void>;
}

export interface IrohRemoteAuditLoggerOptions {
	path?: string;
	sink?: IrohRemoteAuditSink;
	now?: () => number;
}

export class IrohRemoteAuditLogger {
	private readonly path: string | undefined;
	private readonly sink: IrohRemoteAuditSink | undefined;
	private readonly now: () => number;

	constructor(options: IrohRemoteAuditLoggerOptions = {}) {
		this.path = options.path;
		this.sink = options.sink;
		this.now = options.now ?? Date.now;
	}

	async log(event: IrohRemoteAuditEventInput): Promise<void> {
		const auditEvent: IrohRemoteAuditEvent = {
			...event,
			timestamp: event.timestamp ?? this.now(),
		};
		if (this.sink) {
			await this.sink.write(auditEvent);
		}
		if (!this.path) {
			return;
		}
		await mkdir(dirname(this.path), { recursive: true });
		await appendFile(this.path, `${JSON.stringify(auditEvent)}\n`, { mode: 0o600 });
	}
}
