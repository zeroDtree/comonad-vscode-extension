import type { ApprovalDecision, ApprovalRequest, ToolCall, TurnRef } from './lib/types';

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
		'checkpoints/changed'(): void;
	}
}
