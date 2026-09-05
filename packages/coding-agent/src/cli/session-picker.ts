/**
 * TUI session selector for --resume flag
 */

import { ProcessTerminal, setKeybindings, TuiMainScreen } from "@hansjm10/volt-tui";
import { KeybindingsManager } from "../core/keybindings.ts";
import type { SessionInfo, SessionListProgress, SessionReference } from "../core/session-manager.ts";
import { SessionSelectorComponent } from "../modes/interactive/components/session-selector.ts";

type SessionsLoader = (onProgress?: SessionListProgress, query?: string) => Promise<SessionInfo[]>;

/** Show TUI session selector and return the selected stable reference or null if cancelled. */
export async function selectSession(
	currentSessionsLoader: SessionsLoader,
	allSessionsLoader: SessionsLoader,
): Promise<SessionReference | null> {
	return new Promise((resolve) => {
		const ui = new TuiMainScreen(new ProcessTerminal());
		const keybindings = KeybindingsManager.create();
		setKeybindings(keybindings);
		let resolved = false;

		const selector = new SessionSelectorComponent(
			currentSessionsLoader,
			allSessionsLoader,
			(ref: SessionReference) => {
				if (!resolved) {
					resolved = true;
					ui.stop();
					resolve(ref);
				}
			},
			() => {
				if (!resolved) {
					resolved = true;
					ui.stop();
					resolve(null);
				}
			},
			() => {
				ui.stop();
				process.exit(0);
			},
			() => ui.requestRender(),
			{ showRenameHint: false, keybindings },
		);

		ui.addChild(selector);
		ui.setFocus(selector.getSessionList());
		ui.start();
	});
}
