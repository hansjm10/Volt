let iroh;
let irohLoadError;
let irohPackageVersion;
let loadAttempted = false;

function loadIroh() {
	if (!loadAttempted) {
		loadAttempted = true;
		try {
			iroh = require("@number0/iroh/index.js");
			try {
				irohPackageVersion = require("@number0/iroh/package.json").version;
			} catch {}
		} catch (error) {
			irohLoadError = error;
		}
	}
	return { iroh, irohLoadError, irohPackageVersion };
}

module.exports = {
	loadIroh,
};
