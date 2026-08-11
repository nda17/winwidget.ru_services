import { AdminEventLogService } from '@/admin-event-log/admin-event-log.service';
import { BillingCoreStateService } from '@/billing-boundary/billing-core-state.service';
import { BillingReadProjectionService } from '@/billing-boundary/billing-read-projection.service';
import { AutoRenewalChargeRequestedEventPayload } from '@/messaging/auto-renewal-charge-event';
import { CampaignAdminAuditEventPayload } from '@/messaging/campaign-admin-audit-event';
import {
	BillingAdminAuditEventPayload,
	BillingProjectionEventPayload
} from '@/messaging/billing-events';
import {
	INTEGRATION_KINDS,
	INTEGRATION_ROUTING_KEYS,
	IntegrationKind,
	MONOLITH_INTEGRATION_KINDS,
	MonolithIntegrationKind
} from '@/messaging/messaging.constants';
import {
	classifyIntegrationError,
	IntegrationErrorClassification
} from '@/messaging/integration-error-classifier';
import {
	createMessagingHeaders,
	getCurrentCorrelationId
} from '@/messaging/messaging-context';
import { assertMessagingEventContract } from '@/messaging/messaging-event-contract';
import { MessagingHeartbeatService } from '@/messaging/messaging-heartbeat.service';
import { NotificationDeliveryOutcomeEventPayload } from '@/messaging/notification-delivery-event';
import { getStableMessageId } from '@/messaging/poison-message-id';
import { ReportingAdminAuditEventPayload } from '@/messaging/reporting-admin-audit-event';
import { WidgetsAdminAuditEventPayload } from '@/messaging/widgets-admin-audit-event';
import {
	DeliveryEventPayload,
	IntegrationDeliveryService
} from '@/messaging/integration-delivery.service';
import { RabbitMqService } from '@/messaging/rabbitmq.service';
import { TelegramDestinationUnavailableEventPayload } from '@/messaging/telegram-destination-unavailable-event';
import { PrismaService } from '@/prisma.service';
import {
	BeforeApplicationShutdown,
	Injectable,
	Logger,
	OnModuleInit
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
	IntegrationDeliveryReceiptStatus,
	IntegrationErrorCategory,
	Prisma
} from '@prisma/client';
import type { ConsumeMessage } from 'amqplib';
import { randomUUID } from 'crypto';

const DELIVERY_RECEIPT_LEASE_MS = 10 * 60 * 1000;
const DELIVERY_RECOVERY_GRACE_MS = 5_000;
const AUTOMATIC_RETRY_WINDOW_MS = 24 * 60 * 60 * 1000;
const SHUTDOWN_DRAIN_TIMEOUT_MS = 20_000;
const BILLING_OWNERSHIP_RECONCILE_INTERVAL_MS = 1_000;
const REDACTED_FAILURE_DETAIL = '[redacted after retention]';

type DeliveryClaim =
	| { state: 'claimed'; lockedAt: Date }
	| { state: 'delivered' }
	| { state: 'closed' }
	| { state: 'dead-lettered' }
	| { state: 'deferred' }
	| { state: 'processing'; lockedAt: Date };

type WorkerEventPayload =
	| TelegramDestinationUnavailableEventPayload
	| NotificationDeliveryOutcomeEventPayload
	| AutoRenewalChargeRequestedEventPayload
	| CampaignAdminAuditEventPayload
	| ReportingAdminAuditEventPayload
	| WidgetsAdminAuditEventPayload
	| BillingAdminAuditEventPayload
	| BillingProjectionEventPayload;

interface DeliveryFailureLockRow {
	resolvedAt: Date | null;
	retryingAt: Date | null;
	activeRetryToken: string | null;
}

@Injectable()
export class IntegrationWorkerService
	implements OnModuleInit, BeforeApplicationShutdown
{
	private readonly logger = new Logger(IntegrationWorkerService.name);
	private readonly receiptCleanupBatchSize = 1000;
	private readonly receiptCleanupMaxBatches = 20;
	private lastReceiptCleanupAt = 0;
	private readonly activeHandlers = new Set<Promise<void>>();
	private shutdownPromise: Promise<void> | null = null;
	private cleanupTimer: NodeJS.Timeout | null = null;
	private billingOwnershipTimer: NodeJS.Timeout | null = null;
	private billingOwnershipReconciliation: Promise<void> | null = null;
	private readonly attachedKinds = new Set<MonolithIntegrationKind>();
	private enabledKinds: MonolithIntegrationKind[] = [];
	private workerPrefetch = 1;

	constructor(
		private readonly rabbitMq: RabbitMqService,
		private readonly delivery: IntegrationDeliveryService,
		private readonly configService: ConfigService,
		private readonly prisma: PrismaService,
		private readonly heartbeat: MessagingHeartbeatService,
		private readonly adminEventLog: AdminEventLogService,
		private readonly billingState: BillingCoreStateService,
		private readonly billingProjection: BillingReadProjectionService
	) {}

	async onModuleInit(): Promise<void> {
		this.workerPrefetch = this.getPrefetch();
		this.enabledKinds = this.getEnabledKinds();
		for (const kind of this.enabledKinds) {
			if (kind !== 'auto-renewal') {
				await this.startConsumers(kind);
			}
		}
		if (this.enabledKinds.includes('auto-renewal')) {
			await this.reconcileBillingOwnedConsumers();
			this.billingOwnershipTimer = setInterval(
				() => void this.scheduleBillingOwnershipReconciliation(),
				BILLING_OWNERSHIP_RECONCILE_INTERVAL_MS
			);
			this.billingOwnershipTimer.unref();
		}
		this.logger.log(
			`Integration consumers started kinds=${[...this.attachedKinds].join(',')} prefetch=${this.workerPrefetch}`
		);
		void this.runCleanup();
		this.cleanupTimer = setInterval(
			() => void this.runCleanup(),
			60 * 60 * 1000
		);
		this.cleanupTimer.unref();
	}

	beforeApplicationShutdown(): Promise<void> {
		if (!this.shutdownPromise) {
			this.shutdownPromise = this.shutdown();
		}
		return this.shutdownPromise;
	}

	private async shutdown(): Promise<void> {
		if (this.cleanupTimer) clearInterval(this.cleanupTimer);
		if (this.billingOwnershipTimer) {
			clearInterval(this.billingOwnershipTimer);
		}
		let consumerCancellationError: unknown = null;
		const drained = await Promise.race([
			(async () => {
				await this.rabbitMq.cancelConsumers().catch(error => {
					consumerCancellationError = error;
				});
				this.attachedKinds.clear();
				while (this.activeHandlers.size) {
					await Promise.allSettled([...this.activeHandlers]);
				}
				return true;
			})(),
			new Promise<false>(resolve =>
				setTimeout(() => resolve(false), SHUTDOWN_DRAIN_TIMEOUT_MS).unref()
			)
		]);
		if (consumerCancellationError) {
			this.logger.error(
				`Failed to cancel integration consumers during shutdown: ${
					consumerCancellationError instanceof Error
						? consumerCancellationError.message
						: String(consumerCancellationError)
				}`
			);
		}
		if (!drained) {
			this.logger.warn(
				JSON.stringify({
					event: 'integration_worker.shutdown_timeout',
					activeHandlers: this.activeHandlers.size,
					timeoutMs: SHUTDOWN_DRAIN_TIMEOUT_MS
				})
			);
			return;
		}
		this.logger.log(
			JSON.stringify({ event: 'integration_worker.shutdown_complete' })
		);
	}

	private async startConsumers(
		kind: MonolithIntegrationKind
	): Promise<void> {
		if (this.attachedKinds.has(kind)) return;
		try {
			await this.rabbitMq.consume(
				kind,
				message =>
					this.trackHandler(
						() => this.handle(kind, message),
						kind,
						message
					),
				this.workerPrefetch
			);
			await this.rabbitMq.consumeDeadLetter(
				kind,
				message =>
					this.trackHandler(
						() => this.collectDeadLetter(kind, message),
						kind,
						message
					),
				this.workerPrefetch
			);
		} catch (error) {
			await this.rabbitMq
				.cancelConsumersForKinds([kind])
				.catch(() => undefined);
			throw error;
		}
		this.attachedKinds.add(kind);
	}

	private scheduleBillingOwnershipReconciliation(): Promise<void> {
		if (!this.billingOwnershipReconciliation) {
			this.billingOwnershipReconciliation =
				this.reconcileBillingOwnedConsumers()
					.catch(error => {
						this.logger.error(
							`Failed to reconcile Billing-owned Core consumers: ${
								error instanceof Error ? error.message : String(error)
							}`
						);
					})
					.finally(() => {
						this.billingOwnershipReconciliation = null;
					});
		}
		return this.billingOwnershipReconciliation;
	}

	private async reconcileBillingOwnedConsumers(): Promise<void> {
		if (!this.enabledKinds.includes('auto-renewal')) return;
		const legacyEnabled = await this.isLegacyBillingConsumerEnabled();
		const attached = this.attachedKinds.has('auto-renewal');
		if (legacyEnabled && !attached) {
			await this.startConsumers('auto-renewal');
			this.logger.log('Legacy Core auto-renewal consumers attached');
			return;
		}
		if (!legacyEnabled && attached) {
			await this.rabbitMq.cancelConsumersForKinds(['auto-renewal']);
			this.attachedKinds.delete('auto-renewal');
			this.logger.log('Legacy Core auto-renewal consumers detached');
		}
	}

	private trackHandler(
		handler: () => Promise<void>,
		kind?: MonolithIntegrationKind,
		message?: ConsumeMessage
	): Promise<void> {
		const promise = handler().then(() => {
			if (!kind || !message) return;
			this.heartbeat.markSuccessfulConsume(kind);
			this.logger.log(
				JSON.stringify({
					event: 'integration_worker.consume_completed',
					kind,
					messageId: message.properties.messageId || null,
					correlationId: getCurrentCorrelationId()
				})
			);
		});
		this.activeHandlers.add(promise);
		void promise.then(
			() => this.activeHandlers.delete(promise),
			() => this.activeHandlers.delete(promise)
		);
		return promise;
	}

	private async handle(
		kind: MonolithIntegrationKind,
		message: ConsumeMessage
	): Promise<void> {
		const eventId = message.properties.messageId;
		if (!this.isUuid(eventId)) {
			await this.deadLetterMalformed(
				kind,
				message,
				'RabbitMQ messageId is missing or invalid'
			);
			return;
		}

		let payload: WorkerEventPayload;
		try {
			payload = this.parsePayload(kind, message);
		} catch (error) {
			await this.deadLetterMalformed(
				kind,
				message,
				error instanceof Error ? error.message : String(error)
			);
			return;
		}
		if (
			await this.relinquishBillingOwnedMessageBeforeClaim(
				kind,
				payload,
				message
			)
		) {
			return;
		}

		let receiptClaim: Date | null = null;
		try {
			const claim = await this.claimDelivery(
				eventId,
				kind,
				this.getRetryAttempt(message),
				this.getStringHeader(message, 'x-delivery-token')
			);
			if (claim.state === 'delivered') {
				await this.resolveFailure(eventId, kind);
				this.rabbitMq.ack(message);
				this.logger.warn(
					`Duplicate integration skipped eventId=${eventId} kind=${kind}`
				);
				return;
			}
			if (
				claim.state === 'closed' ||
				claim.state === 'dead-lettered' ||
				claim.state === 'deferred'
			) {
				this.rabbitMq.ack(message);
				this.logger.warn(
					`Integration delivery skipped by receipt state=${claim.state} eventId=${eventId} kind=${kind}`
				);
				return;
			}
			if (claim.state === 'processing') {
				try {
					await this.scheduleClaimRecovery(
						kind,
						payload,
						eventId,
						claim.lockedAt,
						message
					);
					this.rabbitMq.ack(message);
					this.logger.warn(
						`Integration recovery scheduled for an active claim eventId=${eventId} kind=${kind}`
					);
				} catch (error) {
					this.logger.error(
						`Failed to schedule integration claim recovery eventId=${eventId} kind=${kind}: ${
							error instanceof Error ? error.message : String(error)
						}`
					);
					this.rabbitMq.nack(message, true);
				}
				return;
			}
			receiptClaim = claim.lockedAt;

			if (kind === 'campaign-admin-audit') {
				await this.deliverCampaignAdminAudit(
					payload as CampaignAdminAuditEventPayload,
					eventId,
					receiptClaim
				);
				receiptClaim = null;
				await this.runCleanup();
				this.rabbitMq.ack(message);
				this.logger.log(
					`Campaign admin audit delivered eventId=${eventId}`
				);
				return;
			}
			if (kind === 'reporting-admin-audit') {
				await this.deliverReportingAdminAudit(
					payload as ReportingAdminAuditEventPayload,
					eventId,
					receiptClaim
				);
				receiptClaim = null;
				await this.runCleanup();
				this.rabbitMq.ack(message);
				this.logger.log(
					`Reporting admin audit delivered eventId=${eventId}`
				);
				return;
			}
			if (kind === 'widgets-admin-audit') {
				await this.deliverWidgetsAdminAudit(
					payload as WidgetsAdminAuditEventPayload,
					eventId,
					receiptClaim
				);
				receiptClaim = null;
				await this.runCleanup();
				this.rabbitMq.ack(message);
				this.logger.log(
					`Widgets admin audit delivered eventId=${eventId}`
				);
				return;
			}
			if (kind === 'billing-admin-audit') {
				await this.deliverBillingAdminAudit(
					payload as BillingAdminAuditEventPayload,
					eventId,
					receiptClaim
				);
				receiptClaim = null;
				await this.runCleanup();
				this.rabbitMq.ack(message);
				this.logger.log(
					`Billing admin audit delivered eventId=${eventId}`
				);
				return;
			}
			if (this.isBillingProjectionKind(kind)) {
				await this.billingProjection.apply(
					payload as BillingProjectionEventPayload
				);
				await this.markDeliveryDelivered(eventId, kind, receiptClaim);
				receiptClaim = null;
				await this.runCleanup();
				this.rabbitMq.ack(message);
				this.logger.log(
					`Billing read projection delivered eventId=${eventId} kind=${kind}`
				);
				return;
			}
			if (
				this.isLegacyBillingOwnedMessage(kind, payload) &&
				!(await this.isLegacyBillingConsumerEnabled())
			) {
				await this.releaseDeliveryClaimIfOwned(
					eventId,
					kind,
					receiptClaim
				);
				receiptClaim = null;
				if (kind === 'auto-renewal') {
					this.rabbitMq.nack(message, true);
				} else {
					this.rabbitMq.ack(message);
				}
				return;
			}

			await this.delivery.deliver(kind, payload as DeliveryEventPayload);
			await this.markDeliveryDelivered(eventId, kind, receiptClaim);
			receiptClaim = null;
			await this.runCleanup();
			this.rabbitMq.ack(message);
			this.logger.log(
				`Integration delivered eventId=${eventId} kind=${kind}`
			);
		} catch (error) {
			if (
				this.isLegacyBillingOwnedMessage(kind, payload) &&
				!(await this.isLegacyBillingConsumerEnabled())
			) {
				await this.releaseDeliveryClaimIfOwned(
					eventId,
					kind,
					receiptClaim
				).catch(releaseError => {
					this.logger.error(
						`Failed to release fenced Billing delivery claim eventId=${eventId} kind=${kind}: ${
							releaseError instanceof Error
								? releaseError.message
								: String(releaseError)
						}`
					);
				});
				receiptClaim = null;
				if (kind === 'auto-renewal') {
					this.rabbitMq.nack(message, true);
				} else {
					this.rabbitMq.ack(message);
				}
				return;
			}
			const lastAttempt = this.getRetryAttempt(message);
			const nextAttempt = lastAttempt + 1;
			const firstFailedAt = this.getFirstFailedAt(message);

			try {
				let classification = this.classifyDeliveryError(kind, error);
				const retryDelayMs = this.getRetryDelayMs(
					classification,
					nextAttempt
				);
				const retryBudgetAvailable =
					nextAttempt <= this.getMaxRetryPublications(classification);
				const retryWindowAvailable =
					Date.now() + retryDelayMs <=
					firstFailedAt.getTime() + AUTOMATIC_RETRY_WINDOW_MS;
				if (
					classification.retryable &&
					retryBudgetAvailable &&
					retryWindowAvailable
				) {
					const availableAt = await this.scheduleRetry(
						kind,
						payload,
						nextAttempt,
						eventId,
						receiptClaim,
						classification,
						retryDelayMs,
						firstFailedAt
					);
					receiptClaim = null;
					this.logger.warn(
						`Integration retry scheduled eventId=${eventId} kind=${kind} attempt=${nextAttempt} category=${classification.category} code=${classification.normalizedCode} availableAt=${availableAt.toISOString()}`
					);
				} else {
					if (classification.retryable && !retryWindowAvailable) {
						classification = this.getExpiredRetryClassification();
					} else if (classification.retryable && !retryBudgetAvailable) {
						classification = {
							...classification,
							retryable: false,
							retryDelayMs: null,
							safeReason: `${classification.safeReason}; automatic retry budget exhausted`
						};
					}
					await this.delivery.handleTerminalFailure(
						kind,
						payload as DeliveryEventPayload,
						classification
					);
					await this.rabbitMq.publishDeadLetter(
						kind,
						payload,
						nextAttempt,
						eventId,
						classification.safeReason,
						this.getEventType(payload),
						this.getDeadLetterMetadata(
							error,
							classification,
							firstFailedAt,
							this.getStringHeader(message, 'x-delivery-token')
						)
					);
					await this.markDeliveryDeadLettered(eventId, kind, receiptClaim);
					receiptClaim = null;
					this.logger.error(
						`Integration moved to dead-letter eventId=${eventId} kind=${kind} category=${classification.category} code=${classification.normalizedCode}: ${classification.safeReason}`
					);
				}
				this.rabbitMq.ack(message);
			} catch (failureHandlingError) {
				this.logger.error(
					`Failed to finalize failed delivery eventId=${eventId} kind=${kind}: ${
						failureHandlingError instanceof Error
							? failureHandlingError.message
							: String(failureHandlingError)
					}`
				);
				await this.releaseDeliveryClaimIfOwned(
					eventId,
					kind,
					receiptClaim
				).catch(releaseError => {
					this.logger.error(
						`Failed to release delivery claim after republish error eventId=${eventId} kind=${kind}: ${
							releaseError instanceof Error
								? releaseError.message
								: String(releaseError)
						}`
					);
				});
				this.rabbitMq.nack(message, true);
			}
		}
	}

	private async claimDelivery(
		eventId: string,
		integration: MonolithIntegrationKind,
		retryAttempt: number,
		deliveryToken: string | null
	): Promise<DeliveryClaim> {
		const lockedAt = new Date();
		try {
			await this.prisma.integrationDeliveryReceipt.create({
				data: {
					eventId,
					integration,
					status: IntegrationDeliveryReceiptStatus.PROCESSING,
					lockedAt,
					deliveredAt: null,
					retryAttempt: null,
					retryAvailableAt: null,
					retryToken: null
				}
			});
			return { state: 'claimed', lockedAt };
		} catch (error) {
			if (!this.isUniqueConstraintError(error)) throw error;
		}

		const receipt =
			await this.prisma.integrationDeliveryReceipt.findUnique({
				where: {
					eventId_integration: {
						eventId,
						integration
					}
				},
				select: {
					status: true,
					lockedAt: true,
					retryAttempt: true,
					retryAvailableAt: true,
					retryToken: true
				}
			});
		if (!receipt) {
			throw new Error(
				`Integration delivery receipt disappeared eventId=${eventId} kind=${integration}`
			);
		}
		if (receipt.status === IntegrationDeliveryReceiptStatus.DELIVERED) {
			return { state: 'delivered' };
		}
		if (
			receipt.status === IntegrationDeliveryReceiptStatus.CLOSED_NO_RETRY
		) {
			return { state: 'closed' };
		}
		if (
			receipt.status === IntegrationDeliveryReceiptStatus.DEAD_LETTERED
		) {
			return { state: 'dead-lettered' };
		}
		if (
			receipt.status === IntegrationDeliveryReceiptStatus.RETRY_SCHEDULED
		) {
			if (
				receipt.retryAttempt !== retryAttempt ||
				!deliveryToken ||
				!this.isUuid(deliveryToken) ||
				receipt.retryToken !== deliveryToken ||
				!receipt.retryAvailableAt ||
				receipt.retryAvailableAt > lockedAt
			) {
				return { state: 'deferred' };
			}
			const activated =
				await this.prisma.integrationDeliveryReceipt.updateMany({
					where: {
						eventId,
						integration,
						status: IntegrationDeliveryReceiptStatus.RETRY_SCHEDULED,
						retryAttempt,
						retryAvailableAt: receipt.retryAvailableAt,
						retryToken: deliveryToken
					},
					data: {
						status: IntegrationDeliveryReceiptStatus.PROCESSING,
						lockedAt,
						deliveredAt: null,
						retryAttempt: null,
						retryAvailableAt: null,
						retryToken: null
					}
				});
			return activated.count === 1
				? { state: 'claimed', lockedAt }
				: { state: 'deferred' };
		}
		if (
			receipt.lockedAt.getTime() >
			lockedAt.getTime() - DELIVERY_RECEIPT_LEASE_MS
		) {
			return { state: 'processing', lockedAt: receipt.lockedAt };
		}

		const reclaimed =
			await this.prisma.integrationDeliveryReceipt.updateMany({
				where: {
					eventId,
					integration,
					status: IntegrationDeliveryReceiptStatus.PROCESSING,
					lockedAt: receipt.lockedAt
				},
				data: {
					lockedAt,
					retryAttempt: null,
					retryAvailableAt: null,
					retryToken: null
				}
			});
		return reclaimed.count === 1
			? { state: 'claimed', lockedAt }
			: { state: 'deferred' };
	}

	private async markDeliveryDelivered(
		eventId: string,
		integration: MonolithIntegrationKind,
		lockedAt: Date
	): Promise<void> {
		await this.prisma.$transaction(async transaction => {
			const delivered =
				await transaction.integrationDeliveryReceipt.updateMany({
					where: {
						eventId,
						integration,
						status: IntegrationDeliveryReceiptStatus.PROCESSING,
						lockedAt
					},
					data: {
						status: IntegrationDeliveryReceiptStatus.DELIVERED,
						deliveredAt: new Date(),
						retryAttempt: null,
						retryAvailableAt: null,
						retryToken: null
					}
				});
			if (delivered.count !== 1) {
				throw new Error(
					`Integration delivery claim was lost eventId=${eventId} kind=${integration}`
				);
			}
			await transaction.integrationDeliveryFailure.updateMany({
				where: { eventId, integration, resolvedAt: null },
				data: {
					resolvedAt: new Date(),
					retryingAt: null,
					resolution: 'DELIVERED',
					resolutionComment: null,
					resolvedById: null,
					activeRetryToken: null
				}
			});
		});
	}

	private async deliverCampaignAdminAudit(
		payload: CampaignAdminAuditEventPayload,
		eventId: string,
		lockedAt: Date
	): Promise<void> {
		const descriptions: Record<
			CampaignAdminAuditEventPayload['action'],
			string
		> = {
			CAMPAIGN_CREATE: `Создана кампания ${payload.target.campaignId}`,
			CAMPAIGN_CANCEL: `Запрошена отмена кампании ${payload.target.campaignId}`,
			CAMPAIGN_DELIVERY_RETRY: `Повтор доставки ${payload.target.deliveryId} кампании ${payload.target.campaignId}`
		};

		await this.prisma.$transaction(async transaction => {
			await this.adminEventLog.recordInTransaction(transaction, {
				adminId: payload.actorId,
				section: 'CAMPAIGNS',
				action: payload.action,
				description: descriptions[payload.action],
				entityType:
					payload.action === 'CAMPAIGN_DELIVERY_RETRY'
						? 'campaign-delivery'
						: 'campaign',
				entityId: payload.target.deliveryId || payload.target.campaignId,
				metadata: {
					eventId: payload.eventId,
					correlationId: payload.correlationId,
					campaignId: payload.target.campaignId,
					...(payload.target.deliveryId
						? { deliveryId: payload.target.deliveryId }
						: {}),
					...payload.metadata
				}
			});

			const delivered =
				await transaction.integrationDeliveryReceipt.updateMany({
					where: {
						eventId,
						integration: 'campaign-admin-audit',
						status: IntegrationDeliveryReceiptStatus.PROCESSING,
						lockedAt
					},
					data: {
						status: IntegrationDeliveryReceiptStatus.DELIVERED,
						deliveredAt: new Date(),
						retryAttempt: null,
						retryAvailableAt: null,
						retryToken: null
					}
				});
			if (delivered.count !== 1) {
				throw new Error(
					`Campaign audit receipt claim was lost eventId=${eventId}`
				);
			}
			await transaction.integrationDeliveryFailure.updateMany({
				where: {
					eventId,
					integration: 'campaign-admin-audit',
					resolvedAt: null
				},
				data: {
					resolvedAt: new Date(),
					retryingAt: null,
					resolution: 'DELIVERED',
					resolutionComment: null,
					resolvedById: null,
					activeRetryToken: null
				}
			});
		});
	}

	private async deliverReportingAdminAudit(
		payload: ReportingAdminAuditEventPayload,
		eventId: string,
		lockedAt: Date
	): Promise<void> {
		await this.prisma.$transaction(async transaction => {
			if (payload.action === 'REPORTING_DAILY_SUMMARY_SETTINGS_UPDATE') {
				await this.adminEventLog.recordInTransaction(transaction, {
					adminId: payload.actorId,
					section: 'REPORTING',
					action: payload.action,
					description: 'Обновлены настройки ежедневной сводки Reporting',
					entityType: 'reporting-settings',
					entityId: payload.target.reportingSettingsId,
					entityLabel: 'Ежедневная сводка',
					metadata: {
						changedFields: payload.metadata.changedFields
					}
				});
			} else {
				await this.adminEventLog.recordInTransaction(transaction, {
					adminId: payload.actorId,
					section: 'REPORTING',
					action: payload.action,
					description: 'Запрошен повтор обработки события Reporting',
					entityType: 'reporting-delivery',
					entityId: payload.target.eventId,
					entityLabel: payload.target.consumerKind,
					metadata: {}
				});
			}

			const delivered =
				await transaction.integrationDeliveryReceipt.updateMany({
					where: {
						eventId,
						integration: 'reporting-admin-audit',
						status: IntegrationDeliveryReceiptStatus.PROCESSING,
						lockedAt
					},
					data: {
						status: IntegrationDeliveryReceiptStatus.DELIVERED,
						deliveredAt: new Date(),
						retryAttempt: null,
						retryAvailableAt: null,
						retryToken: null
					}
				});
			if (delivered.count !== 1) {
				throw new Error(
					`Reporting audit receipt claim was lost eventId=${eventId}`
				);
			}
			await transaction.integrationDeliveryFailure.updateMany({
				where: {
					eventId,
					integration: 'reporting-admin-audit',
					resolvedAt: null
				},
				data: {
					resolvedAt: new Date(),
					retryingAt: null,
					resolution: 'DELIVERED',
					resolutionComment: null,
					resolvedById: null,
					activeRetryToken: null
				}
			});
		});
	}

	private async deliverWidgetsAdminAudit(
		payload: WidgetsAdminAuditEventPayload,
		eventId: string,
		lockedAt: Date
	): Promise<void> {
		const descriptions: Record<
			WidgetsAdminAuditEventPayload['action'],
			string
		> = {
			WIDGET_UPDATE: 'Обновлён пользовательский виджет',
			WIDGET_PUBLISH: 'Опубликован пользовательский виджет',
			WIDGET_VERSION_RESTORE:
				'Восстановлена версия пользовательского виджета',
			WIDGET_CLONE: 'Клонирован пользовательский виджет',
			WIDGET_DRAFT_DISCARD:
				'Отброшены изменения черновика пользовательского виджета',
			WIDGET_BUTTON_IMAGE_UPDATE:
				'Обновлено изображение кнопки пользовательского виджета',
			WIDGET_DELETE: 'Удалён пользовательский виджет',
			WIDGET_DELIVERY_RETRY:
				'Запрошен повтор интеграции пользовательского виджета',
			WIDGET_DELIVERY_CLOSE:
				'Закрыта ошибка интеграции пользовательского виджета'
		};

		await this.prisma.$transaction(async transaction => {
			const isDeliveryAction =
				payload.action === 'WIDGET_DELIVERY_RETRY' ||
				payload.action === 'WIDGET_DELIVERY_CLOSE';
			await this.adminEventLog.recordInTransaction(transaction, {
				adminId: payload.actorId,
				section: 'WIDGETS',
				action: payload.action,
				description: descriptions[payload.action],
				entityType: isDeliveryAction
					? 'widget-integration-delivery'
					: 'widget',
				entityId: isDeliveryAction
					? payload.target.failureId
					: payload.target.widgetId,
				entityLabel: payload.target.widgetType,
				targetUserId: payload.target.ownerId,
				metadata: {
					eventId: payload.eventId,
					correlationId: payload.correlationId,
					widgetId: payload.target.widgetId,
					widgetType: payload.target.widgetType,
					...(isDeliveryAction
						? {
								failureId: payload.target.failureId,
								integration: payload.target.integration
							}
						: {}),
					...payload.metadata
				}
			});

			const delivered =
				await transaction.integrationDeliveryReceipt.updateMany({
					where: {
						eventId,
						integration: 'widgets-admin-audit',
						status: IntegrationDeliveryReceiptStatus.PROCESSING,
						lockedAt
					},
					data: {
						status: IntegrationDeliveryReceiptStatus.DELIVERED,
						deliveredAt: new Date(),
						retryAttempt: null,
						retryAvailableAt: null,
						retryToken: null
					}
				});
			if (delivered.count !== 1) {
				throw new Error(
					`Widgets audit receipt claim was lost eventId=${eventId}`
				);
			}
			await transaction.integrationDeliveryFailure.updateMany({
				where: {
					eventId,
					integration: 'widgets-admin-audit',
					resolvedAt: null
				},
				data: {
					resolvedAt: new Date(),
					retryingAt: null,
					resolution: 'DELIVERED',
					resolutionComment: null,
					resolvedById: null,
					activeRetryToken: null
				}
			});
		});
	}

	private async deliverBillingAdminAudit(
		payload: BillingAdminAuditEventPayload,
		eventId: string,
		lockedAt: Date
	): Promise<void> {
		await this.billingState.assertProjectionConsumerEnabled();
		const { requestIp, requestUserAgent, ...auditMetadata } =
			payload.metadata;
		await this.prisma.$transaction(async transaction => {
			await this.adminEventLog.recordInTransaction(transaction, {
				adminId: payload.actorId,
				section: payload.section,
				action: payload.action,
				description: payload.description,
				entityType: payload.entity.type,
				entityId: payload.entity.id,
				entityLabel: payload.entity.label,
				targetUserId: payload.entity.targetUserId,
				ip: typeof requestIp === 'string' ? requestIp : null,
				userAgent:
					typeof requestUserAgent === 'string' ? requestUserAgent : null,
				metadata: {
					eventId: payload.eventId,
					correlationId: payload.correlationId,
					...auditMetadata
				}
			});

			const delivered =
				await transaction.integrationDeliveryReceipt.updateMany({
					where: {
						eventId,
						integration: 'billing-admin-audit',
						status: IntegrationDeliveryReceiptStatus.PROCESSING,
						lockedAt
					},
					data: {
						status: IntegrationDeliveryReceiptStatus.DELIVERED,
						deliveredAt: new Date(),
						retryAttempt: null,
						retryAvailableAt: null,
						retryToken: null
					}
				});
			if (delivered.count !== 1) {
				throw new Error(
					`Billing audit receipt claim was lost eventId=${eventId}`
				);
			}
			await transaction.integrationDeliveryFailure.updateMany({
				where: {
					eventId,
					integration: 'billing-admin-audit',
					resolvedAt: null
				},
				data: {
					resolvedAt: new Date(),
					retryingAt: null,
					resolution: 'DELIVERED',
					resolutionComment: null,
					resolvedById: null,
					activeRetryToken: null
				}
			});
		});
	}

	private async markDeliveryDeadLettered(
		eventId: string,
		integration: MonolithIntegrationKind,
		lockedAt: Date | null
	): Promise<void> {
		if (!lockedAt) {
			throw new Error(
				`Integration delivery claim is missing before DLQ eventId=${eventId} kind=${integration}`
			);
		}
		const marked = await this.prisma.integrationDeliveryReceipt.updateMany(
			{
				where: {
					eventId,
					integration,
					status: IntegrationDeliveryReceiptStatus.PROCESSING,
					lockedAt
				},
				data: {
					status: IntegrationDeliveryReceiptStatus.DEAD_LETTERED,
					deliveredAt: null,
					retryAttempt: null,
					retryAvailableAt: null,
					retryToken: null
				}
			}
		);
		if (marked.count !== 1) {
			const current =
				await this.prisma.integrationDeliveryReceipt.findUnique({
					where: {
						eventId_integration: { eventId, integration }
					},
					select: { status: true }
				});
			if (
				current?.status === IntegrationDeliveryReceiptStatus.DEAD_LETTERED
			) {
				return;
			}
			throw new Error(
				`Integration delivery claim was lost before DLQ eventId=${eventId} kind=${integration}`
			);
		}
	}

	private async releaseDeliveryClaim(
		eventId: string,
		integration: MonolithIntegrationKind,
		lockedAt: Date
	): Promise<void> {
		await this.prisma.integrationDeliveryReceipt.deleteMany({
			where: {
				eventId,
				integration,
				status: IntegrationDeliveryReceiptStatus.PROCESSING,
				lockedAt
			}
		});
	}

	private async releaseDeliveryClaimIfOwned(
		eventId: string,
		integration: MonolithIntegrationKind,
		lockedAt: Date | null
	): Promise<void> {
		if (!lockedAt) return;
		await this.releaseDeliveryClaim(eventId, integration, lockedAt);
	}

	private isUniqueConstraintError(error: unknown): boolean {
		return (
			error instanceof Prisma.PrismaClientKnownRequestError &&
			error.code === 'P2002'
		);
	}

	private async resolveFailure(
		eventId: string,
		integration: MonolithIntegrationKind
	): Promise<void> {
		await this.prisma.$transaction(async transaction => {
			await transaction.integrationDeliveryFailure.updateMany({
				where: {
					eventId,
					integration,
					resolvedAt: null
				},
				data: {
					resolvedAt: new Date(),
					retryingAt: null,
					resolution: 'DELIVERED',
					resolutionComment: null,
					resolvedById: null,
					activeRetryToken: null
				}
			});
		});
	}

	private async scheduleRetry(
		integration: MonolithIntegrationKind,
		payload: WorkerEventPayload,
		attempt: number,
		eventId: string,
		lockedAt: Date | null,
		classification: IntegrationErrorClassification,
		delayMs: number,
		firstFailedAt: Date
	): Promise<Date> {
		if (!lockedAt) {
			throw new Error(
				`Integration delivery claim is missing before retry eventId=${eventId} kind=${integration}`
			);
		}
		const availableAt = new Date(Date.now() + delayMs);
		const retryToken = randomUUID();

		await this.prisma.$transaction(async transaction => {
			const scheduled =
				await transaction.integrationDeliveryReceipt.updateMany({
					where: {
						eventId,
						integration,
						status: IntegrationDeliveryReceiptStatus.PROCESSING,
						lockedAt
					},
					data: {
						status: IntegrationDeliveryReceiptStatus.RETRY_SCHEDULED,
						deliveredAt: null,
						retryAttempt: attempt,
						retryAvailableAt: availableAt,
						retryToken
					}
				});
			if (scheduled.count !== 1) {
				throw new Error(
					`Integration delivery claim was lost before retry eventId=${eventId} kind=${integration}`
				);
			}
			await transaction.integrationDeliveryFailure.updateMany({
				where: {
					eventId,
					integration,
					resolvedAt: null,
					retryingAt: { not: null }
				},
				data: { activeRetryToken: retryToken }
			});
			await transaction.outboxEvent.create({
				data: {
					messageId: eventId,
					deduplicationKey: `integration:${eventId}:${integration}:retry:${attempt}:${retryToken}`,
					eventType: this.getEventType(payload),
					routingKey: INTEGRATION_ROUTING_KEYS[integration],
					payload: payload as unknown as Prisma.InputJsonValue,
					headers: createMessagingHeaders({
						messageId: eventId,
						causationId: eventId,
						headers: {
							'x-retry-attempt': attempt,
							'x-first-failed-at': firstFailedAt.toISOString(),
							'x-delivery-token': retryToken,
							'x-error-category': classification.category,
							'x-error-code': classification.normalizedCode,
							'x-classification-version':
								classification.classificationVersion
						}
					}),
					availableAt
				}
			});
		});
		return availableAt;
	}

	private async scheduleClaimRecovery(
		integration: MonolithIntegrationKind,
		payload: WorkerEventPayload,
		eventId: string,
		lockedAt: Date,
		message: ConsumeMessage
	): Promise<void> {
		const availableAt = new Date(
			Math.max(
				Date.now() + 1000,
				lockedAt.getTime() +
					DELIVERY_RECEIPT_LEASE_MS +
					DELIVERY_RECOVERY_GRACE_MS
			)
		);
		const attempt = this.getRetryAttempt(message);
		const firstFailedAt = this.getFirstFailedAt(message);
		const deliveryToken = this.getStringHeader(
			message,
			'x-delivery-token'
		);
		await this.prisma.$transaction(async transaction => {
			await transaction.outboxEvent.createMany({
				data: [
					{
						messageId: eventId,
						deduplicationKey: `integration:${eventId}:${integration}:claim:${lockedAt.toISOString()}`,
						eventType: this.getEventType(payload),
						routingKey: INTEGRATION_ROUTING_KEYS[integration],
						payload: payload as unknown as Prisma.InputJsonValue,
						headers: createMessagingHeaders({
							messageId: eventId,
							causationId: eventId,
							headers: {
								'x-retry-attempt': attempt,
								'x-first-failed-at': firstFailedAt.toISOString(),
								...(deliveryToken
									? {
											'x-delivery-token': deliveryToken
										}
									: {})
							}
						}),
						availableAt
					}
				],
				skipDuplicates: true
			});
		});
	}

	private classifyDeliveryError(
		kind: MonolithIntegrationKind,
		error: unknown
	): IntegrationErrorClassification {
		return classifyIntegrationError(kind, error);
	}

	private getMaxRetryPublications(
		classification: IntegrationErrorClassification
	): number {
		return classification.recognized ? 3 : 1;
	}

	private getRetryDelayMs(
		classification: IntegrationErrorClassification,
		attempt: number
	): number {
		const base = Math.max(1000, classification.retryDelayMs || 30_000);
		const scaled =
			classification.category === 'RATE_LIMIT'
				? base
				: base * 2 ** Math.max(0, attempt - 1);
		const capped = Math.min(24 * 60 * 60 * 1000, scaled);
		const jitter =
			classification.category === 'RATE_LIMIT'
				? Math.random() * 0.1
				: Math.random() * 0.2 - 0.1;
		return Math.max(1000, Math.round(capped * (1 + jitter)));
	}

	private getFirstFailedAt(message: ConsumeMessage): Date {
		const value = this.getStringHeader(message, 'x-first-failed-at');
		const timestamp = value ? Date.parse(value) : Number.NaN;
		const now = Date.now();
		return Number.isFinite(timestamp) && timestamp <= now + 60_000
			? new Date(timestamp)
			: new Date(now);
	}

	private getExpiredRetryClassification(): IntegrationErrorClassification {
		return {
			category: 'PERMANENT',
			normalizedCode: 'AUTOMATIC_RETRY_WINDOW_EXPIRED',
			retryable: false,
			retryDelayMs: null,
			safeReason: 'Automatic retry window expired',
			recognized: true,
			mayDisableDestination: false,
			classificationVersion: 1
		};
	}

	private getStringHeader(
		message: ConsumeMessage,
		name: string
	): string | null {
		const value = message.properties.headers?.[name];
		if (typeof value === 'string') return value;
		if (Buffer.isBuffer(value)) return value.toString('utf8');
		return null;
	}

	private getNumberHeader(
		message: ConsumeMessage,
		name: string
	): number | null {
		const value = Number(message.properties.headers?.[name]);
		return Number.isInteger(value) ? value : null;
	}

	private getBooleanHeader(
		message: ConsumeMessage,
		name: string
	): boolean | null {
		const value = message.properties.headers?.[name];
		if (typeof value === 'boolean') return value;
		if (value === 'true' || value === 1) return true;
		if (value === 'false' || value === 0) return false;
		return null;
	}

	private getDeadLetterMetadata(
		error: unknown,
		classification: IntegrationErrorClassification,
		firstFailedAt?: Date,
		deliveryToken?: string | null
	) {
		const details =
			error && typeof error === 'object'
				? (error as Record<string, unknown>)
				: null;
		const httpStatus = Number(
			details?.httpStatus || details?.status || details?.responseCode
		);
		const providerCode =
			typeof details?.providerCode === 'string'
				? details.providerCode
				: typeof details?.errorCode === 'string' ||
					  typeof details?.errorCode === 'number'
					? String(details.errorCode)
					: typeof details?.code === 'string'
						? details.code
						: null;
		return {
			category: classification.category,
			normalizedCode: classification.normalizedCode,
			safeReason: classification.safeReason,
			httpStatus:
				Number.isInteger(httpStatus) && httpStatus > 0 ? httpStatus : null,
			providerCode,
			retryable: classification.retryable,
			classificationVersion: classification.classificationVersion,
			firstFailedAt: firstFailedAt?.toISOString(),
			deliveryToken: deliveryToken || undefined
		};
	}

	private async cleanupReceiptsIfDue(): Promise<void> {
		const now = Date.now();
		if (now - this.lastReceiptCleanupAt < 24 * 60 * 60 * 1000) return;
		this.lastReceiptCleanupAt = now;
		const configured = Number(
			this.configService.get<string>(
				'INTEGRATION_RECEIPT_RETENTION_DAYS'
			) || 90
		);
		const retentionDays =
			Number.isInteger(configured) && configured >= 30 ? configured : 90;
		const deliveredBefore = new Date(
			now - retentionDays * 24 * 60 * 60 * 1000
		);
		for (let batch = 0; batch < this.receiptCleanupMaxBatches; batch++) {
			const count = await this.prisma.$executeRaw(
				Prisma.sql`
					WITH expired AS (
						SELECT "id"
						FROM "integration_delivery_receipts"
						WHERE "status" = 'DELIVERED'::"IntegrationDeliveryReceiptStatus"
							AND "delivered_at" < ${deliveredBefore}
						ORDER BY "delivered_at" ASC
						LIMIT ${this.receiptCleanupBatchSize}
					)
					DELETE FROM "integration_delivery_receipts" AS receipt
					USING expired
					WHERE receipt."id" = expired."id"
				`
			);
			if (count < this.receiptCleanupBatchSize) break;
		}

		const configuredFailureRetention = Number(
			this.configService.get<string>(
				'INTEGRATION_FAILURE_DETAIL_RETENTION_DAYS'
			) || 30
		);
		const failureRetentionDays =
			Number.isInteger(configuredFailureRetention) &&
			configuredFailureRetention >= 1
				? configuredFailureRetention
				: 30;
		const resolvedBefore = new Date(
			now - failureRetentionDays * 24 * 60 * 60 * 1000
		);
		let redacted = 0;
		for (let batch = 0; batch < this.receiptCleanupMaxBatches; batch++) {
			const count = await this.prisma.$executeRaw(
				Prisma.sql`
					WITH expired AS (
						SELECT "id"
						FROM "integration_delivery_failures"
						WHERE "resolved_at" IS NOT NULL
							AND "resolved_at" < ${resolvedBefore}
							AND (
								"payload" <> '{}'::jsonb
								OR "last_error" <> ${REDACTED_FAILURE_DETAIL}
								OR (
									"safe_reason" IS NOT NULL
									AND "safe_reason" <> ${REDACTED_FAILURE_DETAIL}
								)
							)
						ORDER BY "resolved_at" ASC
						LIMIT ${this.receiptCleanupBatchSize}
					)
					UPDATE "integration_delivery_failures" AS failure
					SET
						"payload" = '{}'::jsonb,
						"last_error" = ${REDACTED_FAILURE_DETAIL},
						"safe_reason" = CASE
							WHEN failure."safe_reason" IS NULL THEN NULL
							ELSE ${REDACTED_FAILURE_DETAIL}
						END,
						"updated_at" = NOW()
					FROM expired
					WHERE failure."id" = expired."id"
				`
			);
			redacted += count;
			if (count < this.receiptCleanupBatchSize) break;
		}
		if (redacted) {
			this.logger.log(
				`Redacted ${redacted} resolved integration failures older than ${failureRetentionDays} days`
			);
		}
	}

	private async runCleanup(): Promise<void> {
		await this.cleanupReceiptsIfDue().catch(error => {
			this.logger.error(
				`Messaging retention cleanup failed: ${
					error instanceof Error ? error.stack : String(error)
				}`
			);
		});
	}

	private parsePayload(
		kind: MonolithIntegrationKind,
		message: ConsumeMessage
	): WorkerEventPayload {
		const value = JSON.parse(
			message.content.toString('utf8')
		) as WorkerEventPayload;
		assertMessagingEventContract(value, {
			eventType:
				typeof message.properties.type === 'string'
					? message.properties.type
					: '',
			routingKey: message.fields.routingKey,
			messageId:
				typeof message.properties.messageId === 'string'
					? message.properties.messageId
					: '',
			kind
		});
		return value;
	}

	private async deadLetterMalformed(
		kind: MonolithIntegrationKind,
		message: ConsumeMessage,
		error: string
	): Promise<void> {
		const eventId = getStableMessageId(message, kind);
		const payload = {
			malformed: true,
			contentLength: message.content.length
		};
		const classification: IntegrationErrorClassification = {
			category: 'PERMANENT',
			normalizedCode: 'INVALID_EVENT_PAYLOAD',
			retryable: false,
			retryDelayMs: null,
			safeReason: error.slice(0, 1000),
			recognized: true,
			mayDisableDestination: false,
			classificationVersion: 1
		};

		try {
			await this.rabbitMq.publishDeadLetter(
				kind,
				payload,
				this.getRetryAttempt(message),
				eventId,
				error,
				message.properties.type || 'unknown',
				this.getDeadLetterMetadata(null, classification)
			);
			this.rabbitMq.ack(message);
		} catch {
			this.rabbitMq.nack(message, true);
		}
	}

	private getEventType(payload: WorkerEventPayload): string {
		return payload.eventType;
	}

	private async collectDeadLetter(
		kind: MonolithIntegrationKind,
		message: ConsumeMessage
	): Promise<void> {
		const eventId = getStableMessageId(message, kind);
		const rawPayload = message.content.toString('utf8');
		let payload: Prisma.InputJsonValue = {
			malformed: true,
			contentLength: message.content.length
		};
		let parsedPayload: unknown = null;
		try {
			parsedPayload = JSON.parse(rawPayload) as unknown;
		} catch {}
		if (parsedPayload !== null) {
			payload = parsedPayload as Prisma.InputJsonValue;
		}

		const errorHeader = message.properties.headers?.['x-last-error'];
		const lastError =
			typeof errorHeader === 'string'
				? errorHeader
				: Buffer.isBuffer(errorHeader)
					? errorHeader.toString('utf8')
					: 'Integration delivery failed';
		const failedAt = new Date();
		const categoryHeader = this.getStringHeader(
			message,
			'x-error-category'
		);
		const category =
			categoryHeader &&
			Object.values(IntegrationErrorCategory).includes(
				categoryHeader as IntegrationErrorCategory
			)
				? (categoryHeader as IntegrationErrorCategory)
				: null;
		const normalizedCode = this.getStringHeader(message, 'x-error-code');
		const safeReason =
			this.getStringHeader(message, 'x-safe-reason') || lastError;
		const httpStatus = this.getNumberHeader(message, 'x-http-status');
		const providerCode = this.getStringHeader(message, 'x-provider-code');
		const retryable = this.getBooleanHeader(message, 'x-error-retryable');
		const classificationVersion = this.getNumberHeader(
			message,
			'x-classification-version'
		);
		const firstFailedAtHeader = this.getStringHeader(
			message,
			'x-first-failed-at'
		);
		const firstFailedAtTimestamp = firstFailedAtHeader
			? Date.parse(firstFailedAtHeader)
			: Number.NaN;
		const firstFailedAt = Number.isFinite(firstFailedAtTimestamp)
			? new Date(firstFailedAtTimestamp)
			: failedAt;
		const deliveryTokenHeader = this.getStringHeader(
			message,
			'x-delivery-token'
		);
		const deliveryToken =
			deliveryTokenHeader && this.isUuid(deliveryTokenHeader)
				? deliveryTokenHeader
				: null;
		const classificationData = {
			category,
			normalizedCode: normalizedCode?.slice(0, 255) || null,
			safeReason: safeReason.slice(0, 10_000),
			httpStatus,
			providerCode: providerCode?.slice(0, 255) || null,
			retryable,
			classificationVersion,
			firstFailedAt
		};
		const upsert: Prisma.IntegrationDeliveryFailureUpsertArgs = {
			where: {
				eventId_integration: {
					eventId,
					integration: kind
				}
			},
			create: {
				eventId,
				integration: kind,
				routingKey: INTEGRATION_ROUTING_KEYS[kind],
				payload,
				attempts: this.getRetryAttempt(message),
				lastError: lastError.slice(0, 10_000),
				failedAt,
				...classificationData
			},
			update: {
				integration: kind,
				routingKey: INTEGRATION_ROUTING_KEYS[kind],
				payload,
				attempts: this.getRetryAttempt(message),
				lastError: lastError.slice(0, 10_000),
				failedAt,
				activeRetryToken: null,
				retryingAt: null,
				...classificationData
			}
		};

		try {
			const persisted = await this.persistIntegrationDeadLetter(
				eventId,
				kind,
				upsert,
				deliveryToken
			);
			if (!persisted) {
				this.rabbitMq.ack(message);
				this.logger.warn(
					`Skipped stale or resolved dead-letter eventId=${eventId} kind=${kind}`
				);
				return;
			}
			this.rabbitMq.ack(message);
			this.logger.error(
				`Dead-letter persisted eventId=${eventId} kind=${kind}`
			);
		} catch (error) {
			this.logger.error(
				`Failed to persist dead-letter eventId=${eventId} kind=${kind}: ${
					error instanceof Error ? error.message : String(error)
				}`
			);
			this.rabbitMq.nack(message, true);
		}
	}

	private async persistIntegrationDeadLetter(
		eventId: string,
		kind: MonolithIntegrationKind,
		upsert: Prisma.IntegrationDeliveryFailureUpsertArgs,
		deliveryToken: string | null
	): Promise<boolean> {
		return this.prisma.$transaction(async transaction => {
			const failures = await this.lockDeliveryFailure(
				transaction,
				eventId,
				kind
			);
			if (!this.canPersistDeadLetter(failures[0], deliveryToken)) {
				return false;
			}
			if (
				!(await this.ensureDeadLetterReceipt(transaction, eventId, kind))
			) {
				return false;
			}
			await transaction.integrationDeliveryFailure.upsert(upsert);
			return true;
		});
	}

	private lockDeliveryFailure(
		transaction: Prisma.TransactionClient,
		eventId: string,
		integration: MonolithIntegrationKind
	): Promise<DeliveryFailureLockRow[]> {
		return transaction.$queryRaw<DeliveryFailureLockRow[]>(
			Prisma.sql`
				SELECT
					"resolved_at" AS "resolvedAt",
					"retrying_at" AS "retryingAt",
					"active_retry_token" AS "activeRetryToken"
				FROM "integration_delivery_failures"
				WHERE "event_id" = ${eventId}::uuid
					AND "integration" = ${integration}
				FOR UPDATE
			`
		);
	}

	private canPersistDeadLetter(
		failure: DeliveryFailureLockRow | undefined,
		deliveryToken: string | null,
		allowTokenlessRetry = false
	): boolean {
		if (!failure) return true;
		if (failure.resolvedAt) return false;
		if (
			failure.retryingAt &&
			failure.activeRetryToken &&
			failure.activeRetryToken !== deliveryToken &&
			!(allowTokenlessRetry && deliveryToken === null)
		) {
			return false;
		}
		return true;
	}

	private async ensureDeadLetterReceipt(
		transaction: Prisma.TransactionClient,
		eventId: string,
		integration: MonolithIntegrationKind
	): Promise<boolean> {
		const rows = await transaction.$queryRaw<Array<{ id: string }>>(
			Prisma.sql`
				INSERT INTO "integration_delivery_receipts" (
					"id",
					"event_id",
					"integration",
					"status",
					"locked_at",
					"delivered_at",
					"retry_attempt",
					"retry_available_at",
					"retry_token",
					"created_at"
				)
				VALUES (
					${randomUUID()}::uuid,
					${eventId}::uuid,
					${integration},
					'DEAD_LETTERED'::"IntegrationDeliveryReceiptStatus",
					NOW(),
					NULL,
					NULL,
					NULL,
					NULL,
					NOW()
				)
				ON CONFLICT ("event_id", "integration") DO UPDATE
				SET
					"status" = 'DEAD_LETTERED'::"IntegrationDeliveryReceiptStatus",
					"locked_at" = NOW(),
					"delivered_at" = NULL,
					"retry_attempt" = NULL,
					"retry_available_at" = NULL,
					"retry_token" = NULL
				WHERE "integration_delivery_receipts"."status" IN (
					'PROCESSING'::"IntegrationDeliveryReceiptStatus",
					'RETRY_SCHEDULED'::"IntegrationDeliveryReceiptStatus",
					'DEAD_LETTERED'::"IntegrationDeliveryReceiptStatus"
				)
				RETURNING "id"
			`
		);
		return rows.length === 1;
	}

	private getRetryAttempt(message: ConsumeMessage): number {
		const value = Number(message.properties.headers?.['x-retry-attempt']);
		return Number.isInteger(value) && value >= 0 ? value : 0;
	}

	private isUuid(value: unknown): value is string {
		return (
			typeof value === 'string' &&
			/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
				value
			)
		);
	}

	private getPrefetch(): number {
		const value = Number(
			this.configService.get<string>('RABBITMQ_WORKER_PREFETCH') || 10
		);
		return Number.isInteger(value) && value > 0
			? Math.min(value, 100)
			: 10;
	}

	private getEnabledKinds(): MonolithIntegrationKind[] {
		const configured = this.configService
			.get<string>('INTEGRATION_WORKER_KINDS')
			?.split(',')
			.map(value => value.trim())
			.filter(Boolean);

		if (!configured?.length) return [...MONOLITH_INTEGRATION_KINDS];

		const invalid = configured.filter(
			value => !INTEGRATION_KINDS.includes(value as IntegrationKind)
		);
		if (invalid.length) {
			throw new Error(
				`Invalid INTEGRATION_WORKER_KINDS values: ${invalid.join(', ')}`
			);
		}

		const serviceOwned = configured.filter(
			value =>
				!MONOLITH_INTEGRATION_KINDS.includes(
					value as MonolithIntegrationKind
				)
		);
		if (serviceOwned.length) {
			throw new Error(
				`INTEGRATION_WORKER_KINDS cannot include service-owned kinds: ${serviceOwned.join(', ')}`
			);
		}

		return [...new Set(configured as MonolithIntegrationKind[])];
	}

	private isBillingProjectionKind(kind: MonolithIntegrationKind): boolean {
		return (
			kind === 'billing-payment-projection' ||
			kind === 'billing-subscription-projection' ||
			kind === 'billing-affiliate-projection' ||
			kind === 'billing-settings-projection'
		);
	}

	private async isLegacyBillingConsumerEnabled(): Promise<boolean> {
		try {
			return await this.billingState.isLegacyConsumerEnabled();
		} catch (error) {
			this.logger.error(
				`Billing legacy-consumer marker is unavailable; failing closed: ${
					error instanceof Error ? error.message : String(error)
				}`
			);
			return false;
		}
	}

	private isLegacyBillingOwnedMessage(
		kind: MonolithIntegrationKind,
		payload: WorkerEventPayload
	): boolean {
		return (
			kind === 'auto-renewal' ||
			(kind === 'notification-delivery-outcome' &&
				this.isBillingNotificationOutcome(payload))
		);
	}

	private async relinquishBillingOwnedMessageBeforeClaim(
		kind: MonolithIntegrationKind,
		payload: WorkerEventPayload,
		message: ConsumeMessage
	): Promise<boolean> {
		if (!this.isLegacyBillingOwnedMessage(kind, payload)) return false;
		if (await this.isLegacyBillingConsumerEnabled()) return false;
		if (kind === 'auto-renewal') {
			this.rabbitMq.nack(message, true);
			this.logger.warn(
				'Fenced Core auto-renewal delivery was returned without claiming a receipt'
			);
		} else {
			this.rabbitMq.ack(message);
			this.logger.log(
				'Billing-owned notification outcome was acknowledged by Core without claiming a receipt'
			);
		}
		return true;
	}

	private isBillingNotificationOutcome(
		payload: WorkerEventPayload
	): payload is NotificationDeliveryOutcomeEventPayload {
		if (!('reference' in payload) || !('sourceKind' in payload)) {
			return false;
		}
		return (
			payload.reference.type === 'subscription-expiry-reminder' &&
			(payload.sourceKind === 'subscription-expiry-email' ||
				payload.sourceKind === 'subscription-expiry-telegram')
		);
	}
}
