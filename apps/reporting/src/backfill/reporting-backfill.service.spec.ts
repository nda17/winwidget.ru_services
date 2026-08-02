import { ReportingBackfillService } from './reporting-backfill.service';
import { createHash } from 'node:crypto';

describe('ReportingBackfillService NDJSON contract', () => {
	const snapshotId = '11111111-1111-4111-8111-111111111111';
	const event = {
		schemaVersion: 1,
		eventType: 'widgets.lead.changed.v1',
		eventId: '22222222-2222-4222-8222-222222222222',
		aggregateId: 'quiz:lead-1',
		aggregateVersion: '0',
		sourceSequence: '0',
		occurredAt: '2026-07-31T00:00:00.000Z',
		tombstone: false,
		state: {
			id: 'lead-1',
			widgetId: 'widget-1',
			widgetType: 'quiz',
			createdAt: '2026-07-31T00:00:00.000Z'
		}
	};

	function harness() {
		const reportingBackfillRun = {
			create: jest.fn().mockResolvedValue({}),
			findUnique: jest.fn(),
			updateMany: jest.fn().mockResolvedValue({ count: 1 })
		};
		const projections = {
			applyBatch: jest.fn().mockResolvedValue({
				applied: 1,
				duplicate: 0,
				stale: 0
			})
		};
		return {
			projections,
			instance: new ReportingBackfillService(
				{} as never,
				projections as never,
				{ backfillEnabled: true } as never,
				{ increment: jest.fn() } as never,
				{ reportingBackfillRun } as never
			)
		};
	}

	function service() {
		return harness().instance;
	}

	function response(shaOverride?: string): Response {
		const headerLine = `${JSON.stringify({
			schemaVersion: 1,
			kind: 'header',
			snapshotId,
			watermarks: {
				identityUser: '0',
				billingPayment: '0',
				billingSubscription: '0',
				widget: '0',
				lead: '0',
				reportingSettings: '0'
			}
		})}\n`;
		const recordLine = `${JSON.stringify({
			schemaVersion: 1,
			kind: 'record',
			stream: 'lead',
			event
		})}\n`;
		const sha256 = createHash('sha256')
			.update(headerLine)
			.update(recordLine)
			.digest('hex');
		const text = [
			headerLine.trimEnd(),
			recordLine.trimEnd(),
			JSON.stringify({
				schemaVersion: 1,
				kind: 'footer',
				snapshotId,
				recordCount: 1,
				sha256: shaOverride || sha256
			}),
			''
		].join('\n');
		return new Response(text, {
			headers: { 'content-type': 'application/x-ndjson' }
		});
	}

	it('validates header, record/footer count and exact record-line checksum', async () => {
		await expect(
			service().importResponse(response())
		).resolves.toMatchObject({
			snapshotId,
			recordCount: 1,
			applied: 1,
			counts: { lead: 1 }
		});
	});

	it('fails closed on a checksum mismatch', async () => {
		const { instance, projections } = harness();
		await expect(
			instance.importResponse(response('0'.repeat(64)))
		).rejects.toThrow('SHA-256 mismatch');
		expect(projections.applyBatch).not.toHaveBeenCalled();
	});
});
