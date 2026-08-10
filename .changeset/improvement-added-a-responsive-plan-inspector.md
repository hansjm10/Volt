---
"@hansjm10/volt-coding-agent": patch
"@hansjm10/volt-tui": patch
---

improvement(tui): Added a responsive plan inspector that keeps canonical plan lifecycle state visible beside the conversation on wide terminals.

Plan transitions now preserve existing terminal scrollback, returning from the inspector restores focus to extension custom UIs, focused overlays retain input ownership, compact Plan Details focus follows the inspector after expansion, and only visible ready actions can be confirmed. Conversation rows that scroll above the active viewport are written as plain text, so scrolling back through a session no longer shows a dangling pane divider beside empty space.
