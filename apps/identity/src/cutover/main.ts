import {
	AuthIdentityType,
	Prisma,
	PrismaClient,
	Role,
	ServiceDatabasePhase,
	UserStatus
} from '@prisma/identity-client';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { normalizeEmail, normalizePhone } from '../common/identity.util';

const ACTIONS = [
	'preflight',
	'status',
	'import',
	'activate',
	'complete'
] as const;
type Action = (typeof ACTIONS)[number];

type CutoverArgs = {
	action: Action;
	file?: string;
	sha256?: string;
};

type SnapshotIdentity = {
	id: string;
	type: AuthIdentityType;
	value: string;
	verifiedAt: string | null;
	createdAt: string;
	updatedAt: string;
};

type SnapshotChannel = {
	id: string;
	chatId: string;
	telegramUserId: string | null;
	username: string | null;
	firstName: string | null;
	lastName: string | null;
	isActive: boolean;
	connectedAt: string;
	disabledAt: string | null;
	createdAt: string;
	updatedAt: string;
};

type SnapshotUser = {
	id: string;
	name: string | null;
	password: string;
	avatarPath: string | null;
	status: UserStatus;
	personalDataConsentRevokedAt: string | null;
	deletedAt: string | null;
	rights: Role[];
	createdAt: string;
	updatedAt: string;
	authIdentities: SnapshotIdentity[];
	telegramNotificationChannel: SnapshotChannel | null;
};

type SnapshotVersion = {
	aggregateType: 'identity.user' | 'billing.identity';
	aggregateId: string;
	version: string;
	sourceSequence: string;
};

const AUTH_SETTINGS = [
	'recaptchaEnabled',
	'googleAuthEnabled',
	'yandexAuthEnabled',
	'githubAuthEnabled',
	'vkAuthEnabled',
	'telegramAuthEnabled'
] as const;

type IdentitySnapshot = {
	schemaVersion: 1;
	snapshotId: string;
	createdAt: string;
	counts: {
		users: number;
		identities: number;
		telegramNotificationChannels: number;
		emailCollisionGroups: 0;
		phoneCollisionGroups: 0;
		reportingVersionCoverageFailures: 0;
		billingVersionCoverageFailures: 0;
	};
	authSettings: Record<(typeof AUTH_SETTINGS)[number], boolean>;
	users: SnapshotUser[];
	versions: {
		reporting: SnapshotVersion[];
		billing: SnapshotVersion[];
		reportingHighWater: string;
		billingHighWater: string;
	};
};

type LoadedSnapshot = {
	value: IdentitySnapshot;
	sha256: string;
};

export class IdentityCutoverError extends Error {}

export function parseIdentityCutoverArgs(
	argv: readonly string[]
): CutoverArgs {
	const [rawAction, ...rest] = argv;
	if (!ACTIONS.includes(rawAction as Action)) {
		throw new IdentityCutoverError('Unsupported Identity cutover action');
	}
	const action = rawAction as Action;
	if (
		action === 'status' ||
		action === 'activate' ||
		action === 'complete'
	) {
		if (rest.length) {
			throw new IdentityCutoverError(
				`${action} does not accept arguments`
			);
		}
		return { action };
	}
	if (rest.length !== 2 && rest.length !== 4) {
		throw new IdentityCutoverError(
			`${action} requires --file <absolute-path> and optional --sha256 <hex>`
		);
	}
	if (rest[0] !== '--file') {
		throw new IdentityCutoverError(`${action} requires --file first`);
	}
	const file = rest[1];
	if (!file || !isAbsolute(file) || file.includes('\0')) {
		throw new IdentityCutoverError(
			'Identity snapshot path must be absolute'
		);
	}
	let sha256: string | undefined;
	if (rest.length === 4) {
		if (rest[2] !== '--sha256' || !/^[a-f0-9]{64}$/i.test(rest[3] || '')) {
			throw new IdentityCutoverError(
				'--sha256 must be a 64-character hex digest'
			);
		}
		sha256 = rest[3]!.toLowerCase();
	}
	return { action, file, sha256 };
}

export async function loadIdentitySnapshot(
	file: string,
	expectedSha256?: string
): Promise<LoadedSnapshot> {
	let handle;
	try {
		handle = await open(
			file,
			constants.O_RDONLY | (constants.O_NOFOLLOW || 0)
		);
		const metadata = await handle.stat();
		if (
			!metadata.isFile() ||
			metadata.size < 2 ||
			metadata.size > 512 * 1024 * 1024
		) {
			throw new IdentityCutoverError(
				'Identity snapshot must be a bounded regular file'
			);
		}
		if ((metadata.mode & 0o777) !== 0o600) {
			throw new IdentityCutoverError(
				'Identity snapshot mode must be 0600'
			);
		}
		const body = await handle.readFile();
		if (
			body.at(-1) !== 0x0a ||
			(body.length > 1 && body.at(-2) === 0x0a)
		) {
			throw new IdentityCutoverError(
				'Identity snapshot must contain exactly one trailing newline'
			);
		}
		const digest = createHash('sha256').update(body).digest('hex');
		if (expectedSha256 && digest !== expectedSha256.toLowerCase()) {
			throw new IdentityCutoverError('Identity snapshot SHA-256 mismatch');
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(body.toString('utf8'));
		} catch {
			throw new IdentityCutoverError(
				'Identity snapshot is not valid JSON'
			);
		}
		return { value: validateIdentitySnapshot(parsed), sha256: digest };
	} finally {
		await handle?.close().catch(() => undefined);
	}
}

export function validateIdentitySnapshot(
	value: unknown
): IdentitySnapshot {
	const root = record(value, 'snapshot');
	exact(root, [
		'schemaVersion',
		'snapshotId',
		'createdAt',
		'counts',
		'authSettings',
		'users',
		'versions'
	]);
	if (
		root.schemaVersion !== 1 ||
		!uuid(root.snapshotId) ||
		!date(root.createdAt)
	) {
		throw new IdentityCutoverError('Identity snapshot header is invalid');
	}
	const counts = record(root.counts, 'counts');
	exact(counts, [
		'users',
		'identities',
		'telegramNotificationChannels',
		'emailCollisionGroups',
		'phoneCollisionGroups',
		'reportingVersionCoverageFailures',
		'billingVersionCoverageFailures'
	]);
	for (const key of Object.keys(counts)) {
		if (!Number.isSafeInteger(counts[key]) || Number(counts[key]) < 0) {
			throw new IdentityCutoverError(
				'Identity snapshot counts are invalid'
			);
		}
	}
	if (
		counts.emailCollisionGroups !== 0 ||
		counts.phoneCollisionGroups !== 0 ||
		counts.reportingVersionCoverageFailures !== 0 ||
		counts.billingVersionCoverageFailures !== 0
	) {
		throw new IdentityCutoverError(
			'Identity snapshot preflight failures are non-zero'
		);
	}
	const settings = record(root.authSettings, 'authSettings');
	exact(settings, [...AUTH_SETTINGS]);
	if (AUTH_SETTINGS.some(key => typeof settings[key] !== 'boolean')) {
		throw new IdentityCutoverError('Identity auth settings are invalid');
	}
	if (!Array.isArray(root.users) || !root.users.length) {
		throw new IdentityCutoverError(
			'Identity snapshot users must be non-empty'
		);
	}
	const users = root.users.map((item, index) => parseUser(item, index));
	assertSortedUnique(
		users.map(item => item.id),
		'users'
	);
	const identityIds = new Set<string>();
	const typedValues = new Set<string>();
	const emailValues = new Set<string>();
	const phoneValues = new Set<string>();
	const channelIds = new Set<string>();
	const chatIds = new Set<string>();
	const telegramUserIds = new Set<string>();
	let identityCount = 0;
	let channelCount = 0;
	for (const user of users) {
		const userTypes = new Set<AuthIdentityType>();
		for (const identity of user.authIdentities) {
			identityCount += 1;
			unique(identityIds, identity.id, 'auth identity id');
			unique(userTypes, identity.type, 'auth identity type per user');
			unique(
				typedValues,
				`${identity.type}\0${identity.value}`,
				'auth identity'
			);
			if (identity.type === AuthIdentityType.EMAIL) {
				unique(
					emailValues,
					normalizeEmail(identity.value),
					'normalized email'
				);
			}
			if (identity.type === AuthIdentityType.PHONE) {
				unique(
					phoneValues,
					normalizePhone(identity.value),
					'normalized phone'
				);
			}
		}
		if (user.telegramNotificationChannel) {
			channelCount += 1;
			const channel = user.telegramNotificationChannel;
			unique(channelIds, channel.id, 'Telegram channel id');
			unique(chatIds, channel.chatId, 'Telegram chat id');
			if (channel.telegramUserId) {
				unique(
					telegramUserIds,
					channel.telegramUserId,
					'Telegram user id'
				);
			}
		}
	}
	if (
		counts.users !== users.length ||
		counts.identities !== identityCount ||
		counts.telegramNotificationChannels !== channelCount
	) {
		throw new IdentityCutoverError(
			'Identity snapshot counts do not match rows'
		);
	}
	const versions = record(root.versions, 'versions');
	exact(versions, [
		'reporting',
		'billing',
		'reportingHighWater',
		'billingHighWater'
	]);
	const userIds = users.map(user => user.id);
	const reporting = parseVersions(
		versions.reporting,
		'identity.user',
		userIds
	);
	const billing = parseVersions(
		versions.billing,
		'billing.identity',
		userIds
	);
	const reportingHighWater = positiveIntegerString(
		versions.reportingHighWater,
		'reporting high-water'
	);
	const billingHighWater = positiveIntegerString(
		versions.billingHighWater,
		'billing high-water'
	);
	if (
		reportingHighWater < maxSequence(reporting) ||
		billingHighWater < maxSequence(billing)
	) {
		throw new IdentityCutoverError(
			'Identity source high-water is inconsistent'
		);
	}
	return {
		schemaVersion: 1,
		snapshotId: root.snapshotId as string,
		createdAt: root.createdAt as string,
		counts: counts as IdentitySnapshot['counts'],
		authSettings: settings as IdentitySnapshot['authSettings'],
		users,
		versions: {
			reporting,
			billing,
			reportingHighWater: reportingHighWater.toString(),
			billingHighWater: billingHighWater.toString()
		}
	};
}

function parseUser(value: unknown, index: number): SnapshotUser {
	const user = record(value, `user ${index}`);
	exact(user, [
		'id',
		'name',
		'password',
		'avatarPath',
		'status',
		'personalDataConsentRevokedAt',
		'deletedAt',
		'rights',
		'createdAt',
		'updatedAt',
		'authIdentities',
		'telegramNotificationChannel'
	]);
	if (
		!boundedString(user.id, 255) ||
		!nullableString(user.name, 255) ||
		typeof user.password !== 'string' ||
		!nullableString(user.avatarPath, 2_000) ||
		!Object.values(UserStatus).includes(user.status as UserStatus) ||
		!nullableDate(user.personalDataConsentRevokedAt) ||
		!nullableDate(user.deletedAt) ||
		!date(user.createdAt) ||
		!date(user.updatedAt) ||
		!Array.isArray(user.rights) ||
		!user.rights.length ||
		user.rights.some(
			role => !Object.values(Role).includes(role as Role)
		) ||
		new Set(user.rights).size !== user.rights.length ||
		!Array.isArray(user.authIdentities)
	) {
		throw new IdentityCutoverError(
			`Identity snapshot user ${index} is invalid`
		);
	}
	const authIdentities = user.authIdentities.map((item, identityIndex) => {
		const identity = record(item, `identity ${identityIndex}`);
		exact(identity, [
			'id',
			'type',
			'value',
			'verifiedAt',
			'createdAt',
			'updatedAt'
		]);
		if (
			!boundedString(identity.id, 255) ||
			!Object.values(AuthIdentityType).includes(
				identity.type as AuthIdentityType
			) ||
			!boundedString(identity.value, 4_096) ||
			!nullableDate(identity.verifiedAt) ||
			!date(identity.createdAt) ||
			!date(identity.updatedAt)
		) {
			throw new IdentityCutoverError(
				'Identity snapshot auth identity is invalid'
			);
		}
		return identity as SnapshotIdentity;
	});
	assertSortedUnique(
		authIdentities.map(item => item.id),
		'auth identities'
	);
	let channel: SnapshotChannel | null = null;
	if (user.telegramNotificationChannel !== null) {
		const raw = record(
			user.telegramNotificationChannel,
			'Telegram channel'
		);
		exact(raw, [
			'id',
			'chatId',
			'telegramUserId',
			'username',
			'firstName',
			'lastName',
			'isActive',
			'connectedAt',
			'disabledAt',
			'createdAt',
			'updatedAt'
		]);
		if (
			!boundedString(raw.id, 255) ||
			!boundedString(raw.chatId, 255) ||
			!nullableString(raw.telegramUserId, 255) ||
			!nullableString(raw.username, 255) ||
			!nullableString(raw.firstName, 255) ||
			!nullableString(raw.lastName, 255) ||
			typeof raw.isActive !== 'boolean' ||
			!date(raw.connectedAt) ||
			!nullableDate(raw.disabledAt) ||
			!date(raw.createdAt) ||
			!date(raw.updatedAt)
		) {
			throw new IdentityCutoverError(
				'Identity snapshot Telegram channel is invalid'
			);
		}
		channel = raw as SnapshotChannel;
	}
	return {
		...(user as Omit<
			SnapshotUser,
			'authIdentities' | 'telegramNotificationChannel'
		>),
		authIdentities,
		telegramNotificationChannel: channel
	};
}

function parseVersions(
	value: unknown,
	aggregateType: SnapshotVersion['aggregateType'],
	userIds: string[]
): SnapshotVersion[] {
	if (!Array.isArray(value) || value.length !== userIds.length) {
		throw new IdentityCutoverError(
			`${aggregateType} version coverage is invalid`
		);
	}
	const sequences = new Set<string>();
	const rows = value.map((item, index) => {
		const row = record(item, `${aggregateType} version`);
		exact(row, [
			'aggregateType',
			'aggregateId',
			'version',
			'sourceSequence'
		]);
		if (
			row.aggregateType !== aggregateType ||
			row.aggregateId !== userIds[index]
		) {
			throw new IdentityCutoverError(
				`${aggregateType} version ordering is invalid`
			);
		}
		positiveIntegerString(row.version, `${aggregateType} version`);
		positiveIntegerString(row.sourceSequence, `${aggregateType} sequence`);
		unique(
			sequences,
			row.sourceSequence as string,
			`${aggregateType} sequence`
		);
		return row as SnapshotVersion;
	});
	return rows;
}

function maxSequence(rows: SnapshotVersion[]): bigint {
	return rows.reduce(
		(maximum, row) =>
			BigInt(row.sourceSequence) > maximum
				? BigInt(row.sourceSequence)
				: maximum,
		0n
	);
}

function positiveIntegerString(value: unknown, label: string): bigint {
	if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value)) {
		throw new IdentityCutoverError(
			`${label} must be a positive integer string`
		);
	}
	return BigInt(value);
}

function record(value: unknown, label: string): Record<string, unknown> {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		throw new IdentityCutoverError(`${label} must be an object`);
	}
	return value as Record<string, unknown>;
}

function exact(value: Record<string, unknown>, expected: string[]): void {
	const actual = Object.keys(value).sort();
	const keys = [...expected].sort();
	if (
		actual.length !== keys.length ||
		actual.some((key, index) => key !== keys[index])
	) {
		throw new IdentityCutoverError(
			'Identity snapshot contains unexpected fields'
		);
	}
}

function date(value: unknown): value is string {
	return (
		typeof value === 'string' &&
		Number.isFinite(Date.parse(value)) &&
		new Date(value).toISOString() === value
	);
}

function nullableDate(value: unknown): value is string | null {
	return value === null || date(value);
}

function boundedString(value: unknown, maximum: number): value is string {
	return (
		typeof value === 'string' &&
		value.length > 0 &&
		value.length <= maximum
	);
}

function nullableString(
	value: unknown,
	maximum: number
): value is string | null {
	return (
		value === null ||
		(typeof value === 'string' && value.length <= maximum)
	);
}

function uuid(value: unknown): value is string {
	return (
		typeof value === 'string' &&
		/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
			value
		)
	);
}

function unique<T>(values: Set<T>, value: T, label: string): void {
	if (values.has(value)) {
		throw new IdentityCutoverError(
			`Identity snapshot has duplicate ${label}`
		);
	}
	values.add(value);
}

function assertSortedUnique(values: string[], label: string): void {
	if (
		values.some((value, index) => index > 0 && values[index - 1] >= value)
	) {
		throw new IdentityCutoverError(
			`Identity snapshot ${label} are not sorted unique`
		);
	}
}

function databaseUrl(): string {
	const value = process.env.IDENTITY_DATABASE_URL?.trim() || '';
	if (!value || ['change_me', 'change-me', 'XYZXYZXYZ'].includes(value)) {
		throw new IdentityCutoverError('IDENTITY_DATABASE_URL is missing');
	}
	return value;
}

async function targetStatus(
	client: PrismaClient | Prisma.TransactionClient
) {
	const [
		identity,
		users,
		identities,
		channels,
		sessions,
		challenges,
		outbox
	] = await Promise.all([
		client.serviceIdentity.findUnique({ where: { id: 'singleton' } }),
		client.user.count(),
		client.authIdentity.count(),
		client.telegramNotificationChannel.count(),
		client.userSession.count(),
		client.verificationChallenge.count(),
		client.outboxEvent.count()
	]);
	if (!identity || identity.serviceName !== 'identity-service') {
		throw new IdentityCutoverError('Identity database marker is invalid');
	}
	return {
		identity,
		users,
		identities,
		channels,
		sessions,
		challenges,
		outbox
	};
}

async function preflight(client: PrismaClient, loaded: LoadedSnapshot) {
	const status = await targetStatus(client);
	if (
		status.identity.phase === ServiceDatabasePhase.SHADOW &&
		(status.users ||
			status.identities ||
			status.channels ||
			status.sessions ||
			status.challenges ||
			status.outbox)
	) {
		throw new IdentityCutoverError(
			'Identity shadow database is not empty'
		);
	}
	if (
		status.identity.phase !== ServiceDatabasePhase.SHADOW &&
		status.identity.sourceSnapshotSha256 !== loaded.sha256
	) {
		throw new IdentityCutoverError(
			'Identity database belongs to another snapshot'
		);
	}
	return {
		ok: true,
		action: 'preflight',
		snapshotId: loaded.value.snapshotId,
		sha256: loaded.sha256,
		counts: loaded.value.counts,
		reportingHighWater: loaded.value.versions.reportingHighWater,
		billingHighWater: loaded.value.versions.billingHighWater,
		targetPhase: status.identity.phase
	};
}

async function importSnapshot(
	client: PrismaClient,
	loaded: LoadedSnapshot
) {
	const snapshot = loaded.value;
	return client
		.$transaction(
			async transaction => {
				await transaction.$queryRaw`
				SELECT "id" FROM "identity"."service_identity"
				WHERE "id" = 'singleton' FOR UPDATE
			`;
				const status = await targetStatus(transaction);
				if (status.identity.phase === ServiceDatabasePhase.IMPORTED) {
					if (status.identity.sourceSnapshotSha256 !== loaded.sha256) {
						throw new IdentityCutoverError(
							'Identity database was imported from another snapshot'
						);
					}
					return { duplicate: true, phase: status.identity.phase };
				}
				if (status.identity.phase !== ServiceDatabasePhase.SHADOW) {
					throw new IdentityCutoverError(
						'Identity import requires SHADOW phase'
					);
				}
				if (
					status.users ||
					status.identities ||
					status.channels ||
					status.sessions ||
					status.challenges ||
					status.outbox
				) {
					throw new IdentityCutoverError(
						'Identity import target is not empty'
					);
				}
				await batched(snapshot.users, 500, rows =>
					transaction.user.createMany({
						data: rows.map(user => ({
							id: user.id,
							name: user.name,
							password: user.password,
							avatarPath: user.avatarPath,
							status: user.status,
							personalDataConsentRevokedAt: nullableDateValue(
								user.personalDataConsentRevokedAt
							),
							deletedAt: nullableDateValue(user.deletedAt),
							rights: user.rights,
							createdAt: new Date(user.createdAt),
							updatedAt: new Date(user.updatedAt)
						}))
					})
				);
				const identities = snapshot.users.flatMap(user =>
					user.authIdentities.map(identity => ({
						userId: user.id,
						...identity
					}))
				);
				await batched(identities, 500, rows =>
					transaction.authIdentity.createMany({
						data: rows.map(identity => ({
							id: identity.id,
							userId: identity.userId,
							type: identity.type,
							value: identity.value,
							verifiedAt: nullableDateValue(identity.verifiedAt),
							createdAt: new Date(identity.createdAt),
							updatedAt: new Date(identity.updatedAt)
						}))
					})
				);
				const channels = snapshot.users.flatMap(user =>
					user.telegramNotificationChannel
						? [{ userId: user.id, ...user.telegramNotificationChannel }]
						: []
				);
				await batched(channels, 500, rows =>
					transaction.telegramNotificationChannel.createMany({
						data: rows.map(channel => ({
							id: channel.id,
							userId: channel.userId,
							chatId: channel.chatId,
							telegramUserId: channel.telegramUserId,
							username: channel.username,
							firstName: channel.firstName,
							lastName: channel.lastName,
							isActive: channel.isActive,
							connectedAt: new Date(channel.connectedAt),
							disabledAt: nullableDateValue(channel.disabledAt),
							createdAt: new Date(channel.createdAt),
							updatedAt: new Date(channel.updatedAt)
						}))
					})
				);
				const versions = [
					...snapshot.versions.reporting,
					...snapshot.versions.billing
				];
				await batched(versions, 500, rows =>
					transaction.aggregateVersion.createMany({
						data: rows.map(row => ({
							aggregateType: row.aggregateType,
							aggregateId: row.aggregateId,
							version: BigInt(row.version),
							sourceSequence: BigInt(row.sourceSequence)
						}))
					})
				);
				await transaction.authSettings.update({
					where: { id: 'singleton' },
					data: snapshot.authSettings
				});
				await Promise.all([
					transaction.sourceSequence.update({
						where: { id: 'identity.user.changed.v1' },
						data: {
							lastValue: BigInt(snapshot.versions.reportingHighWater)
						}
					}),
					transaction.sourceSequence.update({
						where: { id: 'billing.identity.changed.v1' },
						data: { lastValue: BigInt(snapshot.versions.billingHighWater) }
					})
				]);
				await transaction.serviceIdentity.update({
					where: { id: 'singleton' },
					data: {
						phase: ServiceDatabasePhase.IMPORTED,
						sourceFingerprint: snapshotSemanticHash(snapshot),
						sourceSnapshotSha256: loaded.sha256,
						sourceSnapshotCounts: snapshot.counts,
						sourceIdentityHighWater: BigInt(
							snapshot.versions.reportingHighWater
						),
						sourceBillingHighWater: BigInt(
							snapshot.versions.billingHighWater
						),
						importedAt: new Date()
					}
				});
				return { duplicate: false, phase: ServiceDatabasePhase.IMPORTED };
			},
			{
				isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
				maxWait: 10_000,
				timeout: 15 * 60_000
			}
		)
		.then(result => ({
			ok: true,
			action: 'import',
			snapshotId: snapshot.snapshotId,
			sha256: loaded.sha256,
			counts: snapshot.counts,
			...result
		}));
}

async function activate(client: PrismaClient) {
	return client.$transaction(
		async transaction => {
			await transaction.$queryRaw`
				SELECT "id" FROM "identity"."service_identity"
				WHERE "id" = 'singleton' FOR UPDATE
			`;
			const status = await targetStatus(transaction);
			if (status.identity.phase === ServiceDatabasePhase.ACTIVE) {
				return {
					ok: true,
					action: 'activate',
					phase: status.identity.phase,
					duplicate: true,
					ownershipGeneration:
						status.identity.ownershipGeneration.toString()
				};
			}
			if (
				status.identity.phase !== ServiceDatabasePhase.IMPORTED ||
				!status.identity.sourceSnapshotSha256 ||
				status.identity.sourceIdentityHighWater === null ||
				status.identity.sourceBillingHighWater === null
			) {
				throw new IdentityCutoverError(
					'Identity activate requires imported snapshot'
				);
			}
			await verifyImportedAnchors(transaction, status);
			const updated = await transaction.serviceIdentity.update({
				where: { id: 'singleton' },
				data: {
					phase: ServiceDatabasePhase.ACTIVE,
					ownershipGeneration: { increment: 1 },
					activatedAt: new Date()
				}
			});
			return {
				ok: true,
				action: 'activate',
				phase: updated.phase,
				duplicate: false,
				ownershipGeneration: updated.ownershipGeneration.toString()
			};
		},
		{ isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
	);
}

async function verifyImportedAnchors(
	client: Prisma.TransactionClient | PrismaClient,
	status: Awaited<ReturnType<typeof targetStatus>>
): Promise<void> {
	const [aggregateCount, reporting, billing] = await Promise.all([
		client.aggregateVersion.count(),
		client.sourceSequence.findUnique({
			where: { id: 'identity.user.changed.v1' }
		}),
		client.sourceSequence.findUnique({
			where: { id: 'billing.identity.changed.v1' }
		})
	]);
	if (
		status.sessions !== 0 ||
		status.challenges !== 0 ||
		status.outbox !== 0 ||
		aggregateCount !== status.users * 2 ||
		reporting?.lastValue !== status.identity.sourceIdentityHighWater ||
		billing?.lastValue !== status.identity.sourceBillingHighWater
	) {
		throw new IdentityCutoverError(
			'Identity imported anchors are inconsistent'
		);
	}
}

async function complete(client: PrismaClient) {
	const status = await targetStatus(client);
	if (
		status.identity.phase !== ServiceDatabasePhase.ACTIVE ||
		!status.identity.sourceSnapshotSha256 ||
		!status.identity.sourceFingerprint ||
		!status.identity.sourceSnapshotCounts
	) {
		throw new IdentityCutoverError(
			'Identity completion ownership mismatch'
		);
	}
	await verifyImportedAnchors(client, status);
	const expectedCounts = record(
		status.identity.sourceSnapshotCounts,
		'imported snapshot counts'
	);
	if (
		!Number.isSafeInteger(expectedCounts.users) ||
		!Number.isSafeInteger(expectedCounts.identities) ||
		!Number.isSafeInteger(expectedCounts.telegramNotificationChannels) ||
		status.users !== expectedCounts.users ||
		status.identities !== expectedCounts.identities ||
		status.channels !== expectedCounts.telegramNotificationChannels
	) {
		throw new IdentityCutoverError('Identity completion count mismatch');
	}
	if (
		(await databaseSemanticHash(client)) !==
		status.identity.sourceFingerprint
	) {
		throw new IdentityCutoverError(
			'Identity completion row fingerprint mismatch'
		);
	}
	return {
		ok: true,
		action: 'complete',
		sha256: status.identity.sourceSnapshotSha256,
		counts: expectedCounts,
		phase: status.identity.phase,
		ownershipGeneration: status.identity.ownershipGeneration.toString()
	};
}

async function status(client: PrismaClient) {
	const value = await targetStatus(client);
	return {
		ok: true,
		action: 'status',
		phase: value.identity.phase,
		databaseId: value.identity.databaseId,
		ownershipGeneration: value.identity.ownershipGeneration.toString(),
		sourceSnapshotSha256: value.identity.sourceSnapshotSha256,
		counts: {
			users: value.users,
			identities: value.identities,
			telegramNotificationChannels: value.channels,
			sessions: value.sessions,
			challenges: value.challenges,
			outbox: value.outbox
		}
	};
}

export async function runIdentityCutover(
	args: CutoverArgs
): Promise<Record<string, unknown>> {
	const client = new PrismaClient({
		datasources: { db: { url: databaseUrl() } }
	});
	try {
		await client.$connect();
		if (args.action === 'status') return status(client);
		if (args.action === 'activate') return activate(client);
		if (args.action === 'complete') return complete(client);
		const loaded = await loadIdentitySnapshot(args.file!, args.sha256);
		if (args.action === 'preflight') return preflight(client, loaded);
		if (args.action === 'import') return importSnapshot(client, loaded);
		throw new IdentityCutoverError('Unsupported Identity cutover action');
	} finally {
		await client.$disconnect();
	}
}

async function batched<T>(
	items: T[],
	size: number,
	write: (items: T[]) => Promise<unknown>
): Promise<void> {
	for (let index = 0; index < items.length; index += size) {
		await write(items.slice(index, index + size));
	}
}

function nullableDateValue(value: string | null): Date | null {
	return value === null ? null : new Date(value);
}

export function snapshotSemanticHash(snapshot: IdentitySnapshot): string {
	return createHash('sha256')
		.update(
			canonicalCutoverJson({
				authSettings: snapshot.authSettings,
				users: snapshot.users,
				versions: snapshot.versions
			})
		)
		.digest('hex');
}

async function databaseSemanticHash(
	client: PrismaClient
): Promise<string> {
	const [
		authSettings,
		users,
		reporting,
		billing,
		reportingSequence,
		billingSequence
	] = await Promise.all([
		client.authSettings.findUniqueOrThrow({
			where: { id: 'singleton' },
			select: {
				recaptchaEnabled: true,
				googleAuthEnabled: true,
				yandexAuthEnabled: true,
				githubAuthEnabled: true,
				vkAuthEnabled: true,
				telegramAuthEnabled: true
			}
		}),
		client.user.findMany({
			orderBy: { id: 'asc' },
			select: {
				id: true,
				name: true,
				password: true,
				avatarPath: true,
				status: true,
				personalDataConsentRevokedAt: true,
				deletedAt: true,
				rights: true,
				createdAt: true,
				updatedAt: true,
				authIdentities: {
					orderBy: { id: 'asc' },
					select: {
						id: true,
						type: true,
						value: true,
						verifiedAt: true,
						createdAt: true,
						updatedAt: true
					}
				},
				telegramNotificationChannel: {
					select: {
						id: true,
						chatId: true,
						telegramUserId: true,
						username: true,
						firstName: true,
						lastName: true,
						isActive: true,
						connectedAt: true,
						disabledAt: true,
						createdAt: true,
						updatedAt: true
					}
				}
			}
		}),
		client.aggregateVersion.findMany({
			where: { aggregateType: 'identity.user' },
			orderBy: { aggregateId: 'asc' }
		}),
		client.aggregateVersion.findMany({
			where: { aggregateType: 'billing.identity' },
			orderBy: { aggregateId: 'asc' }
		}),
		client.sourceSequence.findUniqueOrThrow({
			where: { id: 'identity.user.changed.v1' }
		}),
		client.sourceSequence.findUniqueOrThrow({
			where: { id: 'billing.identity.changed.v1' }
		})
	]);
	const version = (row: (typeof reporting)[number]): SnapshotVersion => ({
		aggregateType: row.aggregateType as SnapshotVersion['aggregateType'],
		aggregateId: row.aggregateId,
		version: row.version.toString(),
		sourceSequence: row.sourceSequence.toString()
	});
	return createHash('sha256')
		.update(
			canonicalCutoverJson({
				authSettings,
				users,
				versions: {
					reporting: reporting.map(version),
					billing: billing.map(version),
					reportingHighWater: reportingSequence.lastValue.toString(),
					billingHighWater: billingSequence.lastValue.toString()
				}
			})
		)
		.digest('hex');
}

function canonicalCutoverJson(value: unknown): string {
	if (value instanceof Date) return JSON.stringify(value.toISOString());
	if (
		value === null ||
		typeof value === 'string' ||
		typeof value === 'boolean'
	) {
		return JSON.stringify(value);
	}
	if (typeof value === 'number') {
		if (!Number.isFinite(value))
			throw new IdentityCutoverError('Non-finite cutover value');
		return JSON.stringify(value);
	}
	if (typeof value === 'bigint') return JSON.stringify(value.toString());
	if (Array.isArray(value)) {
		return `[${value.map(item => canonicalCutoverJson(item)).join(',')}]`;
	}
	if (value && typeof value === 'object') {
		return `{${Object.entries(value as Record<string, unknown>)
			.sort(([left], [right]) => left.localeCompare(right))
			.map(
				([key, item]) =>
					`${JSON.stringify(key)}:${canonicalCutoverJson(item)}`
			)
			.join(',')}}`;
	}
	throw new IdentityCutoverError('Unsupported cutover fingerprint value');
}

if (require.main === module) {
	runIdentityCutover(parseIdentityCutoverArgs(process.argv.slice(2)))
		.then(result => process.stdout.write(`${JSON.stringify(result)}\n`))
		.catch(error => {
			process.stderr.write(
				`${JSON.stringify({
					ok: false,
					error:
						error instanceof IdentityCutoverError
							? error.message
							: 'Identity cutover failed'
				})}\n`
			);
			process.exitCode = 1;
		});
}
