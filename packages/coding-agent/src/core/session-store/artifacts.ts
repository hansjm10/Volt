import { closeSync, constants, fchmodSync, fstatSync, lstatSync, openSync } from "node:fs";
import { PRIVATE_FILE_MODE } from "../../utils/private-files.ts";

/** SQLite may unlink WAL/SHM files while a different connection is opening or closing. */
export function hardenSessionStoreSidecars(databasePath: string): void {
	for (const path of [`${databasePath}-wal`, `${databasePath}-shm`]) {
		let fd: number | undefined;
		try {
			const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
			fd = openSync(path, constants.O_RDONLY | noFollow);
			const stat = fstatSync(fd);
			if (!stat.isFile() || stat.nlink > 1) {
				throw new Error(`Refusing to use non-private session sidecar: ${path}`);
			}
			// An unlinked inode no longer exposes a path and must not be confused with a replacement.
			if (stat.nlink === 0) continue;
			if (noFollow === 0) {
				const current = lstatSync(path);
				if (current.isSymbolicLink() || current.dev !== stat.dev || current.ino !== stat.ino) {
					throw new Error(`Session sidecar identity changed while opening: ${path}`);
				}
			}
			fchmodSync(fd, PRIVATE_FILE_MODE);
		} catch (error) {
			// Missing sidecars are normal, including removal between open and identity checks.
			if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
		} finally {
			if (fd !== undefined) closeSync(fd);
		}
	}
}
