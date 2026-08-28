import {
	BadRequestException,
	ForbiddenException,
	HttpException,
	HttpStatus,
	Injectable,
	NotFoundException
} from '@nestjs/common';
import { EntitlementPlan } from '@prisma/widgets-client';
import { createHash } from 'node:crypto';
import { WidgetsCloudflareTurnstileService } from '../ai/widgets-cloudflare-turnstile.service';
import { WidgetsDomainEventsService } from '../messaging/widgets-domain-events.service';
import { WidgetsQuotaService } from '../quota/widgets-quota.service';
import { normalizeWidgetConfig } from './widgets-config-normalizer';
import { WidgetsDomainRepository } from './widgets-domain.repository';
import { asJsonObject, WidgetType } from './widgets-domain.types';
import {
	isDomainAllowed,
	isExactHostnameAllowed
} from './widgets-domain.util';
import { WidgetsReportingService } from './widgets-reporting.service';
import type { WidgetLeadInput } from './widgets-type-adapter';
import { dataType } from './widgets-type-adapter';
import { WidgetsTypeRegistryService } from './widgets-type-registry.service';

interface PublicConfigRateEntry {
	count: number;
	expiresAt: number;
}

const PUBLIC_AI_CONFIG_WINDOW_MS = 60_000;
const PUBLIC_AI_CONFIG_MAX_ENTRIES = 25_000;
const PUBLIC_AI_CONFIG_LIMITS = {
	global: 600,
	widget: 180,
	ip: 120
} as const;

@Injectable()
export class WidgetsPublicService {
	private readonly publicAiConfigRates = new Map<
		string,
		PublicConfigRateEntry
	>();
	private publicAiConfigOperations = 0;

	constructor(
		private readonly repository: WidgetsDomainRepository,
		private readonly quota: WidgetsQuotaService,
		private readonly events: WidgetsDomainEventsService,
		private readonly reporting: WidgetsReportingService,
		private readonly registry: WidgetsTypeRegistryService,
		private readonly turnstile: WidgetsCloudflareTurnstileService
	) {}

	async config(
		type: WidgetType,
		publicKey: string,
		requestDomain: string | null,
		directPageAccessAllowed: boolean,
		ip: string
	): Promise<Record<string, unknown> | null> {
		if (type === WidgetType.AI_CONSULTANT) {
			this.consumePublicAiConfigRate(publicKey, ip);
		}
		const widget = await this.repository.findByPublicKey(type, publicKey);
		if (!widget) return null;
		if (
			!widget.publishedAt ||
			widget.publishedVersion < 1 ||
			!widget.isActive ||
			(!directPageAccessAllowed &&
				!(type === WidgetType.AI_CONSULTANT
					? isExactHostnameAllowed(widget.installDomain, requestDomain)
					: isDomainAllowed(widget.installDomain, requestDomain)))
		) {
			return { isActive: false };
		}

		let snapshot;
		try {
			snapshot =
				type === WidgetType.AI_CONSULTANT
					? await this.quota.aiSnapshot(widget.userId)
					: await this.quota.snapshot(widget.userId);
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
		const publicConfig = adapter.publicConfig(config, {
			publishedVersion: widget.publishedVersion,
			hardPlan: snapshot.entitlement.plan === EntitlementPlan.HARD,
			duplicateByIp
		});
		return type === WidgetType.AI_CONSULTANT
			? {
					...publicConfig,
					turnstileSiteKey: this.turnstile.siteKey(),
					turnstileAction: this.turnstile.action()
				}
			: publicConfig;
	}

	private consumePublicAiConfigRate(publicKey: string, ip: string): void {
		const now = Date.now();
		this.publicAiConfigOperations += 1;
		if (
			this.publicAiConfigOperations % 128 === 0 ||
			this.publicAiConfigRates.size >= PUBLIC_AI_CONFIG_MAX_ENTRIES
		) {
			for (const [key, entry] of this.publicAiConfigRates) {
				if (entry.expiresAt <= now) this.publicAiConfigRates.delete(key);
			}
		}
		const scopes: Array<[string, number]> = [
			['ai-config:global', PUBLIC_AI_CONFIG_LIMITS.global],
			[
				`ai-config:widget:${this.publicRateScope(publicKey)}`,
				PUBLIC_AI_CONFIG_LIMITS.widget
			],
			[
				`ai-config:ip:${this.publicRateScope(ip || 'unknown')}`,
				PUBLIC_AI_CONFIG_LIMITS.ip
			]
		];
		for (const [key, limit] of scopes) {
			const entry = this.publicAiConfigRates.get(key);
			if (entry && entry.expiresAt > now && entry.count >= limit) {
				throw new HttpException(
					'Слишком много запросов конфигурации',
					HttpStatus.TOO_MANY_REQUESTS
				);
			}
		}
		for (const [key] of scopes) {
			const entry = this.publicAiConfigRates.get(key);
			if (!entry || entry.expiresAt <= now) {
				while (
					this.publicAiConfigRates.size >= PUBLIC_AI_CONFIG_MAX_ENTRIES
				) {
					const evictionKey = [...this.publicAiConfigRates.keys()].find(
						candidate =>
							candidate !== 'ai-config:global' &&
							!scopes.some(([protectedKey]) => protectedKey === candidate)
					);
					if (!evictionKey) break;
					this.publicAiConfigRates.delete(evictionKey);
				}
				if (
					this.publicAiConfigRates.size >= PUBLIC_AI_CONFIG_MAX_ENTRIES
				) {
					throw new HttpException(
						'Слишком много запросов конфигурации',
						HttpStatus.TOO_MANY_REQUESTS
					);
				}
				this.publicAiConfigRates.set(key, {
					count: 1,
					expiresAt: now + PUBLIC_AI_CONFIG_WINDOW_MS
				});
			} else {
				entry.count += 1;
			}
		}
	}

	private publicRateScope(value: string): string {
		return createHash('sha256').update(value).digest('base64url');
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
				WidgetType.AI_CONSULTANT
			].includes(type) && dataType(config, 'NONE') === 'NONE'
		);
	}
}
