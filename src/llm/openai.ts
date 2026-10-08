import type { Context } from 'cordis';
import { listEndpointModels, openAiChat, type Completion } from '../lib/openai';
import type { AdapterRequest, LlmAdapter } from '../services/llm';
import { profileKeyEnvs } from '../services/settings';

/** OpenAI-compatible adapter (also serves Ollama, LM Studio and other compatible endpoints). */

export const openaiAdapter: LlmAdapter = {
	name: 'openai',
	chat(request: AdapterRequest): Promise<Completion> {
		return openAiChat({
			base: request.profile.base ?? '',
			key: request.key ?? '',
			keyEnv: profileKeyEnvs(request.profile)[0],
			model: request.model,
			messages: request.messages,
			tools: request.tools,
			// A preset's samplers win over the profile's: a preset is the more specific choice.
			temperature: request.temperature ?? request.profile.temperature,
			topP: request.topP ?? request.profile.topP,
			maxTokens: request.maxTokens ?? request.profile.maxTokens,
			reasoningEffort: request.reasoningEffort,
			thinkingOff: request.profile.thinkingOff,
			includeUsage: request.profile.includeUsage ?? true,
			signal: request.signal,
			onToken: request.sink.onToken,
			onReasoning: request.sink.onReasoning,
			onToolDelta: request.sink.onToolDelta,
		});
	},
	// The model menu is whatever the endpoint reports, so a new model needs no release.
	listModels: (request) => listEndpointModels({ base: request.profile.base ?? '', key: request.key, signal: request.signal }),
};

export function openaiPlugin(ctx: Context): void {
	ctx.llm.use(openaiAdapter);
}
openaiPlugin.inject = ['llm'];
