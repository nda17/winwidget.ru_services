import { randomUUID } from 'node:crypto';
import { CrmTeamRabbitService } from './team-rabbit.service';
import { CrmTeamOutboxService } from './team-outbox.service';

describe('CRM team publisher delivery boundary', () => {
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
