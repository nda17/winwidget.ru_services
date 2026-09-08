import { randomUUID } from 'node:crypto';
import { ReminderRuntimeService } from './reminder-runtime.service';
import { REMINDER_TICK } from './reminder-delivery.contract';

const now = new Date('2026-09-07T12:00:00.000Z');
function fixture() {
	const id = randomUUID(),
		eventId = randomUUID();
	let row: any = {
		id,
		periodKey: 'minute:test',
		workspaceId: null,
		taskId: null,
		cursor: null,
		status: 'PENDING',
		availableAt: new Date(now.getTime() - 1000),
		leaseToken: null,
		leaseExpiresAt: null,
		attempts: 0
	};
	const outbox: any[] = [];
	const match = (where: any) =>
		row &&
		row.id === where.id &&
		(!where.status || row.status === where.status) &&
		(!where.leaseToken || row.leaseToken === where.leaseToken) &&
		(!where.leaseExpiresAt?.gt ||
			row.leaseExpiresAt > where.leaseExpiresAt.gt) &&
		(!where.availableAt?.lte ||
			row.availableAt <= where.availableAt.lte) &&
		(!where.OR ||
			where.OR.some(
				(part: any) =>
					row.status === part.status &&
					(!part.leaseExpiresAt?.lte ||
						row.leaseExpiresAt <= part.leaseExpiresAt.lte)
			));
	const prisma: any = {
		reminderJob: {
			findUnique: jest.fn(async () => row && { ...row }),
			findUniqueOrThrow: jest.fn(async () => ({ ...row })),
			updateMany: jest.fn(async ({ where, data }: any) => {
				if (!match(where)) return { count: 0 };
				for (const [key, value] of Object.entries(data))
					row[key] =
						value && typeof value === 'object' && 'increment' in value
							? row[key] + (value as any).increment
							: value;
				return { count: 1 };
			})
		},
		reminderOutbox: {
			create: jest.fn(async ({ data }: any) => {
				outbox.push(data);
				return data;
			})
		},
		$transaction: jest.fn(async (fn: any) => {
			const before = { ...row },
				length = outbox.length;
			try {
				return await fn(prisma);
			} catch (error) {
				row = before;
				outbox.splice(length);
				throw error;
			}
		})
	};
	const rabbit: any = {
		ack: jest.fn(),
		nack: jest.fn(),
		publish: jest.fn(),
		isReady: jest.fn(() => true)
	};
	const delivery: any = {
		processPage: jest.fn(async () => {
			row.status = 'COMPLETED';
		}),
		schedulePeriod: jest.fn()
	};
	const series: any = {
		processPage: jest.fn(async () => {
			row.status = 'COMPLETED';
		}),
		schedulePeriod: jest.fn()
	};
	const service = new ReminderRuntimeService(
		prisma,
		rabbit,
		delivery,
		{} as never,
		series
	);
	const message: any = {
		content: Buffer.from(
			JSON.stringify({
				schemaVersion: 1,
				eventId,
				eventType: REMINDER_TICK,
				occurredAt: now.toISOString(),
				jobId: id
			})
		),
		properties: { messageId: eventId, type: REMINDER_TICK },
		fields: { routingKey: REMINDER_TICK }
	};
	return {
		service,
		series,
		prisma,
		rabbit,
		delivery,
		message,
		outbox,
		row: () => row,
		setRow: (value: any) => {
			row = value;
		}
	};
}
describe('Reminder push consumer durable claim/CAS and publisher', () => {
	beforeEach(() => {
		jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
		jest.setSystemTime(now);
	});
	afterEach(() => jest.useRealTimers());
	it('keeps series wakes running during an external transport outage without publishing email/Telegram', async () => {
		const h = fixture();
		const transportReady = jest.fn(async () => false);
		(h.service as any).readiness.transportReady = transportReady;
		h.prisma.reminderRuntime = { upsert: jest.fn() };
		const rows = [
			'notification.wincrm.task-reminder.email.requested.v1',
			'notification.wincrm.task-reminder.telegram.requested.v1',
			REMINDER_TICK
		].map(eventType => ({
			id: randomUUID(),
			messageId: randomUUID(),
			eventType,
			payload: {},
			attempts: 0,
			status: 'PENDING'
		}));
		h.prisma.reminderOutbox.findFirst = jest.fn(async ({ where }: any) =>
			rows.find(
				row =>
					row.status === 'PENDING' &&
					(!where.eventType || row.eventType === where.eventType)
			)
		);
		h.prisma.reminderOutbox.updateMany = jest.fn(
			async ({ where, data }: any) => {
				const row = rows.find(row => row.id === where.id)!;
				if (where.eventType && row.eventType !== where.eventType)
					return { count: 0 };
				Object.assign(row, data);
				return { count: 1 };
			}
		);
		await (h.service as any).runTick();
		expect(h.series.schedulePeriod).toHaveBeenCalledTimes(1);
		expect(h.delivery.schedulePeriod).not.toHaveBeenCalled();
		expect(h.rabbit.publish).toHaveBeenCalledTimes(1);
		expect(h.rabbit.publish).toHaveBeenCalledWith(
			rows[2].messageId,
			REMINDER_TICK,
			rows[2].payload
		);
		expect(rows.slice(0, 2).map(row => row.status)).toEqual([
			'PENDING',
			'PENDING'
		]);
		transportReady.mockResolvedValue(true);
		jest.setSystemTime(new Date(now.getTime() + 11000));
		await (h.service as any).runTick();
		expect(h.delivery.schedulePeriod).toHaveBeenCalledTimes(1);
		expect(h.rabbit.publish).toHaveBeenCalledTimes(3);
	});
	it('dispatches recurring series scans to their generator before ACK, without misreading them as reminder scans', async () => {
		const h = fixture();
		h.row().periodKey = 'task-series-scan:minute:2026-09-08T12:00:00.000Z';
		await h.service.handle(h.message);
		expect(h.series.processPage).toHaveBeenCalledTimes(1);
		expect(h.delivery.processPage).not.toHaveBeenCalled();
		expect(h.rabbit.ack).toHaveBeenCalledTimes(1);
	});
	it('claims before work and ACKs only after durable completion', async () => {
		const h = fixture();
		h.delivery.processPage.mockImplementationOnce(
			async (_job: any, token: string, owned: () => boolean) => {
				expect(h.row()).toMatchObject({
					status: 'PROCESSING',
					leaseToken: token
				});
				expect(owned()).toBe(true);
				expect(h.rabbit.ack).not.toHaveBeenCalled();
				h.row().status = 'COMPLETED';
			}
		);
		await h.service.handle(h.message);
		expect(h.rabbit.ack).toHaveBeenCalledTimes(1);
		await h.service.handle(h.message);
		expect(h.delivery.processPage).toHaveBeenCalledTimes(1);
	});
	it('crash-after-claim before expiry persists a delayed wake before ACK; repeated redelivery gets distinct Outbox receipt', async () => {
		const h = fixture();
		Object.assign(h.row(), {
			status: 'PROCESSING',
			leaseToken: randomUUID(),
			leaseExpiresAt: new Date(now.getTime() + 30_000)
		});
		await h.service.handle(h.message);
		await h.service.handle(h.message);
		expect(h.delivery.processPage).not.toHaveBeenCalled();
		expect(h.outbox).toHaveLength(2);
		expect(h.outbox[0].availableAt).toEqual(h.row().leaseExpiresAt);
		expect(h.outbox[0].id).not.toBe(h.outbox[1].id);
		expect(h.outbox[0].messageId).not.toBe(h.outbox[1].messageId);
		expect(h.rabbit.ack).toHaveBeenCalledTimes(2);
	});
	it('reclaims only an expired lease and preserves the durable cursor', async () => {
		const h = fixture(),
			cursor = randomUUID();
		Object.assign(h.row(), {
			cursor,
			status: 'PROCESSING',
			leaseToken: randomUUID(),
			leaseExpiresAt: new Date(now.getTime() - 1)
		});
		await h.service.handle(h.message);
		expect(h.delivery.processPage.mock.calls[0][0]).toMatchObject({
			cursor
		});
		expect(h.rabbit.ack).toHaveBeenCalledTimes(1);
	});
	it('renewal between read and CAS cannot be stolen; schedules wake at renewed expiry', async () => {
		const h = fixture();
		Object.assign(h.row(), {
			status: 'PROCESSING',
			leaseToken: randomUUID(),
			leaseExpiresAt: new Date(now.getTime() - 1)
		});
		const update = h.prisma.reminderJob.updateMany.getMockImplementation();
		h.prisma.reminderJob.updateMany.mockImplementationOnce(
			async (args: any) => {
				h.row().leaseExpiresAt = new Date(now.getTime() + 60_000);
				return update(args);
			}
		);
		await h.service.handle(h.message);
		expect(h.delivery.processPage).not.toHaveBeenCalled();
		expect(h.outbox[0].availableAt).toEqual(h.row().leaseExpiresAt);
	});
	it('future availability is preserved, not bypassed by redelivery', async () => {
		const h = fixture();
		h.row().availableAt = new Date(now.getTime() + 300_000);
		await h.service.handle(h.message);
		expect(h.delivery.processPage).not.toHaveBeenCalled();
		expect(h.outbox[0].availableAt).toEqual(h.row().availableAt);
	});
	it('busy recovery Outbox failure does not ACK', async () => {
		const h = fixture();
		Object.assign(h.row(), {
			status: 'PROCESSING',
			leaseToken: randomUUID(),
			leaseExpiresAt: new Date(now.getTime() + 30_000)
		});
		h.prisma.reminderOutbox.create.mockRejectedValueOnce(
			new Error('db unavailable')
		);
		await expect(h.service.handle(h.message)).rejects.toThrow();
		expect(h.rabbit.ack).not.toHaveBeenCalled();
	});
	it('work failure commits delayed retry, unchanged cursor and released lease before ACK', async () => {
		const h = fixture(),
			cursor = randomUUID();
		h.row().cursor = cursor;
		h.delivery.processPage.mockRejectedValueOnce(
			new Error('authority outage')
		);
		await h.service.handle(h.message);
		expect(h.row()).toMatchObject({
			status: 'PENDING',
			cursor,
			leaseToken: null,
			leaseExpiresAt: null
		});
		expect(h.outbox).toHaveLength(1);
		expect(h.outbox[0].availableAt.getTime()).toBeGreaterThan(
			now.getTime()
		);
		expect(h.rabbit.ack).toHaveBeenCalledTimes(1);
	});
	it('failed completion after lease loss cannot ACK or clobber new owner', async () => {
		const h = fixture(),
			newToken = randomUUID();
		h.delivery.processPage.mockImplementationOnce(async () => {
			h.row().leaseToken = newToken;
			throw new Error('lease lost');
		});
		await expect(h.service.handle(h.message)).rejects.toThrow(
			'REMINDER_JOB_LEASE_LOST'
		);
		expect(h.row().leaseToken).toBe(newToken);
		expect(h.rabbit.ack).not.toHaveBeenCalled();
		expect(h.outbox).toHaveLength(0);
	});
	it('heartbeat renewal uses exact owner, PROCESSING and unexpired lease', async () => {
		const h = fixture();
		let release!: () => void;
		h.delivery.processPage.mockImplementationOnce(
			() =>
				new Promise<void>(resolve => {
					release = resolve;
				})
		);
		const pending = h.service.handle(h.message);
		await Promise.resolve();
		await Promise.resolve();
		await Promise.resolve();
		await jest.advanceTimersByTimeAsync(15_000);
		expect(
			h.prisma.reminderJob.updateMany.mock.calls.at(-1)[0].where
		).toMatchObject({
			status: 'PROCESSING',
			leaseToken: h.row().leaseToken,
			leaseExpiresAt: { gt: expect.any(Date) }
		});
		release();
		await pending;
	});
	it.each([
		'foreign-kind',
		'foreign-route',
		'mismatch-id',
		'unexpected-body',
		'oversize'
	])(
		'malformed %s goes only to configured DLQ, no DB work',
		async problem => {
			const h = fixture();
			if (problem === 'foreign-kind') h.message.properties.type = 'other';
			if (problem === 'foreign-route')
				h.message.fields.routingKey = 'other';
			if (problem === 'mismatch-id')
				h.message.properties.messageId = randomUUID();
			if (problem === 'unexpected-body')
				h.message.content = Buffer.from(
					JSON.stringify({
						...JSON.parse(h.message.content),
						email: 'secret@example.test'
					})
				);
			if (problem === 'oversize') h.message.content = Buffer.alloc(2049);
			await h.service.handle(h.message);
			expect(h.rabbit.nack).toHaveBeenCalledWith(h.message, false);
			expect(h.prisma.reminderJob.findUnique).not.toHaveBeenCalled();
		}
	);
	it('publisher sends only claimed rows, retries transient failures without finite loss, repeats expiry/availability CAS', async () => {
		const h = fixture(),
			row: any = {
				id: randomUUID(),
				messageId: randomUUID(),
				eventType: REMINDER_TICK,
				payload: {},
				attempts: 999
			};
		h.prisma.reminderOutbox.findFirst = jest.fn(async () => row);
		h.prisma.reminderOutbox.updateMany = jest.fn(async () => ({
			count: 1
		}));
		h.rabbit.publish.mockRejectedValueOnce(new Error('mandatory return'));
		await h.service.publishOne();
		const calls = h.prisma.reminderOutbox.updateMany.mock.calls;
		expect(calls[0][0].where).toMatchObject({
			id: row.id,
			availableAt: { lte: expect.any(Date) },
			OR: [
				{ status: 'PENDING' },
				{ status: 'PROCESSING', leaseExpiresAt: { lte: expect.any(Date) } }
			]
		});
		expect(calls[1][0].data).toMatchObject({
			status: 'PENDING',
			leaseToken: null
		});
		expect(calls[1][0].data.availableAt.getTime()).toBe(
			now.getTime() + 900_000
		);
		expect(
			calls.some(([args]: any) => args.data.status === 'PUBLISHED')
		).toBe(false);
	});
});
