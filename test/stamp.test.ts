// The rc_id stamp, pinned to the bytes RoleCall expects.
//
// `fixtures/frontmatter/stamp-golden.json` is generated from the SERVER's own
// code (see `fixtures/frontmatter/gen-stamp-golden.exs`): for every case, what
// its port of this function (`RoleCall.Test.Stamp`) writes, and whether its
// inverse (`Entities.Frontmatter.unstamp_candidates/3`) recovers the original.
// The corpus cases are the server's Obsidian fixtures, copied into
// `fixtures/frontmatter/obsidian/`.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cwd } from "node:process";
import { describe, it } from "node:test";
import { isRcId, splitHead, stampRcId } from "../src/stamp";

interface GoldenCase {
	name: string;
	text?: string;
	file?: string;
	id: string;
	replace: boolean;
	expected: string | null;
	server_inverts: boolean | null;
	stampable: boolean;
}

// `npm test` runs from the repo root.
const FIXTURES = join(cwd(), "test", "fixtures", "frontmatter");
const golden = JSON.parse(readFileSync(join(FIXTURES, "stamp-golden.json"), "utf8")) as GoldenCase[];
const textOf = (c: GoldenCase): string =>
	c.file !== undefined ? readFileSync(join(FIXTURES, "obsidian", c.file), "utf8") : (c.text ?? "");

const ID = "npc_01j9xk3f2m8qzr7w4e6t1yabcd";
const OTHER = "npc_01j9xk3f2m8qzr7w4e6t1yzzzz";

describe("stampRcId matches the server's port byte for byte", () => {
	it("covers the whole shared corpus", () => {
		const files = new Set(golden.filter((c) => c.file !== undefined).map((c) => c.file));
		assert.equal(files.size, 20);
		assert.ok(golden.length > 1500);
	});

	it("on every golden case", () => {
		const mismatches: string[] = [];
		for (const c of golden) {
			const actual = stampRcId(textOf(c), c.id, c.replace);
			if (actual !== c.expected) {
				mismatches.push(
					`${c.name} (replace: ${c.replace}): ${JSON.stringify(actual)} ≠ ${JSON.stringify(c.expected)}`,
				);
			}
		}
		assert.deepEqual(mismatches, []);
	});

	it("never stamps what the server calls unstampable", () => {
		for (const c of golden) {
			if (!c.stampable) assert.equal(stampRcId(textOf(c), c.id, c.replace), null, c.name);
		}
	});

	it("every stamp that changes a file is one the server can undo", () => {
		// The server's agree rung only works when it can recover the original
		// from the stamped bytes. Two shapes it cannot (an `rc_id :` key with a
		// space, and a value holding a lone CR) leave the file unchanged; the
		// third (a `---\v` fence) is a server-side gap, not ours.
		const gaps = golden.filter(
			(c) => c.expected !== null && c.expected !== textOf(c) && c.server_inverts !== true,
		);
		assert.deepEqual(
			gaps.map((c) => JSON.stringify(textOf(c))),
			gaps.map(() => JSON.stringify("---\u000b\nrace: Elf\n---\n")),
		);
	});
});

describe("stampRcId, case by case", () => {
	it("prepends a block to a note with no frontmatter", () => {
		assert.equal(stampRcId("# Bob\n", ID, false), `---\nrc_id: ${ID}\n---\n# Bob\n`);
		assert.equal(stampRcId("", ID, false), `---\nrc_id: ${ID}\n---\n`);
	});

	it("keeps CRLF line endings", () => {
		assert.equal(
			stampRcId("plain\r\nCRLF body\r\n", ID, false),
			`---\r\nrc_id: ${ID}\r\n---\r\nplain\r\nCRLF body\r\n`,
		);
		assert.equal(
			stampRcId("---\r\nrace: Elf\r\n---\r\nBody\r\n", ID, false),
			`---\r\nrc_id: ${ID}\r\nrace: Elf\r\n---\r\nBody\r\n`,
		);
	});

	it("inserts right after the opening fence, keeping every other byte", () => {
		assert.equal(
			stampRcId("--- \nrace: Elf\n---\nBody", ID, false),
			`--- \nrc_id: ${ID}\nrace: Elf\n---\nBody`,
		);
		assert.equal(stampRcId("---\n---\n", ID, false), `---\nrc_id: ${ID}\n---\n`);
	});

	it("never stamps a file with a byte-order mark", () => {
		assert.equal(stampRcId("﻿# Bob\n", ID, false), null);
		assert.equal(stampRcId("﻿---\nrace: Elf\n---\n", ID, true), null);
	});

	it("never stamps an unclosed fence", () => {
		assert.equal(stampRcId("---\nno closing fence\n", ID, false), null);
		assert.equal(stampRcId("---", ID, false), null);
	});

	it("leaves an existing rc_id alone unless told to replace it", () => {
		const text = `---\ntype: npc\nrc_id: ${OTHER}\nrace: Elf\n---\nBody\n`;
		assert.equal(stampRcId(text, ID, false), null);
		assert.equal(stampRcId(text, ID, true), `---\ntype: npc\nrc_id: ${ID}\nrace: Elf\n---\nBody\n`);
	});

	it("writes the separating space over an emptied rc_id", () => {
		assert.equal(stampRcId("---\nrc_id:\nrace: Elf\n---\n", ID, true), `---\nrc_id: ${ID}\nrace: Elf\n---\n`);
		assert.equal(stampRcId("---\nrc_id:\nrace: Elf\n---\n", ID, false), null);
	});

	it("replaces a quoted value without its quotes, and only the first rc_id line", () => {
		assert.equal(stampRcId(`---\nrc_id: '${OTHER}'\n---\n`, ID, true), `---\nrc_id: ${ID}\n---\n`);
		assert.equal(
			stampRcId("---\nrc_id: one\nrc_id: two\n---\n", ID, true),
			`---\nrc_id: ${ID}\nrc_id: two\n---\n`,
		);
	});

	it("stamps a note whose rc_id is only in the body, a comment or a nested map", () => {
		assert.equal(
			stampRcId("---\nrace: Elf\n---\nrc_id: npc_x\n", ID, false),
			`---\nrc_id: ${ID}\nrace: Elf\n---\nrc_id: npc_x\n`,
		);
		assert.equal(
			stampRcId("---\n# rc_id: npc_x\n---\n", ID, false),
			`---\nrc_id: ${ID}\n# rc_id: npc_x\n---\n`,
		);
		assert.equal(
			stampRcId("---\nstats:\n  rc_id: npc_x\n---\n", ID, false),
			`---\nrc_id: ${ID}\nstats:\n  rc_id: npc_x\n---\n`,
		);
	});

	it("reads frontmatter the server's way", () => {
		assert.equal(splitHead("---\nrace: Elf\n---\nBody").head, "---\nrace: Elf\n---\n");
		assert.equal(splitHead("----\nrace: Elf\n---\n").head, "");
		assert.equal(splitHead("﻿---\nrace: Elf\n---\n").head, "");
	});
});

describe("entity ids", () => {
	it("accepts a TypeID with a kind prefix", () => {
		assert.equal(isRcId(ID), true);
		assert.equal(isRcId("group_01j9xr2d6h8s3f5a7b9c1eghjk"), true);
	});

	it("refuses anything else", () => {
		assert.equal(isRcId("npc_x"), false);
		assert.equal(isRcId("NPC_01j9xk3f2m8qzr7w4e6t1yabcd"), false);
		assert.equal(isRcId("npc_01j9xk3f2m8qzr7w4e6t1yabcu"), false);
		assert.equal(isRcId(`${ID}\n`), false);
		assert.equal(isRcId(42), false);
	});
});
