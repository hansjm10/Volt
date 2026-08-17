---
"@hansjm10/volt-tui": minor
---

breaking(tui): Replaced the constructible `TUI` class with explicit main-screen and fullscreen renderers.

Migrate `new TUI(terminal)` to `new TuiMainScreen(terminal)` and use `TUI` only as a renderer-neutral type. Use `TuiAltScreen` when the application needs an alternate-screen viewport and constrained `VStack`/`HStack`/`ScrollView` layout.
