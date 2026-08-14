import {
	AuthIdentityType,
	Role,
	UserStatus
} from '@prisma/identity-client';
import { createHash } from 'node:crypto';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
	IdentityCutoverError,
	loadIdentitySnapshot,
	parseIdentityCutoverArgs,
	snapshotSemanticHash,
	validateIdentitySnapshot
} from './main';

const USER_ID = '00000000-0000-4000-8000-000000000001';
const IDENTITY_ID = '00000000-0000-4000-8000-000000000011';
const CREATED_AT = '2026-08-14T10:00:00.000Z';

function snapshot() {
	return {
		schemaVersion: 1,
		snapshotId: '00000000-0000-4000-8000-000000000099',
		createdAt: CREATED_AT,
		counts: {
			users: 1,
			identities: 1,
			telegramNotificationChannels: 0,
			emailCollisionGroups: 0,
			phoneCollisionGroups: 0,
			reportingVersionCoverageFailures: 0,
			billingVersionCoverageFailures: 0
		},
		authSettings: {
			recaptchaEnabled: true,
			googleAuthEnabled: true,
			yandexAuthEnabled: false,
			githubAuthEnabled: true,
			vkAuthEnabled: false,
			telegramAuthEnabled: true
		},
		users: [
			{
				id: USER_ID,
				name: 'User',
				password: '$2a$10$opaque',
				avatarPath: null,
				status: UserStatus.ACTIVE,
				personalDataConsentRevokedAt: null,
				deletedAt: null,
				rights: [Role.USER],
				createdAt: CREATED_AT,
				updatedAt: CREATED_AT,
				authIdentities: [
					{
						id: IDENTITY_ID,
						type: AuthIdentityType.EMAIL,
						value: 'user@example.com',
						verifiedAt: CREATED_AT,
						createdAt: CREATED_AT,
						updatedAt: CREATED_AT
					}
				],
				telegramNotificationChannel: null
			}
		],
		versions: {
			reporting: [
				{
					aggregateType: 'identity.user',
					aggregateId: USER_ID,
					version: '7',
					sourceSequence: '12'
				}
			],
			billing: [
				{
					aggregateType: 'billing.identity',
					aggregateId: USER_ID,
					version: '4',
					sourceSequence: '19'
				}
			],
			reportingHighWater: '20',
			billingHighWater: '21'
		}
	};
}

describe('Identity cutover contract', () => {
	it('accepts only the no-argument status/activate/complete contract', () => {
		expect(parseIdentityCutoverArgs(['status'])).toEqual({
			action: 'status'
		});
		expect(parseIdentityCutoverArgs(['activate'])).toEqual({
			action: 'activate'
		});
		expect(parseIdentityCutoverArgs(['complete'])).toEqual({
			action: 'complete'
		});
		expect(() =>
			parseIdentityCutoverArgs(['complete', '--file', '/tmp/a'])
		).toThrow('complete does not accept arguments');
		expect(
			parseIdentityCutoverArgs(['import', '--file', '/tmp/a'])
		).toEqual({
			action: 'import',
			file: '/tmp/a',
			sha256: undefined
		});
	});

	it('validates exact rows, version coverage and imported feature flags', () => {
		const parsed = validateIdentitySnapshot(snapshot());
		expect(parsed.authSettings).toEqual(snapshot().authSettings);
		expect(parsed.versions.reporting[0]?.version).toBe('7');
		expect(parsed.versions.billingHighWater).toBe('21');

		const invalid: any = snapshot();
		invalid.versions.reporting = [];
		expect(() => validateIdentitySnapshot(invalid)).toThrow(
			'identity.user version coverage is invalid'
		);
	});

	it('rejects collisions after canonical phone normalization', () => {
		const invalid: any = snapshot();
		invalid.users[0]!.authIdentities[0]!.type = AuthIdentityType.PHONE;
		invalid.users[0]!.authIdentities[0]!.value = '8 (999) 123-45-67';
		const secondUserId = '00000000-0000-4000-8000-000000000002';
		invalid.users.push({
			...invalid.users[0]!,
			id: secondUserId,
			authIdentities: [
				{
					...invalid.users[0]!.authIdentities[0]!,
					id: '00000000-0000-4000-8000-000000000012',
					value: '+79991234567'
				}
			]
		});
		invalid.counts.users = 2;
		invalid.counts.identities = 2;
		invalid.versions.reporting.push({
			aggregateType: 'identity.user',
			aggregateId: secondUserId,
			version: '1',
			sourceSequence: '13'
		});
		invalid.versions.billing.push({
			aggregateType: 'billing.identity',
			aggregateId: secondUserId,
			version: '1',
			sourceSequence: '20'
		});
		expect(() => validateIdentitySnapshot(invalid)).toThrow(
			'duplicate normalized phone'
		);
	});

	it('fingerprints semantic imported rows and detects corruption', () => {
		const parsed = validateIdentitySnapshot(snapshot());
		const original = snapshotSemanticHash(parsed);
		parsed.users[0]!.name = 'Corrupted';
		expect(snapshotSemanticHash(parsed)).not.toBe(original);
	});

	it('requires a 0600 snapshot, one trailing newline and matching SHA-256', async () => {
		const directory = await mkdtemp(join(tmpdir(), 'identity-cutover-'));
		const file = join(directory, 'snapshot.json');
		const body = `${JSON.stringify(snapshot())}\n`;
		const digest = createHash('sha256').update(body).digest('hex');
		try {
			await writeFile(file, body, { mode: 0o600 });
			await expect(
				loadIdentitySnapshot(file, digest)
			).resolves.toMatchObject({
				sha256: digest
			});
			await expect(
				loadIdentitySnapshot(file, '0'.repeat(64))
			).rejects.toThrow('SHA-256 mismatch');
			await chmod(file, 0o644);
			await expect(loadIdentitySnapshot(file)).rejects.toBeInstanceOf(
				IdentityCutoverError
			);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});
});
