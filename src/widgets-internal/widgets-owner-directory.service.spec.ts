import type { PrismaService } from '@/prisma.service';
import { AuthIdentityType, Plan, Role, UserStatus } from '@prisma/client';
import { WidgetsOwnerDirectoryService } from './widgets-owner-directory.service';

describe('WidgetsOwnerDirectoryService', () => {
	const user = () => ({
		id: 'user-1',
		name: 'Owner',
		status: UserStatus.ACTIVE,
		deletedAt: null,
		rights: [Role.USER],
		authIdentities: [
			{ type: AuthIdentityType.EMAIL, value: 'owner@example.test' },
			{ type: AuthIdentityType.PHONE, value: '+79990000000' }
		]
	});

	it('resolves bounded owner data composed with the Billing projection', async () => {
		const userFindMany = jest.fn().mockResolvedValue([user()]);
		const subscriptionFindMany = jest.fn().mockResolvedValue([]);
		const service = new WidgetsOwnerDirectoryService({
			user: { findMany: userFindMany },
			billingSubscriptionReadProjection: {
				findMany: subscriptionFindMany
			}
		} as unknown as PrismaService);

		await expect(service.resolve(['user-1'])).resolves.toEqual({
			items: [
				{
					id: 'user-1',
					name: 'Owner',
					status: UserStatus.ACTIVE,
					deletedAt: null,
					rights: [Role.USER],
					email: 'owner@example.test',
					phone: '+79990000000',
					subscription: null
				}
			]
		});
		expect(userFindMany).toHaveBeenCalledWith(
			expect.objectContaining({ where: { id: { in: ['user-1'] } } })
		);
		expect(subscriptionFindMany).toHaveBeenCalledWith(
			expect.objectContaining({ where: { userId: { in: ['user-1'] } } })
		);
	});

	it('searches owner PII and plan through a stable projection-backed keyset page', async () => {
		const queryRaw = jest.fn().mockResolvedValue([{ id: 'user-20' }]);
		const userFindMany = jest.fn().mockResolvedValue([
			{
				...user(),
				id: 'user-20',
				authIdentities: [
					{
						type: AuthIdentityType.EMAIL,
						value: 'owner@example.test'
					}
				]
			}
		]);
		const subscription = { userId: 'user-20', plan: Plan.EASY };
		const subscriptionFindMany = jest
			.fn()
			.mockResolvedValue([subscription]);
		const service = new WidgetsOwnerDirectoryService({
			$queryRaw: queryRaw,
			user: { findMany: userFindMany },
			billingSubscriptionReadProjection: {
				findMany: subscriptionFindMany
			}
		} as unknown as PrismaService);

		await expect(
			service.search({
				search: '  OWNER  ',
				plan: 'EASY',
				afterId: 'user-10',
				limit: 1
			})
		).resolves.toEqual({
			items: [
				expect.objectContaining({
					id: 'user-20',
					email: 'owner@example.test',
					phone: null,
					subscription: { plan: Plan.EASY }
				})
			],
			nextAfterId: 'user-20'
		});
		const query = queryRaw.mock.calls[0][0];
		const sql = query.strings.join(' ');
		expect(sql).toContain('billing_subscription_read_projections');
		expect(sql).toContain('auth_identities');
		expect(sql).not.toMatch(/\bsubscriptions\b/);
		expect(query.values).toEqual(
			expect.arrayContaining(['user-10', '%OWNER%', 'EASY', 1])
		);
	});

	it('filters owners without a Billing projection and terminates a short page', async () => {
		const queryRaw = jest.fn().mockResolvedValue([]);
		const userFindMany = jest.fn();
		const service = new WidgetsOwnerDirectoryService({
			$queryRaw: queryRaw,
			user: { findMany: userFindMany },
			billingSubscriptionReadProjection: { findMany: jest.fn() }
		} as unknown as PrismaService);

		await expect(
			service.search({ plan: 'NONE', limit: 100 })
		).resolves.toEqual({ items: [], nextAfterId: null });
		const query = queryRaw.mock.calls[0][0];
		expect(query.strings.join(' ')).toContain('NOT EXISTS');
		expect(query.strings.join(' ')).toContain(
			'billing_subscription_read_projections'
		);
		expect(userFindMany).not.toHaveBeenCalled();
	});
});
