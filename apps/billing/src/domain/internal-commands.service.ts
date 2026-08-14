import {
	AutoRenewalConsentEventType,
	AutoRenewalStatus,
	PaymentStatus,
	Prisma,
	ProviderOperationStatus
} from '@prisma/billing-client';
import { ConflictException, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type {
	EnsureTrialCommandDto,
	RevokeEntitlementsCommandDto,
	UpdateBillingSettingsCommandDto
} from '../http/billing.dto';
import {
	BILLING_EVENT_TYPES,
	BILLING_EVENTS_EXCHANGE
} from '../messaging/billing-messaging.constants';
import { BillingPrismaService } from '../prisma/billing-prisma.service';
import {
	assertBillingCommandReceipt,
	billingCommandRequestHash,
	lockBillingCommand
} from './billing-command-idempotency';
import { SubscriptionDomainService } from './subscription-domain.service';
import { TariffAffiliateService } from './tariff-affiliate.service';

@Injectable()
export class InternalCommandsService {
	constructor(
		private readonly prisma: BillingPrismaService,
		private readonly subscriptions: SubscriptionDomainService,
		private readonly tariffAffiliate: TariffAffiliateService
	) {}

	async ensureTrial(dto: EnsureTrialCommandDto) {
		return this.executeCommand(
			dto.commandId,
			'ENSURE_TRIAL',
			{
				schemaVersion: dto.schemaVersion,
				commandId: dto.commandId,
				userId: dto.userId,
				trialDays: dto.trialDays,
				registeredAt: new Date(dto.registeredAt).toISOString()
			},
			async transaction => {
				const subscription =
					await this.subscriptions.ensureTrialInTransaction(
						transaction,
						dto.userId,
						dto.trialDays || 7,
						new Date(dto.registeredAt)
					);
				return {
					ensured: true,
					subscriptionId: subscription.id,
					userId: dto.userId
				};
			}
		);
	}

	async revokeBeforeDeactivate(dto: RevokeEntitlementsCommandDto) {
		return this.executeCommand(
			dto.commandId,
			'REVOKE_BEFORE_DEACTIVATE',
			{
				schemaVersion: dto.schemaVersion,
				commandId: dto.commandId,
				userId: dto.userId,
				reason: dto.reason,
				actorId: dto.actorId,
				actorRole: dto.actorRole,
				occurredAt: new Date(dto.occurredAt).toISOString()
			},
			async transaction => {
				await transaction.$queryRaw`
					SELECT user_id FROM billing.identity_contact_projections
					WHERE user_id = ${dto.userId}
					FOR UPDATE
				`;
				await transaction.$queryRaw`
					SELECT id FROM billing.auto_renewals
					WHERE user_id = ${dto.userId}
					FOR UPDATE
				`;
				await transaction.$queryRaw`
					SELECT id FROM billing.payments
					WHERE user_id = ${dto.userId}
					FOR UPDATE
				`;
				await transaction.$queryRaw`
					SELECT operation.id
					FROM billing.provider_operations AS operation
					JOIN billing.payments AS payment
						ON payment.id = operation.payment_id
					WHERE payment.user_id = ${dto.userId}
					FOR UPDATE OF operation
				`;
				const inFlight = await transaction.providerOperation.findFirst({
					where: {
						payment: { userId: dto.userId },
						status: {
							in: [
								ProviderOperationStatus.PROCESSING,
								ProviderOperationStatus.UNKNOWN
							]
						}
					},
					select: { id: true, status: true }
				});
				if (inFlight) {
					throw new ConflictException(
						'Billing provider operation is in flight; deactivation is fenced'
					);
				}
				const renewal = await transaction.autoRenewal.findUnique({
					where: { userId: dto.userId }
				});
				if (renewal) {
					const updated = await transaction.autoRenewal.update({
						where: { id: renewal.id },
						data: {
							status: AutoRenewalStatus.REVOKED,
							disabledAt: new Date(dto.occurredAt),
							disableReason: dto.reason,
							paymentMethodCiphertext: null,
							paymentMethodType: null,
							paymentMethodTitle: null,
							paymentMethodLast4: null,
							paymentMethodSavedAt: null,
							dispatchPending: false,
							stateVersion: { increment: 1 }
						}
					});
					await transaction.autoRenewalConsentEvent.create({
						data: {
							autoRenewalId: updated.id,
							userId: updated.userId,
							type: AutoRenewalConsentEventType.ADMIN_REVOKED,
							actorUserId: dto.actorId,
							actorRole: dto.actorRole,
							source: 'IDENTITY_LIFECYCLE',
							reason: dto.reason,
							consentVersion: updated.consentVersion,
							consentText: updated.consentText,
							offerSnapshot: updated.offerSnapshot,
							offerSha256: updated.offerSha256,
							offerUpdatedAt: updated.offerUpdatedAt,
							plan: updated.plan,
							billingPeriod: updated.billingPeriod,
							amount: updated.amount,
							currency: updated.currency,
							metadata: { commandId: dto.commandId }
						}
					});
				}
				await transaction.providerOperation.updateMany({
					where: {
						payment: { userId: dto.userId },
						status: ProviderOperationStatus.PENDING
					},
					data: {
						status: ProviderOperationStatus.FAILED,
						lastErrorCode: 'IDENTITY_DEACTIVATION',
						lastErrorSafe: 'Cancelled before identity deactivation'
					}
				});
				const pendingPayments = await transaction.payment.findMany({
					where: { userId: dto.userId, status: PaymentStatus.PENDING }
				});
				for (const payment of pendingPayments) {
					const sequence = await this.nextSequence(transaction);
					const updated = await transaction.payment.update({
						where: { id: payment.id },
						data: {
							status: PaymentStatus.CANCELLED,
							cancelledAt: new Date(dto.occurredAt),
							cancellationReason: 'IDENTITY_DEACTIVATION',
							aggregateVersion: { increment: 1n },
							sourceSequence: sequence
						}
					});
					await this.emitPaymentDetails(transaction, updated);
				}
				const result = {
					revoked: true,
					userId: dto.userId,
					cancelledPayments: pendingPayments.length,
					stateVersion: renewal ? renewal.stateVersion + 1 : null
				};
				return result;
			}
		);
	}

	async getSettings() {
		const item = await this.prisma.billingSettings.upsert({
			where: { id: 'singleton' },
			create: { id: 'singleton' },
			update: {}
		});
		return this.serializeSettings(item);
	}

	async getAdminUserOverview(userId: string) {
		const [subscription, pending, succeeded, cancelled, expired, latest] =
			await this.prisma.$transaction([
				this.prisma.subscription.findUnique({
					where: { userId },
					select: {
						id: true,
						userId: true,
						plan: true,
						billingPeriod: true,
						status: true,
						startsAt: true,
						expiresAt: true,
						leadsThisPeriod: true,
						periodResetsAt: true,
						createdAt: true,
						updatedAt: true
					}
				}),
				this.prisma.payment.count({
					where: { userId, status: PaymentStatus.PENDING }
				}),
				this.prisma.payment.count({
					where: { userId, status: PaymentStatus.SUCCEEDED }
				}),
				this.prisma.payment.count({
					where: { userId, status: PaymentStatus.CANCELLED }
				}),
				this.prisma.payment.count({
					where: { userId, status: PaymentStatus.EXPIRED }
				}),
				this.prisma.payment.findMany({
					where: { userId },
					orderBy: { createdAt: 'desc' },
					take: 5,
					select: {
						id: true,
						yookassaId: true,
						status: true,
						amount: true,
						plan: true,
						billingPeriod: true,
						createdAt: true,
						updatedAt: true
					}
				})
			]);
		return {
			subscription,
			paymentCounts: {
				[PaymentStatus.PENDING]: pending,
				[PaymentStatus.SUCCEEDED]: succeeded,
				[PaymentStatus.CANCELLED]: cancelled,
				[PaymentStatus.EXPIRED]: expired
			},
			latestPayments: latest
		};
	}

	async getSubscriptionUserIds() {
		const [rows, highWater] = await this.prisma.$transaction([
			this.prisma.subscription.findMany({
				orderBy: { userId: 'asc' },
				select: { userId: true }
			}),
			this.prisma.subscription.aggregate({
				_max: { sourceSequence: true }
			})
		]);
		return {
			schemaVersion: 1 as const,
			userIds: rows.map(item => item.userId),
			count: rows.length,
			sourceSequence: (highWater._max.sourceSequence || 0n).toString()
		};
	}

	async updateSettings(dto: UpdateBillingSettingsCommandDto) {
		return this.executeCommand(
			dto.commandId,
			'UPDATE_SETTINGS',
			{
				schemaVersion: dto.schemaVersion,
				commandId: dto.commandId,
				actorId: dto.actorId,
				occurredAt: new Date(dto.occurredAt).toISOString(),
				settings: {
					paymentEnabled: dto.settings.paymentEnabled,
					autoRenewalSignupEnabled: dto.settings.autoRenewalSignupEnabled,
					autoRenewalChargesEnabled:
						dto.settings.autoRenewalChargesEnabled,
					affiliateProgramEnabled: dto.settings.affiliateProgramEnabled,
					affiliateCashbackPercent: dto.settings.affiliateCashbackPercent
				}
			},
			async transaction => {
				const current = await transaction.billingSettings.upsert({
					where: { id: 'singleton' },
					create: { id: 'singleton' },
					update: {}
				});
				const sequence = await this.nextSequence(transaction);
				const patch = dto.settings;
				const updated = await transaction.billingSettings.update({
					where: { id: 'singleton' },
					data: {
						paymentEnabled: patch.paymentEnabled ?? current.paymentEnabled,
						autoRenewalSignupEnabled:
							patch.autoRenewalSignupEnabled ??
							current.autoRenewalSignupEnabled,
						autoRenewalChargesEnabled:
							patch.autoRenewalChargesEnabled ??
							current.autoRenewalChargesEnabled,
						autoRenewalChargesEnabledAt:
							patch.autoRenewalChargesEnabled === true &&
							!current.autoRenewalChargesEnabled
								? new Date()
								: current.autoRenewalChargesEnabledAt,
						affiliateProgramEnabled:
							patch.affiliateProgramEnabled ??
							current.affiliateProgramEnabled,
						affiliateCashbackPercent:
							patch.affiliateCashbackPercent ??
							current.affiliateCashbackPercent,
						aggregateVersion: { increment: 1n },
						sourceSequence: sequence
					}
				});
				await this.tariffAffiliate.emitSettings(transaction, updated);
				return this.serializeSettings(updated);
			}
		);
	}

	private serializeSettings(item: any) {
		return {
			id: 'singleton',
			paymentEnabled: item.paymentEnabled,
			autoRenewalSignupEnabled: item.autoRenewalSignupEnabled,
			autoRenewalChargesEnabled: item.autoRenewalChargesEnabled,
			autoRenewalChargesEnabledAt:
				item.autoRenewalChargesEnabledAt.toISOString(),
			affiliateProgramEnabled: item.affiliateProgramEnabled,
			affiliateCashbackPercent: item.affiliateCashbackPercent,
			updatedAt: item.updatedAt.toISOString()
		};
	}

	private async emitPaymentDetails(
		transaction: Prisma.TransactionClient,
		item: any
	) {
		for (const [eventType, state] of [
			[
				BILLING_EVENT_TYPES.paymentChanged,
				{
					id: item.id,
					userId: item.userId,
					amount: item.amount,
					status: item.status,
					createdAt: item.createdAt.toISOString(),
					updatedAt: item.updatedAt.toISOString()
				}
			],
			[
				BILLING_EVENT_TYPES.paymentDetailsChanged,
				{
					id: item.id,
					userId: item.userId,
					yookassaId: item.yookassaId,
					status: item.status,
					amount: item.amount,
					plan: item.plan,
					billingPeriod: item.billingPeriod,
					createdAt: item.createdAt.toISOString(),
					updatedAt: item.updatedAt.toISOString()
				}
			]
		] as const) {
			const eventId = randomUUID();
			await transaction.outboxEvent.create({
				data: {
					eventId,
					eventType,
					aggregateType: eventType.replace('.changed.v1', ''),
					aggregateId: item.id,
					aggregateVersion: item.aggregateVersion,
					sourceSequence: item.sourceSequence,
					exchange: BILLING_EVENTS_EXCHANGE,
					routingKey: eventType,
					payload: {
						schemaVersion: 1,
						eventType,
						eventId,
						aggregateId: item.id,
						aggregateVersion: item.aggregateVersion.toString(),
						sourceSequence: item.sourceSequence.toString(),
						occurredAt: item.updatedAt.toISOString(),
						tombstone: false,
						state
					}
				}
			});
		}
	}

	private async executeCommand<T extends Record<string, unknown>>(
		commandId: string,
		commandType: string,
		payload: Record<string, unknown>,
		mutate: (transaction: Prisma.TransactionClient) => Promise<T>
	): Promise<T> {
		const requestHash = billingCommandRequestHash(commandType, payload);
		for (let attempt = 1; attempt <= 3; attempt += 1) {
			try {
				return await this.prisma.$transaction(
					async transaction => {
						await lockBillingCommand(transaction, commandId);
						const prior =
							await transaction.billingCommandReceipt.findUnique({
								where: { commandId }
							});
						if (prior) {
							return assertBillingCommandReceipt(
								prior,
								commandType,
								requestHash
							) as unknown as T;
						}
						const result = await mutate(transaction);
						await transaction.billingCommandReceipt.create({
							data: {
								commandId,
								commandType,
								requestHash,
								requestHashVersion: 1,
								result: result as Prisma.InputJsonValue
							}
						});
						return result;
					},
					{
						isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
						maxWait: 5_000,
						timeout: 30_000
					}
				);
			} catch (error) {
				if (attempt === 3 || !this.retryableTransactionError(error)) {
					throw error;
				}
			}
		}
		throw new Error('Billing command retry loop exhausted');
	}

	private retryableTransactionError(error: unknown): boolean {
		return (
			typeof error === 'object' &&
			error !== null &&
			'code' in error &&
			(error as { code?: unknown }).code === 'P2034'
		);
	}

	private async nextSequence(transaction: Prisma.TransactionClient) {
		const state = await transaction.billingSourceSequence.upsert({
			where: { id: 'billing' },
			create: { id: 'billing', nextValue: 2n },
			update: { nextValue: { increment: 1n } }
		});
		return state.nextValue - 1n;
	}
}
