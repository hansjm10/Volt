---
"@hansjm10/volt-tui": minor
"@hansjm10/volt-coding-agent": minor
---

breaking(tui): Changed custom components to return explicit render frames so terminal image placement survives composition.

Migrate `render(width): string[]` to `render(width): RenderFrame` and wrap text-only output with `createRenderFrame(lines)`. Use the exported frame composition helpers instead of flattening `child.render(width).lines` when building another component.
