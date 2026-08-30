import { DailySummaryRunService } from '../daily-summary/daily-summary-run.service';
import {
	NotificationDeliveryOutcomeEvent,
	OPERATIONS_NOTIFICATION_ROUTING_EVENT_TYPE,
	OperationsNotificationRoutingChangedEvent,
	ReportingSourceEvent,
	parseReportingConsumeMessage
} from '../projections/reporting-event.contract';
import { ProjectionService } from '../projections/projection.service';
import {
	REPORTING_ACCEPTED_PROJECTION_EVENT_TYPES,
	REPORTING_ROUTING_KEYS,
	ReportingConsumerKind,
	isProjectionConsumerKind
} from './reporting-messaging.constants';
import { Injectable } from '@nestjs/common';
import type { ConsumeMessage } from 'amqplib';

export type ParsedReportingConsumeMessage = ReturnType<
	typeof parseReportingConsumeMessage
>;

export interface ReportingConsumerCompletion {
	eventId: string;
	consumer: string;
	lockToken: string;
}

@Injectable()
export class ReportingConsumerRouterService {
	constructor(
		private readonly projections: ProjectionService,
		private readonly dailySummary: DailySummaryRunService
	) {}

	parse(
		kind: ReportingConsumerKind,
		message: ConsumeMessage
	): ParsedReportingConsumeMessage {
		const expectedEventTypes =
			kind === 'reportingSettings'
				? OPERATIONS_NOTIFICATION_ROUTING_EVENT_TYPE
				: isProjectionConsumerKind(kind)
					? REPORTING_ACCEPTED_PROJECTION_EVENT_TYPES[kind]
					: REPORTING_ROUTING_KEYS.deliveryOutcome;
		return parseReportingConsumeMessage(message, expectedEventTypes);
	}

	async dispatch(
		kind: ReportingConsumerKind,
		parsed: ParsedReportingConsumeMessage,
		completion: ReportingConsumerCompletion
	): Promise<void> {
		if (isProjectionConsumerKind(kind)) {
			await this.projections.applyEvent(
				parsed.payload as ReportingSourceEvent,
				completion
			);
			return;
		}
		if (kind === 'reportingSettings') {
			await this.projections.applyOperationsNotificationRouting(
				parsed.payload as OperationsNotificationRoutingChangedEvent,
				completion
			);
			return;
		}
		await this.dailySummary.applyOutcome(
			parsed.payload as NotificationDeliveryOutcomeEvent,
			parsed.eventId,
			completion
		);
	}
}
