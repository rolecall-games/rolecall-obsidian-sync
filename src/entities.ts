// What a push does with RoleCall's entity keys (plugin 0.5.0).
//
// RoleCall binds GM notes under `GM/NPCs`, `GM/Groups`, `GM/Quests` and
// `GM/Locations` to the NPC, group, quest or place they describe. A push
// response to a batch that declared the GM root, from a token that can read
// notes, carries five additive keys (`sync_version` stays 4 — an older
// plugin ignores them, and a server without them simply sends none):
//
// - `bound` — GM notes whose file lacks the entity's `rc_id`. The plugin
//   writes it in (`stampRcId`) and records the hash RoleCall gave, so the
//   next push sends the stamped file as an edit of the agreed version and
//   RoleCall agrees it without a conflict.
// - `normalised` — a GM note dragged into the published folder, as RoleCall
//   stored it (GM-only properties dropped). The local copy is replaced while
//   it is still exactly what was pushed.
// - `entity_notes_kept`, `entity_attachments_kept`, `duplicate_ids` — said
//   in the notice and the console.
//
// Everything here is pure (no `obsidian` import), so `npm test` pins it; the
// vault writes are in `sync.ts`. Nothing local is ever sent up because of
// these keys: the plugin only acts on what the server named.

import type { StampedState, SyncState } from "./plan";
import { isGmWirePath } from "./plan";
import { isRcId } from "./stamp";

export interface BoundEntry {
	path: string;
	rc_id: string;
	/** The version the vault last agreed on — what it pushed, not the stamped file. */
	content_hash: string;
	/** The head has an `rc_id:` key (another id, or emptied): overwrite its value. */
	replace: boolean;
}

export interface NormalisedEntry {
	path: string;
	markdown: string;
	content_hash: string;
}

export interface EntityResults {
	bound: BoundEntry[];
	notesKept: string[];
	attachmentsKept: string[];
	duplicateIds: string[];
	normalised: NormalisedEntry[];
}

const HASH = /^[0-9a-f]{64}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function list(value: unknown): unknown[] {
	return Array.isArray(value) ? value : [];
}

function paths(value: unknown): string[] {
	return list(value).filter((p): p is string => typeof p === "string");
}

/**
 * The entity keys of a push response's `results`, keeping only well-formed
 * entries: a `bound` entry must name a GM-root note, a real entity id and a
 * sha256; a `normalised` one a published note. Absent keys read as empty.
 */
export function readEntityResults(results: unknown): EntityResults {
	const r = isRecord(results) ? results : {};

	const bound: BoundEntry[] = [];
	for (const entry of list(r.bound)) {
		if (!isRecord(entry)) continue;
		const { path, rc_id, content_hash, replace } = entry;
		if (typeof path !== "string" || !isGmWirePath(path) || !path.endsWith(".md")) continue;
		if (!isRcId(rc_id) || typeof content_hash !== "string" || !HASH.test(content_hash)) continue;
		bound.push({ path, rc_id, content_hash, replace: replace === true });
	}

	const normalised: NormalisedEntry[] = [];
	for (const entry of list(r.normalised)) {
		if (!isRecord(entry)) continue;
		const { path, markdown, content_hash } = entry;
		if (typeof path !== "string" || isGmWirePath(path) || !path.endsWith(".md")) continue;
		if (typeof markdown !== "string") continue;
		if (typeof content_hash !== "string" || !HASH.test(content_hash)) continue;
		normalised.push({ path, markdown, content_hash });
	}

	return {
		bound,
		notesKept: paths(r.entity_notes_kept),
		attachmentsKept: paths(r.entity_attachments_kept),
		duplicateIds: paths(r.duplicate_ids),
		normalised,
	};
}

// ── The stamp's bookkeeping ─────────────────────────────────────────────────

/**
 * The entries a push may act on, with where each one is in this vault: never
 * a path the server rejected, and never one the vault has no file for (a GM
 * note while the GM folder is not pushed, a file deleted since) — those are
 * neither written nor recorded.
 */
export function localTargets<T extends { path: string }>(
	entries: T[],
	sources: ReadonlyMap<string, string>,
	rejected: ReadonlySet<string>,
): { entry: T; localPath: string }[] {
	const out: { entry: T; localPath: string }[] = [];
	for (const entry of entries) {
		const localPath = sources.get(entry.path);
		if (localPath !== undefined && !rejected.has(entry.path)) out.push({ entry, localPath });
	}
	return out;
}

/**
 * The `bound` entries a push stamps: the `localTargets` whose copy here, as
 * this push read it (`pushed` — the plan's `currentHashes`), IS the version
 * RoleCall names as agreed. That holds for every note this push sent. A note
 * it did not send whose copy here is another version (a newer one landed
 * from another device or vault since) is neither stamped nor recorded:
 * recording RoleCall's hash would make its newer copy read as "the vault is
 * ahead", and the next push would put this stale copy over it. The pull
 * brings RoleCall's version down; the next push response lists the note
 * again and it is stamped then.
 */
export function stampTargets(
	bound: BoundEntry[],
	sources: ReadonlyMap<string, string>,
	rejected: ReadonlySet<string>,
	pushed: SyncState,
): { entry: BoundEntry; localPath: string }[] {
	return localTargets(bound, sources, rejected).filter(
		({ entry }) => pushed[entry.path] === entry.content_hash,
	);
}

/**
 * After a successful push: forget the stamp records of every path that push
 * sent (RoleCall now has the stamped file) and of every path it no longer
 * tracks.
 */
export function settleStamped(
	previous: StampedState,
	sent: Iterable<string>,
	next: SyncState,
): StampedState {
	const sentPaths = new Set(sent);
	const out: StampedState = {};
	for (const path of Object.keys(previous)) {
		const record = previous[path];
		if (record !== undefined && !sentPaths.has(path) && path in next) out[path] = record;
	}
	return out;
}

/**
 * Record one `bound` entry for a path the vault has a file for: the agreed
 * hash is RoleCall's (so the next push sends the stamped file as an edit of
 * it), and — when the file was exactly that version before the stamp — a
 * stamp record. `before`/`after` are the file's hashes around the stamp;
 * leave them out when the stamp failed. True when the file was stamped.
 *
 * A file the GM had already changed since the push gets no stamp record: it
 * differs from the agreed version by more than the id, and a pull must see
 * that.
 */
export function recordBound(
	next: SyncState,
	stamped: StampedState,
	entry: BoundEntry,
	before?: string,
	after?: string,
): boolean {
	next[entry.path] = entry.content_hash;
	if (before === undefined || after === undefined || before === after) return false;
	if (before === entry.content_hash) stamped[entry.path] = { from: entry.content_hash, to: after };
	return true;
}

/**
 * Replace the local copy of a `normalised` note only while it is still the
 * file this push sent, and only with bytes that hash to what RoleCall says
 * it stored. Anything else is left for the next pull to offer.
 */
export function shouldReplaceNormalised(
	entry: NormalisedEntry,
	pushedHash: string | undefined,
	localHash: string,
	markdownHash: string,
): boolean {
	return pushedHash !== undefined && localHash === pushedHash && markdownHash === entry.content_hash;
}

// ── What the GM is told ─────────────────────────────────────────────────────

export interface EntityTally {
	tagged: number;
	notesKept: number;
	attachmentsKept: number;
	duplicates: number;
	normalised: number;
}

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/** The notice's sentences about entities, in order; `[]` when there is nothing to say. */
export function describeEntityResults(t: EntityTally): string[] {
	const parts: string[] = [];

	if (t.tagged > 0) {
		parts.push(
			t.tagged === 1
				? "1 note tagged with its RoleCall id"
				: `${t.tagged} notes tagged with their RoleCall id`,
		);
	}

	if (t.notesKept > 0) {
		const images =
			t.attachmentsKept > 0
				? ` and ${plural(t.attachmentsKept, "image", "images")} ${t.notesKept === 1 ? "it shows" : "they show"}`
				: "";
		parts.push(
			t.notesKept === 1
				? `RoleCall kept 1 entity note you deleted${images} — remove the NPC, place, group or quest in RoleCall to delete it`
				: `RoleCall kept ${t.notesKept} entity notes you deleted${images} — remove the NPCs, places, groups or quests in RoleCall to delete them`,
		);
	} else if (t.attachmentsKept > 0) {
		parts.push(
			`RoleCall kept ${plural(t.attachmentsKept, "image", "images")} you deleted — an NPC, place, group or quest note still shows ${t.attachmentsKept === 1 ? "it" : "them"}`,
		);
	}

	if (t.duplicates > 0) {
		parts.push(
			t.duplicates === 1
				? "1 note carries an id another note already uses — kept as a plain note"
				: `${t.duplicates} notes carry an id another note already uses — kept as plain notes`,
		);
	}

	if (t.normalised > 0) {
		parts.push(
			`${plural(t.normalised, "player page", "player pages")} published without your GM properties`,
		);
	}

	return parts;
}
