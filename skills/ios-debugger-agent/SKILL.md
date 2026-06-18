---
name: ios-debugger-agent
description: Build, run, and debug iOS apps on Simulator with XcodeBuildMCP. Use when launching an app, inspecting simulator UI or logs, or diagnosing runtime behavior.
---

# iOS Debugger Agent

## Overview
Use XcodeBuildMCP to build and run the current project scheme on a booted iOS simulator, interact with the UI, and capture logs. Prefer the native XcodeBuildMCP-backed Volt tools for simulator control, logs, and view inspection.

## Core Workflow
Follow this sequence unless the user asks for a narrower action.

### 1) Discover the booted simulator
- Call `list_sims` and select the simulator with state `Booted`.
- If none are booted, ask the user to boot one (do not boot automatically unless asked).

### 2) Set session defaults
- Call `session_set_defaults` with:
  - `projectPath` or `workspacePath` (whichever the repo uses)
  - `scheme` for the current app
  - `simulatorId` from the booted device
  - Optional: `configuration: "Debug"`, `useLatestOS: true`

### 3) Build + run (when requested)
- Call `build_run_sim`.
- **If the build fails**, check the error output and retry (optionally with `preferXcodebuild: true`) or escalate to the user before attempting any UI interaction.
- **After a successful build**, verify the app launched by calling `snapshot_ui` or `screenshot` before proceeding to UI interaction.
- If the app is already built and only launch is requested, use `launch_app_sim`.
- If bundle id is unknown:
  1) `get_sim_app_path`
  2) `get_app_bundle_id`

## UI Interaction & Debugging
Use these when asked to inspect or interact with the running app.

- **Describe UI**: `snapshot_ui` before tapping or swiping.
- **Tap**: `tap` (prefer `elementRef`; use coordinates only if needed).
- **Type**: `type_text` after focusing a field.
- **Gestures**: `gesture` for common scrolls and edge swipes.
- **Screenshot**: `screenshot` for visual confirmation.

## Logs & Console Output
- Runtime logs are captured by `build_run_sim`; use the returned log path when diagnosing console output.
- For console output, set `captureConsole: true` and relaunch if required.

## Troubleshooting
- If build fails, ask whether to retry with `preferXcodebuild: true`.
- If the wrong app launches, confirm the scheme and bundle id.
- If UI elements are not hittable, re-run `snapshot_ui` after layout changes.
