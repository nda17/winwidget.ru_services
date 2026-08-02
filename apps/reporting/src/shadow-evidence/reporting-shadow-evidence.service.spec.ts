import {
	ReportingSourceEvent,
	parseReportingSourceEvent
} from '../projections/reporting-event.contract';
import { reportingProjectionStateHash } from '../projections/projection.service';
import { ProjectionComparisonAccumulator } from './reporting-shadow-evidence.service';

const AS_OF = new Date('2026-08-01T12:00:00.000Z');

function payment(amount: string, updatedAt: string): ReportingSourceEvent {
	return parseReportingSourceEvent({
		schemaVersion: 1,
		eventType: 'billing.payment.changed.v1',
		eventId: '00000000-0000-4000-8000-000000000001',
		aggregateId: 'payment-1',
		aggregateVersion: '1',
		sourceSequence: '1',
		occurredAt: updatedAt,
		tombstone: false,
		state: {
			id: 'payment-1',
			userId: 'private-user-id',
			amount,
			status: 'SUCCEEDED',
			createdAt: updatedAt,
			updatedAt
		}
	});
}

function lead(createdAt: string): ReportingSourceEvent {
	return parseReportingSourceEvent({
		schemaVersion: 1,
		eventType: 'widgets.lead.changed.v1',
		eventId: '00000000-0000-4000-8000-000000000002',
		aggregateId: 'wheel:private-lead-id',
		aggregateVersion: '1',
		sourceSequence: '2',
		occurredAt: createdAt,
		tombstone: false,
		state: {
			id: 'private-lead-id',
			widgetId: 'private-widget-id',
			widgetType: 'wheel',
			createdAt
		}
	});
}

describe('ProjectionComparisonAccumulator', () => {
	it('derives real totals and frozen UTC periods from projection states', () => {
		const accumulator = new ProjectionComparisonAccumulator(AS_OF);
		accumulator.add(payment('10,5', '2026-07-15T00:00:00.000Z'));
		accumulator.add(lead('2026-08-01T00:00:00.000Z'));
		const values = accumulator.finish();
		const totals = values.totals as { succeededRevenue: number };
		const periods = values.periods as {
			revenue30d: number;
			leadsToday: number;
			leadDays: Record<string, number>;
		};
		const checksums = values.checksums as { activeRecordCount: number };

		expect(totals.succeededRevenue).toBe(10.5);
		expect(periods.revenue30d).toBe(10.5);
		expect(periods.leadsToday).toBe(1);
		expect(periods.leadDays['2026-08-01']).toBe(1);
		expect(checksums.activeRecordCount).toBe(2);
	});

	it('changes the manifest when any real projection state changes', () => {
		const first = new ProjectionComparisonAccumulator(AS_OF);
		const second = new ProjectionComparisonAccumulator(AS_OF);
		first.add(payment('10', '2026-07-15T00:00:00.000Z'));
		second.add(payment('11', '2026-07-15T00:00:00.000Z'));

		expect(first.finish().checksums).not.toEqual(
			second.finish().checksums
		);
	});

	it('rejects a live target row whose stored hash hides field corruption', () => {
		const event = payment('10', '2026-07-15T00:00:00.000Z');
		const accumulator = new ProjectionComparisonAccumulator(AS_OF);
		expect(() => accumulator.add(event, 'a'.repeat(64))).toThrow(
			'stored state hash differs'
		);
		expect(() =>
			accumulator.add(event, reportingProjectionStateHash(event))
		).not.toThrow();
	});

	it('does not expose source aggregate or relationship identifiers', () => {
		const accumulator = new ProjectionComparisonAccumulator(AS_OF);
		accumulator.add(payment('10', '2026-07-15T00:00:00.000Z'));
		accumulator.add(lead('2026-08-01T00:00:00.000Z'));
		const serialized = JSON.stringify(accumulator.finish());
		expect(serialized).not.toContain('private-user-id');
		expect(serialized).not.toContain('private-widget-id');
		expect(serialized).not.toContain('private-lead-id');
	});
});
