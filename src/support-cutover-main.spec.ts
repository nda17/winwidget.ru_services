import {
	canonicalSupportCoreJson,
	parseSupportCoreCutoverArgs,
	SupportCoreCutoverError,
	supportCoreSnapshotFingerprint,
	type SupportCoreSnapshot
} from '@/support-cutover-main';

describe('Support Core cutover contract', () => {
	it('requires every immutable activation anchor', () => {
		const revision = 'a'.repeat(40);
		expect(
			parseSupportCoreCutoverArgs([
				'activate',
				'--revision',
				revision,
				'--file',
				'/evidence/support.json',
				'--sha256',
				'b'.repeat(64),
				'--fingerprint',
				'c'.repeat(64),
				'--system-id',
				'7521492841934400123',
				'--mapping-count',
				'0',
				'--high-watermark',
				'42'
			])
		).toMatchObject({
			action: 'activate',
			revision,
			mappingCount: '0',
			highWatermark: '42'
		});
		expect(() =>
			parseSupportCoreCutoverArgs(['activate', '--revision', revision])
		).toThrow(SupportCoreCutoverError);
	});

	it('uses stable canonical semantic hashing', () => {
		const value = {
			schemaVersion: 1,
			snapshotId: '11111111-1111-4111-8111-111111111111',
			createdAt: '2026-08-24T00:00:00.000Z',
			sourceRevision: 'a'.repeat(40),
			sourceDatabaseSystemId: '1',
			sourceFingerprint: '',
			sourceHighWatermark: '1',
			counts: { routingSettings: 1 as const, messageMappings: 0 },
			routingSettings: {
				id: 'singleton' as const,
				adminChatId: '-1001',
				supportThreadId: 1,
				updatedAt: '2026-08-24T00:00:00.000Z'
			},
			mappings: []
		} satisfies SupportCoreSnapshot;
		value.sourceFingerprint = supportCoreSnapshotFingerprint(value);
		expect(value.sourceFingerprint).toHaveLength(64);
		expect(canonicalSupportCoreJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
	});
});
