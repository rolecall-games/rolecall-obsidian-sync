// The wire contract for POST /api/v1/vault_imports.
//
// Specified in `rolecall-meta/contracts/vault-imports.md`; the server side is
// `RoleCallWeb.API.VaultImportsController` + `RoleCall.Obsidian.VaultImporter`.
// When the contract moves, FOUR things move together: the server's
// `@sync_version`, the contract doc header, `SYNC_VERSION` below, and
// `CLIENT_VERSION`.

export const CLIENT_NAME = "obsidian-plugin";
export const CLIENT_VERSION = "0.2.0";
export const SYNC_VERSION = 3;

export const VAULT_IMPORTS_PATH = "/api/v1/vault_imports";

// Mirrors the server's attachment allowlist (RoleCall.Obsidian.PathSafety).
// Anything under the published folder that isn't markdown or one of these is
// left unsynced. Kept as a literal so a drift from the server is a visible
// diff here rather than a silent skip in the field.
export const MEDIA_EXTENSIONS = new Set([
	"png", "jpg", "jpeg", "gif", "webp", "avif", "bmp", "svg", "ico",
	"pdf", "mp3", "ogg", "wav", "m4a", "flac", "mp4", "webm", "mov",
]);

export interface NoteEntry {
	path: string;
	markdown: string;
	content_hash: string;
}

export interface AttachmentEntry {
	path: string;
	content_base64: string;
	content_hash: string;
}

export interface SyncResultCounts {
	created: number;
	updated: number;
	skipped: number;
	deleted: number;
}

export interface RejectedPath {
	path: string;
	reason: string;
}

export interface SyncResponse {
	results?: {
		notes?: SyncResultCounts;
		attachments?: SyncResultCounts;
		rejected?: RejectedPath[];
	};
}

export interface SyncPayload {
	sync_version: number;
	client: string;
	client_version: string;
	notes: NoteEntry[];
	attachments: AttachmentEntry[];
	deleted_paths: string[];
}
