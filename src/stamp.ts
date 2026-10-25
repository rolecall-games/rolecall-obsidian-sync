// Writing an entity's RoleCall id into a note's frontmatter, byte for byte.
//
// After a push, RoleCall lists the GM notes it bound to an NPC, group, quest
// or place whose file does not carry the id yet (`results.bound`). The plugin
// writes `rc_id: <id>` into each local file so RoleCall can recognise the
// note across an Obsidian rename + edit.
//
// RoleCall undoes this stamp exactly (`Entities.Frontmatter.unstamp_candidates`)
// to tell "the version we agreed on, plus the id" from a real edit. So this is
// a port of the SERVER's frontmatter rule, not a YAML library: the same fences,
// the same line endings, the same "which line is the key" — and its output is
// pinned against the server's own port (`RoleCall.Test.Stamp`) by the golden
// tests in `test/stamp.test.ts`. Change nothing here without regenerating them.
//
// Pure: no `obsidian` import, so it runs under `npm test`.

/** What an entity id looks like: `npc_` + a 26-character TypeID suffix. */
export const RC_ID_PATTERN = /^[a-z_]+_[0-9a-hjkmnp-tv-z]{26}$/;

export function isRcId(value: unknown): value is string {
	return typeof value === "string" && RC_ID_PATTERN.test(value);
}

// The server's regexes are compiled without the unicode flag and with LF as
// the only newline: `\s` is these six ASCII bytes, `^`/`$` sit only at a
// `\n`. JavaScript's `\s`, `^` and `$` mean more (U+FEFF, U+00A0, a lone
// `\r`), so nothing below leans on them.
const ASCII_SPACE = " \t\n\u000b\f\r";

function isAsciiSpace(ch: string | undefined): boolean {
	return ch !== undefined && ch !== "" && ASCII_SPACE.indexOf(ch) >= 0;
}

// Elixir's `String.trim/1` set — not JavaScript's (`trim()` also strips
// U+FEFF and keeps U+0085).
const ELIXIR_TRIM = new Set(
	[
		0x9, 0xa, 0xb, 0xc, 0xd, 0x20, 0x85, 0xa0, 0x1680, 0x2000, 0x2001, 0x2002, 0x2003, 0x2004,
		0x2005, 0x2006, 0x2007, 0x2008, 0x2009, 0x200a, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000,
	].map((cp) => String.fromCharCode(cp)),
);

function elixirTrim(text: string): string {
	let start = 0;
	let end = text.length;
	while (start < end && ELIXIR_TRIM.has(text.charAt(start))) start += 1;
	while (end > start && ELIXIR_TRIM.has(text.charAt(end - 1))) end -= 1;
	return text.slice(start, end);
}

/**
 * The next match of the server's fence, `~r/^---\s*$/m`, at or after `from`:
 * `---` at a line start, then the longest run of ASCII whitespace (newlines
 * included — a fence can swallow blank lines) that ends at a `\n` or at the
 * end of the text.
 */
function nextFence(text: string, from: number): { start: number; end: number } | null {
	let at = from;
	for (;;) {
		const start = text.indexOf("---", at);
		if (start < 0) return null;

		if (start === 0 || text.charAt(start - 1) === "\n") {
			let run = start + 3;
			while (run < text.length && isAsciiSpace(text.charAt(run))) run += 1;
			for (let end = run; end >= start + 3; end -= 1) {
				if (end === text.length || text.charAt(end) === "\n") return { start, end };
			}
		}
		at = start + 1;
	}
}

export interface Head {
	/** The frontmatter block's exact text; `""` when there is none. */
	head: string;
	/** The block's inner text, as the server parses it. */
	inner: string;
}

/**
 * The server's `Frontmatter.split_head/1`: a `---` line at the very start and
 * a closing `---` line. Anything else — a BOM, `----`, no closing fence — has
 * no frontmatter.
 */
export function splitHead(text: string): Head {
	const none: Head = { head: "", inner: "" };
	if (!text.startsWith("---")) return none;

	const open = nextFence(text, 0);
	if (open === null || open.start !== 0) return none;
	const close = nextFence(text, open.end);
	if (close === null) return none;

	let body = text.slice(close.end);
	if (body.startsWith("\n")) body = body.slice(1);
	return { head: text.slice(0, text.length - body.length), inner: text.slice(open.end, close.start) };
}

const BLOCK_INDICATOR = /^[|>](?:[+-][1-9]?|[1-9][+-]?)?[ \t\n\v\f\r]*$/;
const ITEM = /^[ \t\n\v\f\r]*-[ \t\n\v\f\r]+/;
const KEY = /^[^ \t\n\v\f\r][^:]*:/;
const SUB_KEY = /^[ \t]+[^ \t\n\v\f\r][^:]*:/;

type Open = null | { state: "open" | "list" | "map" | "block"; key: string };

/**
 * Does the head's inner text have a top-level `rc_id` key, by the server's
 * line classifier (`Frontmatter.Reader.classify_lines/1`)? A `# rc_id:`
 * comment, an indented `rc_id:` under a map and an `rc_id:` in the body are
 * not keys; `rc_id:` with no value is.
 */
export function hasRcIdKey(inner: string): boolean {
	const lines = inner.split("\n");
	if (lines[lines.length - 1] === "") lines.pop();

	let open: Open = null;
	for (const line of lines) {
		const content = line.endsWith("\r") ? line.slice(0, -1) : line;

		if (open !== null && open.state === "block") {
			if (elixirTrim(content) === "" || /^[ \t]/.test(content)) continue;
			open = null;
		}

		if (open !== null && (open.state === "open" || open.state === "list") && ITEM.test(content)) {
			open = { state: "list", key: open.key };
		} else if (open !== null && open.state === "map" && ITEM.test(content)) {
			open = null;
		} else if (
			open !== null &&
			(open.state === "open" || open.state === "map") &&
			SUB_KEY.test(content)
		) {
			open = { state: "map", key: open.key };
		} else if (content.startsWith("#")) {
			// a comment: never a key, and it leaves the open value open
		} else if (KEY.test(content)) {
			const colon = content.indexOf(":");
			const key = elixirTrim(content.slice(0, colon));
			const value = elixirTrim(content.slice(colon + 1));
			if (key === "rc_id") return true;

			if (value === "") open = { state: "open", key };
			else if (BLOCK_INDICATOR.test(value)) open = { state: "block", key };
			else open = null;
		}
	}
	return false;
}

/** A line's own ending: `\r\n` when it ends so, else `\n`. */
function eolOf(line: string): string {
	return line.endsWith("\r\n") ? "\r\n" : "\n";
}

/** The file's first line ending, `\n` for a file with none. */
function firstEol(text: string): string {
	const nl = text.indexOf("\n");
	if (nl < 0) return "\n";
	return nl > 0 && text.charAt(nl - 1) === "\r" ? "\r\n" : "\n";
}

/**
 * Replace the value of the head's FIRST line that starts `rc_id:` — the
 * server's `~r/^(rc_id:[ \t]*)[^\r\n]*?(?=[ \t]*\r?$)/m`, first match only.
 * An emptied `rc_id:` gains the separating space. No such line (`rc_id :`)
 * leaves the head as it is.
 */
function replaceRcIdValue(head: string, id: string): string {
	let lineStart = 0;
	while (lineStart <= head.length) {
		if (head.startsWith("rc_id:", lineStart)) {
			let leadEnd = lineStart + "rc_id:".length;
			while (head.charAt(leadEnd) === " " || head.charAt(leadEnd) === "\t") leadEnd += 1;

			// The shortest value after which only blanks, an optional `\r`,
			// then a `\n` or the end remain.
			for (let valueEnd = leadEnd; valueEnd <= head.length; valueEnd += 1) {
				let k = valueEnd;
				while (head.charAt(k) === " " || head.charAt(k) === "\t") k += 1;
				const tailOk =
					k === head.length ||
					head.charAt(k) === "\n" ||
					(head.charAt(k) === "\r" && (k + 1 === head.length || head.charAt(k + 1) === "\n"));
				if (tailOk) {
					const lead = head.slice(lineStart, leadEnd);
					const written = lead === "rc_id:" ? "rc_id: " : lead;
					return head.slice(0, lineStart) + written + id + head.slice(valueEnd);
				}
				const ch = head.charAt(valueEnd);
				if (ch === "\r" || ch === "\n" || valueEnd === head.length) break;
			}
		}

		const nl = head.indexOf("\n", lineStart);
		if (nl < 0) break;
		lineStart = nl + 1;
	}
	return head;
}

/**
 * `text` with `rc_id: <id>` written into its frontmatter, every other byte
 * kept — or `null` when it must not be stamped:
 *
 * - a UTF-8 BOM, or a first line `---` with no closing fence → `null` (no
 *   frontmatter by the server's rule, and nowhere safe to prepend one);
 * - frontmatter with an `rc_id:` key → `null`, whatever its value; with
 *   `replace` (RoleCall says the key is there but wrong or emptied), the
 *   value of its first `rc_id:` line is replaced instead;
 * - frontmatter without one → the line inserted right after the opening
 *   fence, ending as that fence line ends;
 * - no frontmatter → a `---` / `rc_id:` / `---` block prepended, each line
 *   ending as the file's first line does (`\n` for an empty file).
 */
export function stampRcId(text: string, id: string, replace: boolean): string | null {
	if (text.charCodeAt(0) === 0xfeff) return null;

	const { head, inner } = splitHead(text);

	if (head !== "" && hasRcIdKey(inner)) {
		return replace ? replaceRcIdValue(head, id) + text.slice(head.length) : null;
	}

	if (head !== "") {
		const nl = text.indexOf("\n");
		const open = text.slice(0, nl + 1);
		return open + "rc_id: " + id + eolOf(open) + text.slice(nl + 1);
	}

	if (/^---[ \t]*\r?(\n|$)/.test(text)) return null;

	const e = firstEol(text);
	return "---" + e + "rc_id: " + id + e + "---" + e + text;
}
