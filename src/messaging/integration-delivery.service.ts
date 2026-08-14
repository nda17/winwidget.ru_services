import { CampaignAdminAuditEventPayload } from '@/messaging/campaign-admin-audit-event';
import { MonolithIntegrationKind } from '@/messaging/messaging.constants';
import { ReportingAdminAuditEventPayload } from '@/messaging/reporting-admin-audit-event';
import { WidgetsAdminAuditEventPayload } from '@/messaging/widgets-admin-audit-event';
import { Injectable } from '@nestjs/common';

export type DeliveryEventPayload =
	| CampaignAdminAuditEventPayload
	| ReportingAdminAuditEventPayload
	| WidgetsAdminAuditEventPayload;

@Injectable()
export class IntegrationDeliveryService {
	async deliver(
		kind: MonolithIntegrationKind,
		event: DeliveryEventPayload
	): Promise<void> {
		void event;
		throw new Error(
			`Core integration delivery is unsupported for kind=${kind}`
		);
	}
}
