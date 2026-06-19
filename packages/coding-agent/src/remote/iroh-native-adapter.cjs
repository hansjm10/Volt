let iroh;
let irohLoadError;
let loadAttempted = false;

function loadIroh() {
	if (!loadAttempted) {
		loadAttempted = true;
		try {
			iroh = require("@number0/iroh/index.js");
		} catch (error) {
			irohLoadError = error;
		}
	}
	return { iroh, irohLoadError };
}

module.exports = {
	loadIroh,
};
