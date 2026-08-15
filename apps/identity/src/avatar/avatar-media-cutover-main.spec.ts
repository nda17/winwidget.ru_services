import {
	chmod,
	mkdtemp,
	readFile,
	readdir,
	rm,
	writeFile
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { sha256 } from '../common/identity.util';
import {
	AvatarMediaCutoverError,
	activateOwnership,
	assertActivationEvidence,
	classifyAvatarState,
	createManifest,
	parseAvatarMediaCutoverArgs,
	summarizeManifest,
	validateManifest,
	writeManifest,
	type AvatarMediaManifest
} from './avatar-media-cutover-main';

const USER_ID = 'user-1';
const OWNER = sha256(USER_ID);
const NEW_KEY = `identity/avatars/${OWNER}/00000000-0000-4000-8000-000000000001.webp`;
const CONFIG = {
	publicBaseUrl: 'https://cdn.example.test/bucket',
	keyPrefix: 'identity/avatars',
	legacyPublicBaseUrl: 'https://cdn.example.test/bucket',
	legacyKeyPrefix: 'user-avatar',
	uploadsPublicBaseUrl: 'https://api.example.test'
};

function row(
	classification: AvatarMediaManifest['rows'][number]['classification'],
	overrides: Partial<AvatarMediaManifest['rows'][number]> = {}
): AvatarMediaManifest['rows'][number] {
	const hasAvatar = classification !== 'NONE';
	const isManaged = classification === 'NEW_MANAGED';
	return {
		userId: USER_ID,
		avatarPathSha256: hasAvatar ? 'a'.repeat(64) : null,
		avatarObjectKeySha256: isManaged ? sha256(NEW_KEY) : null,
		classification,
		verification: 'NOT_APPLICABLE',
		...(isManaged ? { managedObjectKey: NEW_KEY } : {}),
		...overrides
	};
}

describe('avatar media cutover contract', () => {
	it('parses the exact fail-closed lifecycle commands', () => {
		expect(
			parseAvatarMediaCutoverArgs([
				'activate',
				'--inventory-manifest',
				'/run/avatar-inventory.json',
				'--inventory-sha256',
				'a'.repeat(64),
				'--status-manifest',
				'/run/avatar-status.json',
				'--status-sha256',
				'b'.repeat(64),
				'--revision',
				'c'.repeat(40)
			])
		).toMatchObject({
			action: 'activate',
			inventorySha256: 'a'.repeat(64),
			statusSha256: 'b'.repeat(64),
			revision: 'c'.repeat(40)
		});
		expect(() =>
			parseAvatarMediaCutoverArgs([
				'activate',
				'--inventory-manifest',
				'relative.json'
			])
		).toThrow(AvatarMediaCutoverError);
	});

	it('classifies only exact managed prefixes and leaves OAuth URLs external', () => {
		expect(
			classifyAvatarState(
				{
					id: USER_ID,
					avatarPath: `https://cdn.example.test/bucket/${NEW_KEY}`,
					avatarObjectKey: NEW_KEY
				},
				CONFIG
			).classification
		).toBe('NEW_MANAGED');
		expect(
			classifyAvatarState(
				{
					id: USER_ID,
					avatarPath:
						'https://cdn.example.test/bucket/user-avatar/old.png',
					avatarObjectKey: null
				},
				CONFIG
			).classification
		).toBe('LEGACY_S3');
		expect(
			classifyAvatarState(
				{
					id: USER_ID,
					avatarPath: '/uploads/user-avatar/old.png',
					avatarObjectKey: null
				},
				CONFIG
			).classification
		).toBe('LEGACY_UPLOAD');
		expect(
			classifyAvatarState(
				{
					id: USER_ID,
					avatarPath:
						'https://api.example.test/uploads/user-avatar/old.png',
					avatarObjectKey: null
				},
				CONFIG
			).classification
		).toBe('LEGACY_UPLOAD');
		expect(
			classifyAvatarState(
				{
					id: USER_ID,
					avatarPath: 'https://oauth.example.test/avatar?id=1',
					avatarObjectKey: null
				},
				CONFIG
			).classification
		).toBe('EXTERNAL');
	});

	it('fails closed for managed-base URLs outside the owned prefixes', () => {
		const sameBase = classifyAvatarState(
			{
				id: USER_ID,
				avatarPath: 'https://cdn.example.test/bucket/unmanaged/stale.webp',
				avatarObjectKey: null
			},
			CONFIG
		);
		expect(sameBase).toMatchObject({
			classification: 'INVALID',
			errorCode: 'MANAGED_BASE_KEY_OUTSIDE_PREFIX'
		});

		const distinctBases = {
			...CONFIG,
			legacyPublicBaseUrl: 'https://legacy.example.test/bucket'
		};
		for (const avatarPath of [
			'https://cdn.example.test/bucket/unmanaged/stale.webp',
			'https://legacy.example.test/bucket/unmanaged/stale.webp'
		]) {
			expect(
				classifyAvatarState(
					{ id: USER_ID, avatarPath, avatarObjectKey: null },
					distinctBases
				)
			).toMatchObject({
				classification: 'INVALID',
				errorCode: 'MANAGED_BASE_KEY_OUTSIDE_PREFIX'
			});
		}
		expect(
			classifyAvatarState(
				{
					id: USER_ID,
					avatarPath:
						'https://cdn.example.test/bucket/uploads/user-avatar/old.png',
					avatarObjectKey: null
				},
				{ ...distinctBases, uploadsPublicBaseUrl: CONFIG.publicBaseUrl }
			)
		).toMatchObject({
			classification: 'INVALID',
			errorCode: 'MANAGED_BASE_KEY_OUTSIDE_PREFIX'
		});

		expect(
			classifyAvatarState(
				{
					id: USER_ID,
					avatarPath:
						'https://untrusted.example.test/uploads/user-avatar/old.png',
					avatarObjectKey: null
				},
				distinctBases
			).classification
		).toBe('EXTERNAL');
	});

	it('physically verifies each NEW_MANAGED object and records its digest', async () => {
		const webp = await sharp({
			create: {
				width: 4,
				height: 4,
				channels: 3,
				background: '#fff'
			}
		})
			.webp()
			.toBuffer();
		const fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue(
			new Response(webp, {
				status: 200,
				headers: {
					'content-type': 'image/webp',
					'content-length': String(webp.length)
				}
			})
		);
		try {
			const manifest = await createManifest(
				{
					user: {
						findMany: jest.fn().mockResolvedValue([
							{
								id: USER_ID,
								avatarPath: `https://cdn.example.test/bucket/${NEW_KEY}`,
								avatarObjectKey: NEW_KEY
							}
						])
					}
				} as any,
				CONFIG as any,
				{ kind: 'STATUS', verifyLegacy: false, verifyNew: true }
			);
			expect(fetchSpy).toHaveBeenCalledWith(
				`https://cdn.example.test/bucket/${NEW_KEY}`,
				expect.objectContaining({ redirect: 'error' })
			);
			expect(manifest.rows[0]).toMatchObject({
				classification: 'NEW_MANAGED',
				verification: 'VERIFIED',
				managedObjectKey: NEW_KEY,
				managedObjectSha256: sha256(webp)
			});
			expect(summarizeManifest(manifest).unresolved).toBe(0);
		} finally {
			fetchSpy.mockRestore();
		}
	});

	it('counts a missing NEW_MANAGED object as unresolved', async () => {
		const fetchSpy = jest
			.spyOn(global, 'fetch')
			.mockResolvedValue(new Response(null, { status: 404 }));
		try {
			const manifest = await createManifest(
				{
					user: {
						findMany: jest.fn().mockResolvedValue([
							{
								id: USER_ID,
								avatarPath: `https://cdn.example.test/bucket/${NEW_KEY}`,
								avatarObjectKey: NEW_KEY
							}
						])
					}
				} as any,
				CONFIG as any,
				{ kind: 'STATUS', verifyLegacy: false, verifyNew: true }
			);
			expect(manifest.rows[0]).toMatchObject({
				verification: 'MISSING',
				errorCode: 'NEW_OBJECT_MISSING'
			});
			expect(summarizeManifest(manifest).unresolved).toBe(1);
		} finally {
			fetchSpy.mockRestore();
		}
	});

	it('rejects a public object that is WebP but not normalized to the contract', async () => {
		const oversizedDimensions = await sharp({
			create: {
				width: 1_500,
				height: 1,
				channels: 3,
				background: '#fff'
			}
		})
			.webp()
			.toBuffer();
		const fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue(
			new Response(oversizedDimensions, {
				status: 200,
				headers: { 'content-type': 'image/webp' }
			})
		);
		try {
			const manifest = await createManifest(
				{
					user: {
						findMany: jest.fn().mockResolvedValue([
							{
								id: USER_ID,
								avatarPath: `https://cdn.example.test/bucket/${NEW_KEY}`,
								avatarObjectKey: NEW_KEY
							}
						])
					}
				} as any,
				CONFIG as any,
				{ kind: 'STATUS', verifyLegacy: false, verifyNew: true }
			);
			expect(manifest.rows[0]).toMatchObject({
				verification: 'INVALID',
				errorCode: 'NEW_OBJECT_INVALID'
			});
			expect(summarizeManifest(manifest).unresolved).toBe(1);
		} finally {
			fetchSpy.mockRestore();
		}
	});

	it('requires byte parity before activation', () => {
		const normalizedSha256 = 'd'.repeat(64);
		const inventory: AvatarMediaManifest = {
			schemaVersion: 1,
			kind: 'INVENTORY',
			rows: [
				row('LEGACY_S3', {
					verification: 'VERIFIED',
					source: {
						kind: 'S3',
						key: 'user-avatar/old.png',
						sourceSha256: 'e'.repeat(64),
						normalizedSha256
					}
				})
			]
		};
		const status: AvatarMediaManifest = {
			schemaVersion: 1,
			kind: 'STATUS',
			rows: [
				row('NEW_MANAGED', {
					verification: 'VERIFIED',
					managedObjectSha256: normalizedSha256
				})
			]
		};
		expect(() =>
			assertActivationEvidence(inventory, status)
		).not.toThrow();
		expect(() =>
			assertActivationEvidence({ ...inventory, kind: 'STATUS' }, status)
		).toThrow('requires INVENTORY and STATUS evidence');
		status.rows[0]!.managedObjectSha256 = 'f'.repeat(64);
		expect(() => assertActivationEvidence(inventory, status)).toThrow(
			'Migrated avatar content parity failed'
		);
	});

	it('rejects inconsistent canonical evidence rows', () => {
		expect(() =>
			validateManifest({
				schemaVersion: 1,
				kind: 'INVENTORY',
				rows: [
					row('LEGACY_S3', {
						verification: 'NOT_APPLICABLE',
						source: { kind: 'S3', key: 'user-avatar/old.png' }
					})
				]
			})
		).toThrow('Manifest legacy verification is invalid');
		expect(() =>
			validateManifest({
				schemaVersion: 1,
				kind: 'STATUS',
				rows: [
					row('NEW_MANAGED', {
						verification: 'VERIFIED',
						managedObjectSha256: undefined
					})
				]
			})
		).toThrow('Manifest row is invalid');
		expect(() =>
			validateManifest({
				schemaVersion: 1,
				kind: 'STATUS',
				rows: [{ ...row('NONE'), unexpected: true }]
			})
		).toThrow('Manifest row is invalid');
		expect(() =>
			validateManifest({
				schemaVersion: 1,
				kind: 'STATUS',
				rows: [row('NONE')],
				unexpected: true
			})
		).toThrow('Manifest schema is invalid');
		expect(() =>
			validateManifest({
				schemaVersion: 1,
				kind: 'INVENTORY',
				rows: [
					row('LEGACY_S3', {
						verification: 'VERIFIED',
						source: {
							kind: 'S3',
							key: 'user-avatar/old.png',
							sourceSha256: 'c'.repeat(64),
							normalizedSha256: 'd'.repeat(64),
							unexpected: true
						} as any
					})
				]
			})
		).toThrow('Manifest source is invalid');
		expect(() =>
			validateManifest({
				schemaVersion: 1,
				kind: 'STATUS',
				rows: [row('NONE'), row('NONE')]
			})
		).toThrow('Manifest row is invalid');
		const wrongOwnerKey = NEW_KEY.replace(OWNER, 'f'.repeat(64));
		expect(() =>
			validateManifest({
				schemaVersion: 1,
				kind: 'STATUS',
				rows: [
					row('NEW_MANAGED', {
						avatarObjectKeySha256: sha256(wrongOwnerKey),
						managedObjectKey: wrongOwnerKey,
						verification: 'VERIFIED',
						managedObjectSha256: 'e'.repeat(64)
					})
				]
			})
		).toThrow('object key is invalid');
		expect(() =>
			validateManifest({
				schemaVersion: 1,
				kind: 'STATUS',
				rows: [
					row('INVALID', {
						errorCode: 'SOURCE_MISSING'
					})
				]
			})
		).toThrow('Manifest INVALID row is invalid');
		expect(() =>
			validateManifest({
				schemaVersion: 1,
				kind: 'STATUS',
				rows: [
					row('NEW_MANAGED', {
						verification: 'MISSING',
						errorCode: 'SOURCE_MISSING'
					})
				]
			})
		).toThrow('Manifest NEW_MANAGED verification is invalid');
		expect(() =>
			validateManifest({
				schemaVersion: 1,
				kind: 'INVENTORY',
				rows: [
					row('LEGACY_S3', {
						verification: 'MISSING',
						errorCode: 'NEW_OBJECT_MISSING',
						source: {
							kind: 'S3',
							key: 'user-avatar/old.png'
						}
					})
				]
			})
		).toThrow('Manifest legacy verification is invalid');
	});

	it('activates by Serializable CAS and accepts only exact idempotent evidence', async () => {
		const evidence = {
			revision: 'a'.repeat(40),
			inventorySha256: 'b'.repeat(64),
			statusSha256: 'c'.repeat(64)
		};
		const prepared = {
			id: 'singleton',
			phase: 'PREPARED',
			activatedRevision: null,
			inventorySha256: null,
			statusSha256: null,
			activatedAt: null
		};
		const transaction = {
			$queryRaw: jest.fn().mockResolvedValue([]),
			avatarMediaOwnership: {
				findUnique: jest.fn().mockResolvedValue(prepared),
				updateMany: jest.fn().mockResolvedValue({ count: 1 })
			}
		};
		const prisma = {
			$transaction: jest.fn(
				async (callback: (value: typeof transaction) => unknown) =>
					callback(transaction)
			)
		};
		await expect(
			activateOwnership(prisma as any, evidence)
		).resolves.toMatchObject({ phase: 'ACTIVE', idempotent: false });
		expect(prisma.$transaction).toHaveBeenCalledWith(
			expect.any(Function),
			expect.objectContaining({ isolationLevel: 'Serializable' })
		);
		expect(
			transaction.avatarMediaOwnership.updateMany
		).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({ phase: 'PREPARED' }),
				data: expect.objectContaining({
					activatedRevision: evidence.revision,
					inventorySha256: evidence.inventorySha256,
					statusSha256: evidence.statusSha256
				})
			})
		);

		transaction.avatarMediaOwnership.findUnique.mockResolvedValue({
			...prepared,
			phase: 'ACTIVE',
			activatedRevision: evidence.revision,
			inventorySha256: evidence.inventorySha256,
			statusSha256: evidence.statusSha256,
			activatedAt: new Date()
		});
		await expect(
			activateOwnership(prisma as any, evidence)
		).resolves.toMatchObject({ phase: 'ACTIVE', idempotent: true });
		await expect(
			activateOwnership(prisma as any, {
				...evidence,
				statusSha256: 'd'.repeat(64)
			})
		).rejects.toThrow('already ACTIVE with different evidence');
	});

	it('writes manifests atomically, permits exact retry and preserves a partial final', async () => {
		const directory = await mkdtemp(
			join(tmpdir(), 'identity-avatar-manifest-')
		);
		const manifest: AvatarMediaManifest = {
			schemaVersion: 1,
			kind: 'INVENTORY',
			rows: [row('NONE')]
		};
		try {
			const complete = join(directory, 'complete.json');
			const first = await writeManifest(complete, manifest);
			await expect(writeManifest(complete, manifest)).resolves.toEqual(
				first
			);

			const partial = join(directory, 'partial.json');
			await writeFile(partial, '{', { mode: 0o600 });
			await chmod(partial, 0o600);
			await expect(writeManifest(partial, manifest)).rejects.toThrow(
				'already exists with different content'
			);
			expect(await readFile(partial, 'utf8')).toBe('{');
			expect(
				(await readdir(directory)).filter(name => name.endsWith('.tmp'))
			).toEqual([]);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	it('keeps the additive migration fail-closed with singleton and job checks', async () => {
		const migration = await readFile(
			join(
				__dirname,
				'../../prisma/migrations/20260815010000_add_avatar_media_ownership/migration.sql'
			),
			'utf8'
		);
		expect(migration).toContain('AvatarMediaOwnershipPhase');
		expect(migration).toContain('avatar_media_ownership_state_check');
		expect(migration).toContain('avatar_cleanup_jobs_state_check');
		expect(migration).toContain('owner_fingerprint_check');
		expect(migration).not.toMatch(/CASCADE/i);

		const command = await readFile(
			join(__dirname, 'avatar-media-cutover-main.ts'),
			'utf8'
		);
		expect(command).toContain(
			"required(environment, 'IDENTITY_DATABASE_URL')"
		);
		expect(command).not.toContain('IDENTITY_MIGRATION_DATABASE_URL');
	});
});
