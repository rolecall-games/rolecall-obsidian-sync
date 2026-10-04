// The wire contract for POST /api/v1/vault_imports.
//
// Specified in `rolecall-meta/contracts/vault-imports.md`; the server side is
// `RoleCallWeb.API.VaultImportsController` + `RoleCall.Obsidian.VaultImporter`.
// When the contract moves, FOUR things move together: the server's
// `@sync_version`, the contract doc header, `SYNC_VERSION` below, and
// `CLIENT_VERSION`.

export const CLIENT_NAME = "obsidian-plugin";

// 4: the `roots` declaration, and `GM/…` paths for a GM who switched their GM
// folder on. A v4 batch that names only `published` is a v3 batch.
export const SYNC_VERSION = 4;

// The two folders of a vault that can sync. `published` always does; `gm`
// only when the batch says so — RoleCall rejects a `GM/…` path, and ignores a
// `GM/…` delete, from any batch that does not name it.
export type SyncRoot = "published" | "gm";

export const VAULT_IMPORTS_PATH = "/api/v1/vault_imports";

// The pull (rolecall-meta/contracts/vault-pull.md) is a contract of its own
// with its own canary: three reads that need a token holding `notes:read`.
export const PULL_SYNC_VERSION = 1;
export const VAULT_MANIFEST_PATH = "/api/v1/vault/manifest";
export const VAULT_NOTES_PATH = "/api/v1/vault/notes";
export const VAULT_ATTACHMENT_PATH = "/api/v1/vault/attachment";

// The most paths one notes request may name (the server's ceiling is 200).
export const PULL_NOTES_CHUNK = 100;

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
// Anything under a synced folder that isn't markdown or one of these is
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
	// The hash of the version this change was made from, when the plugin has a
	// record of one. It is what lets RoleCall tell an edit made on top of a
	// note it edited (apply it) from one made without seeing that edit (park
	// it for the GM).
	base_hash?: string;
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
	// The roots the server honoured for the batch.
	roots?: SyncRoot[];
	results?: {
		notes?: SyncResultCounts;
		attachments?: SyncResultCounts;
		rejected?: RejectedPath[];
	};
}

// The 409 body. `sync_version` is the newest shape the server speaks and
// `min_sync_version` the oldest it still accepts, which is what tells "this
// plugin is too old" apart from "the server has not caught up yet".
export interface VersionMismatch {
	sync_version?: number;
	min_sync_version?: number;
}

export interface ManifestNote {
	path: string;
	content_hash: string;
	// A sync conflict is parked on this note on RoleCall and nobody has
	// settled it.
	conflict?: boolean;
}

export interface ManifestAttachment {
	path: string;
	content_hash: string;
	byte_size?: number;
}

export interface VaultManifest {
	sync_version?: number;
	min_sync_version?: number;
	notes?: ManifestNote[];
	attachments?: ManifestAttachment[];
	folders?: string[];
}

export interface VaultNotesResponse {
	notes?: NoteEntry[];
}

export interface SyncPayload {
	sync_version: number;
	client: string;
	client_version: string;
	roots: SyncRoot[];
	notes: NoteEntry[];
	attachments: AttachmentEntry[];
	deleted_paths: string[];
}
