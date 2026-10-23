// SPDX-License-Identifier: AGPL-3.0-only
import type { ApprovalDecision, ApprovalRequest, AttachmentPart, ImagePart, ToolCall, TurnRef } from './lib/types';
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
		'agent/tool-result'(ref: TurnRef, call: ToolCall, output: string, images?: ImagePart[]): void;
		/** The turn's resolved references and prompt attachments, before the first model step. */
		'agent/attachments'(ref: TurnRef, attachments: AttachmentPart[]): void;
		'agent/notice'(ref: TurnRef, text: string): void;
		'agent/turn-end'(ref: TurnRef): void;
		/** A subagent created its own conversation; the parent card links to it. */
		'agent/subagent-start'(ref: TurnRef, info: { callId?: string; id: string; name: string; description?: string }): void;
		/** A subagent session gained a step, finished, or failed: an open child view repaints. */
		'subagent/changed'(id: string): void;
		/** Waterfall: surfaces answer for their own `surface` id and delegate the rest. */
		'approval/request'(request: ApprovalRequest, next: () => ApprovalDecision | Promise<ApprovalDecision>): ApprovalDecision | Promise<ApprovalDecision>;
		'sessions/changed'(id?: string): void;
		'settings/changed'(): void;
		/** A provider key was stored or cleared: model lists and no-key markers may have changed. */
		'llm/keys-changed'(): void;
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
