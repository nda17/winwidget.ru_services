import {
	BadRequestException,
	ForbiddenException,
	Injectable,
	NotFoundException
} from '@nestjs/common';
import { EntitlementPlan } from '@prisma/widgets-client';
import { WidgetsDomainEventsService } from '../messaging/widgets-domain-events.service';
import { WidgetsQuotaService } from '../quota/widgets-quota.service';
import { normalizeWidgetConfig } from './widgets-config-normalizer';
import { WidgetsDomainRepository } from './widgets-domain.repository';
import { asJsonObject, WidgetType } from './widgets-domain.types';
import { isDomainAllowed } from './widgets-domain.util';
import { WidgetsReportingService } from './widgets-reporting.service';
import type { WidgetLeadInput } from './widgets-type-adapter';
import { dataType } from './widgets-type-adapter';
import { WidgetsTypeRegistryService } from './widgets-type-registry.service';

@Injectable()
export class WidgetsPublicService {
	constructor(
		private readonly repository: WidgetsDomainRepository,
		private readonly quota: WidgetsQuotaService,
		private readonly events: WidgetsDomainEventsService,
		private readonly reporting: WidgetsReportingService,
		private readonly registry: WidgetsTypeRegistryService
	) {}

	async config(
		type: WidgetType,
		publicKey: string,
		requestDomain: string | null,
		directPageAccessAllowed: boolean,
		ip: string
	): Promise<Record<string, unknown> | null> {
		const widget = await this.repository.findByPublicKey(type, publicKey);
		if (!widget) return null;
		if (
			!widget.publishedAt ||
			widget.publishedVersion < 1 ||
			!widget.isActive ||
			(!directPageAccessAllowed &&
				!isDomainAllowed(widget.installDomain, requestDomain))
		) {
			return { isActive: false };
		}

		let snapshot;
		try {
			snapshot = await this.quota.snapshot(widget.userId);
		} catch {
			return { isActive: false };
		}
		const config = asJsonObject(
			normalizeWidgetConfig(type, widget.config)
		);
		const limit = snapshot.entitlement.maxLeadsPerPeriod;
		if (
			!this.contactCollectionDisabled(type, config) &&
			snapshot.entitlement.unlimited !== true &&
			(limit === null || snapshot.counter.leadCount >= limit)
		) {
			return { isActive: false };
		}
		const adapter = this.registry.for(type);
		const duplicateRule = adapter.publicDuplicateRule(config, ip);
		const duplicateByIp = duplicateRule
			? await this.repository.findDuplicateLead(
					type,
					widget.id,
					duplicateRule.lookup,
					this.repository.client()
				)
			: false;
		return adapter.publicConfig(config, {
			publishedVersion: widget.publishedVersion,
			hardPlan: snapshot.entitlement.plan === EntitlementPlan.HARD,
			duplicateByIp
		});
	}

	async submitLead(
		type: WidgetType,
		publicKey: string,
		input: WidgetLeadInput,
		ip: string,
		requestDomain: string | null,
		directPageAccessAllowed: boolean,
		correlationId: string
	) {
		const initial = await this.repository.findByPublicKey(type, publicKey);
		if (!initial) throw new NotFoundException('Виджет не найден');
		this.assertSubmissionAvailable(
			initial,
			requestDomain,
			directPageAccessAllowed
		);
		const adapter = this.registry.for(type);
		// This deliberately happens before the quota transaction. For NONE the
		// endpoint must return 400 and must not touch usage or create Outbox rows.
		adapter.prepareLead(
			input,
			asJsonObject(normalizeWidgetConfig(type, initial.config))
		);

		let response: Record<string, unknown> | undefined;
		let limitContext:
			| {
					widget: typeof initial;
					config: Record<string, unknown>;
			  }
			| undefined;
		const result = await this.quota.withLeadCreation(
			initial.userId,
			{
				idempotencyKey: `lead-create:${initial.userId}:${initial.id}:${correlationId}`,
				correlationId
			},
			async transaction => {
				const widget = await this.repository.findByPublicKey(
					type,
					publicKey,
					transaction
				);
				if (!widget || widget.userId !== initial.userId) {
					throw new NotFoundException('Виджет не найден');
				}
				this.assertSubmissionAvailable(
					widget,
					requestDomain,
					directPageAccessAllowed
				);
				const config = asJsonObject(
					normalizeWidgetConfig(type, widget.config)
				);
				limitContext = { widget, config };
				const prepared = adapter.prepareLead(input, config);
				for (const rule of adapter.duplicateRules(
					prepared.data,
					config,
					ip
				)) {
					if (
						await this.repository.findDuplicateLead(
							type,
							widget.id,
							rule.lookup,
							transaction
						)
					) {
						throw new BadRequestException(rule.message);
					}
				}
				const lead = await this.repository.createLead(
					type,
					widget.id,
					{ ...prepared.data, ip },
					transaction
				);
				await this.events.enqueueLeadIntegrations(transaction, {
					type,
					widget,
					lead: { ...lead, name: input.name },
					config
				});
				await this.reporting.enqueueLead(
					transaction,
					type,
					widget.id,
					lead,
					false,
					correlationId
				);
				response = prepared.response;
				return {
					value: lead,
					aggregateType: this.reporting.leadAggregateType(type),
					aggregateId: this.reporting.aggregateId(type, lead.id)
				};
			},
			(transaction, limit, periodKey) => {
				if (!limitContext) {
					throw new Error('Lead limit context was not initialized');
				}
				return this.events.enqueueLimitReached(transaction, {
					type,
					widget: limitContext.widget,
					config: limitContext.config,
					limit,
					periodKey
				});
			}
		);
		return { success: true, lead: result.value, ...(response || {}) };
	}

	private assertSubmissionAvailable(
		widget: {
			publishedAt: Date | null;
			publishedVersion: number;
			isActive: boolean;
			installDomain: string;
		},
		requestDomain: string | null,
		directPageAccessAllowed: boolean
	): void {
		if (!widget.publishedAt || widget.publishedVersion < 1) {
			throw new ForbiddenException('Виджет ещё не опубликован');
		}
		if (!widget.isActive) {
			throw new ForbiddenException(
				'Лимит заявок исчерпан или подписка неактивна'
			);
		}
		if (
			!directPageAccessAllowed &&
			!isDomainAllowed(widget.installDomain, requestDomain)
		) {
			throw new ForbiddenException('Домен установки виджета не совпадает');
		}
	}

	private contactCollectionDisabled(
		type: WidgetType,
		config: Record<string, unknown>
	): boolean {
		return (
			[
				WidgetType.TIMER,
				WidgetType.STOP_OFFER,
				WidgetType.ONLINE_CONSULTANT
			].includes(type) && dataType(config, 'NONE') === 'NONE'
		);
	}
}
