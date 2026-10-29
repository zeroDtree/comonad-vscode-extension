// SPDX-License-Identifier: AGPL-3.0-only
import { Service, type Context } from 'cordis';
import type { ApprovalDecision, ApprovalRequest } from '../lib/types';

declare module 'cordis' {
	interface Context {
		approval: Approval;
	}
}

/**
 * Approval arbitration. The approval response policy is applied here: `never` denies before a
 * surface sees the request. Otherwise surfaces (panel, participant, fallback dialog) register
 * `approval/request` waterfall listeners; each answers for its own surface id and delegates
 * everything else. With no listener the request is denied — safe by default.
 */
export class Approval extends Service {
	constructor(ctx: Context) {
		super(ctx, 'approval');
	}

	request(input: ApprovalRequest): Promise<ApprovalDecision> {
		// The approval response policy is the last word on a confirmation: `never` settles it here,
		// without reaching a surface, and an abort keeps its usual meaning.
		if (input.response === 'never' || input.signal.aborted) {
			return Promise.resolve('deny');
		}
		return new Promise<ApprovalDecision>((resolve, reject) => {
			let settled = false;
			const finish = (): boolean => {
				if (settled) {
					return false;
				}
				settled = true;
				input.signal.removeEventListener('abort', cancel);
				return true;
			};
			const cancel = (): void => {
				if (finish()) {
					resolve('deny');
				}
			};
			input.signal.addEventListener('abort', cancel, { once: true });
			let answered: Promise<ApprovalDecision>;
			try {
				// A synchronous throw from a listener is a broken surface, not a denial: it has to reach
				// the caller, and the abort listener registered above has to be released either way.
				answered = Promise.resolve(this.ctx.waterfall('approval/request', input, () => 'deny' as const));
			} catch (error) {
				if (finish()) {
					reject(error);
				}
				return;
			}
			answered.then(
				(answer) => {
					if (finish()) {
						resolve(answer);
					}
				},
				(error) => {
					if (finish()) {
						reject(error);
					}
				},
			);
		});
	}
}

export const approvalPlugin = Approval;
