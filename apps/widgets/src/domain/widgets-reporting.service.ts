import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/widgets-client';
import {
	WIDGET_LEAD_CHANGED_EVENT_TYPE,
	WIDGET_CHANGED_EVENT_TYPE,
	WidgetsReportingSequenceService
} from '../reporting/widgets-reporting-sequence.service';
import type { WidgetLeadRecord } from './widgets-domain.repository';
import type { WidgetEntity } from './widgets-domain.types';
import { WidgetType } from './widgets-domain.types';

@Injectable()
export class WidgetsReportingService {
	constructor(
		private readonly reporting: WidgetsReportingSequenceService
	) {}

	async enqueueWidget(
		transaction: Prisma.TransactionClient,
		type: WidgetType,
		widget: WidgetEntity,
		tombstone = false,
		correlationId?: string
	): Promise<void> {
		const widgetType = this.wireType(type);
		await this.reporting.createEventInTransaction(transaction, {
			eventType: WIDGET_CHANGED_EVENT_TYPE,
			aggregateType: this.widgetAggregateType(type),
			aggregateId: `${widgetType}:${widget.id}`,
			tombstone,
			correlationId,
			state: tombstone
				? null
				: {
						id: widget.id,
						userId: widget.userId,
						widgetType,
						isActive: widget.isActive,
						hasInstallDomain: Boolean(widget.installDomain),
						createdAt: widget.createdAt.toISOString()
					}
		});
	}

	async enqueueLead(
		transaction: Prisma.TransactionClient,
		type: WidgetType,
		widgetId: string,
		lead: WidgetLeadRecord,
		tombstone = false,
		correlationId?: string
	): Promise<void> {
		const widgetType = this.wireType(type);
		await this.reporting.createEventInTransaction(transaction, {
			eventType: WIDGET_LEAD_CHANGED_EVENT_TYPE,
			aggregateType: this.leadAggregateType(type),
			aggregateId: `${widgetType}:${lead.id}`,
			tombstone,
			correlationId,
			state: tombstone
				? null
				: {
						id: lead.id,
						widgetId,
						widgetType,
						createdAt: lead.createdAt.toISOString()
					}
		});
	}

	aggregateId(type: WidgetType, id: string): string {
		return `${this.wireType(type)}:${id}`;
	}

	widgetAggregateType(type: WidgetType): string {
		return `widgets.widget.${this.wireType(type)}`;
	}

	leadAggregateType(type: WidgetType): string {
		return `widgets.lead.${this.wireType(type)}`;
	}

	private wireType(type: WidgetType): string {
		return (
			{
				[WidgetType.WHEEL]: 'wheel',
				[WidgetType.QUIZ]: 'quiz',
				[WidgetType.CALLBACK]: 'callback',
				[WidgetType.TIMER]: 'countdownTimer',
				[WidgetType.STOP_OFFER]: 'stopOffer',
				[WidgetType.ONLINE_CONSULTANT]: 'onlineConsultant',
				[WidgetType.CALCULATOR]: 'calculator'
			} as Record<WidgetType, string>
		)[type];
	}
}
