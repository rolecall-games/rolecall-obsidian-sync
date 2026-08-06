// The wire contract for POST /api/v1/vault_imports.
//
// Specified in `rolecall-meta/contracts/vault-imports.md`; the server side is
// `RoleCallWeb.API.VaultImportsController` + `RoleCall.Obsidian.VaultImporter`.
// When the contract moves, FOUR things move together: the server's
// `@sync_version`, the contract doc header, `SYNC_VERSION` below, and
// `CLIENT_VERSION`.

export const CLIENT_NAME = "obsidian-plugin";
export const SYNC_VERSION = 3;

export const VAULT_IMPORTS_PATH = "/api/v1/vault_imports";

// The device-code activation handshake (rolecall-meta/contracts/
// plugin-connect.md) carries its own version canary, independent of the
// vault-imports sync_version. The client version sent on the wire is the
// manifest's — threaded in from the plugin instance, never a third
// hand-maintained copy (it drifted to "0.2.0" while the manifest read 0.2.2).
export const CONNECT_PROTOCOL_VERSION = 1;
export const PLUGIN_CONNECT_PATH = "/api/v1/plugin_connect";

export interface ConnectStart {
	protocol_version: number;
	user_code: string;
	device_code: string;
	connect_url: string;
	poll_interval_seconds: number;
	expires_in_seconds: number;
}

export type ConnectPoll =
	| { status: "pending" | "denied" | "expired" | "consumed" }
	| { status: "approved"; token: string; game: { id: string; name: string; url: string } };

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
