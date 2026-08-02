import { DailySummaryRunService } from './daily-summary-run.service';

describe('DailySummaryRunService shared outcome handling', () => {
	it('ACKs and ignores a valid subscription outcome without touching report runs', async () => {
		const transaction = {
			consumerReceipt: {
				updateMany: jest.fn().mockResolvedValue({ count: 1 })
			},
			reportingConsumerFailure: {
				updateMany: jest.fn().mockResolvedValue({ count: 0 })
			},
			reportRun: { findFirst: jest.fn() }
		};
		const prisma = {
			$transaction: jest.fn(
				(callback: (tx: typeof transaction) => unknown) =>
					callback(transaction)
			)
		};
		const metrics = { increment: jest.fn() };
		const service = new DailySummaryRunService(
			prisma as never,
			{} as never,
			metrics as never
		);
		await service.applyOutcome(
			{
				schemaVersion: 1,
				eventType: 'notification.delivery.outcome.v1',
				sourceEventId: '11111111-1111-4111-8111-111111111111',
				sourceKind: 'subscription-expiry-email',
				reference: {
					type: 'subscription-expiry-reminder',
					id: '22222222-2222-4222-8222-222222222222'
				},
				status: 'DELIVERED',
				failure: null,
				occurredAt: '2026-07-31T00:00:00.000Z'
			},
			'33333333-3333-4333-8333-333333333333',
			{
				eventId: '33333333-3333-4333-8333-333333333333',
				consumer: 'reporting-delivery-outcome-v1',
				lockToken: '44444444-4444-4444-8444-444444444444'
			}
		);
		expect(transaction.reportRun.findFirst).not.toHaveBeenCalled();
		expect(transaction.consumerReceipt.updateMany).toHaveBeenCalled();
		expect(
			transaction.reportingConsumerFailure.updateMany
		).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({ status: 'RESOLVED' })
			})
		);
		expect(metrics.increment).toHaveBeenCalledWith(
			'delivery_outcomes_ignored_total'
		);
	});

	it('ACKs a shadow-era daily outcome whose run is not Reporting-owned', async () => {
		const transaction = {
			consumerReceipt: {
				updateMany: jest.fn().mockResolvedValue({ count: 1 })
			},
			reportingConsumerFailure: {
				updateMany: jest.fn().mockResolvedValue({ count: 0 })
			},
			reportRun: { findFirst: jest.fn().mockResolvedValue(null) }
		};
		const prisma = {
			$transaction: jest.fn(
				(callback: (tx: typeof transaction) => unknown) =>
					callback(transaction)
			)
		};
		const metrics = { increment: jest.fn() };
		const service = new DailySummaryRunService(
			prisma as never,
			{} as never,
			metrics as never
		);
		const id = '55555555-5555-4555-8555-555555555555';
		await service.applyOutcome(
			{
				schemaVersion: 1,
				eventType: 'notification.delivery.outcome.v1',
				sourceEventId: id,
				sourceKind: 'daily-summary-delivery-telegram',
				reference: { type: 'daily-summary-job', id },
				status: 'DELIVERED',
				failure: null,
				occurredAt: '2026-07-31T00:00:00.000Z'
			},
			'66666666-6666-4666-8666-666666666666',
			{
				eventId: '66666666-6666-4666-8666-666666666666',
				consumer: 'reporting-delivery-outcome-v1',
				lockToken: '77777777-7777-4777-8777-777777777777'
			}
		);
		expect(metrics.increment).toHaveBeenCalledWith(
			'delivery_outcomes_ignored_total'
		);
	});

	it.each(['WAITING_DELIVERY', 'FAILED'] as const)(
		'completes a %s run when Notification Delivery succeeds',
		async initialStatus => {
			const sourceEventId = '11111111-1111-4111-8111-111111111111';
			const runId = '22222222-2222-4222-8222-222222222222';
			const periodStart = new Date('2026-07-30T21:00:00.000Z');
			const transaction = {
				consumerReceipt: {
					updateMany: jest.fn().mockResolvedValue({ count: 1 })
				},
				reportingConsumerFailure: {
					updateMany: jest.fn().mockResolvedValue({ count: 0 })
				},
				reportRun: {
					findFirst: jest.fn().mockResolvedValue({
						id: runId,
						status: initialStatus,
						requestEventId: sourceEventId,
						periodStart
					}),
					updateMany: jest.fn().mockResolvedValue({ count: 1 })
				},
				reportingSettings: {
					updateMany: jest.fn().mockResolvedValue({ count: 1 })
				}
			};
			const prisma = {
				$transaction: jest.fn(
					(callback: (tx: typeof transaction) => unknown) =>
						callback(transaction)
				)
			};
			const metrics = { increment: jest.fn() };
			const service = new DailySummaryRunService(
				prisma as never,
				{} as never,
				metrics as never
			);

			await service.applyOutcome(
				{
					schemaVersion: 1,
					eventType: 'notification.delivery.outcome.v1',
					sourceEventId,
					sourceKind: 'daily-summary-delivery-telegram',
					reference: { type: 'daily-summary-job', id: runId },
					status: 'DELIVERED',
					failure: null,
					occurredAt: '2026-07-31T00:00:00.000Z'
				},
				'33333333-3333-4333-8333-333333333333',
				{
					eventId: '33333333-3333-4333-8333-333333333333',
					consumer: 'reporting-delivery-outcome-v1',
					lockToken: '44444444-4444-4444-8444-444444444444'
				}
			);

			expect(transaction.reportRun.updateMany).toHaveBeenCalledWith(
				expect.objectContaining({
					where: expect.objectContaining({
						id: runId,
						requestEventId: sourceEventId,
						status: { in: ['WAITING_DELIVERY', 'FAILED'] }
					}),
					data: expect.objectContaining({
						status: 'COMPLETED',
						checkpoint: 'DELIVERY_CONFIRMED'
					})
				})
			);
			expect(
				transaction.reportingSettings.updateMany
			).toHaveBeenCalledWith({
				where: {
					id: 'daily-summary',
					OR: [
						{ lastSuccessfulPeriodStart: null },
						{ lastSuccessfulPeriodStart: { lte: periodStart } }
					]
				},
				data: expect.objectContaining({
					lastSuccessfulPeriodStart: periodStart
				})
			});
			expect(metrics.increment).toHaveBeenCalledWith(
				'delivery_outcomes_completed_total'
			);
		}
	);

	it('ACKs a late failed outcome after the run is already completed', async () => {
		const sourceEventId = '11111111-1111-4111-8111-111111111111';
		const runId = '22222222-2222-4222-8222-222222222222';
		const transaction = {
			consumerReceipt: {
				updateMany: jest.fn().mockResolvedValue({ count: 1 })
			},
			reportingConsumerFailure: {
				updateMany: jest.fn().mockResolvedValue({ count: 0 })
			},
			reportRun: {
				findFirst: jest.fn().mockResolvedValue({
					id: runId,
					status: 'COMPLETED',
					requestEventId: sourceEventId
				}),
				updateMany: jest.fn()
			},
			reportingSettings: { updateMany: jest.fn() }
		};
		const prisma = {
			$transaction: jest.fn(
				(callback: (tx: typeof transaction) => unknown) =>
					callback(transaction)
			)
		};
		const metrics = { increment: jest.fn() };
		const service = new DailySummaryRunService(
			prisma as never,
			{} as never,
			metrics as never
		);

		await service.applyOutcome(
			{
				schemaVersion: 1,
				eventType: 'notification.delivery.outcome.v1',
				sourceEventId,
				sourceKind: 'daily-summary-delivery-telegram',
				reference: { type: 'daily-summary-job', id: runId },
				status: 'FAILED',
				failure: {
					normalizedCode: 'TIMEOUT',
					safeReason: 'Delivery timed out'
				},
				occurredAt: '2026-07-31T00:00:00.000Z'
			},
			'33333333-3333-4333-8333-333333333333',
			{
				eventId: '33333333-3333-4333-8333-333333333333',
				consumer: 'reporting-delivery-outcome-v1',
				lockToken: '44444444-4444-4444-8444-444444444444'
			}
		);

		expect(transaction.reportRun.updateMany).not.toHaveBeenCalled();
		expect(
			transaction.reportingSettings.updateMany
		).not.toHaveBeenCalled();
		expect(transaction.consumerReceipt.updateMany).toHaveBeenCalled();
		expect(metrics.increment).toHaveBeenCalledWith(
			'delivery_outcomes_duplicate_total'
		);
	});

	it('ACKs a delivered outcome when a concurrent consumer already completed the run', async () => {
		const sourceEventId = '11111111-1111-4111-8111-111111111111';
		const runId = '22222222-2222-4222-8222-222222222222';
		const transaction = {
			consumerReceipt: {
				updateMany: jest.fn().mockResolvedValue({ count: 1 })
			},
			reportingConsumerFailure: {
				updateMany: jest.fn().mockResolvedValue({ count: 0 })
			},
			reportRun: {
				findFirst: jest.fn().mockResolvedValue({
					id: runId,
					status: 'WAITING_DELIVERY',
					requestEventId: sourceEventId,
					periodStart: new Date('2026-07-30T21:00:00.000Z')
				}),
				updateMany: jest.fn().mockResolvedValue({ count: 0 }),
				findUnique: jest.fn().mockResolvedValue({ status: 'COMPLETED' })
			},
			reportingSettings: { updateMany: jest.fn() }
		};
		const prisma = {
			$transaction: jest.fn(
				(callback: (tx: typeof transaction) => unknown) =>
					callback(transaction)
			)
		};
		const metrics = { increment: jest.fn() };
		const service = new DailySummaryRunService(
			prisma as never,
			{} as never,
			metrics as never
		);

		await service.applyOutcome(
			{
				schemaVersion: 1,
				eventType: 'notification.delivery.outcome.v1',
				sourceEventId,
				sourceKind: 'daily-summary-delivery-telegram',
				reference: { type: 'daily-summary-job', id: runId },
				status: 'DELIVERED',
				failure: null,
				occurredAt: '2026-07-31T00:00:00.000Z'
			},
			'33333333-3333-4333-8333-333333333333',
			{
				eventId: '33333333-3333-4333-8333-333333333333',
				consumer: 'reporting-delivery-outcome-v1',
				lockToken: '44444444-4444-4444-8444-444444444444'
			}
		);

		expect(
			transaction.reportingSettings.updateMany
		).not.toHaveBeenCalled();
		expect(transaction.consumerReceipt.updateMany).toHaveBeenCalled();
		expect(metrics.increment).toHaveBeenCalledWith(
			'delivery_outcomes_duplicate_total'
		);
	});
});
