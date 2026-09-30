import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, test } from "node:test";

import { systemGuidance } from "../presentation.ts";

const EXTENSION_DIR = dirname(dirname(fileURLToPath(import.meta.url)));

describe("live-context editing guidance", () => {
	test("defines one write as atomicity while requiring surgical conversational edits", async () => {
		const skill = await readFile(join(EXTENSION_DIR, "skills", "live-context", "SKILL.md"), "utf8");
		assert.match(skill, /atomicity rule, \*\*not\*\* a request\s+for one global summary/);
		assert.match(skill, /Default to a \*\*surgical revision\*\*/);
		assert.match(skill, /Do not keep only user messages/);
		assert.match(skill, /"keep\/preserve these messages" means retain the referenced user \*\*and\*\* assistant/);
		assert.match(skill, /global consolidation only when the user explicitly requests/);
		assert.match(skill, /Prefer a sparse patch over the existing conversation/);
		assert.match(skill, /avoid:\s+user A -> one global summary of everything -> user B/);
	});

	test("keeps the concise always-on guidance aligned with the skill", () => {
		const guidance = systemGuidance("/tmp/LIVE_CONTEXT.md");
		assert.match(guidance, /Default to surgical edits/);
		assert.match(guidance, /complete user\/assistant exchanges/);
		assert.match(guidance, /atomically rename/);
		assert.match(guidance, /both user and assistant messages exactly/);
	});
});
