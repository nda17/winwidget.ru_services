import { AdminEventLogService } from '@/admin-event-log/admin-event-log.service';
import {
	AUTO_RENEWAL_CONSENT_TEXT,
	AUTO_RENEWAL_CONSENT_VERSION
} from '@/payment/payment.constants';
import { PrismaService } from '@/prisma.service';
import { UpdateSiteSettingsDto } from '@/site-settings/dto/update-site-settings.dto';
import { Injectable } from '@nestjs/common';
import { Prisma, SiteSettings } from '@prisma/client';
import { Request } from 'express';

@Injectable()
export class SiteSettingsService {
	constructor(
		private readonly prisma: PrismaService,
		private readonly adminEventLog: AdminEventLogService
	) {}

	async get() {
		const settings = await this.prisma.siteSettings.upsert({
			where: { id: 'singleton' },
			update: {},
			create: { id: 'singleton' }
		});
		return this.withAutoRenewalTerms(settings);
	}

	async update(
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
}
