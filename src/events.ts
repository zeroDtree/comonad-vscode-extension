import type { ApprovalDecision, ApprovalRequest, ToolCall, TurnRef } from './lib/types';
import type { PostToolDecision, PreToolDecision, ToolExecution, ToolOutcome } from './services/tools';

/**
 * Typed Cordis events for the whole application. Every cross-module signal is declared
 * here so surfaces and services can subscribe without importing each other.
 */
declare module 'cordis' {
	interface Events {
		/** A turn was accepted and is about to run. */
		'agent/turn-start'(ref: TurnRef, text: string): void;
		'agent/token'(ref: TurnRef, text: string): void;
		'agent/reasoning'(ref: TurnRef, text: string): void;
		'agent/tool-delta'(ref: TurnRef, call: ToolCall): void;
		'agent/tool-start'(ref: TurnRef, call: ToolCall): void;
		'agent/tool-result'(ref: TurnRef, call: ToolCall, output: string): void;
		'agent/notice'(ref: TurnRef, text: string): void;
		'agent/turn-end'(ref: TurnRef): void;
		/** Waterfall: surfaces answer for their own `surface` id and delegate the rest. */
		'approval/request'(request: ApprovalRequest, next: () => ApprovalDecision | Promise<ApprovalDecision>): ApprovalDecision | Promise<ApprovalDecision>;
		'sessions/changed'(id?: string): void;
		'settings/changed'(): void;
		'tasks/changed'(): void;
		'catalog/changed'(): void;
		'tavern/changed'(): void;
		'tools/changed'(): void;
		/**
		 * The tool policy pipeline, named and shaped as the DeepSeek Harness names and shapes it, so a
		 * hook plugin written for the harness works here: refuse a call, wrap its dispatch, reshape its
		 * result, or watch the settled outcome.
		 */
		'tools/pre-execute'(exec: ToolExecution, next: () => PreToolDecision | Promise<PreToolDecision>): PreToolDecision | Promise<PreToolDecision>;
		'tools/execute'(exec: ToolExecution, next: () => ToolOutcome | Promise<ToolOutcome>): ToolOutcome | Promise<ToolOutcome>;
		'tools/post-execute'(
			exec: ToolExecution,
			result: ToolOutcome,
			next: () => PostToolDecision | Promise<PostToolDecision>,
		): PostToolDecision | Promise<PostToolDecision>;
		/** Observation only: the outcome is settled and frozen by the time this runs. */
		'tools/result'(exec: ToolExecution, result: ToolOutcome): void;
		'checkpoints/changed'(): void;
		/** The plugin list was applied again: what is loaded has changed. */
		'plugins/changed'(): void;
	}
}
