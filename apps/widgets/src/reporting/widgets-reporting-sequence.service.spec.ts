import { WidgetsReportingSequenceService } from './widgets-reporting-sequence.service';

const createFixture = (currentVersion: bigint | null = null) => {
	const transaction = {
		$executeRaw: jest.fn().mockResolvedValue(1),
		widgetSourceSequence: {
			upsert: jest
				.fn()
				.mockResolvedValue({ id: 'reporting', lastValue: 11n })
		},
		widgetAggregateVersion: {
			findUnique: jest.fn().mockResolvedValue(
				currentVersion === null
					? null
					: {
							version: currentVersion,
							sourceSequence: 10n,
							stateHash: 'a'.repeat(64)
						}
			),
			upsert: jest.fn().mockResolvedValue({})
		},
		widgetsOutboxEvent: {
			create: jest.fn().mockResolvedValue({})
		}
	};
	return {
		service: new WidgetsReportingSequenceService(),
		transaction
	};
};

const input = {
	eventType: 'widgets.widget.changed.v1' as const,
	aggregateType: 'widgets.widget.wheel',
	aggregateId: 'wheel:widget-1',
	state: { id: 'widget-1' },
	tombstone: false,
	occurredAt: new Date('2026-08-27T00:00:00.000Z')
};

describe('WidgetsReportingSequenceService', () => {
	it('creates the first apps-only Reporting event immediately', async () => {
		const fixture = createFixture();

		await expect(
			fixture.service.createEventInTransaction(
				fixture.transaction as never,
				input
			)
		).resolves.toMatchObject({
			aggregateVersion: 1n,
			sourceSequence: 11n
		});

		expect(
			fixture.transaction.widgetSourceSequence.upsert
		).toHaveBeenCalledWith({
			where: { id: 'reporting' },
			create: { id: 'reporting', lastValue: 1n },
			update: { lastValue: { increment: 1 } }
		});
		expect(
			fixture.transaction.widgetsOutboxEvent.create
		).toHaveBeenCalledWith({
			data: expect.objectContaining({
				deduplicationKey:
					'reporting:widgets.widget.wheel:wheel:widget-1:version:1',
				aggregateVersion: 1n,
				sourceSequence: 11n
			})
		});
	});

	it('continues the service-owned aggregate version monotonically', async () => {
		const fixture = createFixture(3n);

		await expect(
			fixture.service.createEventInTransaction(
				fixture.transaction as never,
				input
			)
		).resolves.toMatchObject({ aggregateVersion: 4n });

		expect(
			fixture.transaction.widgetAggregateVersion.upsert
		).toHaveBeenCalledWith(
			expect.objectContaining({
				update: expect.objectContaining({ version: 4n })
			})
		);
	});

	it('rejects inconsistent tombstone payloads before taking a lock', async () => {
		const fixture = createFixture();

		await expect(
			fixture.service.createEventInTransaction(
				fixture.transaction as never,
				{ ...input, tombstone: true }
			)
		).rejects.toThrow(
			'Reporting event tombstone must be true exactly when state is null'
		);
		expect(fixture.transaction.$executeRaw).not.toHaveBeenCalled();
	});

	it('keeps both advisory-lock statements syntactically balanced', async () => {
		const fixture = createFixture();
		await fixture.service.createEventInTransaction(
			fixture.transaction as never,
			input
		);

		expect(fixture.transaction.$executeRaw).toHaveBeenCalledTimes(2);
		for (const [segments] of fixture.transaction.$executeRaw.mock.calls) {
			const sql = (segments as TemplateStringsArray).join('?');
			let depth = 0;
			for (const character of sql) {
				if (character === '(') depth += 1;
				if (character === ')') depth -= 1;
				expect(depth).toBeGreaterThanOrEqual(0);
			}
			expect(depth).toBe(0);
		}
	});
});
