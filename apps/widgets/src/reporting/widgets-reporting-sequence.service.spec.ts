import type { WidgetsPrismaService } from '../prisma/widgets-prisma.service';
import {
	ReportingSequenceSeed,
	WidgetsReportingSequenceService
} from './widgets-reporting-sequence.service';

const POSTGRES_BIGINT_MAX = '9223372036854775807';
const FINGERPRINT = 'a'.repeat(64);

const seed = (
	overrides: Partial<ReportingSequenceSeed> = {}
): ReportingSequenceSeed => ({
	sourceDatabaseFingerprint: FINGERPRINT,
	sourceExportedAt: '2026-08-04T12:00:00.000Z',
	sourceSnapshotSha256: 'c'.repeat(64),
	sourceSnapshotCounts: { widgets: 1, leads: 0 },
	sourceSequenceHighWater: '10',
	aggregates: [
		{
			aggregateType: 'widgets.widget.wheel',
			aggregateId: 'wheel:widget-1',
			version: '2',
			sourceSequence: '9',
			stateHash: 'b'.repeat(64)
		}
	],
	...overrides
});

const createFixture = (
	identityOverrides: Record<string, unknown> = {}
) => {
	const transaction = {
		$executeRaw: jest.fn().mockResolvedValue(1),
		widgetsServiceIdentity: {
			findUnique: jest.fn().mockResolvedValue({
				id: 'widgets-service',
				ownershipActivatedAt: null,
				...identityOverrides
			}),
			upsert: jest.fn().mockResolvedValue({
				id: 'widgets-service',
				databaseId: '11111111-1111-4111-8111-111111111111',
				ownershipGeneration: 0n,
				sourceDatabaseFingerprint: null,
				sourceExportedAt: null,
				sourceSnapshotSha256: null,
				sourceSnapshotCounts: null,
				sourceReportingHighWater: null,
				handoffStartedAt: null,
				ownershipActivatedAt: null,
				...identityOverrides
			}),
			update: jest.fn().mockResolvedValue({})
		},
		widgetSourceSequence: {
			findUnique: jest.fn().mockResolvedValue(null),
			upsert: jest
				.fn()
				.mockResolvedValue({ id: 'reporting', lastValue: 10n })
		},
		widgetAggregateVersion: {
			findUnique: jest.fn().mockResolvedValue(null),
			upsert: jest.fn().mockResolvedValue({})
		},
		widgetsOutboxEvent: {
			create: jest.fn().mockResolvedValue({})
		}
	};
	const prisma = {
		$transaction: jest.fn(async callback => callback(transaction))
	} as unknown as WidgetsPrismaService;
	return {
		service: new WidgetsReportingSequenceService(prisma),
		prisma,
		transaction
	};
};

describe('WidgetsReportingSequenceService', () => {
	it('seeds exact aggregate anchors and the source identity atomically', async () => {
		const fixture = createFixture();

		await fixture.service.seed(seed());

		expect(fixture.transaction.$executeRaw).toHaveBeenCalledTimes(1);
		expect(
			fixture.transaction.widgetSourceSequence.upsert
		).toHaveBeenCalledWith({
			where: { id: 'reporting' },
			create: { id: 'reporting', lastValue: 10n },
			update: { lastValue: 10n }
		});
		expect(
			fixture.transaction.widgetAggregateVersion.upsert
		).toHaveBeenCalledWith(
			expect.objectContaining({
				create: expect.objectContaining({
					version: 2n,
					sourceSequence: 9n,
					stateHash: 'b'.repeat(64)
				})
			})
		);
		expect(
			fixture.transaction.widgetsServiceIdentity.update
		).toHaveBeenCalledWith({
			where: { id: 'widgets-service' },
			data: {
				sourceDatabaseFingerprint: FINGERPRINT,
				sourceExportedAt: new Date('2026-08-04T12:00:00.000Z'),
				sourceSnapshotSha256: 'c'.repeat(64),
				sourceSnapshotCounts: { widgets: 1, leads: 0 },
				sourceReportingHighWater: 10n
			}
		});
	});

	it('accepts the maximum PostgreSQL BIGINT anchor', async () => {
		const fixture = createFixture();
		await expect(
			fixture.service.seed(
				seed({
					sourceSequenceHighWater: POSTGRES_BIGINT_MAX,
					aggregates: [
						{
							...seed().aggregates[0],
							version: POSTGRES_BIGINT_MAX,
							sourceSequence: POSTGRES_BIGINT_MAX
						}
					]
				})
			)
		).resolves.toBeUndefined();
	});

	const overflowCases: Array<[string, Partial<ReportingSequenceSeed>]> = [
		[
			'sourceSequenceHighWater',
			{ sourceSequenceHighWater: '9223372036854775808' }
		],
		[
			'aggregate.version',
			{
				aggregates: [
					{
						...seed().aggregates[0],
						version: '9223372036854775808'
					}
				]
			}
		],
		[
			'aggregate.sourceSequence',
			{
				sourceSequenceHighWater: POSTGRES_BIGINT_MAX,
				aggregates: [
					{
						...seed().aggregates[0],
						sourceSequence: '9223372036854775808'
					}
				]
			}
		]
	];

	it.each(overflowCases)(
		'rejects %s above PostgreSQL BIGINT',
		async (path, overrides) => {
			const fixture = createFixture();
			await expect(fixture.service.seed(seed(overrides))).rejects.toThrow(
				`${path} must be a valid PostgreSQL bigint decimal string`
			);
			expect(fixture.prisma.$transaction).not.toHaveBeenCalled();
		}
	);

	it('rejects another source fingerprint and post-activation reseeding', async () => {
		await expect(
			createFixture({
				sourceDatabaseFingerprint: 'c'.repeat(64)
			}).service.seed(seed())
		).rejects.toThrow('source fingerprint does not match');
		await expect(
			createFixture({
				sourceDatabaseFingerprint: FINGERPRINT,
				ownershipActivatedAt: new Date()
			}).service.seed(seed())
		).rejects.toThrow(
			'cannot be seeded after Widgets ownership activation'
		);
	});

	it('activates only a seeded identity with a source sequence anchor', async () => {
		const fixture = createFixture({
			sourceDatabaseFingerprint: FINGERPRINT,
			sourceExportedAt: new Date('2026-08-04T12:00:00.000Z'),
			sourceSnapshotSha256: 'c'.repeat(64),
			sourceSnapshotCounts: { widgets: 1, leads: 0 },
			sourceReportingHighWater: 10n,
			handoffStartedAt: new Date('2026-08-04T12:01:00.000Z')
		});
		fixture.transaction.widgetSourceSequence.findUnique.mockResolvedValue({
			id: 'reporting',
			lastValue: 10n
		});

		await fixture.service.activateOwnership();

		expect(
			fixture.transaction.widgetsServiceIdentity.update
		).toHaveBeenCalledWith({
			where: { id: 'widgets-service' },
			data: {
				ownershipGeneration: { increment: 1 },
				ownershipActivatedAt: expect.any(Date)
			}
		});
		await expect(
			createFixture().service.activateOwnership()
		).rejects.toThrow(
			'must be seeded before Widgets ownership activation'
		);
		await expect(
			createFixture({
				sourceDatabaseFingerprint: FINGERPRINT,
				sourceExportedAt: new Date('2026-08-04T12:00:00.000Z'),
				sourceSnapshotSha256: 'c'.repeat(64),
				sourceSnapshotCounts: { widgets: 1, leads: 0 },
				sourceReportingHighWater: 10n
			}).service.activateOwnership()
		).rejects.toThrow('durable handoff must start');
	});

	it('creates a Reporting event with syntactically balanced advisory locks', async () => {
		const fixture = createFixture({ ownershipActivatedAt: new Date() });
		fixture.transaction.widgetSourceSequence.upsert.mockResolvedValue({
			id: 'reporting',
			lastValue: 11n
		});

		await expect(
			fixture.service.createEventInTransaction(
				fixture.transaction as never,
				{
					eventType: 'widgets.widget.changed.v1',
					aggregateType: 'widgets.widget.wheel',
					aggregateId: 'wheel:widget-1',
					state: { id: 'widget-1' },
					tombstone: false
				}
			)
		).resolves.toMatchObject({
			aggregateVersion: 1n,
			sourceSequence: 11n
		});

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
		expect(
			fixture.transaction.widgetsOutboxEvent.create
		).toHaveBeenCalledTimes(1);
	});
});
