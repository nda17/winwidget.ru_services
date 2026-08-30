import {
	InvalidReportingEventError,
	reportingPayloadHash
} from '../projections/reporting-event.contract';
import { ParsedReportingConsumeMessage } from './reporting-consumer-router.service';
import {
	REPORTING_CONSUMERS,
	REPORTING_CONSUMER_KINDS,
	ReportingConsumerKind
} from './reporting-messaging.constants';
import { ReportingWorkerService } from './reporting-worker.service';
import type { ConsumeMessage } from 'amqplib';

const EVENT_ID = '11111111-1111-4111-8111-111111111111';
const LOCK_TOKEN = '22222222-2222-4222-8222-222222222222';

const payload = {
	schemaVersion: 1 as const,
	eventType: 'identity.user.changed.v1' as const,
	eventId: EVENT_ID,
	aggregateId: 'user-1',
	aggregateVersion: '1',
	sourceSequence: '1',
	occurredAt: '2026-08-30T12:00:00.000Z',
	tombstone: false,
	state: {
		id: 'user-1',
		createdAt: '2026-01-01T00:00:00.000Z',
		updatedAt: '2026-08-30T12:00:00.000Z',
		deletedAt: null,
		status: 'ACTIVE' as const,
		roles: ['USER' as const],
		hasEmailIdentity: true,
		hasPhoneIdentity: false,
		hasTelegramIdentity: false,
		loginMethodCount: 1
	}
};

const parsed: ParsedReportingConsumeMessage = {
	eventId: EVENT_ID,
	eventType: payload.eventType,
	payload,
	retryAttempt: 0,
	retryCycle: 0
};

function message(): ConsumeMessage {
	return {
		content: Buffer.from(JSON.stringify(payload)),
		fields: {
			consumerTag: 'reporting-test',
			deliveryTag: 1,
			redelivered: false,
			exchange: 'winwidget.events',
			routingKey: payload.eventType
		},
		properties: {
			contentType: 'application/json',
			contentEncoding: 'utf-8',
			headers: {},
			deliveryMode: 2,
			priority: undefined,
			correlationId: EVENT_ID,
			replyTo: undefined,
			expiration: undefined,
			messageId: EVENT_ID,
			timestamp: Date.now(),
			type: payload.eventType,
			userId: undefined,
			appId: undefined,
			clusterId: undefined
		}
	};
}

function deferred<T = void>() {
	let resolve!: (value: T | PromiseLike<T>) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	return { promise, resolve, reject };
}

function harness(input?: { workerEnabled?: boolean; prefetch?: string }) {
	const rabbitMq = {
		consume: jest.fn().mockResolvedValue(undefined),
		cancelConsumers: jest.fn().mockResolvedValue(undefined),
		ack: jest.fn(),
		nack: jest.fn()
	};
	const runtime = { workerEnabled: input?.workerEnabled ?? true };
	const config = {
		get: jest.fn().mockReturnValue(input?.prefetch ?? '5')
	};
	const metrics = { increment: jest.fn() };
	const router = {
		parse: jest.fn().mockReturnValue(parsed),
		dispatch: jest.fn().mockResolvedValue(undefined)
	};
	const receipts = {
		claim: jest
			.fn()
			.mockResolvedValue({ state: 'claimed', lockToken: LOCK_TOKEN }),
		renew: jest.fn().mockResolvedValue(true)
	};
	const failures = {
		finalize: jest.fn().mockResolvedValue(undefined),
		publishPoison: jest.fn().mockResolvedValue(undefined)
	};
	const service = new ReportingWorkerService(
		rabbitMq as never,
		runtime as never,
		config as never,
		metrics as never,
		router as never,
		receipts as never,
		failures as never
	);
	const logger = (
		service as unknown as {
			logger: {
				error: (...args: unknown[]) => void;
				warn: (...args: unknown[]) => void;
			};
		}
	).logger;
	jest.spyOn(logger, 'error').mockImplementation(() => undefined);
	jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
	return {
		service,
		rabbitMq,
		runtime,
		config,
		metrics,
		router,
		receipts,
		failures
	};
}

async function consumerHandler(
	h: ReturnType<typeof harness>,
	kind: ReportingConsumerKind = 'identityUser'
): Promise<(message: ConsumeMessage) => Promise<void>> {
	await h.service.onModuleInit();
	const registration = h.rabbitMq.consume.mock.calls.find(
		([registeredKind]) => registeredKind === kind
	);
	if (!registration) throw new Error(`Missing ${kind} registration`);
	return registration[1] as (message: ConsumeMessage) => Promise<void>;
}

describe('ReportingWorkerService orchestration', () => {
	afterEach(() => {
		jest.useRealTimers();
	});

	it('stays ready and does not touch RabbitMQ when the worker role is disabled', async () => {
		const h = harness({ workerEnabled: false });

		await h.service.onModuleInit();
		await h.service.beforeApplicationShutdown();

		expect(h.service.isReady()).toBe(true);
		expect(h.rabbitMq.consume).not.toHaveBeenCalled();
		expect(h.rabbitMq.cancelConsumers).not.toHaveBeenCalled();
	});

	it('registers every consumer with the exact configured prefetch and reports readiness', async () => {
		const h = harness({ prefetch: '17' });

		await h.service.onModuleInit();

		expect(h.rabbitMq.consume).toHaveBeenCalledTimes(
			REPORTING_CONSUMER_KINDS.length
		);
		for (const kind of REPORTING_CONSUMER_KINDS) {
			expect(h.rabbitMq.consume).toHaveBeenCalledWith(
				kind,
				expect.any(Function),
				17
			);
		}
		expect(h.service.isReady()).toBe(true);

		await h.service.beforeApplicationShutdown();

		expect(h.rabbitMq.cancelConsumers).toHaveBeenCalledTimes(1);
		expect(h.service.isReady()).toBe(false);
	});

	it.each(['0', '101', '1.5', 'invalid'])(
		'rejects invalid REPORTING_PREFETCH=%s before consumer registration',
		async prefetch => {
			const h = harness({ prefetch });

			await expect(h.service.onModuleInit()).rejects.toThrow(
				'REPORTING_PREFETCH must be between 1 and 100'
			);
			expect(h.rabbitMq.consume).not.toHaveBeenCalled();
			expect(h.service.isReady()).toBe(false);
		}
	);

	it('acknowledges poison only after its confirmed publication succeeds', async () => {
		const h = harness();
		const parseError = new InvalidReportingEventError('invalid payload');
		h.router.parse.mockImplementation(() => {
			throw parseError;
		});
		const publication = deferred();
		h.failures.publishPoison.mockReturnValue(publication.promise);
		const consumed = message();
		const handler = await consumerHandler(h);

		const handling = handler(consumed);
		await Promise.resolve();
		expect(h.failures.publishPoison).toHaveBeenCalledWith(
			'identityUser',
			consumed,
			parseError
		);
		expect(h.rabbitMq.ack).not.toHaveBeenCalled();
		expect(h.rabbitMq.nack).not.toHaveBeenCalled();

		publication.resolve();
		await handling;
		expect(h.rabbitMq.ack).toHaveBeenCalledWith(consumed);
		expect(h.receipts.claim).not.toHaveBeenCalled();
	});

	it('requeues poison when its confirmed publication fails', async () => {
		const h = harness();
		h.router.parse.mockImplementation(() => {
			throw new InvalidReportingEventError('invalid payload');
		});
		h.failures.publishPoison.mockRejectedValue(
			new Error('broker unavailable')
		);
		const consumed = message();
		const handler = await consumerHandler(h);

		await handler(consumed);

		expect(h.rabbitMq.ack).not.toHaveBeenCalled();
		expect(h.rabbitMq.nack).toHaveBeenCalledWith(consumed, true);
	});

	it('routes payload-hash conflicts to poison instead of retrying the claim', async () => {
		const h = harness();
		const conflict = new InvalidReportingEventError(
			'eventId was reused with another payload'
		);
		h.receipts.claim.mockRejectedValue(conflict);
		const consumed = message();
		const handler = await consumerHandler(h);

		await handler(consumed);

		expect(h.failures.publishPoison).toHaveBeenCalledWith(
			'identityUser',
			consumed,
			conflict
		);
		expect(h.rabbitMq.ack).toHaveBeenCalledWith(consumed);
		expect(h.router.dispatch).not.toHaveBeenCalled();
	});

	it('requeues a transient receipt claim failure without dispatching', async () => {
		const h = harness();
		h.receipts.claim.mockRejectedValue(new Error('database unavailable'));
		const consumed = message();
		const handler = await consumerHandler(h);

		await handler(consumed);

		expect(h.rabbitMq.nack).toHaveBeenCalledWith(consumed, true);
		expect(h.rabbitMq.ack).not.toHaveBeenCalled();
		expect(h.failures.publishPoison).not.toHaveBeenCalled();
		expect(h.router.dispatch).not.toHaveBeenCalled();
	});

	it('acknowledges a terminal duplicate without dispatching it again', async () => {
		const h = harness();
		h.receipts.claim.mockResolvedValue({ state: 'done' });
		const consumed = message();
		const handler = await consumerHandler(h);

		await handler(consumed);

		expect(h.metrics.increment).toHaveBeenCalledWith(
			'consumer_duplicate_deliveries_total'
		);
		expect(h.rabbitMq.ack).toHaveBeenCalledWith(consumed);
		expect(h.rabbitMq.nack).not.toHaveBeenCalled();
		expect(h.router.dispatch).not.toHaveBeenCalled();
	});

	it('delays and requeues an active receipt instead of acknowledging it', async () => {
		jest.useFakeTimers();
		const h = harness();
		h.receipts.claim.mockResolvedValue({ state: 'active' });
		const consumed = message();
		const handler = await consumerHandler(h);

		const handling = handler(consumed);
		await Promise.resolve();
		expect(h.rabbitMq.nack).not.toHaveBeenCalled();

		await jest.advanceTimersByTimeAsync(249);
		expect(h.rabbitMq.nack).not.toHaveBeenCalled();
		await jest.advanceTimersByTimeAsync(1);
		await handling;

		expect(h.metrics.increment).toHaveBeenCalledWith(
			'consumer_active_redeliveries_total'
		);
		expect(h.rabbitMq.nack).toHaveBeenCalledWith(consumed, true);
		expect(h.rabbitMq.ack).not.toHaveBeenCalled();
	});

	it('acknowledges success only after domain work and receipt completion resolve', async () => {
		const h = harness();
		const dispatch = deferred();
		h.router.dispatch.mockReturnValue(dispatch.promise);
		const consumed = message();
		const handler = await consumerHandler(h);

		const handling = handler(consumed);
		await Promise.resolve();
		expect(h.router.dispatch).toHaveBeenCalledWith(
			'identityUser',
			parsed,
			{
				eventId: EVENT_ID,
				consumer: REPORTING_CONSUMERS.identityUser,
				lockToken: LOCK_TOKEN
			}
		);
		expect(h.receipts.claim).toHaveBeenCalledWith(
			EVENT_ID,
			REPORTING_CONSUMERS.identityUser,
			reportingPayloadHash(payload),
			0,
			0
		);
		expect(h.rabbitMq.ack).not.toHaveBeenCalled();

		dispatch.resolve();
		await handling;

		expect(h.metrics.increment).toHaveBeenCalledWith(
			'consumer_events_delivered_total'
		);
		expect(h.rabbitMq.ack).toHaveBeenCalledWith(consumed);
		expect(h.failures.finalize).not.toHaveBeenCalled();
	});

	it('acknowledges a failed domain event only after durable failure finalization', async () => {
		const h = harness();
		const domainError = new Error('projection unavailable');
		h.router.dispatch.mockRejectedValue(domainError);
		const finalization = deferred();
		h.failures.finalize.mockReturnValue(finalization.promise);
		const consumed = message();
		const handler = await consumerHandler(h);

		const handling = handler(consumed);
		await Promise.resolve();
		await Promise.resolve();
		expect(h.failures.finalize).toHaveBeenCalledWith(
			'identityUser',
			parsed,
			REPORTING_CONSUMERS.identityUser,
			LOCK_TOKEN,
			domainError,
			consumed
		);
		expect(h.rabbitMq.ack).not.toHaveBeenCalled();

		finalization.resolve();
		await handling;

		expect(h.rabbitMq.ack).toHaveBeenCalledWith(consumed);
		expect(h.rabbitMq.nack).not.toHaveBeenCalled();
		expect(h.metrics.increment).not.toHaveBeenCalledWith(
			'consumer_events_delivered_total'
		);
	});

	it('requeues a domain event when durable failure finalization fails', async () => {
		const h = harness();
		h.router.dispatch.mockRejectedValue(
			new Error('projection unavailable')
		);
		h.failures.finalize.mockRejectedValue(
			new Error('failure transaction unavailable')
		);
		const consumed = message();
		const handler = await consumerHandler(h);

		await handler(consumed);

		expect(h.rabbitMq.nack).toHaveBeenCalledWith(consumed, true);
		expect(h.rabbitMq.ack).not.toHaveBeenCalled();
	});

	it('renews the exact claim while work is active and clears the timer afterward', async () => {
		jest.useFakeTimers();
		const h = harness();
		const dispatch = deferred();
		h.router.dispatch.mockReturnValue(dispatch.promise);
		const consumed = message();
		const handler = await consumerHandler(h);

		const handling = handler(consumed);
		await Promise.resolve();
		await jest.advanceTimersByTimeAsync(60_000);

		expect(h.receipts.renew).toHaveBeenCalledWith(
			EVENT_ID,
			REPORTING_CONSUMERS.identityUser,
			LOCK_TOKEN
		);

		dispatch.resolve();
		await handling;
		await jest.advanceTimersByTimeAsync(120_000);
		expect(h.receipts.renew).toHaveBeenCalledTimes(1);
	});

	it('records a renewal transport failure but leaves final ack/nack to processing', async () => {
		jest.useFakeTimers();
		const h = harness();
		const dispatch = deferred();
		h.router.dispatch.mockReturnValue(dispatch.promise);
		h.receipts.renew.mockRejectedValue(new Error('database unavailable'));
		const consumed = message();
		const handler = await consumerHandler(h);

		const handling = handler(consumed);
		await Promise.resolve();
		await jest.advanceTimersByTimeAsync(60_000);

		expect(h.metrics.increment).toHaveBeenCalledWith(
			'consumer_lease_renew_failures_total'
		);
		expect(h.rabbitMq.ack).not.toHaveBeenCalled();
		expect(h.rabbitMq.nack).not.toHaveBeenCalled();

		dispatch.resolve();
		await handling;
		expect(h.rabbitMq.ack).toHaveBeenCalledWith(consumed);
	});

	it('cancels consumers and drains a tracked handler before shutdown completes', async () => {
		const h = harness();
		const dispatch = deferred();
		h.router.dispatch.mockReturnValue(dispatch.promise);
		const handler = await consumerHandler(h);
		const handling = handler(message());
		await Promise.resolve();

		const shutdown = h.service.beforeApplicationShutdown();
		await Promise.resolve();
		expect(h.rabbitMq.cancelConsumers).toHaveBeenCalledTimes(1);
		let shutdownComplete = false;
		void shutdown.then(() => {
			shutdownComplete = true;
		});
		await Promise.resolve();
		expect(shutdownComplete).toBe(false);

		dispatch.resolve();
		await handling;
		await shutdown;
		expect(shutdownComplete).toBe(true);
		expect(h.service.isReady()).toBe(false);
	});
});
