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

	async assertBillingOwner(): Promise<void> {
		if (!(await this.isBillingOwner())) {
			throw new ServiceUnavailableException(
				'Billing service ownership is unavailable'
			);
		}
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
