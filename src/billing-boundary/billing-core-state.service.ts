import { PrismaService } from '@/prisma.service';
import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import {
	BillingCoreOwnership,
	type BillingCoreState
} from '@prisma/client';

@Injectable()
export class BillingCoreStateService {
	constructor(private readonly prisma: PrismaService) {}

	async get(): Promise<BillingCoreState> {
		const state = await this.prisma.billingCoreState.findUnique({
			where: { id: 'singleton' }
		});
		if (!state) {
			throw new ServiceUnavailableException(
				'Billing ownership state is unavailable'
			);
		}
		this.assertValid(state);
		return state;
	}

	async isBillingOwner(): Promise<boolean> {
		return (await this.get()).ownership === BillingCoreOwnership.BILLING;
	}

	async isLegacyWriter(): Promise<boolean> {
		const state = await this.get();
		return (
			state.ownership === BillingCoreOwnership.CORE &&
			state.sourceProducersEnabled
		);
	}

	async isSchedulerEnabled(): Promise<boolean> {
		return (await this.get()).schedulerEnabled;
	}

	async assertSchedulerEnabled(): Promise<void> {
		if (!(await this.isSchedulerEnabled())) {
			throw new ServiceUnavailableException(
				'Legacy Core Billing scheduler is fenced'
			);
		}
	}

	async assertLegacyRouteEnabled(): Promise<void> {
		if (!(await this.get()).legacyRoutesEnabled) {
			throw new ServiceUnavailableException(
				'Legacy Core Billing route is fenced'
			);
		}
	}

	async assertLegacyConsumerEnabled(): Promise<void> {
		if (!(await this.isLegacyConsumerEnabled())) {
			throw new ServiceUnavailableException(
				'Legacy Core Billing consumer is fenced'
			);
		}
	}

	async isLegacyConsumerEnabled(): Promise<boolean> {
		return (await this.get()).legacyConsumerEnabled;
	}

	async assertProjectionConsumerEnabled(): Promise<void> {
		if (!(await this.get()).projectionConsumerEnabled) {
			throw new ServiceUnavailableException(
				'Core Billing projection consumer is fenced'
			);
		}
	}

	private assertValid(state: BillingCoreState): void {
		if (state.ownership !== BillingCoreOwnership.BILLING) return;
		if (
			state.sourceProducersEnabled ||
			state.legacyRoutesEnabled ||
			state.schedulerEnabled ||
			state.legacyConsumerEnabled ||
			!state.projectionConsumerEnabled ||
			state.generation <= 0n ||
			!state.preparedRevision ||
			!state.ownershipRevision ||
			state.ownershipRevision !== state.preparedRevision ||
			!state.activatedAt
		) {
			throw new ServiceUnavailableException(
				'Billing ownership marker is inconsistent'
			);
		}
	}
}
