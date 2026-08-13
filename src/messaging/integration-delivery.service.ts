import { CampaignAdminAuditEventPayload } from '@/messaging/campaign-admin-audit-event';
import { MonolithIntegrationKind } from '@/messaging/messaging.constants';
import { ReportingAdminAuditEventPayload } from '@/messaging/reporting-admin-audit-event';
import { WidgetsAdminAuditEventPayload } from '@/messaging/widgets-admin-audit-event';
import { TelegramDestinationUnavailableEventPayload } from '@/messaging/telegram-destination-unavailable-event';
import { PrismaService } from '@/prisma.service';
import { Injectable } from '@nestjs/common';

export type DeliveryEventPayload =
	| TelegramDestinationUnavailableEventPayload
	| CampaignAdminAuditEventPayload
	| ReportingAdminAuditEventPayload
	| WidgetsAdminAuditEventPayload;

@Injectable()
export class IntegrationDeliveryService {
	constructor(private readonly prisma: PrismaService) {}

	async deliver(
		kind: MonolithIntegrationKind,
		event: DeliveryEventPayload
	): Promise<void> {
		if (kind === 'telegram-destination-unavailable') {
			await this.applyTelegramDestinationUnavailable(
				event as TelegramDestinationUnavailableEventPayload
			);
			return;
		}
		throw new Error(
			`Core integration delivery is unsupported for kind=${kind}`
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
}
