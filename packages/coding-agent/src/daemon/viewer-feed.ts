import { Buffer } from "node:buffer";
import { type ProjectionDiagnostic, StreamProjector } from "../core/rpc/stream-projection.ts";
import type { ControlEvent } from "./control-protocol.ts";

/**
 * Read-only viewer feeds for lease drains (§4.3): from drain start, every
 * AgentSessionEvent of the draining runtime is captured; events are buffered
 * until the acquiring TUI sends viewer_subscribe, then flushed and streamed
 * live as viewer_event control messages. The feed is delivered only to the
 * drain requester's control connection.
 */

export const VIEWER_BUFFER_MAX_EVENTS = 2000;
export const VIEWER_BUFFER_MAX_BYTES = 4 * 1024 * 1024;

/** Structural view of AgentSession as the feed needs it. */
export interface ViewerFeedSession {
	subscribe(handler: (event: unknown) => void): () => void;
	abort(source?: "remote_request"): Promise<void> | void;
}

interface BufferedViewerEvent {
	event: unknown;
	byteLength: number;
}

interface ViewerFeed {
	viewerFeedId: string;
	connectionId: string;
	session: ViewerFeedSession;
	unsubscribeSession: () => void;
	/** Buffered events awaiting viewer_subscribe; null once flushed (live). */
	buffer: BufferedViewerEvent[] | null;
	bufferedBytes: number;
	/** Buffer overflowed: buffer dropped, TUI gets {kind:"truncated"} first. */
	truncated: boolean;
	seq: number;
	subscribed: boolean;
	ended: boolean;
	/** Projection state for this feed's single ordered delivery stream. */
	projector: StreamProjector;
}

export interface ViewerFeedEffects {
	/** Deliver a control event to a specific connection; false when it is gone. */
	sendTo(connectionId: string, event: ControlEvent): boolean;
}

export class ViewerFeedRegistry {
	private readonly effects: ViewerFeedEffects;
	private readonly feeds = new Map<string, ViewerFeed>();

	constructor(effects: ViewerFeedEffects) {
		this.effects = effects;
	}

	/** Begin capturing the draining runtime's events for the requesting connection. */
	start(viewerFeedId: string, connectionId: string, session: ViewerFeedSession): void {
		if (this.feeds.has(viewerFeedId)) {
			return;
		}
		const feed: ViewerFeed = {
			viewerFeedId,
			connectionId,
			session,
			unsubscribeSession: () => {},
			buffer: [],
			bufferedBytes: 0,
			truncated: false,
			seq: 0,
			subscribed: false,
			ended: false,
			projector: new StreamProjector(),
		};
		feed.unsubscribeSession = session.subscribe((event) => {
			this.onSessionEvent(feed, event);
		});
		this.feeds.set(viewerFeedId, feed);
	}

	private onSessionEvent(feed: ViewerFeed, event: unknown): void {
		if (feed.ended) {
			return;
		}
		if (feed.subscribed) {
			const entries = this.projectDeliverableEvents(feed, event);
			for (const entry of entries) {
				if (!this.emit(feed, entry.event)) {
					this.markDiscontinuity(feed);
					break;
				}
			}
			return;
		}
		if (feed.truncated || feed.buffer === null) {
			return;
		}
		const entries = this.projectDeliverableEvents(feed, event);
		const nextEventCount = feed.buffer.length + entries.length;
		const nextBufferedBytes = feed.bufferedBytes + entries.reduce((total, entry) => total + entry.byteLength, 0);
		if (nextEventCount > VIEWER_BUFFER_MAX_EVENTS || nextBufferedBytes > VIEWER_BUFFER_MAX_BYTES) {
			// Cap exceeded: drop everything; the TUI shows a spinner and relies on
			// the post-grant session file load for truth.
			feed.buffer = null;
			feed.bufferedBytes = 0;
			feed.truncated = true;
			// Buffered history is gone. Any later live frame must not depend on it.
			this.markDiscontinuity(feed);
			return;
		}
		feed.buffer.push(...entries);
		feed.bufferedBytes = nextBufferedBytes;
	}

	private projectDeliverableEvents(feed: ViewerFeed, event: unknown): BufferedViewerEvent[] {
		try {
			let frames: readonly unknown[];
			if (typeof event === "object" && event !== null) {
				const batch = feed.projector.push(event);
				this.reportProjectionDiagnostics(feed, batch.diagnostics);
				frames = batch.frames;
			} else {
				frames = [event];
			}
			return frames.map((frame) => {
				const serialized = JSON.stringify(frame);
				if (serialized === undefined) {
					throw new Error("Viewer event is not JSON serializable");
				}
				return {
					event: JSON.parse(serialized),
					byteLength: Buffer.byteLength(serialized, "utf8"),
				};
			});
		} catch {
			// The dropped input may already have advanced projection state. Fence it
			// so the next deliverable assistant update is a replacement snapshot.
			this.markDiscontinuity(feed);
			return [];
		}
	}

	private emit(feed: ViewerFeed, event: unknown): boolean {
		return this.effects.sendTo(feed.connectionId, {
			type: "viewer_event",
			viewerFeedId: feed.viewerFeedId,
			seq: feed.seq++,
			event,
		});
	}

	private markDiscontinuity(feed: ViewerFeed): void {
		this.reportProjectionDiagnostics(feed, feed.projector.discontinuity().diagnostics);
	}

	private reportProjectionDiagnostics(feed: ViewerFeed, diagnostics: readonly ProjectionDiagnostic[]): void {
		for (const diagnostic of diagnostics) {
			console.error(
				`[stream-projection:viewer:${feed.viewerFeedId}] ${diagnostic.code}: ${diagnostic.message}`,
				diagnostic,
			);
		}
	}

	/**
	 * viewer_subscribe from the drain requester: flush the buffer (or the
	 * truncation marker) and switch to live forwarding. Returns false for an
	 * unknown feed or a connection that is not the drain requester.
	 */
	subscribe(viewerFeedId: string, connectionId: string): boolean {
		const feed = this.feeds.get(viewerFeedId);
		if (!feed || feed.ended || feed.connectionId !== connectionId) {
			return false;
		}
		if (feed.subscribed) {
			return true;
		}
		feed.subscribed = true;
		if (feed.truncated) {
			if (!this.emit(feed, { kind: "truncated" })) {
				this.markDiscontinuity(feed);
			}
		} else if (feed.buffer) {
			for (const entry of feed.buffer) {
				if (!this.emit(feed, entry.event)) {
					this.markDiscontinuity(feed);
					break;
				}
			}
		}
		feed.buffer = null;
		feed.bufferedBytes = 0;
		return true;
	}

	/** Stop forwarding without ending the drain (TUI dismissed the overlay). */
	unsubscribe(viewerFeedId: string, connectionId: string): boolean {
		const feed = this.feeds.get(viewerFeedId);
		if (!feed || feed.connectionId !== connectionId) {
			return false;
		}
		feed.subscribed = false;
		feed.buffer = null;
		feed.bufferedBytes = 0;
		// Events are dropped while unsubscribed, so resumption needs a snapshot.
		this.markDiscontinuity(feed);
		return true;
	}

	/** viewer_abort: stop the draining turn (non-destructive abort, §7.4). */
	async abort(viewerFeedId: string, connectionId: string): Promise<boolean> {
		const feed = this.feeds.get(viewerFeedId);
		if (!feed || feed.ended || feed.connectionId !== connectionId) {
			return false;
		}
		await feed.session.abort("remote_request");
		return true;
	}

	/** Drain ended: emit viewer_end (best-effort) and tear the feed down. */
	end(viewerFeedId: string, reason: "granted" | "cancelled" | "error"): void {
		const feed = this.feeds.get(viewerFeedId);
		if (!feed) {
			return;
		}
		feed.ended = true;
		feed.unsubscribeSession();
		this.reportProjectionDiagnostics(feed, feed.projector.endStream().diagnostics);
		this.feeds.delete(viewerFeedId);
		this.effects.sendTo(feed.connectionId, { type: "viewer_end", viewerFeedId, reason });
	}

	has(viewerFeedId: string): boolean {
		return this.feeds.has(viewerFeedId);
	}
}
