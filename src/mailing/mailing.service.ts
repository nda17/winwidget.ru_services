import { EmailService } from '@/email/email.service';
import {
	AdminBroadcastAudience,
	AdminBroadcastChannel,
	SendAdminBroadcastDto
} from '@/mailing/dto/send-admin-broadcast.dto';
import { PrismaService } from '@/prisma.service';
import { TelegramBotService } from '@/telegram-bot/telegram-bot.service';
import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import {
	AuthIdentityType,
	SubscriptionStatus,
	UserStatus
} from '@prisma/client';

export interface AdminBroadcastResult {
	audience: AdminBroadcastAudience;
	channel: AdminBroadcastChannel;
	recipientCount: number;
	sentCount: number;
	failedCount: number;
	emailRecipientCount: number;
	emailSentCount: number;
	emailFailedCount: number;
	telegramRecipientCount: number;
	telegramSentCount: number;
	telegramFailedCount: number;
	executedAt: string;
}

@Injectable()
export class MailingService {
	private readonly logger = new Logger(MailingService.name);

	constructor(
		private readonly prisma: PrismaService,
		private readonly emailService: EmailService,
		private readonly telegramBotService: TelegramBotService
	) {}

	async sendAdminBroadcast(
		dto: SendAdminBroadcastDto
	): Promise<AdminBroadcastResult> {
		const subject = dto.subject.trim();
		const message = dto.message.trim();
		const channel = dto.channel ?? 'EMAIL';

		if (!subject || !message) {
			throw new BadRequestException('Тема и текст письма обязательны');
		}

		const emailRecipients =
			channel === 'EMAIL' || channel === 'BOTH'
				? await this.getRecipientEmails(dto.audience)
				: [];
		const telegramRecipients =
			channel === 'TELEGRAM' || channel === 'BOTH'
				? await this.getRecipientTelegramChatIds(dto.audience)
				: [];
		const emailResult = await this.sendEmailBroadcast(
			emailRecipients,
			subject,
			message
		);
		const telegramResult = await this.sendTelegramBroadcast(
			telegramRecipients,
			subject,
			message
		);

		return {
			audience: dto.audience,
			channel,
			recipientCount: emailRecipients.length + telegramRecipients.length,
			sentCount: emailResult.sentCount + telegramResult.sentCount,
			failedCount: emailResult.failedCount + telegramResult.failedCount,
			emailRecipientCount: emailRecipients.length,
			emailSentCount: emailResult.sentCount,
			emailFailedCount: emailResult.failedCount,
			telegramRecipientCount: telegramRecipients.length,
			telegramSentCount: telegramResult.sentCount,
			telegramFailedCount: telegramResult.failedCount,
			executedAt: new Date().toISOString()
		};
	}

	private async sendEmailBroadcast(
		recipients: string[],
		subject: string,
		message: string
	) {
		let sentCount = 0;
		let failedCount = 0;
		const batchSize = 5;

		for (let i = 0; i < recipients.length; i += batchSize) {
			const batch = recipients.slice(i, i + batchSize);

			await Promise.all(
				batch.map(async email => {
					try {
						await this.emailService.sendAdminBroadcast(email, {
							subject,
							message
						});
						sentCount += 1;
					} catch (error) {
						failedCount += 1;
						this.logger.warn(
							`Admin email broadcast failed for ${email}: ${
								error instanceof Error ? error.message : String(error)
							}`
						);
					}
				})
			);
		}

		return {
			sentCount,
			failedCount
		};
	}

	private async sendTelegramBroadcast(
		recipients: string[],
		subject: string,
		message: string
	) {
		let sentCount = 0;
		let failedCount = 0;
		const batchSize = 5;
		const telegramMessages = this.buildTelegramBroadcastMessages(
			subject,
			message
		);

		for (let i = 0; i < recipients.length; i += batchSize) {
			const batch = recipients.slice(i, i + batchSize);

			await Promise.all(
				batch.map(async chatId => {
					try {
						for (const telegramMessage of telegramMessages) {
							await this.telegramBotService.sendInfoBotMessage(
								chatId,
								telegramMessage,
								{ parseMode: null }
							);
						}
						sentCount += 1;
					} catch (error) {
						failedCount += 1;

						if (
							this.telegramBotService.isRecipientUnavailableError(error)
						) {
							await this.telegramBotService
								.deactivateNotificationChannelByChatId(chatId)
								.catch(() => undefined);
						}

						this.logger.warn(
							`Admin Telegram broadcast failed for ${chatId}: ${
								error instanceof Error ? error.message : String(error)
							}`
						);
					}
				})
			);
		}

		return {
			sentCount,
			failedCount
		};
	}

	private async getRecipientEmails(audience: AdminBroadcastAudience) {
		const now = new Date();
		const identities = await this.prisma.authIdentity.findMany({
			where: {
				type: AuthIdentityType.EMAIL,
				value: {
					not: ''
				},
				user: {
					status: UserStatus.ACTIVE,
					...(audience === 'ACTIVE_SUBSCRIPTION'
						? {
								subscription: {
									is: {
										status: SubscriptionStatus.ACTIVE,
										OR: [
											{
												expiresAt: null
											},
											{
												expiresAt: {
													gt: now
												}
											}
										]
									}
								}
							}
						: {})
				}
			},
			select: {
				value: true
			},
			orderBy: {
				createdAt: 'asc'
			}
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
					chatId: {
						not: ''
					},
					user: {
						status: UserStatus.ACTIVE,
						...(audience === 'ACTIVE_SUBSCRIPTION'
							? {
									subscription: {
										is: {
											status: SubscriptionStatus.ACTIVE,
											OR: [
												{
													expiresAt: null
												},
												{
													expiresAt: {
														gt: now
													}
												}
											]
										}
									}
								}
							: {})
					}
				},
				select: {
					chatId: true
				},
				orderBy: {
					createdAt: 'asc'
				}
			});

		return Array.from(
			new Set(
				channels.map(channel => channel.chatId.trim()).filter(Boolean)
			)
		);
	}

	private buildTelegramBroadcastMessages(
		subject: string,
		message: string
	) {
		return this.splitTelegramMessage(message).map((chunk, index) =>
			index === 0 ? [subject, '', chunk].join('\n') : chunk
		);
	}

	private splitTelegramMessage(message: string) {
		const maxLength = 3500;
		const chunks: string[] = [];
		let rest = message;

		while (rest.length > maxLength) {
			const slice = rest.slice(0, maxLength);
			const lastLineBreak = slice.lastIndexOf('\n');
			const splitAt =
				lastLineBreak > maxLength * 0.6 ? lastLineBreak + 1 : maxLength;

			chunks.push(rest.slice(0, splitAt).trimEnd());
			rest = rest.slice(splitAt).trimStart();
		}

		if (rest) {
			chunks.push(rest);
		}

		return chunks.length ? chunks : [''];
	}
}
