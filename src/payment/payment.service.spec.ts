import { buildRecurringCycleKey } from '@/payment/payment.constants';
import { PaymentService } from '@/payment/payment.service';
import {
	AutoRenewalStatus,
	AuthIdentityType,
	BillingPeriod,
	PaymentKind,
	PaymentStatus,
	Plan,
	SubscriptionStatus,
	UserStatus
} from '@prisma/client';

describe('PaymentService payment notification outbox', () => {
	it.each([
		{
			label: 'configured destination',
			settings: {
				dailySummaryChatId: '  -100123  ',
				paymentsThreadId: 42
			},
			destination: {
				telegramChatId: '-100123',
				messageThreadId: 42
			}
		},
		{
			label: 'missing destination',
			settings: {
				dailySummaryChatId: '   ',
				paymentsThreadId: 0
			},
			destination: {
				telegramChatId: null,
				messageThreadId: null
			}
		}
	])(
		'creates email and prepared Telegram outboxes in one transaction for $label',
		async ({ settings, destination }) => {
			const updatedAt = new Date('2026-07-25T12:00:00.000Z');
			const outboxCreate = jest
				.fn()
				.mockResolvedValue({ id: 'outbox-event' });
			const transaction = {
				$queryRaw: jest.fn().mockResolvedValue([{ id: 'user-1' }]),
				payment: {
					updateMany: jest.fn().mockResolvedValue({ count: 1 }),
					findUniqueOrThrow: jest.fn().mockResolvedValue({
						id: 'payment-1',
						userId: 'user-1',
						yookassaId: 'yookassa-1',
						amount: '990.00',
						plan: Plan.EASY,
						billingPeriod: BillingPeriod.MONTHLY,
						updatedAt
					})
				},
				user: {
					findUnique: jest.fn().mockResolvedValue({
						name: 'Иван',
						authIdentities: [
							{
								type: AuthIdentityType.EMAIL,
								value: 'owner@example.com'
							},
							{
								type: AuthIdentityType.PHONE,
								value: '+79990000000'
							}
						]
					})
				},
				telegramBotSettings: {
					findUnique: jest.fn().mockResolvedValue(settings)
				},
				outboxEvent: {
					create: outboxCreate
				}
			};
			const prisma = {
				payment: {
					findUnique: jest.fn().mockResolvedValue({
						status: PaymentStatus.PENDING,
						userId: 'user-1',
						plan: Plan.EASY,
						billingPeriod: BillingPeriod.MONTHLY
					})
				},
				$transaction: jest.fn(async callback => callback(transaction))
			};
			const yookassa = {
				getPayment: jest.fn().mockResolvedValue({
					status: 'succeeded'
				})
			};
			const subscription = {
				createOrUpgradeSubscriptionInTransaction: jest
					.fn()
					.mockResolvedValue({
						expiresAt: new Date('2026-08-25T12:00:00.000Z')
					})
			};
			const affiliate = {
				processPaymentSucceededInTransaction: jest
					.fn()
					.mockResolvedValue(undefined)
			};
			const autoRenewal = {
				activateFromSuccessfulPaymentInTransaction: jest
					.fn()
					.mockResolvedValue(null),
				alignAfterOneTimePaymentInTransaction: jest
					.fn()
					.mockResolvedValue(undefined)
			};
			const receipt = {
				syncForPayment: jest.fn().mockResolvedValue(0)
			};
			const service = new PaymentService(
				prisma as never,
				yookassa as never,
				subscription as never,
				{} as never,
				{} as never,
				affiliate as never,
				autoRenewal as never,
				receipt as never
			);

			await service.handleWebhook({
				event: 'payment.succeeded',
				object: { id: 'yookassa-1' }
			});

			expect(prisma.$transaction).toHaveBeenCalledTimes(1);
			expect(
				transaction.telegramBotSettings.findUnique
			).toHaveBeenCalledWith({
				where: { id: 'singleton' },
				select: {
					dailySummaryChatId: true,
					paymentsThreadId: true
				}
			});
			expect(outboxCreate).toHaveBeenCalledTimes(2);
			expect(outboxCreate).toHaveBeenNthCalledWith(
				1,
				expect.objectContaining({
					data: expect.objectContaining({
						eventType: 'payment.succeeded.v1',
						routingKey: 'payment.succeeded.v1',
						payload: expect.objectContaining({
							subscription: {
								expiresAt: '2026-08-25T12:00:00.000Z'
							}
						})
					})
				})
			);
			expect(outboxCreate).toHaveBeenNthCalledWith(
				2,
				expect.objectContaining({
					data: expect.objectContaining({
						eventType: 'payment.notification.telegram.requested.v1',
						routingKey: 'payment.notification.telegram.requested.v1',
						payload: {
							schemaVersion: 1,
							eventType: 'payment.notification.telegram.requested.v1',
							payment: {
								id: 'payment-1',
								yookassaId: 'yookassa-1',
								amount: '990.00',
								plan: Plan.EASY,
								billingPeriod: BillingPeriod.MONTHLY,
								succeededAt: updatedAt.toISOString()
							},
							user: {
								id: 'user-1',
								name: 'Иван',
								email: 'owner@example.com',
								phone: '+79990000000'
							},
							destination
						}
					})
				})
			);
		}
	);
});

describe('PaymentService recurring provider-call boundary', () => {
	const nextChargeAt = new Date('2026-08-28T09:00:00.000Z');
	const renewalId = 'renewal-1';
	const cycleKey = buildRecurringCycleKey(renewalId, nextChargeAt, 0);

	const createPayment = (checkoutExpiresAt: Date) => ({
		id: 'payment-1',
		userId: 'user-1',
		kind: PaymentKind.RECURRING,
		status: PaymentStatus.PENDING,
		providerStatus: 'creating',
		yookassaId: null,
		providerIdempotencyKey: 'idempotency-1',
		recurringCycleKey: cycleKey,
		recurringAttempt: 0,
		plan: Plan.EASY,
		billingPeriod: BillingPeriod.MONTHLY,
		amount: '990.00',
		currency: 'RUB',
		customerEmail: 'owner@example.com',
		customerPhone: null,
		paymentMethodCiphertext: 'ciphertext',
		checkoutExpiresAt
	});

	const createRenewal = (status: AutoRenewalStatus) => ({
		id: renewalId,
		userId: 'user-1',
		status,
		dispatchPending: true,
		pendingAmount: null,
		nextChargeAt,
		nextRetryAt: null,
		retryAttempt: 0,
		plan: Plan.EASY,
		billingPeriod: BillingPeriod.MONTHLY,
		amount: '990.00',
		currency: 'RUB',
		paymentMethodCiphertext: 'ciphertext',
		consentVersion: 'v1',
		consentText: 'consent',
		consentedAt: new Date('2026-07-28T09:00:00.000Z'),
		stateVersion: 2
	});
	const createUser = (expiresAt = nextChargeAt) => ({
		status: UserStatus.ACTIVE,
		deletedAt: null,
		subscription: {
			status: SubscriptionStatus.ACTIVE,
			plan: Plan.EASY,
			billingPeriod: BillingPeriod.MONTHLY,
			expiresAt
		}
	});

	const invokeProviderBoundary = (
		service: PaymentService,
		prepared: unknown
	) => {
		const method = Reflect.get(
			service,
			'createRecurringProviderPaymentUnderLock'
		) as (input: unknown) => Promise<unknown>;
		return method.call(service, prepared);
	};

	it.each([
		{
			label: 'user disable',
			status: AutoRenewalStatus.USER_DISABLED,
			chargesEnabled: true
		},
		{
			label: 'admin pause',
			status: AutoRenewalStatus.ADMIN_PAUSED,
			chargesEnabled: true
		},
		{
			label: 'global stop',
			status: AutoRenewalStatus.ACTIVE,
			chargesEnabled: false
		}
	])(
		'does not send a new YooKassa request after $label is visible under lock',
		async ({ status, chargesEnabled }) => {
			const payment = createPayment(new Date('2099-08-28T10:00:00.000Z'));
			const transaction = {
				$queryRaw: jest.fn().mockResolvedValue([{ id: 'locked' }]),
				siteSettings: {
					upsert: jest.fn().mockResolvedValue({ id: 'singleton' }),
					findUniqueOrThrow: jest.fn().mockResolvedValue({
						paymentEnabled: true,
						autoRenewalChargesEnabled: chargesEnabled,
						autoRenewalChargesEnabledAt: new Date(
							'2026-07-28T09:00:00.000Z'
						)
					})
				},
				user: {
					findUnique: jest.fn().mockResolvedValue(createUser())
				},
				payment: {
					findUnique: jest.fn().mockResolvedValue(payment),
					update: jest.fn().mockResolvedValue({
						...payment,
						status: PaymentStatus.CANCELLED
					})
				},
				autoRenewal: {
					findUnique: jest.fn().mockResolvedValue(createRenewal(status)),
					updateMany: jest.fn().mockResolvedValue({ count: 1 })
				}
			};
			const prisma = {
				$transaction: jest.fn(async callback => callback(transaction)),
				payment: { update: jest.fn() }
			};
			const yookassa = { createPayment: jest.fn() };
			const service = new PaymentService(
				prisma as never,
				yookassa as never,
				{} as never,
				{} as never,
				{} as never,
				{} as never,
				{ decryptPaymentMethod: jest.fn() } as never,
				{} as never
			);

			const result = await invokeProviderBoundary(service, {
				payment,
				renewalStateVersion: 2,
				providerRequestMayExist: false
			});

			expect(result).toBeNull();
			expect(transaction.$queryRaw).toHaveBeenCalledTimes(5);
			expect(yookassa.createPayment).not.toHaveBeenCalled();
			expect(transaction.payment.update).toHaveBeenCalledWith(
				expect.objectContaining({
					data: expect.objectContaining({
						status: PaymentStatus.CANCELLED,
						providerStatus: 'not_sent',
						cancellationReason:
							'auto_renewal_state_changed_before_provider_call'
					})
				})
			);
		}
	);

	it('keeps renewal and global locks until provider id is persisted', async () => {
		const payment = createPayment(new Date('2099-08-28T10:00:00.000Z'));
		const renewal = createRenewal(AutoRenewalStatus.ACTIVE);
		let transactionActive = false;
		const providerPayment = {
			id: 'yookassa-1',
			status: 'pending',
			amount: { value: '990.00', currency: 'RUB' },
			metadata: { paymentId: payment.id }
		};
		const transaction = {
			$queryRaw: jest.fn().mockResolvedValue([{ id: 'locked' }]),
			siteSettings: {
				upsert: jest.fn().mockResolvedValue({ id: 'singleton' }),
				findUniqueOrThrow: jest.fn().mockResolvedValue({
					paymentEnabled: true,
					autoRenewalChargesEnabled: true,
					autoRenewalChargesEnabledAt: new Date('2026-07-28T09:00:00.000Z')
				})
			},
			user: {
				findUnique: jest.fn().mockResolvedValue(createUser())
			},
			payment: {
				findUnique: jest.fn().mockResolvedValue(payment),
				update: jest.fn().mockImplementation(async ({ data }) => ({
					...payment,
					...data
				}))
			},
			autoRenewal: {
				findUnique: jest.fn().mockResolvedValue(renewal)
			},
			tariffPrice: {
				findUnique: jest.fn().mockResolvedValue({ amount: 990 })
			}
		};
		const prisma = {
			$transaction: jest.fn(async callback => {
				transactionActive = true;
				const result = await callback(transaction);
				transactionActive = false;
				return result;
			}),
			payment: { update: jest.fn() }
		};
		const yookassa = {
			createPayment: jest.fn().mockImplementation(async () => {
				expect(transactionActive).toBe(true);
				expect(transaction.$queryRaw).toHaveBeenCalledTimes(5);
				return providerPayment;
			})
		};
		const autoRenewal = {
			decryptPaymentMethod: jest.fn().mockReturnValue('saved-method-1')
		};
		const service = new PaymentService(
			prisma as never,
			yookassa as never,
			{} as never,
			{} as never,
			{} as never,
			{} as never,
			autoRenewal as never,
			{} as never
		);

		const result = await invokeProviderBoundary(service, {
			payment,
			renewalStateVersion: renewal.stateVersion,
			providerRequestMayExist: false
		});

		expect(result).toEqual(
			expect.objectContaining({
				providerPayment,
				payment: expect.objectContaining({
					yookassaId: providerPayment.id
				})
			})
		);
		expect(transaction.payment.update).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					yookassaId: providerPayment.id
				})
			})
		);
		expect(prisma.payment.update).not.toHaveBeenCalled();
		expect(transactionActive).toBe(false);
	});

	it('does not execute an already queued charge after global re-enable', async () => {
		const payment = createPayment(new Date('2099-08-28T10:00:00.000Z'));
		const renewal = createRenewal(AutoRenewalStatus.ACTIVE);
		const transaction = {
			$queryRaw: jest.fn().mockResolvedValue([{ id: 'locked' }]),
			siteSettings: {
				upsert: jest.fn().mockResolvedValue({ id: 'singleton' }),
				findUniqueOrThrow: jest.fn().mockResolvedValue({
					paymentEnabled: true,
					autoRenewalChargesEnabled: true,
					autoRenewalChargesEnabledAt: new Date('2026-08-28T09:00:00.001Z')
				})
			},
			payment: {
				findUnique: jest.fn().mockResolvedValue(payment),
				update: jest.fn().mockResolvedValue(payment)
			},
			autoRenewal: {
				findUnique: jest.fn().mockResolvedValue(renewal),
				updateMany: jest.fn().mockResolvedValue({ count: 1 })
			},
			autoRenewalConsentEvent: {
				create: jest.fn().mockResolvedValue({ id: 'event-1' })
			}
		};
		const prisma = {
			$transaction: jest.fn(async callback => callback(transaction)),
			payment: { update: jest.fn() }
		};
		const yookassa = { createPayment: jest.fn() };
		const service = new PaymentService(
			prisma as never,
			yookassa as never,
			{} as never,
			{} as never,
			{} as never,
			{} as never,
			{} as never,
			{} as never
		);

		const result = await invokeProviderBoundary(service, {
			payment,
			renewalStateVersion: renewal.stateVersion,
			providerRequestMayExist: false
		});

		expect(result).toBeNull();
		expect(yookassa.createPayment).not.toHaveBeenCalled();
		expect(transaction.payment.update).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					status: PaymentStatus.CANCELLED,
					cancellationReason: 'charge_missed_during_global_pause'
				})
			})
		);
		expect(transaction.autoRenewal.updateMany).toHaveBeenLastCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					status: AutoRenewalStatus.TECHNICAL_PAUSE,
					lastChargeErrorCode: 'CHARGE_MISSED_DURING_GLOBAL_PAUSE'
				})
			})
		);
	});

	it('rechecks the subscription cycle under lock before provider POST', async () => {
		const payment = createPayment(new Date('2099-08-28T10:00:00.000Z'));
		const renewal = createRenewal(AutoRenewalStatus.ACTIVE);
		const extendedExpiresAt = new Date('2026-09-28T09:00:00.000Z');
		const transaction = {
			$queryRaw: jest.fn().mockResolvedValue([{ id: 'locked' }]),
			siteSettings: {
				upsert: jest.fn().mockResolvedValue({ id: 'singleton' }),
				findUniqueOrThrow: jest.fn().mockResolvedValue({
					paymentEnabled: true,
					autoRenewalChargesEnabled: true,
					autoRenewalChargesEnabledAt: new Date('2026-07-28T09:00:00.000Z')
				})
			},
			user: {
				findUnique: jest
					.fn()
					.mockResolvedValue(createUser(extendedExpiresAt))
			},
			payment: {
				findUnique: jest.fn().mockResolvedValue(payment),
				update: jest.fn().mockResolvedValue(payment)
			},
			autoRenewal: {
				findUnique: jest.fn().mockResolvedValue(renewal),
				updateMany: jest.fn().mockResolvedValue({ count: 1 })
			}
		};
		const prisma = {
			$transaction: jest.fn(async callback => callback(transaction)),
			payment: { update: jest.fn() }
		};
		const yookassa = { createPayment: jest.fn() };
		const autoRenewal = {
			alignAfterOneTimePaymentInTransaction: jest.fn()
		};
		const service = new PaymentService(
			prisma as never,
			yookassa as never,
			{} as never,
			{} as never,
			{} as never,
			{} as never,
			autoRenewal as never,
			{} as never
		);

		const result = await invokeProviderBoundary(service, {
			payment,
			renewalStateVersion: renewal.stateVersion,
			providerRequestMayExist: false
		});

		expect(result).toBeNull();
		expect(yookassa.createPayment).not.toHaveBeenCalled();
		expect(
			autoRenewal.alignAfterOneTimePaymentInTransaction
		).toHaveBeenCalledWith(transaction, payment.userId, extendedExpiresAt);
		expect(transaction.payment.update).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					cancellationReason:
						'subscription_cycle_changed_before_provider_call'
				})
			})
		);
	});

	it('rejects a retry whose checkout deadline has passed', async () => {
		const payment = createPayment(new Date('2020-08-28T10:00:00.000Z'));
		const renewal = createRenewal(AutoRenewalStatus.ACTIVE);
		const transaction = {
			$queryRaw: jest.fn().mockResolvedValue([{ id: 'locked' }]),
			siteSettings: {
				upsert: jest.fn().mockResolvedValue({ id: 'singleton' }),
				findUniqueOrThrow: jest.fn().mockResolvedValue({
					paymentEnabled: true,
					autoRenewalChargesEnabled: true,
					autoRenewalChargesEnabledAt: new Date('2026-07-28T09:00:00.000Z')
				})
			},
			user: {
				findUnique: jest.fn().mockResolvedValue(createUser())
			},
			payment: {
				findUnique: jest.fn().mockResolvedValue(payment),
				update: jest.fn().mockResolvedValue(payment)
			},
			autoRenewal: {
				findUnique: jest.fn().mockResolvedValue(renewal),
				updateMany: jest.fn().mockResolvedValue({ count: 1 })
			},
			autoRenewalConsentEvent: {
				create: jest.fn().mockResolvedValue({ id: 'event-1' })
			}
		};
		const prisma = {
			$transaction: jest.fn(async callback => callback(transaction)),
			payment: { update: jest.fn() }
		};
		const yookassa = { createPayment: jest.fn() };
		const service = new PaymentService(
			prisma as never,
			yookassa as never,
			{} as never,
			{} as never,
			{} as never,
			{} as never,
			{ decryptPaymentMethod: jest.fn() } as never,
			{} as never
		);

		const result = await invokeProviderBoundary(service, {
			payment,
			renewalStateVersion: renewal.stateVersion,
			providerRequestMayExist: false
		});

		expect(result).toBeNull();
		expect(yookassa.createPayment).not.toHaveBeenCalled();
		expect(transaction.payment.update).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					cancellationReason: 'charge_window_expired'
				})
			})
		);
		expect(transaction.autoRenewal.updateMany).toHaveBeenLastCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					status: AutoRenewalStatus.TECHNICAL_PAUSE,
					lastChargeErrorCode: 'CHARGE_WINDOW_EXPIRED'
				})
			})
		);
	});
});
