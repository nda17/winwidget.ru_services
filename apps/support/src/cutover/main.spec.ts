import {
	parseSupportCutoverArgs,
	parseSupportSnapshot,
	SupportCutoverError,
	supportSnapshotFingerprint,
	type SupportCutoverSnapshot
} from './main';

function snapshot(): SupportCutoverSnapshot {
	const value: SupportCutoverSnapshot = {
		schemaVersion: 1,
		snapshotId: '11111111-1111-4111-8111-111111111111',
		createdAt: '2026-08-24T00:00:00.000Z',
		sourceRevision: 'a'.repeat(40),
		sourceDatabaseSystemId: '7521492841934400123',
		sourceFingerprint: '',
		sourceHighWatermark: '4815162342',
		counts: { routingSettings: 1, messageMappings: 1 },
		routingSettings: {
			id: 'singleton',
			adminChatId: '-1001234567890',
			supportThreadId: 42,
			updatedAt: '2026-08-24T00:00:00.000Z'
		},
		mappings: [
			{
				sourceId: 'cm1234567890',
				adminChatId: '-1001234567890',
				adminMessageId: 7,
				userChatId: '123456789',
				telegramUserId: '123456789',
				username: 'tester',
				firstName: 'Test',
				lastName: null,
				text: 'question',
				createdAt: '2026-08-24T00:00:00.000Z'
			}
		]
	};
	value.sourceFingerprint = supportSnapshotFingerprint(value);
	return value;
}

describe('Support cutover contract', () => {
	it('accepts only an exact source-bound snapshot', () => {
		expect(parseSupportSnapshot(snapshot())).toEqual(snapshot());
	});

	it('rejects semantic tampering and mapping alias collisions', () => {
		const tampered = snapshot();
		tampered.mappings[0]!.userChatId = '987654321';
		expect(() => parseSupportSnapshot(tampered)).toThrow(
			'sourceFingerprint'
		);

		const duplicate = snapshot();
		duplicate.mappings.push({ ...duplicate.mappings[0]! });
		duplicate.counts.messageMappings = 2;
		duplicate.sourceFingerprint = supportSnapshotFingerprint(duplicate);
		expect(() => parseSupportSnapshot(duplicate)).toThrow(
			'mapping uniqueness'
		);
	});

	it('requires a mode-0600 snapshot SHA anchor for import and activation', () => {
		expect(
			parseSupportCutoverArgs([
				'import',
				'--file',
				'/evidence/support.json',
				'--sha256',
				'b'.repeat(64)
			])
		).toEqual({
			action: 'import',
			file: '/evidence/support.json',
			sha256: 'b'.repeat(64)
		});
		expect(
			parseSupportCutoverArgs(['activate', '--sha256', 'b'.repeat(64)])
		).toEqual({ action: 'activate', sha256: 'b'.repeat(64) });
		expect(() => parseSupportCutoverArgs(['activate'])).toThrow(
			SupportCutoverError
		);
	});
});
