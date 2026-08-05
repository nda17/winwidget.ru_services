import {
	DATABASE_RESTORE_QUEUE_MANIFEST_VERSION,
	DatabaseRestoreJobPayload,
	canonicalDatabaseRestoreJson,
	parseAndVerifyDatabaseRestoreJobManifest,
	parseAndVerifyDatabaseRestoreTargetLock,
	parseAndVerifyDatabaseRestoreTransitionGate,
	signDatabaseRestoreJobPayload,
	signDatabaseRestoreTargetLock,
	signDatabaseRestoreTransitionGate,
	verifyDatabaseRestoreJobManifest
} from '@/dev-tools/database-restore-queue.contract';
import { randomUUID } from 'node:crypto';

describe('database restore queue contract', () => {
	const secret = 'restore-queue-test-secret-32-characters';

	const createQueuedPayload = (): DatabaseRestoreJobPayload => {
		const jobId = randomUUID();
		return {
			version: DATABASE_RESTORE_QUEUE_MANIFEST_VERSION,
			jobId,
			target: 'reporting',
			status: 'QUEUED',
			uploadFileName: `${jobId}.dump`,
			originalFileName: 'reporting.dump',
			fileSize: 128,
			sha256: 'a'.repeat(64),
			requestedBy: 'clrestoreadmin123',
			requestedAt: '2026-07-31T10:00:00.000Z',
			startedAt: null,
			finishedAt: null,
			attempt: 0,
			error: null,
			result: null
		};
	};

	it('canonicalizes object keys deterministically', () => {
		expect(canonicalDatabaseRestoreJson({ z: 1, a: { y: 2, b: 3 } })).toBe(
			'{"a":{"b":3,"y":2},"z":1}'
		);
		expect(canonicalDatabaseRestoreJson({ a: { b: 3, y: 2 }, z: 1 })).toBe(
			'{"a":{"b":3,"y":2},"z":1}'
		);
	});

	it('signs, verifies and parses a strict queued manifest', () => {
		const manifest = signDatabaseRestoreJobPayload(
			createQueuedPayload(),
			secret
		);

		expect(manifest.signature).toMatch(/^[0-9a-f]{64}$/);
		expect(verifyDatabaseRestoreJobManifest(manifest, secret)).toBe(true);
		expect(
			parseAndVerifyDatabaseRestoreJobManifest(
				`${JSON.stringify(manifest)}\n`,
				secret
			)
		).toEqual(manifest);
	});

	it('fails closed for tampering, weak secrets and unexpected fields', () => {
		const manifest = signDatabaseRestoreJobPayload(
			createQueuedPayload(),
			secret
		);

		expect(
			verifyDatabaseRestoreJobManifest(
				{ ...manifest, target: 'core' },
				secret
			)
		).toBe(false);
		expect(() =>
			signDatabaseRestoreJobPayload(createQueuedPayload(), 'short-secret')
		).toThrow('at least 32 bytes');
		expect(() =>
			parseAndVerifyDatabaseRestoreJobManifest(
				JSON.stringify({ ...manifest, unexpected: true }),
				secret
			)
		).toThrow('unexpected fields');
	});

	it('signs a strict target lock bound to one target and job', () => {
		const payload = createQueuedPayload();
		const lock = signDatabaseRestoreTargetLock(
			{
				version: 1,
				target: payload.target,
				jobId: payload.jobId,
				createdAt: payload.requestedAt
			},
			secret
		);

		expect(
			parseAndVerifyDatabaseRestoreTargetLock(JSON.stringify(lock), secret)
		).toEqual(lock);
		expect(() =>
			parseAndVerifyDatabaseRestoreTargetLock(
				JSON.stringify({ ...lock, target: 'core' }),
				secret
			)
		).toThrow('signature is invalid');
	});

	it('signs a domain-bound transition gate for cancellation races', () => {
		const payload = createQueuedPayload();
		const gate = signDatabaseRestoreTransitionGate(
			{
				version: 1,
				kind: 'DATABASE_RESTORE_TRANSITION_GATE',
				target: payload.target,
				jobId: payload.jobId,
				createdAt: payload.requestedAt
			},
			secret
		);

		expect(
			parseAndVerifyDatabaseRestoreTransitionGate(
				JSON.stringify(gate),
				secret
			)
		).toEqual(gate);
		expect(() =>
			parseAndVerifyDatabaseRestoreTransitionGate(
				JSON.stringify({ ...gate, jobId: randomUUID() }),
				secret
			)
		).toThrow('signature is invalid');
	});

	it('accepts only coherent terminal fields', () => {
		const queued = createQueuedPayload();
		const succeeded: DatabaseRestoreJobPayload = {
			...queued,
			status: 'SUCCEEDED',
			startedAt: '2026-07-31T10:01:00.000Z',
			finishedAt: '2026-07-31T10:02:00.000Z',
			attempt: 1,
			result: {
				safetyBackupFileName: `safety-${queued.jobId}.dump`,
				safetyBackupSha256: 'b'.repeat(64),
				restoredAt: '2026-07-31T10:01:30.000Z',
				verifiedAt: '2026-07-31T10:01:50.000Z'
			}
		};

		expect(() =>
			signDatabaseRestoreJobPayload(succeeded, secret)
		).not.toThrow();
		expect(() =>
			signDatabaseRestoreJobPayload(
				{
					...queued,
					status: 'CANCELLED',
					startedAt: '2026-07-31T10:01:00.000Z',
					finishedAt: '2026-07-31T10:01:01.000Z',
					attempt: 1
				},
				secret
			)
		).not.toThrow();
		expect(() =>
			signDatabaseRestoreJobPayload({ ...succeeded, result: null }, secret)
		).toThrow('Invalid SUCCEEDED');
	});

	it('accepts Widgets as a strict independently signed restore target', () => {
		const jobId = randomUUID();
		const payload: DatabaseRestoreJobPayload = {
			...createQueuedPayload(),
			jobId,
			target: 'widgets',
			uploadFileName: `${jobId}.dump`,
			originalFileName: 'widgets.dump'
		};

		expect(() =>
			parseAndVerifyDatabaseRestoreJobManifest(
				JSON.stringify(signDatabaseRestoreJobPayload(payload, secret)),
				secret
			)
		).not.toThrow();
	});
});
