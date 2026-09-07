import { Buffer } from "node:buffer";
import png from "@jimp/js-png";
import QRCodeTerminal from "qrcode-terminal";
import QRCode from "qrcode-terminal/vendor/QRCode/index.js";
import QRErrorCorrectLevel from "qrcode-terminal/vendor/QRCode/QRErrorCorrectLevel.js";

const IROH_REMOTE_QR_ERROR_CORRECTION_LEVEL = "M";
const IROH_REMOTE_QR_MODULE_PIXELS = 4;
const IROH_REMOTE_QR_QUIET_ZONE_MODULES = 4;

export interface IrohRemoteTicketQrCode {
	modules: boolean[][];
	size: number;
	version: number;
}

export interface IrohRemoteTicketQrCodeFormatOptions {
	small?: boolean;
}

export interface IrohRemoteTicketQrCodePng {
	base64Data: string;
	heightPx: number;
	widthPx: number;
}

export function createIrohRemoteTicketQrCode(ticket: string): IrohRemoteTicketQrCode {
	const qrCode = new QRCode(-1, QRErrorCorrectLevel[IROH_REMOTE_QR_ERROR_CORRECTION_LEVEL]);
	qrCode.addData(ticket);
	qrCode.make();
	const size = qrCode.getModuleCount();
	return {
		modules: qrCode.modules.map((row) => row.map((module) => module === true)),
		size,
		version: Math.floor((size - 17) / 4),
	};
}

export function createIrohRemoteTicketQrCodePng(ticket: string): IrohRemoteTicketQrCodePng {
	const qrCode = createIrohRemoteTicketQrCode(ticket);
	const imageSizeModules = qrCode.size + IROH_REMOTE_QR_QUIET_ZONE_MODULES * 2;
	const imageSizePixels = imageSizeModules * IROH_REMOTE_QR_MODULE_PIXELS;
	const data = Buffer.alloc(imageSizePixels * imageSizePixels * 4, 0xff);
	for (let row = 0; row < qrCode.size; row++) {
		for (let column = 0; column < qrCode.size; column++) {
			if (!qrCode.modules[row]![column]) continue;
			const top = (row + IROH_REMOTE_QR_QUIET_ZONE_MODULES) * IROH_REMOTE_QR_MODULE_PIXELS;
			const left = (column + IROH_REMOTE_QR_QUIET_ZONE_MODULES) * IROH_REMOTE_QR_MODULE_PIXELS;
			for (let y = top; y < top + IROH_REMOTE_QR_MODULE_PIXELS; y++) {
				for (let x = left; x < left + IROH_REMOTE_QR_MODULE_PIXELS; x++) {
					const offset = (y * imageSizePixels + x) * 4;
					data[offset] = 0;
					data[offset + 1] = 0;
					data[offset + 2] = 0;
				}
			}
		}
	}
	return {
		base64Data: png().encode({ data, width: imageSizePixels, height: imageSizePixels }).toString("base64"),
		heightPx: imageSizePixels,
		widthPx: imageSizePixels,
	};
}

export function formatIrohRemoteTicketQrCode(
	ticket: string,
	options: IrohRemoteTicketQrCodeFormatOptions = {},
): string {
	return formatIrohRemoteTicketQrCodeTerminal(ticket, options);
}

export function formatIrohRemoteTicketQrCodeTerminal(
	ticket: string,
	options: IrohRemoteTicketQrCodeFormatOptions = {},
): string {
	let output = "";
	QRCodeTerminal.setErrorLevel(IROH_REMOTE_QR_ERROR_CORRECTION_LEVEL);
	QRCodeTerminal.generate(ticket, { small: options.small ?? true }, (qrCode) => {
		output = qrCode;
	});
	return output;
}
