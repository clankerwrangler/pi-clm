import type { LiveContextMessage } from "../../types.ts";
import { signedToolResult } from "./signed-tool-result.ts";

/** Synthetic history: all categories that previously prevented whole-context compaction. */
export function mixedHistory(): LiveContextMessage[] {
	const { assistant, result } = signedToolResult(true);
	return [
		{ role: "user", content: "Keep the task and current findings.", timestamp: 1 },
		{ role: "compactionSummary", summary: "old compaction findings\n".repeat(1000), tokensBefore: 10000, timestamp: 2 },
		{ role: "branchSummary", summary: "old branch findings\n".repeat(1000), fromId: "synthetic", timestamp: 3 },
		{ role: "custom", customType: "synthetic-extension", content: "old custom notes\n".repeat(1000), details: { opaque: true }, display: false, timestamp: 4 },
		{ role: "user", content: [{ type: "text", text: "historical diagram" }, { type: "image", mimeType: "image/png", data: "synthetic-data" }], timestamp: 5 },
		{ ...assistant, content: assistant.content.filter(part => part.type !== "toolCall"), timestamp: 6 },
		{ ...assistant, timestamp: 7 },
		{ ...result, timestamp: 8 },
		{ role: "user", content: "Continue with the findings.", timestamp: 9 },
	];
}
