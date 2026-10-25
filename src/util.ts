import type { RequestUrlResponse } from "obsidian";
import type { SyncResponse } from "./api";

// Lowercase hex sha256, byte-for-byte identical to the server's
// `:crypto.hash(:sha256, bytes) |> Base.encode16(case: :lower)`.
export async function sha256Hex(data: Uint8Array): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", data);

	// Array.from over the view rather than an indexed loop: indexing a typed
	// array under `noUncheckedIndexedAccess` yields `number | undefined`, and
	// the `?? 0` that silences it is a lie — the index is always in range. The
	// mapper's parameter is a plain `number`, so nothing here can be `any`.
	//
	// The leading zero is added by hand rather than with `padStart`: that is
	// ES2017, and this project compiles against the ES2016 library (`lib` in
	// tsconfig.json). It only ever type-checked because Node's ambient types
	// were in scope; without them the call is untyped.
	return Array.from(
		new Uint8Array(digest),
		(byte) => (byte < 16 ? "0" : "") + byte.toString(16),
	).join("");
}

// Chunked so a large attachment doesn't blow the argument limit on `apply`.
export function toBase64(bytes: Uint8Array): string {
	let binary = "";
	const chunk = 0x8000;
	for (let i = 0; i < bytes.length; i += chunk) {
		binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
	}
	return btoa(binary);
}

/**
 * Identifies *what the sync state is about*: which server, which game, which
 * folder. Hashed rather than stored raw so the API token never lands in
 * `data.json` twice.
 *
 * The incremental state is only meaningful against the target it was built
 * from. The bearer token IS the game (see `contracts/auth.md`), so repointing
 * at a second campaign — or regenerating a token after a revoke — leaves a
 * state that claims every note is already synced against a server-side vault
 * that is empty. Comparing this on every push is what turns that into a full
 * re-push instead of a cheerful "Already up to date" and a blank campaign site.
 */
export async function targetFingerprint(target: {
	apiBaseUrl: string;
	apiToken: string;
	publishedFolder: string;
}): Promise<string> {
	const material = [
		target.apiBaseUrl.trim().replace(/\/+$/, ""),
		target.apiToken.trim(),
		target.publishedFolder.trim(),
		// NUL: the one character none of the three parts can contain, so no two
		// targets can join to the same string.
	].join("\u0000");
	return sha256Hex(new TextEncoder().encode(material));
}

export function parseJson<T>(response: RequestUrlResponse): T | undefined {
	try {
		return JSON.parse(response.text) as T;
	} catch {
		return undefined;
	}
}

// Files in the published folder the plugin held back because they sit in a
// folder named GM (`claimsGmRoot`). Said in every outcome, including "nothing
// changed": a note that never reaches the site with no word of why is the
// failure this exists to prevent.
export function withHeldBack(message: string, heldBack: number): string {
	if (heldBack === 0) return message;
	return `${message} — ${heldBack} not sent: a folder named GM inside your published folder (rename it, or move it to your GM folder)`;
}

// `entity` is what the push did with RoleCall's entity keys
// (`describeEntityResults`), one sentence each.
export function summarize(
	body: SyncResponse | undefined,
	rejectedCount: number,
	heldBack = 0,
	entity: string[] = [],
): string {
	const n = body?.results?.notes;
	const a = body?.results?.attachments;
	const created = (n?.created ?? 0) + (a?.created ?? 0);
	const updated = (n?.updated ?? 0) + (a?.updated ?? 0);
	const deleted = (n?.deleted ?? 0) + (a?.deleted ?? 0);

	const parts: string[] = [];
	if (created) parts.push(`${created} added`);
	if (updated) parts.push(`${updated} updated`);
	if (deleted) parts.push(`${deleted} deleted`);
	let msg = parts.length ? `Synced: ${parts.join(", ")}` : "Synced";
	if (rejectedCount > 0) msg += ` — ${rejectedCount} rejected (see console)`;
	for (const sentence of entity) msg += ` — ${sentence}`;
	return withHeldBack(msg, heldBack);
}

/** Why a pull request failed, in terms a GM can act on. */
export function explainPullFailure(response: { status: number; text?: string }): string {
	const status = response.status;
	if (status === 401) return "Invalid or revoked token — check plugin settings";
	if (status === 403) {
		// A token from before pulling existed can push but not read. Connect
		// mints one that can.
		return "This token can push notes but not pull them — select Connect in the plugin settings to allow pulling";
	}
	if (status === 404) return "This server doesn't support pulling notes yet";
	if (status === 429) return "Too many requests — try again in a few minutes";
	return `Pull failed: HTTP ${status}`;
}

/** The end-of-pull notice. */
export function summarizePull(
	tally: { added: number; updated: number; failed: number },
	conflicts: number,
	gone: number,
	unplaced: number,
): string {
	const parts: string[] = [];
	if (tally.added) parts.push(`${tally.added} added`);
	if (tally.updated) parts.push(`${tally.updated} updated`);

	let message = parts.length ? `Pulled: ${parts.join(", ")}` : "Already up to date";
	if (conflicts > 0) {
		message += ` — ${conflicts} changed in both places (your copy was kept)`;
	}
	if (tally.failed > 0) message += ` — ${tally.failed} failed (see console)`;
	if (unplaced > 0) {
		message += ` — ${unplaced} GM ${unplaced === 1 ? "file" : "files"} skipped: set a GM folder in the plugin settings`;
	}
	if (gone > 0) {
		message += ` — ${gone} removed on RoleCall ${gone === 1 ? "is" : "are"} still in this vault`;
	}
	return message;
}
