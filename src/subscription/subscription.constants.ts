import { BillingPeriod, Plan } from '@prisma/client';

export const PLAN_PRIORITY: Record<Plan, number> = {
	[Plan.TRIAL]: 0,
	[Plan.EASY]: 1,
	[Plan.HARD]: 2
};

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
