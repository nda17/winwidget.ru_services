import { PrismaService } from '@/prisma.service';
import { Injectable } from '@nestjs/common';
import { AuthIdentityType, Plan, Prisma } from '@prisma/client';
import {
	SearchWidgetOwnersDto,
	WidgetOwnerSearchPlan
} from './widgets-owner-directory.dto';

const ownerDirectorySelect = Prisma.validator<Prisma.UserSelect>()({
	id: true,
	name: true,
	status: true,
	deletedAt: true,
	rights: true,
	authIdentities: {
		where: {
			type: {
				in: [AuthIdentityType.EMAIL, AuthIdentityType.PHONE]
			}
		},
		select: { type: true, value: true }
	},
	subscription: {
		select: {
			id: true,
			plan: true,
			billingPeriod: true,
			status: true,
			startsAt: true,
			expiresAt: true,
			periodResetsAt: true,
			createdAt: true,
			updatedAt: true
		}
	}
});

type OwnerDirectoryRecord = Prisma.UserGetPayload<{
	select: typeof ownerDirectorySelect;
}>;

@Injectable()
export class WidgetsOwnerDirectoryService {
	constructor(private readonly prisma: PrismaService) {}

	async resolve(userIds: string[]) {
		const users = await this.prisma.user.findMany({
			where: { id: { in: userIds } },
			select: ownerDirectorySelect
		});

		return {
			items: users.map(user => this.serialize(user))
		};
	}

	async search(input: SearchWidgetOwnersDto) {
		const search = input.search?.trim() || null;
		const users = await this.prisma.user.findMany({
			where: {
				deletedAt: null,
				...(input.afterId ? { id: { gt: input.afterId } } : {}),
				...this.planWhere(input.plan),
				...(search
					? {
							OR: [
								{
									id: {
										contains: search,
										mode: 'insensitive' as const
									}
								},
								{
									name: {
										contains: search,
										mode: 'insensitive' as const
									}
								},
								{
									authIdentities: {
										some: {
											type: {
												in: [
													AuthIdentityType.EMAIL,
													AuthIdentityType.PHONE
												]
											},
											value: {
												contains: search,
												mode: 'insensitive' as const
											}
										}
									}
								}
							]
						}
					: {})
			},
			orderBy: { id: 'asc' },
			take: input.limit,
			select: ownerDirectorySelect
		});
		return {
			items: users.map(user => this.serialize(user)),
			nextAfterId:
				users.length === input.limit
					? users[users.length - 1]?.id || null
					: null
		};
	}

	private planWhere(
		plan: WidgetOwnerSearchPlan | undefined
	): Prisma.UserWhereInput {
		if (!plan) return {};
		if (plan === 'NONE') return { subscription: { is: null } };
		return { subscription: { is: { plan: plan as Plan } } };
	}

	private serialize(user: OwnerDirectoryRecord) {
		return {
			id: user.id,
			name: user.name,
			status: user.status,
			deletedAt: user.deletedAt,
			rights: user.rights,
			email:
				user.authIdentities.find(
					identity => identity.type === AuthIdentityType.EMAIL
				)?.value ?? null,
			phone:
				user.authIdentities.find(
					identity => identity.type === AuthIdentityType.PHONE
				)?.value ?? null,
			subscription: user.subscription
		};
	}
}
