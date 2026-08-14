import { Prisma } from '@prisma/billing-client';
import { EventEmitter } from 'node:events';
import { BillingCampaignAudienceService } from './billing-campaign-audience.service';

class ResponseFixture extends EventEmitter {
	destroyed = false;
	writableEnded = false;
	lines: string[] = [];

	write(value: string): boolean {
		this.lines.push(value);
		return true;
	}
}

describe('BillingCampaignAudienceService', () => {
	it('uses one database transaction timestamp after a delayed transaction start', async () => {
		jest.useFakeTimers();
		jest.setSystemTime(new Date('2026-08-14T08:00:00.000Z'));
		const databaseAsOf = new Date('2026-08-14T08:05:00.000Z');
		let audienceQuery: Prisma.Sql | undefined;
		const transaction = {
			$executeRaw: jest.fn().mockResolvedValue(0),
			$queryRaw: jest.fn(async (query: Prisma.Sql) => {
				const sql = query.strings.join(' ');
				if (sql.includes('transaction_timestamp()')) {
					return [{ asOf: databaseAsOf }];
				}
				audienceQuery = query;
				return [{ userId: 'user-1' }];
			})
		};
		const prisma = {
			$transaction: jest.fn(
				async (
					callback: (client: typeof transaction) => Promise<void>,
					options: unknown
				) => {
					jest.setSystemTime(new Date('2026-08-14T08:10:00.000Z'));
					await callback(transaction);
					return options;
				}
			)
		};
		const response = new ResponseFixture();
		const service = new BillingCampaignAudienceService(prisma as never);

		try {
			await service.stream({ aborted: false } as never, response as never);
		} finally {
			jest.useRealTimers();
		}

		const lines = response.lines.map(line => JSON.parse(line));
		expect(lines[0]).toMatchObject({
			type: 'snapshot',
			schemaVersion: 1,
			asOf: databaseAsOf.toISOString()
		});
		expect(lines[1]).toEqual({ type: 'subscriber', userId: 'user-1' });
		expect(lines[2]).toMatchObject({ type: 'complete', totalCount: 1 });
		expect(audienceQuery?.values).toContain(databaseAsOf);
		expect(prisma.$transaction).toHaveBeenCalledWith(
			expect.any(Function),
			expect.objectContaining({
				isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead
			})
		);
	});
});
