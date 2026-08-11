import { PrismaService } from '@/prisma.service';
import { BadRequestException, Injectable } from '@nestjs/common';
import { AuthIdentityType, UserStatus } from '@prisma/client';

const MAX_USER_IDS = 200;

@Injectable()
export class BillingIdentityDirectoryService {
	constructor(private readonly prisma: PrismaService) {}

	async resolve(body: unknown) {
		const userIds = this.parseUserIds(body);
		const users = await this.prisma.user.findMany({
			where: { id: { in: userIds } },
			include: {
				authIdentities: {
					where: {
						type: {
							in: [AuthIdentityType.EMAIL, AuthIdentityType.PHONE]
						}
					},
					orderBy: { createdAt: 'asc' }
				},
				telegramNotificationChannel: true
			}
		});
		const byId = new Map(users.map(user => [user.id, user]));

		return {
			schemaVersion: 1 as const,
			users: userIds.flatMap(userId => {
				const user = byId.get(userId);
				if (!user) return [];
				const email = user.authIdentities.find(
					identity => identity.type === AuthIdentityType.EMAIL
				)?.value;
				const phone = user.authIdentities.find(
					identity => identity.type === AuthIdentityType.PHONE
				)?.value;
				const channel = user.telegramNotificationChannel;
				return [
					{
						id: user.id,
						name: user.name,
						email: email?.trim() || null,
						phone: phone?.trim() || null,
						status: user.status,
						deletedAt: user.deletedAt?.toISOString() ?? null,
						roles: user.rights,
						active: user.status === UserStatus.ACTIVE && !user.deletedAt,
						telegramChatId:
							channel?.isActive && channel.chatId.trim()
								? channel.chatId.trim()
								: null,
						telegramChannelActive: channel?.isActive ?? false,
						createdAt: user.createdAt.toISOString(),
						updatedAt: user.updatedAt.toISOString()
					}
				];
			}),
			missingUserIds: userIds.filter(userId => !byId.has(userId))
		};
	}

	private parseUserIds(body: unknown): string[] {
		if (!body || typeof body !== 'object' || Array.isArray(body)) {
			throw new BadRequestException('Invalid Billing identity request');
		}
		const input = body as Record<string, unknown>;
		if (
			Object.keys(input).some(
				key => key !== 'schemaVersion' && key !== 'userIds'
			) ||
			input.schemaVersion !== 1 ||
			!Array.isArray(input.userIds) ||
			input.userIds.length < 1 ||
			input.userIds.length > MAX_USER_IDS
		) {
			throw new BadRequestException('Invalid Billing identity request');
		}
		const userIds = input.userIds.map(value =>
			typeof value === 'string' ? value.trim() : ''
		);
		if (userIds.some(value => !value || value.length > 255)) {
			throw new BadRequestException('Invalid Billing identity request');
		}
		return [...new Set(userIds)];
	}
}
