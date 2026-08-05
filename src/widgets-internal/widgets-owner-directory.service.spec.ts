import { PrismaService } from '@/prisma.service';
import { AuthIdentityType, Plan, Role, UserStatus } from '@prisma/client';
import { WidgetsOwnerDirectoryService } from './widgets-owner-directory.service';

describe('WidgetsOwnerDirectoryService', () => {
	it('returns only the bounded owner data needed by Widgets admin views', async () => {
		const findMany = jest.fn().mockResolvedValue([
			{
				id: 'user-1',
				name: 'Owner',
				status: UserStatus.ACTIVE,
				deletedAt: null,
				rights: [Role.USER],
				authIdentities: [
					{ type: AuthIdentityType.EMAIL, value: 'owner@example.test' },
					{ type: AuthIdentityType.PHONE, value: '+79990000000' }
				],
				subscription: null
			}
		]);
		const service = new WidgetsOwnerDirectoryService({
			user: { findMany }
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
		expect(findMany).toHaveBeenCalledWith(
			expect.objectContaining({ where: { id: { in: ['user-1'] } } })
		);
	});

	it('searches owner PII and plan with a bounded stable keyset page', async () => {
		const findMany = jest.fn().mockResolvedValue([
			{
				id: 'user-20',
				name: 'Owner',
				status: UserStatus.ACTIVE,
				deletedAt: null,
				rights: [Role.USER],
				authIdentities: [
					{ type: AuthIdentityType.EMAIL, value: 'owner@example.test' }
				],
				subscription: { plan: Plan.EASY }
			}
		]);
		const service = new WidgetsOwnerDirectoryService({
			user: { findMany }
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
				{
					id: 'user-20',
					name: 'Owner',
					status: UserStatus.ACTIVE,
					deletedAt: null,
					rights: [Role.USER],
					email: 'owner@example.test',
					phone: null,
					subscription: { plan: Plan.EASY }
				}
			],
			nextAfterId: 'user-20'
		});
		expect(findMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({
					deletedAt: null,
					id: { gt: 'user-10' },
					subscription: { is: { plan: Plan.EASY } },
					OR: expect.arrayContaining([
						{
							id: {
								contains: 'OWNER',
								mode: 'insensitive'
							}
						},
						{
							name: {
								contains: 'OWNER',
								mode: 'insensitive'
							}
						}
					])
				}),
				orderBy: { id: 'asc' },
				take: 1
			})
		);
	});

	it('filters owners without subscriptions and terminates a short page', async () => {
		const findMany = jest.fn().mockResolvedValue([]);
		const service = new WidgetsOwnerDirectoryService({
			user: { findMany }
		} as unknown as PrismaService);

		await expect(
			service.search({ plan: 'NONE', limit: 100 })
		).resolves.toEqual({ items: [], nextAfterId: null });
		expect(findMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: { deletedAt: null, subscription: { is: null } },
				orderBy: { id: 'asc' },
				take: 100
			})
		);
	});
});
