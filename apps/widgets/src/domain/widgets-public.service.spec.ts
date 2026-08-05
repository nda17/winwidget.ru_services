import { NotFoundException } from '@nestjs/common';
import { EntitlementPlan } from '@prisma/widgets-client';
import { WidgetType } from './widgets-domain.types';
import { WidgetsPublicService } from './widgets-public.service';
import { safePublicKey } from './widgets-domain.util';
import { WidgetsTypeRegistryService } from './widgets-type-registry.service';

const publicWidget = (type: WidgetType) => ({
	id: `widget-${type.toLowerCase()}`,
	userId: 'user-1',
	publicKey: 'abcdef123456',
	name: 'Widget',
	publishedAt: new Date('2026-08-04T12:00:00.000Z'),
	publishedVersion: 1,
	isActive: true,
	installDomain: 'example.test',
	config: { dataType: 'NONE' }
});

describe('WidgetsPublicService parity', () => {
	it('returns the legacy 404 for a malformed canonical public key', () => {
		expect(() => safePublicKey('invalid')).toThrow(NotFoundException);
	});

	it.each([
		[WidgetType.CALCULATOR, false],
		[WidgetType.TIMER, true],
		[WidgetType.STOP_OFFER, true],
		[WidgetType.ONLINE_CONSULTANT, true]
	] as const)(
		'preserves NONE lead-limit visibility for %s',
		async (type, expectedVisible) => {
			const widget = publicWidget(type);
			const publicConfig = jest.fn().mockReturnValue({ isActive: true });
			const repository = {
				findByPublicKey: jest.fn().mockResolvedValue(widget),
				findDuplicateLead: jest.fn(),
				client: jest.fn()
			};
			const quota = {
				snapshot: jest.fn().mockResolvedValue({
					entitlement: {
						plan: EntitlementPlan.EASY,
						unlimited: false,
						maxLeadsPerPeriod: 10
					},
					counter: { leadCount: 10 }
				})
			};
			const registry = {
				for: jest.fn().mockReturnValue({
					publicDuplicateRule: jest.fn().mockReturnValue(null),
					publicConfig
				})
			};
			const service = new WidgetsPublicService(
				repository as never,
				quota as never,
				{} as never,
				{} as never,
				registry as never
			);

			await expect(
				service.config(
					type,
					widget.publicKey,
					'example.test',
					false,
					'127.0.0.1'
				)
			).resolves.toEqual({ isActive: expectedVisible });
			expect(publicConfig).toHaveBeenCalledTimes(expectedVisible ? 1 : 0);
		}
	);

	it('uses the transactionally refetched widget for the limit event', async () => {
		const initial = {
			...publicWidget(WidgetType.WHEEL),
			name: 'Initial widget',
			config: {
				dataType: 'PHONE',
				integrations: { email: 'initial@example.test' }
			}
		};
		const refetched = {
			...initial,
			name: 'Refetched widget',
			config: {
				dataType: 'PHONE',
				integrations: { email: 'refetched@example.test' }
			}
		};
		const transaction = {};
		const repository = {
			findByPublicKey: jest
				.fn()
				.mockResolvedValueOnce(initial)
				.mockResolvedValueOnce(refetched),
			findDuplicateLead: jest.fn().mockResolvedValue(false),
			createLead: jest.fn().mockResolvedValue({
				id: 'lead-1',
				createdAt: new Date('2026-08-04T12:00:00.000Z')
			})
		};
		const enqueueLimitReached = jest.fn().mockResolvedValue(undefined);
		const events = {
			enqueueLeadIntegrations: jest.fn().mockResolvedValue(undefined),
			enqueueLimitReached
		};
		const reporting = {
			enqueueLead: jest.fn().mockResolvedValue(undefined),
			leadAggregateType: jest.fn().mockReturnValue('widgets.lead.wheel'),
			aggregateId: jest.fn().mockReturnValue('wheel:lead-1')
		};
		const quota = {
			withLeadCreation: jest
				.fn()
				.mockImplementation(
					async (
						_userId: string,
						_input: unknown,
						operation: (client: unknown) => Promise<{ value: unknown }>,
						onLimit: (
							client: unknown,
							limit: number,
							periodKey: string
						) => Promise<unknown>
					) => {
						const result = await operation(transaction);
						await onLimit(transaction, 10, 'period-1');
						return {
							value: result.value,
							newCount: 10,
							limitReached: true
						};
					}
				)
		};
		const service = new WidgetsPublicService(
			repository as never,
			quota as never,
			events as never,
			reporting as never,
			new WidgetsTypeRegistryService()
		);

		await service.submitLead(
			WidgetType.WHEEL,
			initial.publicKey,
			{ phone: '+79990000000', bonus: '10%' },
			'127.0.0.1',
			'example.test',
			true,
			'correlation-1'
		);

		expect(enqueueLimitReached).toHaveBeenCalledWith(
			transaction,
			expect.objectContaining({
				widget: refetched,
				config: expect.objectContaining({
					integrations: expect.objectContaining({
						email: 'refetched@example.test'
					})
				})
			})
		);
	});
});
