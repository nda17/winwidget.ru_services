import { AutoRenewalChargeRequestedEventPayload } from '@/messaging/auto-renewal-charge-event';
import { CampaignAdminAuditEventPayload } from '@/messaging/campaign-admin-audit-event';
import { IntegrationErrorClassification } from '@/messaging/integration-error-classifier';
import { MonolithIntegrationKind } from '@/messaging/messaging.constants';
import { NotificationDeliveryOutcomeEventPayload } from '@/messaging/notification-delivery-event';
import { ReportingAdminAuditEventPayload } from '@/messaging/reporting-admin-audit-event';
import { WidgetsAdminAuditEventPayload } from '@/messaging/widgets-admin-audit-event';
import { TelegramDestinationUnavailableEventPayload } from '@/messaging/telegram-destination-unavailable-event';
import { PaymentService } from '@/payment/payment.service';
import { PrismaService } from '@/prisma.service';
import { Injectable } from '@nestjs/common';
import { SubscriptionExpiryReminderStatus } from '@prisma/client';

type DeliveryEventPayload =
	| TelegramDestinationUnavailableEventPayload
	| NotificationDeliveryOutcomeEventPayload
	| AutoRenewalChargeRequestedEventPayload
	| CampaignAdminAuditEventPayload
	| ReportingAdminAuditEventPayload
	| WidgetsAdminAuditEventPayload;

@Injectable()
export class IntegrationDeliveryService {
	constructor(
		private readonly prisma: PrismaService,
		private readonly paymentService: PaymentService
	) {}

	async deliver(
		kind: MonolithIntegrationKind,
		event: DeliveryEventPayload
	): Promise<void> {
		if (kind === 'auto-renewal') {
			await this.paymentService.executeRecurringCharge(
				(event as AutoRenewalChargeRequestedEventPayload).paymentId
			);
			return;
		}
		if (kind === 'telegram-destination-unavailable') {
			await this.applyTelegramDestinationUnavailable(
				event as TelegramDestinationUnavailableEventPayload
			);
			return;
		}
		if (kind === 'notification-delivery-outcome') {
			await this.applyNotificationDeliveryOutcome(
				event as NotificationDeliveryOutcomeEventPayload
			);
			return;
		}
		throw new Error(
			`Core integration delivery is unsupported for kind=${kind}`
		);
	}

	async handleTerminalFailure(
		kind: MonolithIntegrationKind,
		event: DeliveryEventPayload,
		classification: IntegrationErrorClassification
	): Promise<void> {
		if (kind !== 'auto-renewal') return;
		const payload = event as AutoRenewalChargeRequestedEventPayload;
		await this.paymentService.handleRecurringDeliveryTerminalFailure(
			payload.paymentId,
			classification.normalizedCode,
			classification.safeReason
		);
	}

	private async applyTelegramDestinationUnavailable(
		event: TelegramDestinationUnavailableEventPayload
	): Promise<void> {
		const occurredAt = new Date(event.occurredAt);
		await this.prisma.telegramNotificationChannel.updateMany({
			where: {
				chatId: event.destination.telegramChatId,
				isActive: true,
				updatedAt: { lte: occurredAt }
			},
			data: {
				isActive: false,
				disabledAt: occurredAt
			}
		});
	}

	private async applyNotificationDeliveryOutcome(
		event: NotificationDeliveryOutcomeEventPayload
	): Promise<void> {
		await this.applySubscriptionExpiryDeliveryOutcome(event);
	}

	private async applySubscriptionExpiryDeliveryOutcome(
		event: NotificationDeliveryOutcomeEventPayload
	): Promise<void> {
		if (
			event.reference.type !== 'subscription-expiry-reminder' ||
			(event.sourceKind !== 'subscription-expiry-email' &&
				event.sourceKind !== 'subscription-expiry-telegram')
		) {
			throw new Error('Invalid subscription expiry delivery outcome');
		}
		if (event.status === 'FAILED') {
			await this.prisma.subscriptionExpiryReminder.updateMany({
				where: {
					id: event.reference.id,
					status: SubscriptionExpiryReminderStatus.PROCESSING
				},
				data: {
					status: SubscriptionExpiryReminderStatus.FAILED,
					lockedAt: null,
					lockedBy: null,
					lastError: this.getOutcomeError(event)
				}
			});
			return;
		}
		await this.prisma.subscriptionExpiryReminder.updateMany({
			where: {
				id: event.reference.id,
				status: {
					in: [
						SubscriptionExpiryReminderStatus.PROCESSING,
						SubscriptionExpiryReminderStatus.FAILED
					]
				}
			},
			data: {
				status: SubscriptionExpiryReminderStatus.SENT,
				sentAt: new Date(event.occurredAt),
				lockedAt: null,
				lockedBy: null,
				lastError: null
			}
		});
	}

	private getOutcomeError(
		event: NotificationDeliveryOutcomeEventPayload
	): string {
		if (event.status !== 'FAILED' || !event.failure) {
			throw new Error('Failed notification outcome is missing failure');
		}
		return `${event.failure.normalizedCode}: ${event.failure.safeReason}`.slice(
			0,
			10_000
		);
	}
}
