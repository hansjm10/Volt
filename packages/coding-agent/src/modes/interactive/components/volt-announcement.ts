import { Container, Spacer, Text } from "@hansjm10/volt-tui";
import { theme } from "../../../core/theme/runtime.ts";
import { DynamicBorder } from "./dynamic-border.ts";

export class VoltAnnouncementComponent extends Container {
	constructor() {
		super();

		this.addChild(new DynamicBorder((text) => theme.fg("accent", text)));
		this.addChild(new Text(theme.bold(theme.fg("accent", "Volt is taking shape")), 1, 0));
		this.addChild(new Spacer(1));
		this.addChild(
			new Text(theme.fg("muted", "Maintained by Jordan Hans · github.com/volt-hq/Volt · @hansjm10 on npm"), 1, 0),
		);
		this.addChild(new Spacer(1));
		this.addChild(new DynamicBorder((text) => theme.fg("accent", text)));
	}
}
