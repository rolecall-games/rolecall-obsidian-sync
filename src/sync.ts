import { App, Notice, requestUrl, RequestUrlResponse } from "obsidian";
import {
	CLIENT_NAME,
	RejectedPath,
	SYNC_VERSION,
	SyncPayload,
	SyncResponse,
	VAULT_IMPORTS_PATH,
	VersionMismatch,
} from "./api";
import {
	Collected,
	MissingFolderError,
	OverlappingFoldersError,
	VaultCollector,
} from "./collect";
import {
	BoundEntry,
	describeEntityResults,
	EntityResults,
	localTargets,
	NormalisedEntry,
	readEntityResults,
	recordBound,
	settleStamped,
	shouldReplaceNormalised,
	stampTargets,
} from "./entities";
import { planPush, PushPlan, StampedState, SyncState } from "./plan";
import type { RoleCallSyncSettings } from "./settings";
import { stampRcId } from "./stamp";
import { parseJson, sha256Hex, summarize, withHeldBack } from "./util";

/** What a successful push leaves to persist. */
export interface PushOutcome {
	synced: SyncState;
	stamped: StampedState;
}

const hashText = (text: string): Promise<string> => sha256Hex(new TextEncoder().encode(text));

/**
 * One push of a vault's notes to a RoleCall game: the published folder always,
 * the GM folder only when the GM has switched it on, and with each note the
 * images it embeds — wherever in the vault they live, the GM folder excepted.
 *
 * The engine owns the request; `VaultCollector` reads the vault; the plugin
 * owns the persisted state and hands it in; `plan.ts` owns every decision
 * that can be made without a vault. The privacy promises live in two places
 * and each has its own test: which folder a file is sent under and which
 * files are refused (`collect.ts`, by way of `plan.ts`), and what RoleCall
 * does with a `GM/…` path (the server — the plugin's word is never taken for
 * it).
 */
export class SyncEngine {
	constructor(
		private readonly app: App,
		private readonly settings: RoleCallSyncSettings,
		// The manifest's version, threaded in by the plugin — the wire
		// `client_version` must never be a hand-maintained copy (it drifted).
		private readonly clientVersion: string,
	) {}

	/**
	 * Runs one sync. Returns the state to persist, or null when nothing was
	 * written (no-op, or a failure the caller should not record as progress).
	 *
	 * `pulledHashes` is the pull's record of GM notes it brought down while
	 * the GM folder was not being pushed. It is read here only to say which
	 * version a changed note was edited from — see `planPush`. `stamped` is
	 * the record of files the last push wrote an `rc_id` into (`entities.ts`).
	 */
	async push(
		lastSyncedHashes: SyncState,
		pulledHashes: SyncState = {},
		stamped: StampedState = {},
	): Promise<PushOutcome | null> {
		const baseUrl = this.settings.apiBaseUrl.trim().replace(/\/+$/, "");
		const token = this.settings.apiToken.trim();

		if (!baseUrl || !token) {
			new Notice("Add your API token in the plugin settings first");
			return null;
		}

		new Notice(
			this.settings.syncGmFolder
				? "Syncing published and GM notes…"
				: "Syncing published notes…",
		);

		let collected: Collected;
		try {
			collected = await new VaultCollector(this.app, this.settings).collect(
				this.settings.syncGmFolder,
			);
		} catch (err) {
			if (err instanceof MissingFolderError) {
				new Notice(`Published folder not found: ${err.folderPath}`);
				return null;
			}
			if (err instanceof OverlappingFoldersError) {
				new Notice(
					"Your published folder and GM folder overlap, so nothing was sent — point them at two separate folders in the plugin settings",
				);
				return null;
			}
			console.error("RoleCall Sync: failed to read the vault's notes", err);
			new Notice("Couldn't read the notes to sync");
			return null;
		}

		if (collected.gm === "missing") {
			new Notice(
				`GM folder not found: ${collected.gmFolderPath} — syncing published notes only, and leaving the GM notes already on RoleCall as they are`,
			);
		}

		const plan = planPush(lastSyncedHashes, collected.snapshot, collected.gm, pulledHashes);

		if (plan.isNoop) {
			new Notice(withHeldBack("Already up to date", collected.shadowed));
			return null;
		}

		if (plan.gmRemovals > 0) {
			new Notice(
				`GM folder sync is off — removing ${plan.gmRemovals} GM ${plan.gmRemovals === 1 ? "file" : "files"} from RoleCall`,
			);
		}

		const payload: SyncPayload = {
			sync_version: SYNC_VERSION,
			client: CLIENT_NAME,
			client_version: this.clientVersion,
			roots: plan.roots,
			notes: plan.notes,
			attachments: plan.attachments,
			deleted_paths: plan.deletedPaths,
		};

		let response: RequestUrlResponse;
		try {
			response = await requestUrl({
				url: `${baseUrl}${VAULT_IMPORTS_PATH}`,
				method: "POST",
				headers: {
					Authorization: `Bearer ${token}`,
					Accept: "application/json",
					"Content-Type": "application/json",
				},
				body: JSON.stringify(payload),
				throw: false,
			});
		} catch (err) {
			console.error("RoleCall Sync: request failed", err);
			new Notice(`Couldn't reach RoleCall: ${baseUrl}`);
			return null;
		}

		return this.handleResponse(response, plan, collected, stamped);
	}

	private async handleResponse(
		response: RequestUrlResponse,
		plan: PushPlan,
		collected: Collected,
		previouslyStamped: StampedState,
	): Promise<PushOutcome | null> {
		const status = response.status;

		if (status >= 200 && status < 300) {
			const body = parseJson<SyncResponse>(response);
			const rejected: RejectedPath[] = body?.results?.rejected ?? [];
			const rejectedPaths = new Set(rejected.map((r) => r.path));

			// Record everything currently present as synced, except anything the
			// server rejected (so it is retried next push).
			const next: SyncState = {};
			for (const path of Object.keys(plan.currentHashes)) {
				const hash = plan.currentHashes[path];
				if (hash !== undefined && !rejectedPaths.has(path)) next[path] = hash;
			}

			const sent = plan.notes.map((n) => n.path).filter((path) => !rejectedPaths.has(path));
			const stamped = settleStamped(previouslyStamped, sent, next);

			const entity = readEntityResults(body?.results);
			const tagged = await this.stampBound(
				entity.bound,
				collected,
				plan,
				rejectedPaths,
				next,
				stamped,
			);
			await this.applyNormalised(entity.normalised, collected, plan, rejectedPaths, next);
			logEntityResults(entity);

			const sentences = describeEntityResults({
				tagged,
				notesKept: entity.notesKept.length,
				attachmentsKept: entity.attachmentsKept.length,
				duplicates: entity.duplicateIds.length,
				normalised: entity.normalised.length,
			});
			// Longer on screen when it says something about entities: those
			// sentences ask the GM to do something in RoleCall.
			new Notice(
				summarize(body, rejected.length, collected.shadowed, sentences),
				sentences.length > 0 ? 12000 : undefined,
			);
			if (rejected.length > 0) {
				console.warn("RoleCall Sync: server rejected paths", rejected);
			}
			return { synced: next, stamped };
		}

		if (status === 401) {
			new Notice("Invalid or revoked token — check plugin settings");
			return null;
		}
		if (status === 409) {
			// Outside the server's accepted range — in one of two directions,
			// and only one of them is fixed by updating the plugin.
			const serverVersion = parseJson<VersionMismatch>(response)?.sync_version;
			if (typeof serverVersion === "number" && serverVersion < SYNC_VERSION) {
				new Notice(
					"This server doesn't support this plugin version yet — nothing was sent, so try again later",
				);
			} else {
				new Notice("This plugin version is out of date — please update it and sync again");
			}
			return null;
		}
		if (status === 413) {
			new Notice("Too much changed to sync at once — split it into smaller pushes");
			return null;
		}
		if (status === 400) {
			new Notice("The server rejected the request (bad payload)");
			return null;
		}
		new Notice(`Sync failed: HTTP ${status}`);
		return null;
	}
	/**
	 * Write each `bound` entry's id into its local file and record RoleCall's
	 * hash for it. Only a path this vault has a file for, in the version
	 * RoleCall names, is touched or recorded (`stampTargets`) — a GM note
	 * RoleCall names that is not here (the GM folder off, deleted since)
	 * stays out of the push state. The stamp runs on the file's CURRENT
	 * text, so anything typed since the push is kept. Returns how many files
	 * were stamped.
	 */
	private async stampBound(
		bound: BoundEntry[],
		collected: Collected,
		plan: PushPlan,
		rejected: Set<string>,
		next: SyncState,
		stamped: StampedState,
	): Promise<number> {
		let tagged = 0;
		const targets = stampTargets(bound, collected.sources, rejected, plan.currentHashes);

		for (const { entry, localPath } of targets) {
			const file = this.app.vault.getFileByPath(localPath);
			if (!file) continue;

			try {
				const current = await this.app.vault.read(file);
				const preview = stampRcId(current, entry.rc_id, entry.replace);
				if (preview === null || preview === current) {
					// Not stampable (a BOM, an unclosed fence) or it already has an
					// rc_id: no write. RoleCall's binding by note holds regardless.
					const hash = await hashText(current);
					recordBound(next, stamped, entry, hash, hash);
					continue;
				}

				const seen = { before: current, after: current };
				await this.app.vault.process(file, (data) => {
					seen.before = data;
					seen.after = stampRcId(data, entry.rc_id, entry.replace) ?? data;
					return seen.after;
				});

				const before = await hashText(seen.before);
				const after = await hashText(seen.after);
				if (recordBound(next, stamped, entry, before, after)) tagged += 1;
			} catch (err) {
				console.error(`RoleCall Sync: couldn't write the RoleCall id into ${file.path}`, err);
				recordBound(next, stamped, entry);
			}
		}

		return tagged;
	}

	/**
	 * Replace each `normalised` note's local copy with what RoleCall stored —
	 * only while it is still exactly the file this push sent. A copy edited
	 * since keeps the pushed hash, so the next pull offers RoleCall's version
	 * and the next push of the edit parks on RoleCall rather than putting the
	 * GM properties back on a player page.
	 */
	private async applyNormalised(
		normalised: NormalisedEntry[],
		collected: Collected,
		plan: PushPlan,
		rejected: Set<string>,
		next: SyncState,
	): Promise<void> {
		for (const { entry, localPath } of localTargets(normalised, collected.sources, rejected)) {
			const file = this.app.vault.getFileByPath(localPath);
			if (!file) continue;

			try {
				const current = await this.app.vault.read(file);
				const replace = shouldReplaceNormalised(
					entry,
					plan.currentHashes[entry.path],
					await hashText(current),
					await hashText(entry.markdown),
				);
				if (!replace) {
					console.debug(
						`RoleCall Sync: left ${file.path} as it is — it changed since the push; pull to get RoleCall's player page`,
					);
					continue;
				}

				const done = { replaced: false };
				await this.app.vault.process(file, (data) => {
					if (data !== current) return data;
					done.replaced = true;
					return entry.markdown;
				});
				if (done.replaced) next[entry.path] = entry.content_hash;
			} catch (err) {
				console.error(`RoleCall Sync: couldn't update ${file.path}`, err);
			}
		}
	}
}

/** The entity keys, path by path, for the console. */
function logEntityResults(entity: EntityResults): void {
	if (entity.bound.length > 0) {
		console.debug(
			"RoleCall Sync: notes RoleCall bound to an NPC, place, group or quest",
			entity.bound.map((b) => b.path),
		);
	}
	if (entity.notesKept.length > 0 || entity.attachmentsKept.length > 0) {
		console.warn(
			"RoleCall Sync: deletes RoleCall refused — these belong to an NPC, place, group or quest; remove it in RoleCall to delete them",
			[...entity.notesKept, ...entity.attachmentsKept],
		);
	}
	if (entity.duplicateIds.length > 0) {
		console.warn(
			"RoleCall Sync: notes carrying an rc_id another note already uses — kept as plain notes (delete the copy, or its rc_id line)",
			entity.duplicateIds,
		);
	}
	if (entity.normalised.length > 0) {
		console.debug(
			"RoleCall Sync: player pages published without their GM properties",
			entity.normalised.map((n) => n.path),
		);
	}
}
