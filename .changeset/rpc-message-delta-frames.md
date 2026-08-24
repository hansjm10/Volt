---
"@hansjm10/volt-coding-agent": minor
---

breaking(rpc): Changed `message_update` frames to carry only deltas instead of accumulated partial messages. ([#44](https://github.com/volt-hq/Volt/issues/44))

Every `message_update` frame previously serialized the full accumulated assistant message twice (as `message` and as `assistantMessageEvent.partial`), making streaming bandwidth quadratic in message length on stdio RPC, Iroh remote, `--mode json`, and daemon viewer feeds. Frames now carry only the streaming delta; `message_start` seeds the accumulator, `message_end` carries the final message, and a client attaching mid-message receives one full `message` snapshot on its first update. Daemon viewer feeds still carry full messages but drop the duplicated partial.

Migration: clients using the bundled RPC client (`RpcClientBase` and SDK clients built on it) are unaffected — full `message` and `partial` fields are reconstructed transparently. Clients reading raw JSONL frames must accumulate deltas per the reconstruction rules in `docs/rpc.md` (`text_delta`/`thinking_delta` append to the block at `contentIndex`; `toolcall_start` carries an id/name stub, `toolcall_delta` streams raw argument JSON, `toolcall_end` is authoritative), or read only `message_end` for final content.
