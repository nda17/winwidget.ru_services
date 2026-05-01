import { EmailService } from '@/email/email.service';
import {
	AdminBroadcastAudience,
	SendAdminBroadcastDto
} from '@/mailing/dto/send-admin-broadcast.dto';
import { PrismaService } from '@/prisma.service';
import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import {
	AuthIdentityType,
	SubscriptionStatus,
	UserStatus
} from '@prisma/client';

export interface AdminBroadcastResult {
	audience: AdminBroadcastAudience;
	recipientCount: number;
	sentCount: number;
	failedCount: number;
	executedAt: string;
}

@Injectable()
export class MailingService {
	private readonly logger = new Logger(MailingService.name);

	constructor(
		private readonly prisma: PrismaService,
		private readonly emailService: EmailService
	) {}

	async sendAdminBroadcast(
		dto: SendAdminBroadcastDto
	): Promise<AdminBroadcastResult> {
		const subject = dto.subject.trim();
		const message = dto.message.trim();

		if (!subject || !message) {
			throw new BadRequestException('Тема и текст письма обязательны');
		}

		const recipients = await this.getRecipientEmails(dto.audience);
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
							`Admin broadcast failed for ${email}: ${
								error instanceof Error ? error.message : String(error)
							}`
						);
					}
				})
			);
		}

		return {
			audience: dto.audience,
			recipientCount: recipients.length,
			sentCount,
			failedCount,
			executedAt: new Date().toISOString()
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
}
