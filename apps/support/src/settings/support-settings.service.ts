import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/support-client';
import type { Request } from 'express';
import type { SupportActor } from '../auth/support-request';
import { enqueueSupportAdminAudit } from '../domain/support-admin-audit';
import { SupportPrismaService } from '../prisma/support-prisma.service';
import type { UpdateSupportRoutingSettingsDto } from './support-settings.dto';

@Injectable()
export class SupportSettingsService {
	constructor(private readonly prisma: SupportPrismaService) {}

	async get() {
		const settings = await this.prisma.routingSettings.upsert({
			where: { id: 'singleton' },
			update: {},
			create: { id: 'singleton' }
		});
		return this.serialize(settings);
	}

	async update(
		dto: UpdateSupportRoutingSettingsDto,
		actor: SupportActor,
		request: Request
	) {
		return this.prisma.$transaction(
			async transaction => {
				await transaction.routingSettings.upsert({
					where: { id: 'singleton' },
					update: {},
					create: { id: 'singleton' }
				});
				const locked = await transaction.$queryRaw<Array<{ id: string }>>(
					Prisma.sql`SELECT "id" FROM "support"."routing_settings" WHERE "id" = 'singleton' FOR UPDATE`
				);
				if (locked.length !== 1) {
					throw new Error('Support routing settings lock failed');
				}
				const settings = await transaction.routingSettings.update({
					where: { id: 'singleton' },
					data: {
						adminChatId: dto.adminChatId.trim(),
						supportThreadId: dto.supportThreadId,
						aggregateVersion: { increment: 1 }
					}
				});
				await enqueueSupportAdminAudit(transaction, {
					actor,
					action: 'SUPPORT_ROUTING_SETTINGS_UPDATE',
					description: 'Обновлены настройки маршрутизации Support_bot',
					entityType: 'support_routing_settings',
					entityId: 'singleton',
					entityLabel: 'Support_bot',
					metadata: {
						adminChatIdConfigured: true,
						supportThreadIdConfigured: true,
						aggregateVersion: settings.aggregateVersion.toString()
					},
					request
				});
				return this.serialize(settings);
			},
			{ isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
		);
	}

	private serialize(settings: {
		adminChatId: string;
		supportThreadId: number | null;
		aggregateVersion: bigint;
		updatedAt: Date;
	}) {
		return {
			schemaVersion: 1,
			adminChatId: settings.adminChatId,
			supportThreadId: settings.supportThreadId,
			aggregateVersion: settings.aggregateVersion.toString(),
			updatedAt: settings.updatedAt.toISOString()
		};
	}
}
