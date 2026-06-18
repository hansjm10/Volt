# Build iOS Apps Volt Package

Build, profile, debug, and refine iOS apps with SwiftUI and Xcode workflows.

This package vendors OpenAI's `build-ios-apps` plugin payload from `openai/plugins` commit `015c0dff7475b7ee3cddc6cb06789ef302cfa4d6` and exposes its skills through Volt's package manifest.

Volt also loads `extensions/xcodebuildmcp.ts`, which starts pinned `xcodebuildmcp@2.6.2` as a stdio MCP subprocess, discovers its `tools/list` response, and registers each XcodeBuildMCP tool as a native Volt tool. The preserved upstream `.mcp.json` is included for parity with the original plugin payload; Volt does not need it for the native tool path.

## Install

From the Volt store:

```text
/store install build-ios-apps
```

Or install the package source directly:

```bash
volt install git:https://github.com/hansjm10/Volt@store/build-ios-apps
```

## Skills

- `ios-debugger-agent`
- `ios-simulator-browser`
- `ios-ettrace-performance`
- `ios-memgraph-leaks`
- `ios-app-intents`
- `swiftui-liquid-glass`
- `swiftui-performance-audit`
- `swiftui-ui-patterns`
- `swiftui-view-refactor`

## Requirements

- macOS with Xcode and iOS Simulator.
- `xcodebuild`, `xcrun`, and relevant simulator runtimes installed.
- Node.js available for the bundled native extension and helper scripts.
- Optional workflow tools such as `serve-sim`, ETTrace, Instruments, and `leaks`, depending on the selected skill.
- Optional: set `VOLT_XCODEBUILDMCP_WORKFLOWS` to override the extension default of `simulator,ui-automation,debugging`.

## Package Structure

- `package.json`: Volt package manifest that enables the skills and native XcodeBuildMCP extension.
- `extensions/`: Volt extension that forwards XcodeBuildMCP tools as native Volt tools.
- `.codex-plugin/plugin.json`: upstream Codex plugin manifest, preserved for parity with the original package.
- `.mcp.json`: upstream XcodeBuildMCP configuration, preserved with the plugin payload.
- `agents/`: upstream plugin-level agent metadata.
- `assets/`: upstream icon assets.
- `skills/`: upstream skill payload and helper scripts.
