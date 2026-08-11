import { AdminEventLogService } from '@/admin-event-log/admin-event-log.service';
import { BillingCoreStateService } from '@/billing-boundary/billing-core-state.service';
import {
	BillingSettingsCompositionService,
	type BillingSettingsPatch,
	type CoreSettingsPatch
} from '@/billing-boundary/billing-settings-composition.service';
import { BillingSettingsState } from '@/messaging/billing-events';
import {
	AUTO_RENEWAL_CONSENT_TEXT,
	AUTO_RENEWAL_CONSENT_VERSION
} from '@/payment/payment.constants';
import { PrismaService } from '@/prisma.service';
import { UpdateSiteSettingsDto } from '@/site-settings/dto/update-site-settings.dto';
import {
	Injectable,
	Logger,
	ServiceUnavailableException
} from '@nestjs/common';
import {
	BillingCoreOwnership,
	type BillingSettingsReadProjection,
	Prisma,
	type SiteSettings
} from '@prisma/client';
import { Request } from 'express';

@Injectable()
export class SiteSettingsService {
	private readonly logger = new Logger(SiteSettingsService.name);

	constructor(
		private readonly prisma: PrismaService,
		private readonly adminEventLog: AdminEventLogService,
		private readonly billingState: BillingCoreStateService,
		private readonly composition: BillingSettingsCompositionService
	) {}

	async get() {
		const state = await this.billingState.get();
		const coreSettings = await this.getCoreSettings(
			state.ownership === BillingCoreOwnership.CORE &&
				state.sourceProducersEnabled
		);
		if (state.ownership !== BillingCoreOwnership.BILLING) {
			return this.withAutoRenewalTerms(coreSettings);
		}

		await this.composition.repairPending().catch(() => {
			this.logger.warn(
				'Pending Billing settings composition could not be repaired during read'
			);
		});
		const billingSettings =
			await this.prisma.billingSettingsReadProjection.findUnique({
				where: { id: 'singleton' }
			});
		if (!billingSettings) {
			throw new ServiceUnavailableException({
				statusCode: 503,
				message: 'Billing settings projection is unavailable',
				error: 'Service Unavailable',
				code: 'billing_settings_projection_unavailable'
			});
		}
		return this.compose(coreSettings, billingSettings);
	}

	async update(
		dto: UpdateSiteSettingsDto,
		audit?: { adminId: string; request: Request }
	) {
		const state = await this.billingState.get();
		if (
			state.ownership === BillingCoreOwnership.CORE &&
			state.sourceProducersEnabled
		) {
			return this.updateLegacy(dto, audit);
		}
		if (!audit) {
			throw new ServiceUnavailableException(
				'Billing settings update requires an authenticated actor'
			);
		}

		const corePatch = this.getCorePatch(dto);
		const billingPatch = this.getBillingPatch(dto);
		if (
			state.ownership === BillingCoreOwnership.CORE &&
			!state.sourceProducersEnabled &&
			Object.keys(billingPatch).length > 0
		) {
			throw new ServiceUnavailableException({
				statusCode: 503,
				message: 'Billing ownership migration is in progress',
				error: 'Service Unavailable',
				code: 'billing_migration_in_progress'
			});
		}
		if (Object.keys(billingPatch).length > 0) {
			const result = await this.composition.execute({
				corePatch,
				billingPatch,
				actorId: audit.adminId,
				request: audit.request
			});
			return this.compose(result.coreSettings, result.billingSettings);
		}

		const coreSettings = await this.updateCoreOnly(corePatch, dto, audit);
		if (state.ownership === BillingCoreOwnership.BILLING) {
			const billingSettings =
				await this.prisma.billingSettingsReadProjection.findUnique({
					where: { id: 'singleton' }
				});
			if (!billingSettings) {
				throw new ServiceUnavailableException(
					'Billing settings projection is unavailable'
				);
			}
			return this.compose(coreSettings, billingSettings);
		}
		return this.withAutoRenewalTerms(coreSettings);
	}

	private updateLegacy(
		dto: UpdateSiteSettingsDto,
		audit?: { adminId: string; request: Request }
	) {
		return this.prisma.$transaction(async transaction => {
			await transaction.siteSettings.upsert({
				where: { id: 'singleton' },
				update: {},
				create: { id: 'singleton' }
			});
			await transaction.$queryRaw(
				Prisma.sql`
					SELECT "id"
					FROM "site_settings"
					WHERE "id" = 'singleton'
					FOR UPDATE
				`
			);
			const current = await transaction.siteSettings.findUniqueOrThrow({
				where: { id: 'singleton' }
			});
			const settings = await transaction.siteSettings.update({
				where: { id: 'singleton' },
				data: {
					...this.getUpdateData(dto),
					...((dto.autoRenewalChargesEnabled === true &&
						!current.autoRenewalChargesEnabled) ||
					(dto.paymentEnabled === true && !current.paymentEnabled)
						? { autoRenewalChargesEnabledAt: new Date() }
						: {})
				}
			});
			if (audit) {
				await this.adminEventLog.recordInTransaction(transaction, {
					adminId: audit.adminId,
					section: 'SITE_SETTINGS',
					action: 'SITE_SETTINGS_UPDATE',
					description: 'Обновлены настройки сайта',
					entityType: 'site_settings',
					entityId: 'singleton',
					entityLabel: 'Настройки сайта',
					metadata: this.getUpdateMetadata(dto, settings),
					request: audit.request
				});
			}
			return this.withAutoRenewalTerms(settings);
		});
	}

	private updateCoreOnly(
		corePatch: CoreSettingsPatch,
		dto: UpdateSiteSettingsDto,
		audit: { adminId: string; request: Request }
	) {
		return this.prisma.$transaction(async transaction => {
			await transaction.$queryRaw(
				Prisma.sql`
					SELECT "id"
					FROM "site_settings"
					WHERE "id" = 'singleton'
					FOR UPDATE
				`
			);
			const settings = Object.keys(corePatch).length
				? await transaction.siteSettings.update({
						where: { id: 'singleton' },
						data: corePatch
					})
				: await transaction.siteSettings.findUniqueOrThrow({
						where: { id: 'singleton' }
					});
			await this.adminEventLog.recordInTransaction(transaction, {
				adminId: audit.adminId,
				section: 'SITE_SETTINGS',
				action: 'SITE_SETTINGS_UPDATE',
				description: 'Обновлены настройки сайта',
				entityType: 'site_settings',
				entityId: 'singleton',
				entityLabel: 'Настройки сайта',
				metadata: this.getUpdateMetadata(dto, settings),
				request: audit.request
			});
			return settings;
		});
	}

	private async getCoreSettings(
		allowCreate: boolean
	): Promise<SiteSettings> {
		const settings = await this.prisma.siteSettings.findUnique({
			where: { id: 'singleton' }
		});
		if (settings) return settings;
		if (!allowCreate) {
			throw new ServiceUnavailableException(
				'Core site settings are unavailable'
			);
		}
		return this.prisma.siteSettings.create({
			data: { id: 'singleton' }
		});
	}

	private getCorePatch(dto: UpdateSiteSettingsDto): CoreSettingsPatch {
		return {
			...(dto.bannerEnabled !== undefined
				? { bannerEnabled: dto.bannerEnabled }
				: {}),
			...(dto.bannerText !== undefined
				? { bannerText: dto.bannerText }
				: {}),
			...(dto.snowflakeEnabled !== undefined
				? { snowflakeEnabled: dto.snowflakeEnabled }
				: {}),
			...(dto.recaptchaEnabled !== undefined
				? { recaptchaEnabled: dto.recaptchaEnabled }
				: {}),
			...(dto.googleAuthEnabled !== undefined
				? { googleAuthEnabled: dto.googleAuthEnabled }
				: {}),
			...(dto.yandexAuthEnabled !== undefined
				? { yandexAuthEnabled: dto.yandexAuthEnabled }
				: {}),
			...(dto.githubAuthEnabled !== undefined
				? { githubAuthEnabled: dto.githubAuthEnabled }
				: {}),
			...(dto.vkAuthEnabled !== undefined
				? { vkAuthEnabled: dto.vkAuthEnabled }
				: {}),
			...(dto.telegramAuthEnabled !== undefined
				? { telegramAuthEnabled: dto.telegramAuthEnabled }
				: {})
		};
	}

	private getBillingPatch(
		dto: UpdateSiteSettingsDto
	): BillingSettingsPatch {
		return {
			...(dto.paymentEnabled !== undefined
				? { paymentEnabled: dto.paymentEnabled }
				: {}),
			...(dto.autoRenewalSignupEnabled !== undefined
				? { autoRenewalSignupEnabled: dto.autoRenewalSignupEnabled }
				: {}),
			...(dto.autoRenewalChargesEnabled !== undefined
				? { autoRenewalChargesEnabled: dto.autoRenewalChargesEnabled }
				: {})
		};
	}

	private getUpdateData(
		dto: UpdateSiteSettingsDto
	): Prisma.SiteSettingsUpdateInput {
		return {
			...(dto.bannerEnabled !== undefined
				? { bannerEnabled: dto.bannerEnabled }
				: {}),
			...(dto.bannerText !== undefined
				? { bannerText: dto.bannerText }
				: {}),
			...(dto.snowflakeEnabled !== undefined
				? { snowflakeEnabled: dto.snowflakeEnabled }
				: {}),
			...(dto.paymentEnabled !== undefined
				? { paymentEnabled: dto.paymentEnabled }
				: {}),
			...(dto.autoRenewalSignupEnabled !== undefined
				? {
						autoRenewalSignupEnabled: dto.autoRenewalSignupEnabled
					}
				: {}),
			...(dto.autoRenewalChargesEnabled !== undefined
				? {
						autoRenewalChargesEnabled: dto.autoRenewalChargesEnabled
					}
				: {}),
			...(dto.recaptchaEnabled !== undefined
				? { recaptchaEnabled: dto.recaptchaEnabled }
				: {}),
			...(dto.googleAuthEnabled !== undefined
				? { googleAuthEnabled: dto.googleAuthEnabled }
				: {}),
			...(dto.yandexAuthEnabled !== undefined
				? { yandexAuthEnabled: dto.yandexAuthEnabled }
				: {}),
			...(dto.githubAuthEnabled !== undefined
				? { githubAuthEnabled: dto.githubAuthEnabled }
				: {}),
			...(dto.vkAuthEnabled !== undefined
				? { vkAuthEnabled: dto.vkAuthEnabled }
				: {}),
			...(dto.telegramAuthEnabled !== undefined
				? { telegramAuthEnabled: dto.telegramAuthEnabled }
				: {})
		};
	}

	private getUpdateMetadata(
		dto: UpdateSiteSettingsDto,
		settings: SiteSettings
	) {
		const booleanFields = [
			'bannerEnabled',
			'snowflakeEnabled',
			'paymentEnabled',
			'autoRenewalSignupEnabled',
			'autoRenewalChargesEnabled',
			'recaptchaEnabled',
			'googleAuthEnabled',
			'yandexAuthEnabled',
			'githubAuthEnabled',
			'vkAuthEnabled',
			'telegramAuthEnabled'
		] as const;
		return {
			changedFields: Object.keys(dto),
			bannerTextChanged: typeof dto.bannerText === 'string',
			...Object.fromEntries(
				booleanFields
					.filter(field => typeof dto[field] === 'boolean')
					.map(field => [field, settings[field]])
			)
		};
	}

	private withAutoRenewalTerms<T extends object>(settings: T) {
		return {
			...settings,
			autoRenewalTerms: {
				version: AUTO_RENEWAL_CONSENT_VERSION,
				text: AUTO_RENEWAL_CONSENT_TEXT
			}
		};
	}

	private compose(
		core: SiteSettings,
		billing: BillingSettingsState | BillingSettingsReadProjection
	) {
		const billingUpdatedAt = this.toDate(billing.updatedAt);
		return this.withAutoRenewalTerms({
			...core,
			paymentEnabled: billing.paymentEnabled,
			autoRenewalSignupEnabled: billing.autoRenewalSignupEnabled,
			autoRenewalChargesEnabled: billing.autoRenewalChargesEnabled,
			autoRenewalChargesEnabledAt: this.toDate(
				billing.autoRenewalChargesEnabledAt
			),
			affiliateProgramEnabled: billing.affiliateProgramEnabled,
			affiliateCashbackPercent: billing.affiliateCashbackPercent,
			updatedAt: new Date(
				Math.max(core.updatedAt.getTime(), billingUpdatedAt.getTime())
			)
		});
	}

	private toDate(value: Date | string): Date {
		return value instanceof Date ? value : new Date(value);
	}
}
