import { PrismaService } from '@/prisma.service';
import { Injectable } from '@nestjs/common';
import { AuthIdentityType, Prisma } from '@prisma/client';
import {
	SearchWidgetOwnersDto,
	WidgetOwnerSearchPlan
} from './widgets-owner-directory.dto';

const ownerDirectoryUserSelect = Prisma.validator<Prisma.UserSelect>()({
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
	}
});

const ownerDirectorySubscriptionSelect =
	Prisma.validator<Prisma.BillingSubscriptionReadProjectionSelect>()({
		id: true,
		userId: true,
		plan: true,
		billingPeriod: true,
		status: true,
		startsAt: true,
		expiresAt: true,
		periodResetsAt: true,
		createdAt: true,
		updatedAt: true
	});

type OwnerDirectoryUser = Prisma.UserGetPayload<{
	select: typeof ownerDirectoryUserSelect;
}>;
type OwnerDirectorySubscription =
	Prisma.BillingSubscriptionReadProjectionGetPayload<{
		select: typeof ownerDirectorySubscriptionSelect;
	}>;
type PublicOwnerDirectorySubscription = Omit<
	OwnerDirectorySubscription,
	'userId'
>;

@Injectable()
export class WidgetsOwnerDirectoryService {
	constructor(private readonly prisma: PrismaService) {}

	async resolve(userIds: string[]) {
		const [users, subscriptions] = await Promise.all([
			this.prisma.user.findMany({
				where: { id: { in: userIds } },
				select: ownerDirectoryUserSelect
			}),
			this.prisma.billingSubscriptionReadProjection.findMany({
				where: { userId: { in: userIds } },
				select: ownerDirectorySubscriptionSelect
			})
		]);
		const subscriptionsByUserId = new Map(
			subscriptions.map(({ userId, ...subscription }) => [
				userId,
				subscription
			])
		);

		return {
			items: users.map(user =>
				this.serialize(user, subscriptionsByUserId.get(user.id) ?? null)
			)
		};
	}

	async search(input: SearchWidgetOwnersDto) {
		const userIds = await this.findSearchUserIds(input);
		if (!userIds.length) return { items: [], nextAfterId: null };
		const [users, subscriptions] = await Promise.all([
			this.prisma.user.findMany({
				where: { id: { in: userIds } },
				select: ownerDirectoryUserSelect
			}),
			this.prisma.billingSubscriptionReadProjection.findMany({
				where: { userId: { in: userIds } },
				select: ownerDirectorySubscriptionSelect
			})
		]);
		const usersById = new Map(users.map(user => [user.id, user]));
		const subscriptionsByUserId = new Map(
			subscriptions.map(({ userId, ...subscription }) => [
				userId,
				subscription
			])
		);
		const items = userIds.flatMap(userId => {
			const user = usersById.get(userId);
			return user
				? [this.serialize(user, subscriptionsByUserId.get(userId) ?? null)]
				: [];
		});
		return {
			items,
			nextAfterId:
				userIds.length === input.limit
					? (userIds[userIds.length - 1] ?? null)
					: null
		};
	}

	private findSearchUserIds(
		input: SearchWidgetOwnersDto
	): Promise<string[]> {
		const search = input.search?.trim();
		const afterFilter = input.afterId
			? Prisma.sql`AND u.id > ${input.afterId}`
			: Prisma.empty;
		const searchFilter = search
			? Prisma.sql`
				AND (
					u.id ILIKE ${`%${search}%`}
					OR u.name ILIKE ${`%${search}%`}
					OR EXISTS (
						SELECT 1
						FROM auth_identities identity
						WHERE identity.user_id = u.id
							AND identity.type IN (
								'EMAIL'::"AuthIdentityType",
								'PHONE'::"AuthIdentityType"
							)
							AND identity.value ILIKE ${`%${search}%`}
					)
				)
			`
			: Prisma.empty;
		const planFilter = this.getPlanFilter(input.plan);
		return this.prisma
			.$queryRaw<Array<{ id: string }>>(
				Prisma.sql`
			SELECT u.id
			FROM "User" u
			WHERE u.deleted_at IS NULL
				${afterFilter}
				${searchFilter}
				${planFilter}
			ORDER BY u.id ASC
			LIMIT ${input.limit}
		`
			)
			.then(rows => rows.map(row => row.id));
	}

	private getPlanFilter(
		plan: WidgetOwnerSearchPlan | undefined
	): Prisma.Sql {
		if (!plan) return Prisma.empty;
		if (plan === 'NONE') {
			return Prisma.sql`
				AND NOT EXISTS (
					SELECT 1
					FROM billing_subscription_read_projections subscription
					WHERE subscription.user_id = u.id
				)
			`;
		}
		return Prisma.sql`
			AND EXISTS (
				SELECT 1
				FROM billing_subscription_read_projections subscription
				WHERE subscription.user_id = u.id
					AND subscription.plan = ${plan}::"Plan"
			)
		`;
	}

	private serialize(
		user: OwnerDirectoryUser,
		subscription: PublicOwnerDirectorySubscription | null
	) {
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
			subscription
		};
	}
}
