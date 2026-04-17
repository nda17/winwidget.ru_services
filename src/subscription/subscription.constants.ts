import { BillingPeriod, Plan } from '@prisma/client';

export const PLAN_LIMITS = {
	[Plan.TRIAL]: {
		maxWidgets: 1,
		maxLeadsPerPeriod: 10,
		unlimited: false
	},
	[Plan.EASY]: {
		maxWidgets: 1,
		maxLeadsPerPeriod: 100,
		unlimited: false
	},
	[Plan.HARD]: {
		maxWidgets: 10,
		maxLeadsPerPeriod: Infinity,
		unlimited: true
	}
} as const;

export const PLAN_PRICES: Record<Plan, Record<BillingPeriod, number>> = {
	[Plan.TRIAL]: {
		[BillingPeriod.MONTHLY]: 0,
		[BillingPeriod.YEARLY]: 0
	},
	[Plan.EASY]: {
		[BillingPeriod.MONTHLY]: 990,
		[BillingPeriod.YEARLY]: 4680 // 390 * 12
	},
	[Plan.HARD]: {
		[BillingPeriod.MONTHLY]: 1690,
		[BillingPeriod.YEARLY]: 9480 // 790 * 12
	}
};
