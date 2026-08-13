import { BillingInternalClient } from '@/billing-boundary/billing-internal.client';
import { BillingCoreStateService } from '@/billing-boundary/billing-core-state.service';
import {
	BILLING_LIFECYCLE_REPAIR_EVENT_TYPE,
	BILLING_REFERRAL_REQUESTED_EVENT_TYPE
} from '@/messaging/messaging.constants';
import { PrismaService } from '@/prisma.service';
import { Injectable } from '@nestjs/common';
import { Prisma, Role, UserStatus } from '@prisma/client';
import { randomUUID } from 'node:crypto';

export type BillingLifecycleOperation = 'DEACTIVATE' | 'DELETE';

export interface BillingLifecycleRevocation {
	commandId: string;
	remoteApplied: boolean;
	userId: string;
	operation: BillingLifecycleOperation;
	actorId: string;
	actorRole: Role;
	requestedAt: string;
}

@Injectable()
export class BillingRegistrationBoundaryService {
	constructor(
		private readonly prisma: PrismaService,
		private readonly state: BillingCoreStateService,
		private readonly client: BillingInternalClient
	) {}

	async captureReferralInTransaction(
		transaction: Prisma.TransactionClient,
		input: {
			referrerId: string | undefined;
			referredUserId: string;
			requestedAt?: Date;
		}
	): Promise<void> {
		const referrerId = input.referrerId?.trim();
		if (
			!referrerId ||
			referrerId.length > 255 ||
			referrerId === input.referredUserId
		) {
			return;
		}
		await this.state.assertBillingOwner();
		const requestedAt = input.requestedAt ?? new Date();
		const referrer = await transaction.user.findFirst({
			where: {
				id: referrerId,
				status: UserStatus.ACTIVE,
				deletedAt: null
			},
			select: { id: true }
		});
		if (!referrer) return;

		await this.recordSourceEvent(transaction, {
			eventType: BILLING_REFERRAL_REQUESTED_EVENT_TYPE,
			aggregateType: 'billing.referral-request',
			aggregateId: input.referredUserId,
			state: {
				referrerId,
				referredUserId: input.referredUserId,
				requestedAt: requestedAt.toISOString()
			}
		});
	}

	async ensureTrial(userId: string, registeredAt: Date): Promise<void> {
		await this.state.assertBillingOwner();
		await this.client.ensureTrial({
			commandId: randomUUID(),
			userId,
			registeredAt: registeredAt.toISOString()
		});
	}

	async revokeBeforeLifecycleMutation(input: {
		userId: string;
		operation: BillingLifecycleOperation;
		actorId: string;
		actorRights: Role[];
	}): Promise<BillingLifecycleRevocation> {
		await this.state.assertBillingOwner();
		const commandId = randomUUID();
		const remoteApplied = true;
		const actorRole = input.actorRights.includes(Role.DEV)
			? Role.DEV
			: Role.ADMIN;
		const requestedAt = new Date().toISOString();
		const revocation: BillingLifecycleRevocation = {
			commandId,
			remoteApplied,
			userId: input.userId,
			operation: input.operation,
			actorId: input.actorId,
			actorRole,
			requestedAt
		};
		try {
			await this.client.revokeEntitlements({
				commandId,
				userId: input.userId,
				reason:
					input.operation === 'DELETE'
						? 'USER_SOFT_DELETE'
						: 'USER_DEACTIVATION',
				actorId: input.actorId,
				actorRole,
				occurredAt: requestedAt
			});
		} catch (error) {
			await this.recordLifecycleRepair(revocation);
			throw error;
		}
		return revocation;
	}

	async recordLifecycleRepair(
		revocation: BillingLifecycleRevocation
	): Promise<void> {
		if (!revocation.remoteApplied) return;
		await this.prisma.$transaction(transaction =>
			this.recordSourceEvent(transaction, {
				eventType: BILLING_LIFECYCLE_REPAIR_EVENT_TYPE,
				aggregateType: 'billing.lifecycle-repair',
				aggregateId: revocation.userId,
				state: {
					commandId: revocation.commandId,
					userId: revocation.userId,
					operation: revocation.operation,
					actorId: revocation.actorId,
					actorRole: revocation.actorRole,
					coreMutationApplied: false,
					requestedAt: revocation.requestedAt
				}
			})
		);
	}

	private async recordSourceEvent(
		transaction: Prisma.TransactionClient,
		input: {
			eventType: string;
			aggregateType: string;
			aggregateId: string;
			state: Prisma.InputJsonObject;
		}
	): Promise<void> {
		const stateJson = JSON.stringify(input.state);
		await transaction.$executeRaw(
			Prisma.sql`
				SELECT "billing_record_source_event"(
					${input.eventType},
					${input.eventType},
					${input.aggregateType},
					${input.aggregateId},
					${stateJson}::jsonb,
					FALSE
				)
			`
		);
	}
}
