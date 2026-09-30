import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
	createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager,
} from "@earendil-works/pi-coding-agent";

import { toolExposureFromEnv } from "../../index.ts";
import liveContextExtension from "../index.ts";

const helpers = ["live_context_annotate", "live_context_recall"];

test("helper exposure defaults to direct and rejects invalid load-time configuration", () => {
	assert.equal(toolExposureFromEnv({}), "direct");
	assert.equal(toolExposureFromEnv({ PI_CLM_TOOL_EXPOSURE: " codemode " }), "codemode");
	assert.equal(toolExposureFromEnv({ PI_CLM_TOOL_EXPOSURE: "direct" }), "direct");
	assert.throws(() => toolExposureFromEnv({ PI_CLM_TOOL_EXPOSURE: "automatic" }), /PI_CLM_TOOL_EXPOSURE must be direct or codemode/);
});

for (const exposure of [undefined, "codemode"] as const) {
	test(`stock Pi SDK: ${exposure ?? "default direct"} helpers remain callable with correct declarations`, async (t) => {
		const directory = await mkdtemp(join(tmpdir(), "clm-exposure-"));
		t.after(() => rm(directory, { recursive: true, force: true }));
		const settingsManager = SettingsManager.inMemory();
		const resourceLoader = new DefaultResourceLoader({
			cwd: directory, agentDir: directory, settingsManager,
			noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
			extensionFactories: [(pi) => liveContextExtension(pi, { editingMode: "clm", toolExposure: exposure })],
		});
		await resourceLoader.reload();
		assert.deepEqual(resourceLoader.getExtensions().errors, []);
		const modelRuntime = await ModelRuntime.create({
			authPath: join(directory, "auth.json"), modelsPath: null,
			modelsStorePath: join(directory, "models-cache.json"), refreshOnCreate: false, allowModelNetwork: false,
		});
		const { session } = await createAgentSession({
			cwd: directory, agentDir: directory, modelRuntime, resourceLoader,
			sessionManager: SessionManager.inMemory(directory), settingsManager,
		});
		try {
			await session.bindExtensions({ mode: "print" });
			for (const name of helpers) {
				assert.equal(session.getActiveToolNames().includes(name), exposure !== "codemode");
				assert.ok(session.getCallableToolNames().includes(name));
			}
			if (exposure === "codemode") session.setActiveToolsByName([]);
			session.agent.state.messages = [...session.agent.state.messages, {
				role: "assistant", content: [{ type: "toolCall", id: "public-sdk-test", name: "test_code", arguments: {} }],
				api: "openai-responses", provider: "test", model: "test", stopReason: "toolUse", timestamp: 1,
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
			}];
			const ctx = session.extensionRunner.createToolContext("public-sdk-test", undefined);
			for (const name of helpers) assert.ok(ctx.tools.some((tool) => tool.name === name));
			const listed = await ctx.executeTool("live_context_annotate", { action: "list" });
			assert.notEqual(listed.isError, true, JSON.stringify(listed));
			assert.match(JSON.stringify(listed.result.content), /annotations/i);
			const source = session.sessionManager.appendMessage({ role: "user", content: "Exact source for public SDK recall.", timestamp: 2 });
			const created = await ctx.executeTool("live_context_annotate", {
				action: "create", source, title: "SDK source", reason: "test source retention",
				futureAction: "recall the source", retention: "archive",
			});
			assert.equal(created.isError, false, JSON.stringify(created));
			const recalled = await ctx.executeTool("live_context_recall", { id: created.result.details.annotation.id });
			assert.equal(recalled.isError, false, JSON.stringify(recalled));
			assert.match(JSON.stringify(recalled.result.content), /Exact source for public SDK recall/);
		} finally {
			await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
			session.dispose();
		}
	});
}
