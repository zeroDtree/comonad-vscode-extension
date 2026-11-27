// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Test seams for @comonad/model: a fake protocol whose per-call behavior a test scripts,
 * and (from the replay suite) recorded-stream transports. Host tests register the fake
 * through the same `registerProtocol` seam real protocols use.
 */
import type {
	BrandDefinition,
	OptionSchema,
	OptionValues,
	ProtocolDefinition,
	ProtocolImpl,
	ProviderInstanceConfig,
	ResolvedProvider,
} from '../config/schema';
import { OPENAI_CHAT_OPTIONS } from '../protocols/openai-chat/wire';
import type {
	FinishReason,
	InvocationContext,
	Message,
	ProviderStreamEvent,
	ToolCall,
	ToolDeclaration,
	UsageRecord,
} from '../types';

export { RecordingTransport, formatSse } from '../replay/record';
export { ReplayTransport } from '../replay/replay-transport';
export type { FixtureEnvelope } from '../replay/replay-transport';

export interface FakeCall {
	model: string;
	messages: Message[];
	tools: ToolDeclaration[];
	options: OptionValues;
	ctx: InvocationContext;
}

export interface FakeOutcome {
	message?: Message;
	toolCalls?: ToolCall[];
	usage?: UsageRecord;
	finish?: FinishReason;
}

export interface FakeProtocolOptions {
	id?: string;
	optionsSchema?: OptionSchema;
	/**
	 * Per-call behavior. The handler owns emission: emit events through `emit` as the call
	 * streams, then return (or throw). Without a handler the call answers "ok" and stops.
	 */
	handler?(call: FakeCall, emit: (event: ProviderStreamEvent) => void): Promise<FakeOutcome>;
	/** Receives the invocation context and the resolved provider, so a test can answer per endpoint. */
	listModels?(ctx: InvocationContext, provider: ResolvedProvider): Promise<string[]>;
}

export interface FakeProtocol {
	definition: ProtocolDefinition;
	/** Every chat the runtime routed here, in order. */
	calls: FakeCall[];
}

export const FAKE_OPTIONS_SCHEMA: OptionSchema = {
	temperature: { type: 'number' },
	topP: { type: 'number' },
	maxTokens: { type: 'number' },
	reasoningEffort: { type: 'string' },
	includeUsage: { type: 'boolean' },
};

/** A protocol definition whose chat behavior a test scripts call by call. */
export function makeFakeProtocol(options: FakeProtocolOptions = {}): FakeProtocol {
	const calls: FakeCall[] = [];
	const definition: ProtocolDefinition = {
		apiVersion: 1,
		id: options.id ?? 'fake-chat',
		defaults: {
			chatPath: '/chat/completions',
			modelsPath: '/models',
			headers: {},
			optionsSchema: options.optionsSchema ?? OPENAI_CHAT_OPTIONS,
		},
		create(_transport: unknown, provider: ResolvedProvider): ProtocolImpl {
			return {
				async chat(request, emit) {
					const call: FakeCall = {
						model: request.model,
						messages: request.messages,
						tools: request.tools,
						options: request.options,
						ctx: request.ctx,
					};
					calls.push(call);
					if (options.handler) {
						const outcome = await options.handler(call, emit);
						return {
							message: outcome.message ?? { role: 'assistant', content: '' },
							toolCalls: outcome.toolCalls ?? [],
							usage: outcome.usage,
							finish: outcome.finish ?? 'stop',
						};
					}
					const message: Message = { role: 'assistant', content: 'ok' };
					emit({ type: 'text', text: 'ok' });
					emit({ type: 'finish', reason: 'stop' });
					return { message, toolCalls: [], finish: 'stop' };
				},
				async listModels(ctx) {
					return options.listModels ? options.listModels(ctx, provider) : ['fake-small', 'fake-large'];
				},
			};
		},
	};
	return { definition, calls };
}

/** A brand riding the fake protocol, with only the fields a test cares about filled in. */
export function makeFakeBrand(overrides: Partial<BrandDefinition> = {}): BrandDefinition {
	return {
		apiVersion: 1,
		id: 'fake',
		protocol: 'fake-chat',
		defaults: { baseURL: 'https://fake.example', headers: {}, options: {} },
		...overrides,
	};
}

/** A provider instance riding the fake brand. */
export function makeFakeInstance(overrides: Partial<ProviderInstanceConfig> = {}): ProviderInstanceConfig {
	return {
		id: 'fake',
		brand: 'fake',
		base: 'https://fake.example',
		model: 'fake-small',
		keyEnv: 'FAKE_KEY',
		...overrides,
	};
}
