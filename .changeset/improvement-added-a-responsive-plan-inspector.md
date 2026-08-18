---
"@hansjm10/volt-coding-agent": patch
"@hansjm10/volt-tui": patch
---

improvement(tui): Added a responsive plan inspector that keeps canonical plan lifecycle state visible beside the conversation in regular and fullscreen modes.

Wide terminals keep at least 80 columns for the conversation and show a focusable, independently scrollable 48–72-column plan pane above the full-width footer. Compact terminals retain Plan Details, while responsive transitions preserve regular-mode scrollback and fullscreen paging, search, pointer routing, images, overlays, and custom UI focus.
