import { PaymentService } from '@/payment/payment.service';
import {
	AuthIdentityType,
	BillingPeriod,
	PaymentStatus,
	Plan
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
				payment: {
					updateMany: jest.fn().mockResolvedValue({ count: 1 }),
					findUniqueOrThrow: jest.fn().mockResolvedValue({
						id: 'payment-1',
						yookassaId: 'yookassa-1',
						amount: '990.00',
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
			const service = new PaymentService(
				prisma as never,
				yookassa as never,
				subscription as never,
				{} as never,
				{} as never,
				affiliate as never
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
