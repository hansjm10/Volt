let iroh;
let irohLoadError;
let irohPackageVersion;
let loadAttempted = false;

function loadIroh() {
	if (!loadAttempted) {
		loadAttempted = true;
		try {
			irohPackageVersion = require("@hansjm10/volt-iroh/package.json").version;
		} catch {}
		try {
			iroh = require("@hansjm10/volt-iroh/index.js");
		} catch (error) {
			irohLoadError = error;
		}
	}
	return { iroh, irohLoadError, irohPackageVersion };
}

module.exports = {
	loadIroh,
};
