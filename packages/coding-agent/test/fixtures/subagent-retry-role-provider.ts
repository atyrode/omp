import { appendFileSync } from "node:fs";
import {
	createAssistantMessageEventStream,
	type AssistantMessageEventStream,
	type AssistantMessage,
	type TextContent,
	type ToolCall,
} from "@oh-my-pi/pi-ai";
import type { Model, Usage } from "@oh-my-pi/pi-catalog/types";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent/extensibility/extensions";

const usage: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function response(
	model: Model,
	content: Array<TextContent | ToolCall>,
	errorMessage?: string,
): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();
	queueMicrotask(() => {
		const reason = content.some(block => block.type === "toolCall") ? "toolUse" : "stop";
		const partial: AssistantMessage = {
			role: "assistant",
			content,
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage,
			stopReason: errorMessage ? "error" : reason,
			timestamp: Date.now(),
			...(errorMessage ? { errorMessage } : {}),
		};
		stream.push({ type: "start", partial });
		if (errorMessage) {
			stream.push({ type: "error", reason: "error", error: partial });
			return;
		}
		content.forEach((block, contentIndex) => {
			if (block.type === "text") {
				stream.push({ type: "text_start", contentIndex, partial });
				stream.push({ type: "text_delta", contentIndex, delta: block.text, partial });
				stream.push({ type: "text_end", contentIndex, content: block.text, partial });
			} else {
				stream.push({ type: "toolcall_start", contentIndex, partial });
				stream.push({ type: "toolcall_delta", contentIndex, delta: JSON.stringify(block.arguments), partial });
				stream.push({ type: "toolcall_end", contentIndex, toolCall: block, partial });
			}
		});
		stream.push({ type: "done", reason, message: partial });
	});
	return stream;
}

export default function fixture(pi: ExtensionAPI): void {
	const agent = process.env.RETRY_ROLE_AGENT;
	const log = process.env.RETRY_ROLE_LOG;
	if (!agent || !log) throw new Error("Retry role fixture environment missing");
	for (const provider of ["fixture-lead", "fixture-left", "fixture-right", "fixture-default", "fixture-parent"]) {
		pi.registerProvider(provider, {
			baseUrl: "fixture://retry-role",
			apiKey: "fixture-key",
			api: "retry-role-script",
			models: [
				{
					id: "model",
					name: provider,
					reasoning: false,
					input: ["text"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 128000,
					maxTokens: 2048,
				},
			],
			streamSimple(model, context) {
				const child = context.messages.some(
					message => message.role === "user" && JSON.stringify(message.content).includes("CHILD_CASE="),
				);
				if (child) {
					appendFileSync(log, `${model.provider}/${model.id}\n`);
					if (model.provider === "fixture-lead")
						return response(model, [], "503 overloaded_error: fixture overloaded");
					return response(model, [
						{ type: "toolCall", id: "child-yield", name: "yield", arguments: { data: "finished" } },
					]);
				}
				if (!context.messages.some(message => message.role === "toolResult")) {
					return response(model, [
						{
							type: "toolCall",
							id: "child-call",
							name: "task",
							arguments: {
								name: "RetryRoleChild",
								agent,
								task: `CHILD_CASE=${agent}. Submit your result with yield.`,
								isolated: false,
							},
						},
					]);
				}
				return response(model, [{ type: "text", text: "Finished" }]);
			},
		});
	}
}
