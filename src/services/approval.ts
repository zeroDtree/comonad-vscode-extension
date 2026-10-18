// SPDX-License-Identifier: AGPL-3.0-only
import { Service, type Context } from 'cordis';
import type { ApprovalDecision, ApprovalRequest } from '../lib/types';

declare module 'cordis' {
	interface Context {
		approval: Approval;
	}
}

/**
 * Approval arbitration. Surfaces (panel, participant, fallback dialog) register
 * `approval/request` waterfall listeners; each answers for its own surface id and
 * delegates everything else. With no listener the request is denied — safe by default.
 */
export class Approval extends Service {
	constructor(ctx: Context) {
		super(ctx, 'approval');
	}

	request(input: ApprovalRequest): Promise<ApprovalDecision> {
		return Promise.resolve(this.ctx.waterfall('approval/request', input, () => 'deny' as const));
	}
}

export const approvalPlugin = Approval;
