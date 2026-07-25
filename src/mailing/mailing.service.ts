import { AdminEventLogService } from '@/admin-event-log/admin-event-log.service';
import {
	AdminBroadcastAudience,
	SendAdminBroadcastDto
} from '@/mailing/dto/send-admin-broadcast.dto';
import {
	getMailingDeliveryRoutingKey,
	MailingDeliveryEventPayload,
	serializeMailingDeliveryEvent
} from '@/messaging/mailing-delivery-event';
import { createMessagingHeaders } from '@/messaging/messaging-context';
import { PrismaService } from '@/prisma.service';
import {
	BadRequestException,
	ConflictException,
	Injectable,
	NotFoundException
} from '@nestjs/common';
import {
	AuthIdentityType,
	MailingCampaignStatus,
	MailingDeliveryChannel,
	MailingDeliveryStatus,
	Prisma,
	SubscriptionStatus,
	UserStatus
} from '@prisma/client';
import { Request } from 'express';
import { randomUUID } from 'crypto';

const TERMINAL_CAMPAIGN_STATUSES: MailingCampaignStatus[] = [
	MailingCampaignStatus.COMPLETED,
	MailingCampaignStatus.PARTIAL_FAILED,
	MailingCampaignStatus.CANCELLED
];

@Injectable()
export class MailingService {
	constructor(
		private readonly prisma: PrismaService,
		private readonly adminEventLog: AdminEventLogService
	) {}

	async createAdminBroadcast(
		adminId: string,
		dto: SendAdminBroadcastDto,
		idempotencyKey: string,
		request?: Request
	) {
		const subject = dto.subject.trim();
		const message = dto.message.trim();
		const requestedChannel = dto.channel ?? 'EMAIL';
		const normalizedIdempotencyKey = idempotencyKey.trim().toLowerCase();

		if (!subject || !message || !normalizedIdempotencyKey) {
			throw new BadRequestException('Тема и текст рассылки обязательны');
		}

		const [emailRecipients, telegramRecipients] = await Promise.all([
			requestedChannel === 'EMAIL' || requestedChannel === 'BOTH'
				? this.getRecipientEmails(dto.audience)
				: Promise.resolve([]),
			requestedChannel === 'TELEGRAM' || requestedChannel === 'BOTH'
				? this.getRecipientTelegramChatIds(dto.audience)
				: Promise.resolve([])
		]);
		const campaignId = randomUUID();
		const deliveries = [
			...emailRecipients.map(recipient => ({
				id: randomUUID(),
				campaignId,
				channel: MailingDeliveryChannel.EMAIL,
				recipient
			})),
			...telegramRecipients.map(recipient => ({
				id: randomUUID(),
				campaignId,
				channel: MailingDeliveryChannel.TELEGRAM,
				recipient
			}))
		];
		const now = new Date();
		const campaignStatus = deliveries.length
			? MailingCampaignStatus.QUEUED
			: MailingCampaignStatus.COMPLETED;

		const persistedCampaignId = await this.prisma.$transaction(
			async transaction => {
				await transaction.$executeRaw(
					Prisma.sql`
							SELECT pg_advisory_xact_lock(
								hashtextextended(
									CAST(${`mailing:${adminId}:${normalizedIdempotencyKey}`} AS text),
									0::bigint
								)
							)
						`
				);
				const repeatedRequest =
					await transaction.mailingCampaign.findUnique({
						where: {
							adminId_idempotencyKey: {
								adminId,
								idempotencyKey: normalizedIdempotencyKey
							}
						}
					});
				if (repeatedRequest) {
					this.assertMatchingIdempotentRequest(repeatedRequest, {
						subject,
						message,
						audience: dto.audience,
						requestedChannel
					});
					return repeatedRequest.id;
				}

				await transaction.mailingCampaign.create({
					data: {
						id: campaignId,
						adminId,
						idempotencyKey: normalizedIdempotencyKey,
						subject,
						message,
						audience: dto.audience,
						requestedChannel,
						status: campaignStatus,
						recipientCount: deliveries.length,
						emailRecipientCount: emailRecipients.length,
						telegramRecipientCount: telegramRecipients.length,
						completedAt: deliveries.length ? null : now
					}
				});
				if (deliveries.length) {
					await transaction.mailingDelivery.createMany({
						data: deliveries
					});
					await transaction.outboxEvent.createMany({
						data: deliveries.map(delivery => {
							const eventId = randomUUID();
							const payload: MailingDeliveryEventPayload = {
								schemaVersion: 1,
								eventType: 'mailing.delivery.requested.v1',
								campaignId,
								deliveryId: delivery.id,
								channel: delivery.channel
							};
							return {
								id: eventId,
								messageId: eventId,
								eventType: payload.eventType,
								routingKey: getMailingDeliveryRoutingKey(delivery.channel),
								payload: serializeMailingDeliveryEvent(payload),
								headers: createMessagingHeaders({
									messageId: eventId
								})
							};
						})
					});
				}

				await this.adminEventLog.recordInTransaction(transaction, {
					adminId,
					section: 'MAILINGS',
					action: 'MAILING_BROADCAST_SEND',
					description: `Ручная рассылка: ${subject}`,
					entityType: 'mailing',
					entityId: campaignId,
					entityLabel: subject,
					metadata: {
						audience: dto.audience,
						channel: requestedChannel,
						campaignId,
						recipientCount: deliveries.length,
						emailRecipientCount: emailRecipients.length,
						telegramRecipientCount: telegramRecipients.length,
						status: campaignStatus
					},
					request
				});
				return campaignId;
			},
			{ maxWait: 5000, timeout: 30_000 }
		);

		return this.getCampaign(persistedCampaignId);
	}

	async getCampaigns(page = 1, limit = 20) {
		const normalizedPage = Number.isInteger(page) && page > 0 ? page : 1;
		const normalizedLimit =
			Number.isInteger(limit) && limit > 0 ? Math.min(limit, 100) : 20;
		const [items, total] = await this.prisma.$transaction([
			this.prisma.mailingCampaign.findMany({
				orderBy: { createdAt: 'desc' },
				skip: (normalizedPage - 1) * normalizedLimit,
				take: normalizedLimit
			}),
			this.prisma.mailingCampaign.count()
		]);

		return {
			items: items.map(item => this.serializeCampaign(item)),
			total,
			page: normalizedPage,
			limit: normalizedLimit,
			totalPages: Math.max(1, Math.ceil(total / normalizedLimit))
		};
	}

	async getCampaign(id: string) {
		const campaign = await this.prisma.mailingCampaign.findUnique({
			where: { id }
		});
		if (!campaign) throw new NotFoundException('Рассылка не найдена');
		return this.serializeCampaign(campaign);
	}

	async cancelCampaign(id: string, adminId: string, request?: Request) {
		const campaign = await this.prisma.$transaction(async transaction => {
			await transaction.$executeRaw(
				Prisma.sql`
					SELECT pg_advisory_xact_lock(
						hashtextextended(CAST(${`mailing-cancel:${id}`} AS text), 0::bigint)
					)
				`
			);
			const campaign = await transaction.mailingCampaign.findUnique({
				where: { id }
			});
			if (!campaign) throw new NotFoundException('Рассылка не найдена');
			if (TERMINAL_CAMPAIGN_STATUSES.includes(campaign.status)) {
				throw new ConflictException('Рассылка уже завершена');
			}

			const now = new Date();
			const cancelled = await transaction.mailingDelivery.updateMany({
				where: {
					campaignId: id,
					status: MailingDeliveryStatus.PENDING
				},
				data: {
					status: MailingDeliveryStatus.CANCELLED,
					cancelledAt: now
				}
			});
			const updatedCampaign = await transaction.mailingCampaign.update({
				where: { id },
				data: {
					status: MailingCampaignStatus.CANCELLED,
					cancelRequestedAt: now,
					completedAt: now,
					cancelledCount: { increment: cancelled.count }
				}
			});
			await this.adminEventLog.recordInTransaction(transaction, {
				adminId,
				section: 'MAILINGS',
				action: 'MAILING_BROADCAST_CANCEL',
				description: `Отмена рассылки: ${updatedCampaign.subject}`,
				entityType: 'mailing',
				entityId: updatedCampaign.id,
				entityLabel: updatedCampaign.subject,
				metadata: {
					campaignId: updatedCampaign.id,
					status: updatedCampaign.status,
					sentCount: updatedCampaign.sentCount,
					cancelledCount: updatedCampaign.cancelledCount
				},
				request
			});
			return updatedCampaign;
		});

		return this.serializeCampaign(campaign);
	}

	private assertMatchingIdempotentRequest(
		campaign: {
			subject: string;
			message: string;
			audience: string;
			requestedChannel: string;
		},
		request: {
			subject: string;
			message: string;
			audience: string;
			requestedChannel: string;
		}
	): void {
		if (
			campaign.subject !== request.subject ||
			campaign.message !== request.message ||
			campaign.audience !== request.audience ||
			campaign.requestedChannel !== request.requestedChannel
		) {
			throw new ConflictException(
				'Idempotency-Key уже использован для другой рассылки'
			);
		}
	}

	private serializeCampaign(campaign: {
		id: string;
		subject: string;
		message: string;
		audience: string;
		requestedChannel: string;
		status: MailingCampaignStatus;
		recipientCount: number;
		sentCount: number;
		failedCount: number;
		cancelledCount: number;
		emailRecipientCount: number;
		telegramRecipientCount: number;
		startedAt: Date | null;
		completedAt: Date | null;
		cancelRequestedAt: Date | null;
		createdAt: Date;
		updatedAt: Date;
	}) {
		return {
			...campaign,
			startedAt: campaign.startedAt?.toISOString() || null,
			completedAt: campaign.completedAt?.toISOString() || null,
			cancelRequestedAt: campaign.cancelRequestedAt?.toISOString() || null,
			createdAt: campaign.createdAt.toISOString(),
			updatedAt: campaign.updatedAt.toISOString()
		};
	}

	private async getRecipientEmails(audience: AdminBroadcastAudience) {
		const now = new Date();
		const identities = await this.prisma.authIdentity.findMany({
			where: {
				type: AuthIdentityType.EMAIL,
				value: { not: '' },
				user: {
					status: UserStatus.ACTIVE,
					...(audience === 'ACTIVE_SUBSCRIPTION'
						? {
								subscription: {
									is: {
										status: SubscriptionStatus.ACTIVE,
										OR: [{ expiresAt: null }, { expiresAt: { gt: now } }]
									}
								}
							}
						: {})
				}
			},
			select: { value: true },
			orderBy: { createdAt: 'asc' }
		});
		return Array.from(
			new Set(
				identities
					.map(identity => identity.value.trim().toLowerCase())
					.filter(Boolean)
			)
		);
	}

	private async getRecipientTelegramChatIds(
		audience: AdminBroadcastAudience
	) {
		const now = new Date();
		const channels =
			await this.prisma.telegramNotificationChannel.findMany({
				where: {
					isActive: true,
					chatId: { not: '' },
					user: {
						status: UserStatus.ACTIVE,
						...(audience === 'ACTIVE_SUBSCRIPTION'
							? {
									subscription: {
										is: {
											status: SubscriptionStatus.ACTIVE,
											OR: [{ expiresAt: null }, { expiresAt: { gt: now } }]
										}
									}
								}
							: {})
					}
				},
				select: { chatId: true },
				orderBy: { createdAt: 'asc' }
			});
		return Array.from(
			new Set(
				channels.map(channel => channel.chatId.trim()).filter(Boolean)
			)
		);
	}
}
