---
"@hansjm10/volt-tui": patch
"@hansjm10/volt-coding-agent": patch
---

feature(tui): Added negotiated Sixel image rendering in Windows Terminal 1.22+, including fullscreen scrolling, cropping, and stale-image repainting.

Sixel output uses deterministic adaptive quantization with up to 256 colors for improved fidelity without dithering.
