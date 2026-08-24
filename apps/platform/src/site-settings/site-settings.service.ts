import {
	BadRequestException,
	Injectable,
	ServiceUnavailableException
} from '@nestjs/common';
import { Prisma } from '@prisma/platform-client';
import type { PlatformActor } from '../auth/platform-request';
import { enqueuePlatformAdminAudit } from '../domain/platform-admin-audit';
import {
	nextPlatformSequence,
	refreshPlatformSemanticFingerprint
} from '../domain/platform-sequence';
import { PlatformPrismaService } from '../prisma/platform-prisma.service';
import type { UpdatePlatformSiteSettingsDto } from './site-settings.dto';

@Injectable()
export class PlatformSiteSettingsService {
	constructor(private readonly prisma: PlatformPrismaService) {}

	async get() {
		const settings = await this.prisma.siteSettings.findUnique({
			where: { id: 'singleton' }
		});
		if (!settings) {
			throw new ServiceUnavailableException(
				'Platform site settings are unavailable'
			);
		}
		return this.serialize(settings);
	}

	async update(
		dto: UpdatePlatformSiteSettingsDto,
		context: {
			actor: PlatformActor;
			ip?: string | null;
			userAgent?: string | null;
		}
	) {
		const changedFields = Object.keys(dto).sort();
		if (!changedFields.length) {
			throw new BadRequestException(
				'At least one Platform setting is required'
			);
		}
		return this.prisma.$transaction(
			async transaction => {
				await transaction.$queryRaw(
					Prisma.sql`SELECT id FROM platform.site_settings WHERE id = 'singleton' FOR UPDATE`
				);
				const current = await transaction.siteSettings.findUnique({
					where: { id: 'singleton' }
				});
				if (!current) {
					throw new ServiceUnavailableException(
						'Platform site settings are unavailable'
					);
				}
				const sourceSequence = await nextPlatformSequence(transaction);
				const updated = await transaction.siteSettings.update({
					where: { id: 'singleton' },
					data: {
						...(dto.bannerEnabled !== undefined
							? { bannerEnabled: dto.bannerEnabled }
							: {}),
						...(dto.bannerText !== undefined
							? { bannerText: dto.bannerText }
							: {}),
						...(dto.snowflakeEnabled !== undefined
							? { snowflakeEnabled: dto.snowflakeEnabled }
							: {}),
						aggregateVersion: { increment: 1n },
						sourceSequence
					}
				});
				await refreshPlatformSemanticFingerprint(transaction);
				await enqueuePlatformAdminAudit(transaction, {
					actor: context.actor,
					action: 'PLATFORM_SITE_SETTINGS_UPDATE',
					description: 'Обновлены настройки платформы',
					entity: {
						type: 'site_settings',
						id: 'singleton',
						label: 'Настройки платформы'
					},
					metadata: {
						changedFields,
						bannerTextChanged: dto.bannerText !== undefined,
						...(dto.bannerEnabled !== undefined
							? { bannerEnabled: updated.bannerEnabled }
							: {}),
						...(dto.snowflakeEnabled !== undefined
							? { snowflakeEnabled: updated.snowflakeEnabled }
							: {})
					},
					ip: context.ip,
					userAgent: context.userAgent
				});
				return this.serialize(updated);
			},
			{ isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
		);
	}

	private serialize(settings: {
		id: string;
		bannerEnabled: boolean;
		bannerText: string;
		snowflakeEnabled: boolean;
		updatedAt: Date;
	}) {
		return {
			id: settings.id,
			bannerEnabled: settings.bannerEnabled,
			bannerText: settings.bannerText,
			snowflakeEnabled: settings.snowflakeEnabled,
			updatedAt: settings.updatedAt.toISOString()
		};
	}
}
