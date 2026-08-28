import { NotFoundException } from '@nestjs/common';
import { EntitlementPlan } from '@prisma/widgets-client';
import { createHash } from 'node:crypto';
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
	it('returns 404 for a malformed canonical public key', () => {
		expect(() => safePublicKey('invalid')).toThrow(NotFoundException);
	});

	it.each([
		[WidgetType.CALCULATOR, false],
		[WidgetType.TIMER, true],
		[WidgetType.STOP_OFFER, true],
		[WidgetType.AI_CONSULTANT, true]
	] as const)(
		'keeps no-contact widgets visible independently of the lead quota for %s',
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
				}),
				aiSnapshot: jest.fn().mockResolvedValue({
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
				registry as never,
				{
					siteKey: () => 'turnstile-site-key',
					action: () => 'ai-consultant-session'
				} as never,
				{} as never
			);

			await expect(
				service.config(
					type,
					widget.publicKey,
					'example.test',
					false,
					'127.0.0.1'
				)
			).resolves.toEqual(
				type === WidgetType.AI_CONSULTANT
					? {
							isActive: true,
							turnstileSiteKey: 'turnstile-site-key',
							turnstileAction: 'ai-consultant-session'
						}
					: { isActive: expectedVisible }
			);
			expect(publicConfig).toHaveBeenCalledTimes(expectedVisible ? 1 : 0);
			if (type === WidgetType.AI_CONSULTANT) {
				expect(quota.aiSnapshot).toHaveBeenCalledWith(widget.userId);
				expect(quota.snapshot).not.toHaveBeenCalled();
			}
		}
	);

	it('rejects an exhausted AI config IP bucket before repository and quota work', async () => {
		const repository = { findByPublicKey: jest.fn() };
		const quota = { aiSnapshot: jest.fn() };
		const service = new WidgetsPublicService(
			repository as never,
			quota as never,
			{} as never,
			{} as never,
			{} as never,
			{} as never,
			{} as never
		);
		const source = createHash('sha256')
			.update('203.0.113.7')
			.digest('base64url');
		(
			service as unknown as {
				publicAiConfigRates: Map<
					string,
					{ count: number; expiresAt: number }
				>;
			}
		).publicAiConfigRates.set(`ai-config:ip:${source}`, {
			count: 120,
			expiresAt: Date.now() + 60_000
		});

		await expect(
			service.config(
				WidgetType.AI_CONSULTANT,
				'abcdef123456',
				'example.test',
				false,
				'203.0.113.7'
			)
		).rejects.toMatchObject({ status: 429 });
		expect(repository.findByPublicKey).not.toHaveBeenCalled();
		expect(quota.aiSnapshot).not.toHaveBeenCalled();
	});

	it('uses the owner-published callback channel and normalizes the OTP destination', async () => {
		const widget = {
			...publicWidget(WidgetType.CALLBACK),
			config: { verificationMode: 'EMAIL', launcherEnabled: false }
		};
		const repository = {
			findByPublicKey: jest.fn().mockResolvedValue(widget)
		};
		const quota = {
			snapshot: jest.fn().mockResolvedValue({
				entitlement: { unlimited: false, maxLeadsPerPeriod: 10 },
				counter: { leadCount: 2 }
			})
		};
		const callbackOtp = {
			start: jest.fn().mockResolvedValue({
				challengeId: '11111111-1111-4111-8111-111111111111',
				expiresAt: '2026-08-28T12:05:00.000Z',
				resendAvailableAt: '2026-08-28T12:01:00.000Z',
				destinationHint: 'v•••@example.test'
			})
		};
		const service = new WidgetsPublicService(
			repository as never,
			quota as never,
			{} as never,
			{} as never,
			{} as never,
			{} as never,
			callbackOtp as never
		);

		await expect(
			service.startCallbackVerification(
				widget.publicKey,
				{ email: ' Visitor@Example.Test ' },
				'203.0.113.10',
				'example.test',
				false
			)
		).resolves.toMatchObject({
			challengeId: '11111111-1111-4111-8111-111111111111'
		});
		expect(callbackOtp.start).toHaveBeenCalledWith(
			expect.objectContaining({
				callbackId: widget.id,
				ownerId: widget.userId,
				publishedVersion: 1,
				channel: 'EMAIL',
				destination: 'visitor@example.test',
				ip: '203.0.113.10'
			})
		);
		expect(quota.snapshot).toHaveBeenCalledWith(widget.userId);

		await expect(
			service.startCallbackVerification(
				widget.publicKey,
				{ phone: '+79991234567' },
				'203.0.113.10',
				'example.test',
				false
			)
		).rejects.toMatchObject({ status: 400 });
		expect(callbackOtp.start).toHaveBeenCalledTimes(1);
	});

	it('binds EMAIL verification without persisting email in the callback lead', async () => {
		const callback = {
			...publicWidget(WidgetType.CALLBACK),
			config: {
				verificationMode: 'EMAIL',
				launcherEnabled: true,
				filterDuplicates: false,
				timeSlots: ['11:00–13:00']
			}
		};
		const transaction = {};
		const createdLead = {
			id: 'lead-1',
			phone: '+79991234567',
			createdAt: new Date('2026-08-28T12:00:00.000Z')
		};
		const repository = {
			findByPublicKey: jest.fn().mockResolvedValue(callback),
			findDuplicateLead: jest.fn().mockResolvedValue(false),
			createLead: jest.fn().mockResolvedValue(createdLead)
		};
		const events = {
			enqueueLeadIntegrations: jest.fn().mockResolvedValue(undefined),
			enqueueLimitReached: jest.fn()
		};
		const reporting = {
			enqueueLead: jest.fn().mockResolvedValue(undefined),
			leadAggregateType: jest
				.fn()
				.mockReturnValue('widgets.lead.callback'),
			aggregateId: jest.fn().mockReturnValue('callback:lead-1')
		};
		const callbackOtp = {
			precheckOrReplay: jest.fn().mockResolvedValue(null),
			findReplayInTransaction: jest.fn().mockResolvedValue(null),
			assertConsumable: jest.fn().mockResolvedValue(undefined),
			consume: jest.fn().mockResolvedValue(undefined)
		};
		const quota = {
			withLeadCreation: jest
				.fn()
				.mockImplementation(
					async (_userId, _input, operation, _onLimit, findExisting) => {
						expect(await findExisting(transaction)).toBeNull();
						const result = await operation(transaction);
						return {
							value: result.value,
							newCount: 1,
							limitReached: false
						};
					}
				)
		};
		const service = new WidgetsPublicService(
			repository as never,
			quota as never,
			events as never,
			reporting as never,
			new WidgetsTypeRegistryService(),
			{} as never,
			callbackOtp as never
		);
		const challengeId = '11111111-1111-4111-8111-111111111111';

		await expect(
			service.submitLead(
				WidgetType.CALLBACK,
				callback.publicKey,
				{
					phone: '+7 (999) 123-45-67',
					email: 'Visitor@Example.Test',
					timeSlot: '11:00–13:00',
					timezone: 'Europe/Moscow',
					url: 'https://example.test/callback',
					challengeId,
					code: '123456'
				},
				'203.0.113.10',
				'example.test',
				false,
				'correlation-1'
			)
		).resolves.toEqual({ success: true, lead: createdLead });
		expect(repository.createLead).toHaveBeenCalledWith(
			WidgetType.CALLBACK,
			callback.id,
			expect.not.objectContaining({ email: expect.anything() }),
			transaction
		);
		expect(repository.createLead).toHaveBeenCalledWith(
			WidgetType.CALLBACK,
			callback.id,
			expect.objectContaining({
				phone: '+79991234567',
				verificationMode: 'EMAIL',
				verificationChallengeId: challengeId
			}),
			transaction
		);
		expect(callbackOtp.consume).toHaveBeenCalledWith(
			transaction,
			expect.objectContaining({
				destination: 'visitor@example.test',
				challengeId,
				code: '123456',
				payload: {
					phone: '+79991234567',
					timeSlot: '11:00–13:00',
					timezone: 'Europe/Moscow',
					url: 'https://example.test/callback'
				}
			})
		);
		expect(callbackOtp.precheckOrReplay).toHaveBeenCalledWith(
			expect.objectContaining({
				payload: {
					phone: '+79991234567',
					timeSlot: '11:00–13:00',
					timezone: 'Europe/Moscow',
					url: 'https://example.test/callback'
				}
			})
		);
		expect(callbackOtp.findReplayInTransaction).toHaveBeenCalledWith(
			transaction,
			expect.objectContaining({
				payload: {
					phone: '+79991234567',
					timeSlot: '11:00–13:00',
					timezone: 'Europe/Moscow',
					url: 'https://example.test/callback'
				}
			})
		);
	});

	it.each([
		[
			'OFF',
			{
				phone: '+79991234567',
				email: 'visitor@example.test'
			}
		],
		[
			'SMS',
			{
				phone: '+79991234567',
				email: 'visitor@example.test',
				challengeId: '11111111-1111-4111-8111-111111111111',
				code: '123456'
			}
		]
	] as const)(
		'rejects email in the strict %s callback submission contract',
		async (verificationMode, input) => {
			const callback = {
				...publicWidget(WidgetType.CALLBACK),
				config: {
					verificationMode,
					launcherEnabled: true,
					filterDuplicates: false
				}
			};
			const repository = {
				findByPublicKey: jest.fn().mockResolvedValue(callback)
			};
			const quota = { withLeadCreation: jest.fn() };
			const callbackOtp = { precheckOrReplay: jest.fn() };
			const service = new WidgetsPublicService(
				repository as never,
				quota as never,
				{} as never,
				{} as never,
				new WidgetsTypeRegistryService(),
				{} as never,
				callbackOtp as never
			);

			await expect(
				service.submitLead(
					WidgetType.CALLBACK,
					callback.publicKey,
					input,
					'203.0.113.10',
					'example.test',
					false,
					`correlation-${verificationMode.toLowerCase()}`
				)
			).rejects.toMatchObject({
				status: 400,
				message: 'Email разрешён только при подтверждении по email'
			});
			expect(quota.withLeadCreation).not.toHaveBeenCalled();
			expect(callbackOtp.precheckOrReplay).not.toHaveBeenCalled();
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
			new WidgetsTypeRegistryService(),
			{} as never,
			{} as never
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
