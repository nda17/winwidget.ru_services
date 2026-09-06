import { randomUUID } from 'node:crypto';
import { CrmTeamRabbitService } from './team-rabbit.service';
import { CrmTeamOutboxService } from './team-outbox.service';
import {
	legacyTeamRetryRoute,
	TEAM_RETRY_DELAYS
} from './team-messaging.contract';
import { TEAM_EVENTS } from './team.util';
import type { CrmTeamOutbox } from '@prisma/crm-access-client';

const legacyRow = (
	attempt = 1,
	consumer: keyof typeof TEAM_EVENTS = 'admission'
) =>
	({
		id: randomUUID(),
		messageId: randomUUID(),
		attempts: 2,
		exchange: 'winwidget.retry',
		routingKey: `crm-access.team.${consumer}.retry.${attempt}`,
		eventType: TEAM_EVENTS[consumer],
		payload: { eventId: randomUUID() },
		headers: {
			'x-retry-attempt': attempt,
			'x-delivery-token': randomUUID()
		},
		createdAt: new Date(),
		availableAt: new Date(),
		status: 'PENDING',
		leaseToken: null,
		leaseExpiresAt: null,
		lastError: null,
		publishedAt: null,
		updatedAt: new Date(),
		deduplicationKey: randomUUID()
	}) satisfies CrmTeamOutbox;

describe('CRM team publisher delivery boundary', () => {
	afterEach(() => jest.useRealTimers());
	it.each(Object.keys(TEAM_EVENTS) as (keyof typeof TEAM_EVENTS)[])(
		'converts each unpublished legacy %s retry without shortening its durable deadline',
		consumer => {
			for (const [index, delay] of TEAM_RETRY_DELAYS.entries()) {
				const row = legacyRow(index + 1, consumer);
				expect(legacyTeamRetryRoute(row)).toEqual({
					exchange: 'winwidget.manual-retry',
					routingKey: `crm-access.team.${consumer}`,
					availableAt: new Date(row.createdAt.getTime() + delay)
				});
				row.availableAt = new Date(
					row.createdAt.getTime() + delay + 10000
				);
				expect(legacyTeamRetryRoute(row)?.availableAt).toEqual(
					row.availableAt
				);
			}
		}
	);
	it.each([
		{ routingKey: 'crm-access.team.foreign.retry.1' },
		{ routingKey: 'crm-access.team.admission.retry.4' },
		{ headers: { 'x-retry-attempt': 2 } },
		{ eventType: TEAM_EVENTS.provision },
		{ availableAt: new Date(NaN) }
	])(
		'rejects ambiguous legacy retry metadata without broadening the route',
		changes => {
			expect(() =>
				legacyTeamRetryRoute({
					...legacyRow(),
					...changes
				} as CrmTeamOutbox)
			).toThrow('INVALID_LEGACY_TEAM_RETRY');
		}
	);
	it('defers a legacy retry under its claim before any broker call, without rewriting identity or payload', async () => {
		jest.useFakeTimers({ now: new Date('2026-09-06T18:00:00.000Z') });
		const row = legacyRow();
		const prisma = {
			crmTeamOutbox: {
				findFirst: jest.fn().mockResolvedValue(row),
				updateMany: jest.fn().mockResolvedValue({ count: 1 })
			}
		};
		const rabbit = { publish: jest.fn() };
		const publisher = new CrmTeamOutboxService(
			prisma as never,
			{} as never,
			rabbit as never
		);
		await publisher.publishOne();
		expect(rabbit.publish).not.toHaveBeenCalled();
		expect(prisma.crmTeamOutbox.updateMany).toHaveBeenCalledTimes(2);
		const claimToken =
			prisma.crmTeamOutbox.updateMany.mock.calls[0][0].data.leaseToken;
		expect(prisma.crmTeamOutbox.updateMany.mock.calls[1][0]).toEqual({
			where: { id: row.id, status: 'PROCESSING', leaseToken: claimToken },
			data: {
				exchange: 'winwidget.manual-retry',
				routingKey: 'crm-access.team.admission',
				availableAt: new Date(Date.now() + 30000),
				status: 'PENDING',
				leaseToken: null,
				leaseExpiresAt: null
			}
		});
	});
	it('publishes a due legacy retry directly to its main binding after the route CAS, preserving replay identity', async () => {
		const row = legacyRow();
		row.createdAt = new Date(Date.now() - 60000);
		row.availableAt = new Date(Date.now() - 1);
		const prisma = {
			crmTeamOutbox: {
				findFirst: jest.fn().mockResolvedValue(row),
				updateMany: jest.fn().mockResolvedValue({ count: 1 })
			}
		};
		const rabbit = { publish: jest.fn().mockResolvedValue(undefined) };
		const publisher = new CrmTeamOutboxService(
			prisma as never,
			{} as never,
			rabbit as never
		);
		await publisher.publishOne();
		expect(rabbit.publish).toHaveBeenCalledWith(
			'winwidget.manual-retry',
			'crm-access.team.admission',
			row.payload,
			{
				messageId: row.messageId,
				type: row.eventType,
				headers: row.headers
			}
		);
		expect(
			prisma.crmTeamOutbox.updateMany.mock.invocationCallOrder[1]
		).toBeLessThan(rabbit.publish.mock.invocationCallOrder[0]);
		expect(
			prisma.crmTeamOutbox.updateMany.mock.calls.at(-1)?.[0].data.status
		).toBe('PUBLISHED');
	});
	it('never publishes a legacy retry after losing its conversion lease', async () => {
		const row = legacyRow();
		const prisma = {
			crmTeamOutbox: {
				findFirst: jest.fn().mockResolvedValue(row),
				updateMany: jest
					.fn()
					.mockResolvedValue({ count: 0 })
					.mockResolvedValueOnce({ count: 1 })
			}
		};
		const rabbit = { publish: jest.fn() };
		await new CrmTeamOutboxService(
			prisma as never,
			{} as never,
			rabbit as never
		).publishOne();
		expect(rabbit.publish).not.toHaveBeenCalled();
		expect(
			prisma.crmTeamOutbox.updateMany.mock.calls.at(-1)?.[0]
		).toMatchObject({
			where: {
				id: row.id,
				status: 'PROCESSING',
				leaseToken: expect.any(String)
			}
		});
	});
	it('only selects due PENDING or expired PROCESSING rows, never PUBLISHED history', async () => {
		const prisma = {
			crmTeamOutbox: { findFirst: jest.fn().mockResolvedValue(null) }
		};
		const rabbit = { publish: jest.fn() };
		expect(
			await new CrmTeamOutboxService(
				prisma as never,
				{} as never,
				rabbit as never
			).publishOne()
		).toBe(false);
		expect(prisma.crmTeamOutbox.findFirst).toHaveBeenCalledWith({
			where: {
				availableAt: { lte: expect.any(Date) },
				OR: [
					{ status: 'PENDING' },
					{
						status: 'PROCESSING',
						leaseExpiresAt: { lte: expect.any(Date) }
					}
				]
			},
			orderBy: [{ availableAt: 'asc' }, { createdAt: 'asc' }]
		});
		expect(rabbit.publish).not.toHaveBeenCalled();
	});
	it('publishes Buffer JSON with mandatory and rejects returned confirmed messages', async () => {
		const rabbit = new CrmTeamRabbitService(
			{} as never,
			{ publisherEnabled: true } as never
		);
		const publish = jest
			.fn()
			.mockImplementation(async (_exchange, _route, body, options) => {
				expect(Buffer.isBuffer(body)).toBe(true);
				expect(JSON.parse(body.toString())).toEqual({ eventId: 'test' });
				expect(options).toMatchObject({
					mandatory: true,
					contentType: 'application/json',
					deliveryMode: 2
				});
				const returned = Reflect.get(rabbit, 'returns') as Map<
					string,
					boolean
				>;
				returned.set(options.headers['x-publication-token'], true);
			});
		Reflect.set(rabbit, 'channel', { publish });
		await expect(
			rabbit.publish(
				'winwidget.events',
				'crm.access.admission-wake.v1',
				{ eventId: 'test' },
				{}
			)
		).rejects.toThrow('returned');
	});
	it('marks PUBLISHED only after transport success and returns uncertain publishes to PENDING indefinitely', async () => {
		const row = {
			id: randomUUID(),
			messageId: randomUUID(),
			attempts: 999,
			eventType: 'test',
			routingKey: 'test',
			exchange: 'winwidget.events',
			payload: {},
			headers: {}
		};
		const prisma = {
			crmTeamOutbox: {
				findFirst: jest.fn().mockResolvedValue(row),
				updateMany: jest.fn().mockResolvedValue({ count: 1 })
			}
		};
		let finish!: () => void;
		const rabbit = {
			publish: jest.fn().mockImplementation(
				() =>
					new Promise<void>(resolve => {
						finish = resolve;
					})
			)
		};
		const publisher = new CrmTeamOutboxService(
			prisma as never,
			{} as never,
			rabbit as never
		);
		const running = publisher.publishOne();
		while (!finish)
			await new Promise<void>(resolve => setImmediate(resolve));
		expect(prisma.crmTeamOutbox.updateMany).toHaveBeenCalledTimes(1);
		finish();
		await running;
		expect(prisma.crmTeamOutbox.updateMany.mock.calls[1][0]).toMatchObject(
			{
				where: { status: 'PROCESSING', leaseToken: expect.any(String) },
				data: { status: 'PUBLISHED' }
			}
		);
		rabbit.publish.mockRejectedValueOnce(new Error('mandatory return'));
		await publisher.publishOne();
		expect(
			prisma.crmTeamOutbox.updateMany.mock.calls.at(-1)?.[0]
		).toMatchObject({
			data: {
				status: 'PENDING',
				lastError: 'PUBLISH_UNCONFIRMED',
				availableAt: expect.any(Date)
			}
		});
	});
});
