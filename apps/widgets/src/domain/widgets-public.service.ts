import {
	BadRequestException,
	ForbiddenException,
	HttpException,
	HttpStatus,
	Injectable,
	NotFoundException
} from '@nestjs/common';
import {
	CallbackOtpChannel,
	CallbackVerificationMode,
	EntitlementPlan
} from '@prisma/widgets-client';
import { createHash } from 'node:crypto';
import { WidgetsCloudflareTurnstileService } from '../ai/widgets-cloudflare-turnstile.service';
import {
	callbackOtpChannel,
	WidgetsCallbackOtpService
} from '../callback/widgets-callback-otp.service';
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
import type {
	PreparedWidgetLead,
	WidgetLeadInput
} from './widgets-type-adapter';
import {
	dataType,
	normalizeEmail,
	normalizePhone
} from './widgets-type-adapter';
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
		private readonly turnstile: WidgetsCloudflareTurnstileService,
		private readonly callbackOtp: WidgetsCallbackOtpService
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

	async startCallbackVerification(
		publicKey: string,
		input: { phone?: string; email?: string },
		ip: string,
		requestDomain: string | null,
		directPageAccessAllowed: boolean
	) {
		const callback = await this.repository.findByPublicKey(
			WidgetType.CALLBACK,
			publicKey
		);
		if (!callback) throw new NotFoundException('Виджет не найден');
		this.assertSubmissionAvailable(
			callback,
			requestDomain,
			directPageAccessAllowed
		);
		const config = asJsonObject(
			normalizeWidgetConfig(WidgetType.CALLBACK, callback.config)
		);
		const mode = this.callbackVerificationMode(config);
		const channel = callbackOtpChannel(mode);
		if (!channel) {
			throw new BadRequestException(
				'Проверка для этого виджета отключена'
			);
		}
		let destination: string | undefined;
		if (channel === CallbackOtpChannel.SMS) {
			if (input.email !== undefined) {
				throw new BadRequestException(
					'Для SMS-проверки передавайте только телефон'
				);
			}
			destination = normalizePhone(input.phone);
			if (!destination) {
				throw new BadRequestException('Укажите корректный телефон');
			}
		} else {
			if (input.phone !== undefined) {
				throw new BadRequestException(
					'Для email-проверки передавайте только email'
				);
			}
			destination = normalizeEmail(input.email);
			if (!destination) {
				throw new BadRequestException('Укажите корректный email');
			}
		}
		const snapshot = await this.quota.snapshot(callback.userId);
		const limit = snapshot.entitlement.maxLeadsPerPeriod;
		if (
			snapshot.entitlement.unlimited !== true &&
			(limit === null || snapshot.counter.leadCount >= limit)
		) {
			throw new ForbiddenException(
				'Лимит заявок исчерпан или подписка неактивна'
			);
		}
		return this.callbackOtp.start({
			callbackId: callback.id,
			ownerId: callback.userId,
			publishedVersion: callback.publishedVersion,
			channel,
			destination,
			ip
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
		const initialConfig = asJsonObject(
			normalizeWidgetConfig(type, initial.config)
		);
		const initialPrepared = adapter.prepareLead(input, initialConfig);
		const initialVerification = this.callbackVerificationIdentity(
			type,
			initial,
			initialConfig,
			input,
			initialPrepared
		);
		if (initialVerification?.identity) {
			const replay = await this.callbackOtp.precheckOrReplay(
				initialVerification.identity
			);
			if (replay) return { success: true, lead: replay };
		}

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
				idempotencyKey: initialVerification?.identity
					? `lead-create:${initial.userId}:${initial.id}:${initialVerification.identity.challengeId}`
					: `lead-create:${initial.userId}:${initial.id}:${correlationId}`,
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
				const verification = this.callbackVerificationIdentity(
					type,
					widget,
					config,
					input,
					prepared
				);
				if (verification?.identity) {
					await this.callbackOtp.assertConsumable(
						transaction,
						verification.identity
					);
				}
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
					{
						...prepared.data,
						ip,
						...(verification && {
							verificationMode: verification.mode,
							verificationChallengeId: verification.identity?.challengeId
						})
					},
					transaction
				);
				if (verification?.identity) {
					await this.callbackOtp.consume(
						transaction,
						verification.identity
					);
				}
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
			},
			initialVerification?.identity
				? transaction =>
						this.callbackOtp.findReplayInTransaction(
							transaction,
							initialVerification.identity
						)
				: undefined
		);
		return { success: true, lead: result.value, ...(response || {}) };
	}

	private callbackVerificationIdentity(
		type: WidgetType,
		widget: { id: string; userId: string; publishedVersion: number },
		config: Record<string, unknown>,
		input: WidgetLeadInput,
		prepared: PreparedWidgetLead
	) {
		if (type !== WidgetType.CALLBACK) return null;
		const mode = this.callbackVerificationMode(config);
		if (
			mode !== CallbackVerificationMode.EMAIL &&
			input.email !== undefined
		) {
			throw new BadRequestException(
				'Email разрешён только при подтверждении по email'
			);
		}
		const channel = callbackOtpChannel(mode);
		if (!channel) {
			if (input.challengeId !== undefined || input.code !== undefined) {
				throw new BadRequestException(
					'Код подтверждения не должен передаваться при отключённой проверке'
				);
			}
			return { mode, identity: null };
		}
		if (
			!input.challengeId ||
			!input.code ||
			!/^[0-9]{6}$/.test(input.code)
		) {
			throw new BadRequestException(
				'Введите шестизначный код подтверждения'
			);
		}
		const destination =
			channel === CallbackOtpChannel.SMS
				? prepared.data.phone
				: normalizeEmail(input.email);
		if (!destination) {
			throw new BadRequestException(
				channel === CallbackOtpChannel.SMS
					? 'Укажите корректный телефон'
					: 'Укажите корректный email'
			);
		}
		return {
			mode,
			identity: {
				callbackId: widget.id,
				ownerId: widget.userId,
				publishedVersion: widget.publishedVersion,
				channel,
				challengeId: input.challengeId,
				code: input.code,
				destination,
				payload: {
					phone: prepared.data.phone || '',
					timeSlot: prepared.data.timeSlot || '',
					timezone: prepared.data.timezone || '',
					url: prepared.data.url ?? null
				}
			}
		};
	}

	private callbackVerificationMode(
		config: Record<string, unknown>
	): CallbackVerificationMode {
		return config.verificationMode as CallbackVerificationMode;
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
