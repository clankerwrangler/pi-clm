import type { AssistantMessage, ToolResultMessage } from "@earendil-works/pi-ai";

/** A normal Responses-shaped complete native pair, including opaque public-SDK fields. */
export function signedToolResult() {
	const assistant: AssistantMessage = {
		role: "assistant", provider: "openai", api: "openai-responses", model: "gpt-5", responseId: "resp_fixture",
		content: [
			{ type: "thinking", thinking: "Inspect the saved output.", thinkingSignature: JSON.stringify({
				id: "rs_fixture", type: "reasoning", summary: [{ type: "summary_text", text: "Inspect the saved output." }], encrypted_content: "opaque-fixture",
			}) },
			{ type: "text", text: "Reading the file.", textSignature: "msg_fixture" },
			{ type: "toolCall", id: "call_fixture|fc_fixture", name: "read", arguments: { path: "/tmp/example.txt" } },
		],
		usage: { input: 100, output: 30, cacheRead: 0, cacheWrite: 0, totalTokens: 130, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: "toolUse", timestamp: 2,
	};
	const result: ToolResultMessage = {
		role: "toolResult", toolCallId: "call_fixture|fc_fixture", toolName: "read",
		content: [{ type: "text", text: "stale complete output\n".repeat(10_000) }],
		isError: false, timestamp: 3, details: { source: "fixture", nested: { kept: true } },
	};
	return { assistant, result };
}
