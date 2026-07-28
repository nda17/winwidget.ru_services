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
					findUnique: jest.fn().mockResolvedValue({
						id: 'payment-1',
						kind: PaymentKind.ONE_TIME,
						status: PaymentStatus.PENDING,
						cancellationReason: null
					}),
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

describe('PaymentService local pending-payment cancellation', () => {
	const userId = 'user-1';
	const paymentId = 'payment-1';
	const updatedAt = new Date('2026-07-29T09:00:00.000Z');
	const createPayment = (
		status: PaymentStatus,
		overrides: Record<string, unknown> = {}
	) => ({
		id: paymentId,
		userId,
		kind: PaymentKind.ONE_TIME,
		status,
		cancelledAt: null,
		cancellationReason: null,
		updatedAt,
		...overrides
	});
	const createHarness = (payment: ReturnType<typeof createPayment>) => {
		const transaction = {
			$queryRaw: jest.fn().mockResolvedValue([{ id: 'locked' }]),
			payment: {
				findFirst: jest.fn().mockResolvedValue(payment),
				update: jest.fn().mockImplementation(async ({ data }) => ({
					...payment,
					...data
				}))
			}
		};
		const prisma = {
			$transaction: jest.fn(async callback => callback(transaction))
		};
		const yookassa = {
			createPayment: jest.fn(),
			getPayment: jest.fn()
		};
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
		return { service, transaction, prisma, yookassa };
	};

	it('atomically cancels the exact owned pending one-time payment without calling YooKassa', async () => {
		const { service, transaction, prisma, yookassa } = createHarness(
			createPayment(PaymentStatus.PENDING)
		);

		const result = await service.cancelPendingPayment(
			userId,
			` ${paymentId} `
		);

		expect(prisma.$transaction).toHaveBeenCalledWith(
			expect.any(Function),
			expect.objectContaining({
				isolationLevel: 'Serializable'
			})
		);
		expect(transaction.$queryRaw).toHaveBeenCalledTimes(2);
		expect(transaction.payment.findFirst).toHaveBeenCalledWith({
			where: {
				id: paymentId,
				userId,
				kind: PaymentKind.ONE_TIME
			}
		});
		expect(transaction.payment.update).toHaveBeenCalledWith({
			where: { id: paymentId },
			data: {
				status: PaymentStatus.CANCELLED,
				confirmationUrl: null,
				cancelledAt: expect.any(Date),
				cancellationReason: 'user_cancelled'
			}
		});
		expect(result).toEqual({
			cancelled: true,
			message: 'Незавершённый платёж отменён.',
			cancelledAt: expect.any(String)
		});
		expect(yookassa.getPayment).not.toHaveBeenCalled();
		expect(yookassa.createPayment).not.toHaveBeenCalled();
	});

	it('returns success for a repeated cancellation of the same payment', async () => {
		const cancelledAt = new Date('2026-07-29T09:30:00.000Z');
		const { service, transaction, yookassa } = createHarness(
			createPayment(PaymentStatus.CANCELLED, {
				cancelledAt,
				cancellationReason: 'user_cancelled'
			})
		);

		await expect(
			service.cancelPendingPayment(userId, paymentId)
		).resolves.toEqual({
			cancelled: true,
			message: 'Незавершённый платёж уже отменён.',
			cancelledAt: cancelledAt.toISOString()
		});
		expect(transaction.payment.update).not.toHaveBeenCalled();
		expect(yookassa.getPayment).not.toHaveBeenCalled();
	});

	it('does not cancel an already succeeded payment', async () => {
		const { service, transaction, yookassa } = createHarness(
			createPayment(PaymentStatus.SUCCEEDED)
		);

		await expect(
			service.cancelPendingPayment(userId, paymentId)
		).rejects.toThrow('Платёж уже подтверждён, отменить его нельзя');
		expect(transaction.payment.update).not.toHaveBeenCalled();
		expect(yookassa.getPayment).not.toHaveBeenCalled();
	});

	it('idempotently accepts an expired payment without rewriting it as cancelled', async () => {
		const { service, transaction } = createHarness(
			createPayment(PaymentStatus.EXPIRED)
		);

		await expect(
			service.cancelPendingPayment(userId, paymentId)
		).resolves.toEqual({
			cancelled: true,
			message: 'Срок незавершённого платежа уже истёк.',
			cancelledAt: updatedAt.toISOString()
		});
		expect(transaction.payment.update).not.toHaveBeenCalled();
	});

	it('uses only pending payments as blockers for lookup and reservation', async () => {
		const outerFindFirst = jest.fn().mockResolvedValue(null);
		const transaction = {
			$queryRaw: jest.fn().mockResolvedValue([{ id: userId }]),
			user: {
				findUnique: jest.fn().mockResolvedValue({
					status: UserStatus.ACTIVE,
					deletedAt: null
				})
			},
			payment: {
				findFirst: jest.fn().mockResolvedValue(null),
				create: jest.fn().mockResolvedValue({ id: paymentId })
			}
		};
		const prisma = {
			payment: { findFirst: outerFindFirst },
			$transaction: jest.fn(async callback => callback(transaction))
		};
		const service = new PaymentService(
			prisma as never,
			{} as never,
			{} as never,
			{} as never,
			{} as never,
			{} as never,
			{} as never,
			{} as never
		);
		const findBlockingPayment = Reflect.get(
			service,
			'findBlockingPayment'
		) as (id: string) => Promise<unknown>;
		const reserveOneTimeIntent = Reflect.get(
			service,
			'reserveOneTimeIntent'
		) as (input: {
			userId: string;
			plan: Plan;
			billingPeriod: BillingPeriod;
			amount: string;
			autoRenew: boolean;
			context: Record<string, never>;
		}) => Promise<unknown>;

		await findBlockingPayment.call(service, userId);
		await reserveOneTimeIntent.call(service, {
			userId,
			plan: Plan.EASY,
			billingPeriod: BillingPeriod.MONTHLY,
			amount: '990.00',
			autoRenew: false,
			context: {}
		});

		expect(outerFindFirst).toHaveBeenCalledWith({
			where: {
				userId,
				kind: PaymentKind.ONE_TIME,
				status: PaymentStatus.PENDING,
				checkoutExpiresAt: { gt: expect.any(Date) }
			},
			orderBy: { createdAt: 'desc' }
		});
		expect(transaction.payment.findFirst).toHaveBeenCalledWith({
			where: {
				userId,
				OR: [
					{
						kind: PaymentKind.RECURRING,
						status: PaymentStatus.PENDING
					},
					{
						kind: PaymentKind.ONE_TIME,
						status: PaymentStatus.PENDING,
						checkoutExpiresAt: { gt: expect.any(Date) }
					}
				]
			},
			orderBy: { createdAt: 'desc' }
		});
	});

	it('does not return a payment that expires during provider synchronization', async () => {
		const expiredPayment = {
			...createPayment(PaymentStatus.EXPIRED),
			yookassaId: 'yookassa-1',
			providerStatus: 'pending',
			checkoutExpiresAt: new Date('2020-07-29T09:00:00.000Z'),
			providerExpiresAt: null,
			confirmationUrl: null
		};
		const pendingPayment = {
			...expiredPayment,
			status: PaymentStatus.PENDING,
			confirmationUrl: 'https://yookassa.test/confirm'
		};
		const prisma = {
			payment: {
				findFirst: jest.fn().mockResolvedValue(pendingPayment),
				update: jest.fn().mockResolvedValue(expiredPayment)
			}
		};
		const yookassa = {
			getPayment: jest.fn().mockResolvedValue({
				id: pendingPayment.yookassaId,
				status: 'pending'
			})
		};
		const cleanup = {
			cleanupStalePendingPaymentsForUser: jest.fn().mockResolvedValue(0)
		};
		const service = new PaymentService(
			prisma as never,
			yookassa as never,
			{} as never,
			cleanup as never,
			{} as never,
			{} as never,
			{} as never,
			{} as never
		);

		await expect(service.getPendingPayment(userId)).resolves.toBeNull();
		expect(prisma.payment.update).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					status: PaymentStatus.EXPIRED,
					confirmationUrl: null
				})
			})
		);
	});

	it('serializes an expired payment as terminal instead of waiting for YooKassa', () => {
		const service = new PaymentService(
			{} as never,
			{} as never,
			{} as never,
			{} as never,
			{} as never,
			{} as never,
			{} as never,
			{} as never
		);
		const serializePaymentVerification = Reflect.get(
			service,
			'serializePaymentVerification'
		) as (
			payment: ReturnType<typeof createPayment>,
			activated: boolean
		) => unknown;

		expect(
			serializePaymentVerification.call(
				service,
				createPayment(PaymentStatus.EXPIRED),
				false
			)
		).toEqual({
			activated: false,
			status: 'cancelled',
			plan: undefined,
			billingPeriod: undefined,
			message: 'Срок ссылки истёк. Создайте новый платёж.'
		});
	});
});

describe('PaymentService late success after local cancellation', () => {
	it.each([
		{
			label: 'user-cancelled',
			status: PaymentStatus.CANCELLED,
			cancellationReason: 'user_cancelled',
			cancelledAt: new Date('2026-07-29T09:55:00.000Z')
		},
		{
			label: 'expired',
			status: PaymentStatus.EXPIRED,
			cancellationReason: null,
			cancelledAt: null
		}
	])(
		'activates the paid period for a late $label payment but does not create a new auto-renewal',
		async ({ status, cancellationReason, cancelledAt }) => {
			const succeededAt = new Date('2026-07-29T10:00:00.000Z');
			const nextChargeAt = new Date('2026-08-29T10:00:00.000Z');
			const localPayment = {
				id: 'payment-1',
				userId: 'user-1',
				yookassaId: 'yookassa-1',
				kind: PaymentKind.ONE_TIME,
				status,
				providerStatus: 'pending',
				amount: '990.00',
				currency: 'RUB',
				plan: Plan.EASY,
				billingPeriod: BillingPeriod.MONTHLY,
				autoRenew: true,
				cancellationReason,
				cancelledAt,
				updatedAt: succeededAt
			};
			const updatedPayment = {
				...localPayment,
				status: PaymentStatus.SUCCEEDED,
				cancellationReason: null,
				cancelledAt: null,
				succeededAt
			};
			const transaction = {
				$queryRaw: jest.fn().mockResolvedValue([{ id: 'locked' }]),
				payment: {
					findUnique: jest.fn().mockResolvedValue(localPayment),
					updateMany: jest.fn().mockResolvedValue({ count: 1 }),
					findUniqueOrThrow: jest.fn().mockResolvedValue(updatedPayment)
				},
				user: {
					findUnique: jest.fn().mockResolvedValue({
						name: 'Иван',
						authIdentities: [
							{
								type: AuthIdentityType.EMAIL,
								value: 'owner@example.com'
							}
						]
					})
				},
				telegramBotSettings: {
					findUnique: jest.fn().mockResolvedValue({
						dailySummaryChatId: null,
						paymentsThreadId: null
					})
				},
				outboxEvent: {
					create: jest.fn().mockResolvedValue({ id: 'outbox-1' })
				}
			};
			const prisma = {
				payment: {
					findUnique: jest.fn().mockResolvedValue(localPayment),
					findMany: jest.fn().mockResolvedValue([localPayment])
				},
				$transaction: jest.fn(async callback => callback(transaction))
			};
			const providerPayment = {
				id: localPayment.yookassaId,
				status: 'succeeded',
				captured_at: succeededAt.toISOString(),
				amount: {
					value: localPayment.amount,
					currency: localPayment.currency
				},
				metadata: {
					paymentId: localPayment.id,
					userId: localPayment.userId
				},
				payment_method: {
					id: 'saved-method-from-cancelled-checkout',
					saved: true,
					type: 'bank_card'
				}
			};
			const yookassa = {
				getPayment: jest.fn().mockResolvedValue(providerPayment)
			};
			const subscription = {
				createOrUpgradeSubscriptionInTransaction: jest
					.fn()
					.mockResolvedValue({ expiresAt: nextChargeAt })
			};
			const affiliate = {
				processPaymentSucceededInTransaction: jest
					.fn()
					.mockResolvedValue(undefined)
			};
			const autoRenewal = {
				activateFromSuccessfulPaymentInTransaction: jest.fn(),
				alignAfterOneTimePaymentInTransaction: jest
					.fn()
					.mockResolvedValue(undefined)
			};
			const receipt = {
				syncForPayment: jest.fn().mockResolvedValue(1)
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

			if (status === PaymentStatus.CANCELLED) {
				await expect(service.reconcilePendingPayments()).resolves.toBe(1);
				expect(prisma.payment.findMany).toHaveBeenCalledWith(
					expect.objectContaining({
						where: expect.objectContaining({
							yookassaId: { not: null },
							AND: expect.arrayContaining([
								expect.objectContaining({
									OR: expect.arrayContaining([
										expect.objectContaining({
											kind: PaymentKind.ONE_TIME,
											status: PaymentStatus.CANCELLED,
											providerStatus: 'pending',
											cancellationReason: 'user_cancelled'
										})
									])
								})
							])
						})
					})
				);
			} else {
				await service.handleWebhook({
					event: 'payment.succeeded',
					object: { id: localPayment.yookassaId }
				});
			}

			expect(transaction.payment.updateMany).toHaveBeenCalledWith(
				expect.objectContaining({
					data: expect.objectContaining({
						status: PaymentStatus.SUCCEEDED,
						cancelledAt: null,
						cancellationReason: null
					})
				})
			);
			expect(
				subscription.createOrUpgradeSubscriptionInTransaction
			).toHaveBeenCalledTimes(1);
			expect(
				autoRenewal.activateFromSuccessfulPaymentInTransaction
			).not.toHaveBeenCalled();
			expect(
				autoRenewal.alignAfterOneTimePaymentInTransaction
			).toHaveBeenCalledWith(
				transaction,
				localPayment.userId,
				nextChargeAt
			);
			expect(receipt.syncForPayment).toHaveBeenCalledWith(localPayment.id);
			expect(yookassa.getPayment).toHaveBeenCalledTimes(1);
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
