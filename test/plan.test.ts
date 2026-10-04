// The plugin's privacy rules, pinned without an Obsidian runtime.
//
// Run with `npm test`. Everything under test is in `src/plan.ts`, which is
// kept free of the `obsidian` import for exactly this reason.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AttachmentEntry, NoteEntry } from "../src/api";
import {
	claimsGmRoot,
	foldersOverlap,
	gmWirePath,
	isGmWirePath,
	isInsideFolder,
	isVaultRoot,
	placeLooseMedia,
	planPush,
	type Snapshot,
} from "../src/plan";
import { summarize, withHeldBack } from "../src/util";

const note = (path: string, hash: string): NoteEntry => ({
	path,
	markdown: `body of ${path}`,
	content_hash: hash,
});

const media = (path: string, hash: string): AttachmentEntry => ({
	path,
	content_base64: "AAAA",
	content_hash: hash,
});

const snapshot = (notes: NoteEntry[] = [], attachments: AttachmentEntry[] = []): Snapshot => ({
	notes,
	attachments,
});

describe("wire paths", () => {
	it("a GM-folder file is sent under the server's literal GM/ prefix", () => {
		assert.equal(gmWirePath("NPCs/Bob.md"), "GM/NPCs/Bob.md");
		assert.equal(isGmWirePath("GM/NPCs/Bob.md"), true);
	});

	it("only the exact-case prefix is the GM root", () => {
		assert.equal(isGmWirePath("gm/NPCs/Bob.md"), false);
		assert.equal(isGmWirePath("GMs/Bob.md"), false);
		assert.equal(isGmWirePath("GM.md"), false);
		assert.equal(isGmWirePath("NPCs/GM/Bob.md"), false);
	});
});

describe("a folder named GM inside the published folder", () => {
	it("is spotted in any case, at the top level only", () => {
		assert.equal(claimsGmRoot("GM/Bob.md"), true);
		assert.equal(claimsGmRoot("gm/Bob.md"), true);
		assert.equal(claimsGmRoot("Gm/deep/Bob.md"), true);
	});

	it("leaves everything else alone", () => {
		assert.equal(claimsGmRoot("GM.md"), false);
		assert.equal(claimsGmRoot("GMs/Bob.md"), false);
		assert.equal(claimsGmRoot("NPCs/GM/Bob.md"), false);
		assert.equal(claimsGmRoot("Bob.md"), false);
		assert.equal(claimsGmRoot("/Bob.md"), false);
	});
});

describe("folder settings that must not be walked", () => {
	it("an empty setting is the vault root", () => {
		assert.equal(isVaultRoot(""), true);
		assert.equal(isVaultRoot("/"), true);
		assert.equal(isVaultRoot("Published"), false);
	});

	it("the same folder, or one inside the other, overlaps", () => {
		assert.equal(foldersOverlap("Published", "Published"), true);
		assert.equal(foldersOverlap("Published", "Published/Secrets"), true);
		assert.equal(foldersOverlap("Campaign/GM", "Campaign"), true);
	});

	it("overlap is judged case-insensitively", () => {
		assert.equal(foldersOverlap("Published", "published/Secrets"), true);
		assert.equal(foldersOverlap("campaign", "Campaign"), true);
	});

	it("siblings and name-prefix lookalikes do not overlap", () => {
		assert.equal(foldersOverlap("Published", "GM"), false);
		assert.equal(foldersOverlap("Published", "PublishedDrafts"), false);
		assert.equal(foldersOverlap("Campaign/Published", "Campaign/GM"), false);
	});

	it("the vault root overlaps everything", () => {
		assert.equal(foldersOverlap("/", "GM"), true);
		assert.equal(foldersOverlap("Published", ""), true);
	});
});

describe("media a note embeds from outside the synced folders", () => {
	it("knows what is inside a folder, in any case", () => {
		assert.equal(isInsideFolder("GM/NPCs/face.png", "GM"), true);
		assert.equal(isInsideFolder("gm/NPCs/face.png", "GM"), true);
		assert.equal(isInsideFolder("GMs/face.png", "GM"), false);
		assert.equal(isInsideFolder("face.png", "GM"), false);
		assert.equal(isInsideFolder("Campaign/GM/face.png", "Campaign/GM"), true);
		// An unset folder is the vault root, and everything is inside that.
		assert.equal(isInsideFolder("face.png", ""), true);
	});

	it("goes beside the published notes when a published note embeds it", () => {
		const { placed, skipped } = placeLooseMedia(
			[{ vaultPath: "Pasted image 1.png", embeddedBy: "published" }],
			[],
		);
		assert.deepEqual(placed, [
			{ vaultPath: "Pasted image 1.png", wirePath: "_att/Pasted image 1.png" },
		]);
		assert.deepEqual(skipped, []);
	});

	it("is GM-only when only GM notes embed it", () => {
		const { placed } = placeLooseMedia([{ vaultPath: "Maps/lair.png", embeddedBy: "gm" }], []);
		assert.deepEqual(placed, [{ vaultPath: "Maps/lair.png", wirePath: "GM/_att/lair.png" }]);
	});

	it("is sent once, published, when both a published and a GM note embed it", () => {
		const { placed } = placeLooseMedia(
			[
				{ vaultPath: "shared.png", embeddedBy: "gm" },
				{ vaultPath: "shared.png", embeddedBy: "published" },
				{ vaultPath: "shared.png", embeddedBy: "gm" },
			],
			[],
		);
		assert.deepEqual(placed, [{ vaultPath: "shared.png", wirePath: "_att/shared.png" }]);
	});

	it("never lands on a file the folder walk already produced", () => {
		const { placed, skipped } = placeLooseMedia(
			[{ vaultPath: "map.png", embeddedBy: "published" }],
			["_att/Map.png", "Notes.md"],
		);
		assert.deepEqual(placed, []);
		assert.deepEqual(skipped, ["map.png"]);
	});

	it("keeps the first of two loose files with the same name", () => {
		const { placed, skipped } = placeLooseMedia(
			[
				{ vaultPath: "Zeta/map.png", embeddedBy: "published" },
				{ vaultPath: "Alpha/map.png", embeddedBy: "published" },
			],
			[],
		);
		assert.deepEqual(placed, [{ vaultPath: "Alpha/map.png", wirePath: "_att/map.png" }]);
		assert.deepEqual(skipped, ["Zeta/map.png"]);
	});

	it("lets the same name exist once in each root", () => {
		const { placed, skipped } = placeLooseMedia(
			[
				{ vaultPath: "A/map.png", embeddedBy: "published" },
				{ vaultPath: "B/map.png", embeddedBy: "gm" },
			],
			[],
		);
		assert.deepEqual(
			placed.map((p) => p.wirePath),
			["_att/map.png", "GM/_att/map.png"],
		);
		assert.deepEqual(skipped, []);
	});

	it("a GM-only loose file is removed by the switch-off cleanup like any GM path", () => {
		const plan = planPush({ "A.md": "a1", "GM/_att/lair.png": "l1" }, snapshot([note("A.md", "a1")]), "off");
		assert.deepEqual(plan.deletedPaths, ["GM/_att/lair.png"]);
		assert.deepEqual(plan.roots, ["published", "gm"]);
	});

	it("a loose file no note embeds any more is deleted on the next push", () => {
		const plan = planPush(
			{ "A.md": "a1", "_att/old.png": "o1" },
			snapshot([note("A.md", "a2")]),
			"off",
		);
		assert.deepEqual(plan.deletedPaths, ["_att/old.png"]);
	});
});

describe("planPush with the GM folder off", () => {
	it("names only the published root and sends only what changed", () => {
		const plan = planPush(
			{ "A.md": "a1", "B.md": "b1" },
			snapshot([note("A.md", "a1"), note("B.md", "b2"), note("C.md", "c1")]),
			"off",
		);

		assert.deepEqual(plan.roots, ["published"]);
		assert.deepEqual(
			plan.notes.map((n) => n.path),
			["B.md", "C.md"],
		);
		assert.deepEqual(plan.deletedPaths, []);
		assert.equal(plan.gmRemovals, 0);
		assert.equal(plan.isNoop, false);
	});

	it("deletes what disappeared from the published folder", () => {
		const plan = planPush({ "A.md": "a1", "_att/map.png": "m1" }, snapshot(), "off");
		assert.deepEqual(plan.deletedPaths, ["A.md", "_att/map.png"]);
		assert.deepEqual(plan.roots, ["published"]);
	});

	it("is a no-op when nothing changed", () => {
		const plan = planPush({ "A.md": "a1" }, snapshot([note("A.md", "a1")]), "off");
		assert.equal(plan.isNoop, true);
		assert.deepEqual(plan.currentHashes, { "A.md": "a1" });
	});
});

describe("planPush with the GM folder on", () => {
	it("names both roots and sends GM files beside published ones", () => {
		const plan = planPush(
			{ "A.md": "a1" },
			snapshot([note("A.md", "a1"), note("GM/Heist.md", "h1")], [media("GM/_att/map.png", "m1")]),
			"synced",
		);

		assert.deepEqual(plan.roots, ["published", "gm"]);
		assert.deepEqual(
			plan.notes.map((n) => n.path),
			["GM/Heist.md"],
		);
		assert.deepEqual(
			plan.attachments.map((a) => a.path),
			["GM/_att/map.png"],
		);
		assert.deepEqual(plan.currentHashes, {
			"A.md": "a1",
			"GM/Heist.md": "h1",
			"GM/_att/map.png": "m1",
		});
	});

	it("deletes a GM file the GM deleted, like any other", () => {
		const plan = planPush(
			{ "A.md": "a1", "GM/Heist.md": "h1", "GM/Old.md": "o1" },
			snapshot([note("A.md", "a1"), note("GM/Heist.md", "h1")]),
			"synced",
		);

		assert.deepEqual(plan.deletedPaths, ["GM/Old.md"]);
		assert.deepEqual(plan.roots, ["published", "gm"]);
		// A file deleted while the switch is on is an ordinary delete, not the
		// switch-off cleanup.
		assert.equal(plan.gmRemovals, 0);
	});

	it("still names the GM root when nothing under it changed", () => {
		const plan = planPush(
			{ "A.md": "a1", "GM/Heist.md": "h1" },
			snapshot([note("A.md", "a2"), note("GM/Heist.md", "h1")]),
			"synced",
		);

		assert.deepEqual(plan.roots, ["published", "gm"]);
		assert.deepEqual(
			plan.notes.map((n) => n.path),
			["A.md"],
		);
	});
});

describe("planPush after the GM folder is switched off", () => {
	const last = { "A.md": "a1", "GM/Heist.md": "h1", "GM/_att/map.png": "m1" };

	it("removes every GM path it had synced, in a batch that names the GM root", () => {
		const plan = planPush(last, snapshot([note("A.md", "a1")]), "off");

		assert.deepEqual(plan.deletedPaths, ["GM/Heist.md", "GM/_att/map.png"]);
		// Without `gm` in roots RoleCall ignores GM deletes, and the notes the
		// GM just asked to have removed would stay.
		assert.deepEqual(plan.roots, ["published", "gm"]);
		assert.equal(plan.gmRemovals, 2);
		assert.equal(plan.isNoop, false);
		assert.deepEqual(plan.currentHashes, { "A.md": "a1" });
	});

	it("is published-only again on the push after that", () => {
		const cleanup = planPush(last, snapshot([note("A.md", "a1")]), "off");
		const next = planPush(cleanup.currentHashes, snapshot([note("A.md", "a1")]), "off");

		assert.deepEqual(next.roots, ["published"]);
		assert.equal(next.isNoop, true);
	});
});

describe("planPush when the GM folder is on but cannot be found", () => {
	const last = { "A.md": "a1", "GM/Heist.md": "h1", "GM/_att/map.png": "m1" };

	it("deletes nothing under the GM root — a typo is not a request to remove", () => {
		const plan = planPush(last, snapshot([note("A.md", "a1")]), "missing");

		assert.deepEqual(plan.deletedPaths, []);
		assert.equal(plan.gmRemovals, 0);
		assert.equal(plan.isNoop, true);
	});

	it("carries the GM state forward so a later push can still diff it", () => {
		const plan = planPush(last, snapshot([note("A.md", "a2")]), "missing");

		assert.deepEqual(plan.currentHashes, {
			"A.md": "a2",
			"GM/Heist.md": "h1",
			"GM/_att/map.png": "m1",
		});
		assert.deepEqual(
			plan.notes.map((n) => n.path),
			["A.md"],
		);
	});

	it("says nothing about the GM root", () => {
		const plan = planPush(last, snapshot([note("A.md", "a2")]), "missing");
		assert.deepEqual(plan.roots, ["published"]);
	});

	it("still deletes what disappeared from the published folder", () => {
		const plan = planPush(last, snapshot(), "missing");
		assert.deepEqual(plan.deletedPaths, ["A.md"]);
	});
});

describe("the end-of-push notice", () => {
	it("counts both kinds of entry together", () => {
		const message = summarize(
			{
				results: {
					notes: { created: 2, updated: 1, skipped: 0, deleted: 0 },
					attachments: { created: 1, updated: 0, skipped: 0, deleted: 3 },
				},
			},
			0,
		);
		assert.equal(message, "Synced: 3 added, 1 updated, 3 deleted");
	});

	it("says when the server rejected something", () => {
		assert.equal(summarize(undefined, 2), "Synced — 2 rejected (see console)");
	});

	it("says when published files were held back, even if nothing changed", () => {
		assert.match(withHeldBack("Already up to date", 2), /^Already up to date — 2 not sent: /);
		assert.equal(withHeldBack("Already up to date", 0), "Already up to date");
		assert.match(summarize(undefined, 0, 1), /^Synced — 1 not sent: a folder named GM/);
	});
});
