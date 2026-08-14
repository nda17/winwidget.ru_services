import { Prisma, PrismaClient } from '@prisma/client';
import { createHash, randomUUID } from 'node:crypto';
import { chmod, lstat, open, rename, unlink } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join } from 'node:path';

const ACTIONS = [
	'status',
	'preflight',
	'export',
	'fence',
	'unfence'
] as const;
const LEGACY_IDENTITY_EVENT_TYPES = [
	'identity.user.changed.v1',
	'billing.identity.changed.v1'
] as const;
type Action = (typeof ACTIONS)[number];

interface CutoverArgs {
	action: Action;
	file?: string;
}

interface VersionRow {
	aggregateType: string;
	aggregateId: string;
	version: bigint;
	sourceSequence: bigint;
}

interface CountRow {
	count: bigint;
}

interface TimestampRow {
	value: Date;
}

interface BigIntRow {
	value: bigint;
}

interface FenceRow {
	ownership: 'OPEN' | 'FENCED';
	generation: bigint;
	fencedRevision: string | null;
	fencedAt: Date | null;
}

class IdentityCoreCutoverError extends Error {}

export const parseIdentityCoreCutoverArgs = (
	argv: readonly string[]
): CutoverArgs => {
	const [rawAction, ...rest] = argv;
	if (!ACTIONS.includes(rawAction as Action)) {
		throw new IdentityCoreCutoverError(
			'Unsupported Identity Core cutover action'
		);
	}
	if (rawAction !== 'export') {
		if (rest.length) {
			throw new IdentityCoreCutoverError(
				`Identity Core ${rawAction} does not accept arguments`
			);
		}
		return { action: rawAction as Action };
	}
	if (rest.length !== 2 || rest[0] !== '--file') {
		throw new IdentityCoreCutoverError(
			'Identity Core export requires exactly --file <absolute-path>'
		);
	}
	const file = rest[1];
	if (!file || !isAbsolute(file) || file.includes('\0')) {
		throw new IdentityCoreCutoverError(
			'Identity Core snapshot path must be absolute'
		);
	}
	return { action: 'export', file };
};

const databaseUrl = (): string => {
	const mode = process.env.MODE?.trim().toLowerCase() || 'development';
	if (!['development', 'production'].includes(mode)) {
		throw new IdentityCoreCutoverError(
			'MODE must be development or production'
		);
	}
	const key =
		mode === 'production'
			? 'DATABASE_URL_PRODUCTION'
			: 'DATABASE_URL_DEVELOPMENT';
	const value = process.env[key]?.trim();
	if (!value || value === 'change_me') {
		throw new IdentityCoreCutoverError(
			'Core database URL is missing for Identity cutover'
		);
	}
	return value;
};

const bigintStrings = (rows: VersionRow[]) =>
	rows.map(row => ({
		aggregateType: row.aggregateType,
		aggregateId: row.aggregateId,
		version: row.version.toString(),
		sourceSequence: row.sourceSequence.toString()
	}));

const highWater = (rows: VersionRow[]): string =>
	rows
		.reduce(
			(maximum, row) =>
				row.sourceSequence > maximum ? row.sourceSequence : maximum,
			0n
		)
		.toString();

const revision = (): string => {
	const value = process.env.APP_REVISION?.trim() || '';
	if (!/^[0-9a-f]{40}$/.test(value)) {
		throw new IdentityCoreCutoverError(
			'APP_REVISION must be the exact lowercase 40-character Git revision'
		);
	}
	return value;
};

const readFenceState = async (
	client: Prisma.TransactionClient | PrismaClient
): Promise<FenceRow> => {
	const rows = await client.$queryRaw<FenceRow[]>(Prisma.sql`
		SELECT
			"ownership",
			"generation",
			"fenced_revision" AS "fencedRevision",
			"fenced_at" AS "fencedAt"
		FROM "identity_core_source_state"
		WHERE "id" = 'singleton'
	`);
	const state = rows[0];
	if (
		rows.length !== 1 ||
		!state ||
		!['OPEN', 'FENCED'].includes(state.ownership) ||
		state.generation < 0n ||
		(state.ownership === 'OPEN'
			? state.fencedRevision !== null || state.fencedAt !== null
			: !state.fencedRevision || state.fencedAt === null)
	) {
		throw new IdentityCoreCutoverError(
			'Identity Core source fence state is missing or invalid'
		);
	}
	return state;
};

const serializeFence = (state: FenceRow) => ({
	identityOwnershipFence: state.ownership,
	fenceGeneration: state.generation.toString(),
	fencedRevision: state.fencedRevision,
	fencedAt: state.fencedAt?.toISOString() || null
});

const readPreflight = async (
	client: Prisma.TransactionClient | PrismaClient
) => {
	const [
		users,
		identities,
		channels,
		emailCollisionGroups,
		phoneCollisionGroups,
		reportingVersionCoverageFailures,
		billingVersionCoverageFailures,
		legacyIdentityOutboxPending,
		legacyDestinationFailuresUnresolved,
		fenceState
	] = await Promise.all([
		client.user.count(),
		client.authIdentity.count(),
		client.telegramNotificationChannel.count(),
		client.$queryRaw<CountRow[]>(Prisma.sql`
				SELECT COUNT(*)::bigint AS count
				FROM (
					SELECT LOWER(BTRIM(value))
					FROM auth_identities
					WHERE type = 'EMAIL'::"AuthIdentityType"
					GROUP BY LOWER(BTRIM(value))
					HAVING COUNT(*) > 1
				) collisions
			`),
		client.$queryRaw<CountRow[]>(Prisma.sql`
				SELECT COUNT(*)::bigint AS count
				FROM (
					SELECT CASE
						WHEN LENGTH(digits) = 11 AND LEFT(digits, 1) IN ('7', '8')
							THEN '+7' || SUBSTRING(digits FROM 2)
						WHEN LENGTH(digits) = 10 THEN '+7' || digits
						WHEN LENGTH(digits) > 0 AND BTRIM(value) LIKE '+%'
							THEN '+' || digits
						ELSE BTRIM(value)
					END AS normalized_value
					FROM (
						SELECT value, REGEXP_REPLACE(value, '[^0-9]', '', 'g') AS digits
						FROM auth_identities
						WHERE type = 'PHONE'::"AuthIdentityType"
					) phones
					GROUP BY normalized_value
					HAVING COUNT(*) > 1
				) collisions
			`),
		client.$queryRaw<CountRow[]>(Prisma.sql`
				SELECT COUNT(*)::bigint AS count
				FROM "User" AS users
				LEFT JOIN reporting_projection_versions AS versions
					ON versions.aggregate_type = 'identity.user'
					AND versions.aggregate_id = users.id
				WHERE versions.aggregate_id IS NULL
					OR versions.version < 1
					OR versions.source_sequence < 1
			`),
		client.$queryRaw<CountRow[]>(Prisma.sql`
				SELECT COUNT(*)::bigint AS count
				FROM "User" AS users
				LEFT JOIN billing_source_aggregate_versions AS versions
					ON versions.aggregate_type = 'billing.identity'
					AND versions.aggregate_id = users.id
				WHERE versions.aggregate_id IS NULL
					OR versions.version < 1
					OR versions.source_sequence < 1
			`),
		client.outboxEvent.count({
			where: {
				eventType: { in: [...LEGACY_IDENTITY_EVENT_TYPES] },
				status: { not: 'PUBLISHED' }
			}
		}),
		client.integrationDeliveryFailure.count({
			where: {
				integration: 'telegram-destination-unavailable',
				resolvedAt: null
			}
		}),
		readFenceState(client)
	]);
	return {
		users,
		identities,
		telegramNotificationChannels: channels,
		emailCollisionGroups: Number(emailCollisionGroups[0]?.count || 0n),
		phoneCollisionGroups: Number(phoneCollisionGroups[0]?.count || 0n),
		reportingVersionCoverageFailures: Number(
			reportingVersionCoverageFailures[0]?.count || 0n
		),
		billingVersionCoverageFailures: Number(
			billingVersionCoverageFailures[0]?.count || 0n
		),
		legacyIdentityOutboxPending,
		legacyDestinationFailuresUnresolved,
		...serializeFence(fenceState)
	};
};

export const assertIdentityCoreOutboxDrained = (pending: number): void => {
	if (!Number.isSafeInteger(pending) || pending !== 0) {
		throw new IdentityCoreCutoverError(
			'Identity cutover requires every legacy identity Outbox event to be PUBLISHED'
		);
	}
};

export const assertIdentityCoreDestinationFailuresDrained = (
	unresolved: number
): void => {
	if (!Number.isSafeInteger(unresolved) || unresolved !== 0) {
		throw new IdentityCoreCutoverError(
			'Identity cutover requires every legacy Telegram destination failure to be resolved'
		);
	}
};

const assertIdentityCoreSourceOpen = (result: {
	identityOwnershipFence: string;
}): void => {
	if (result.identityOwnershipFence !== 'OPEN') {
		throw new IdentityCoreCutoverError(
			'Legacy Core identity source is already fenced'
		);
	}
};

const assertIdentityCoreSourceFenced = (result: {
	identityOwnershipFence: string;
	fencedRevision: string | null;
}): void => {
	if (
		result.identityOwnershipFence !== 'FENCED' ||
		result.fencedRevision !== revision()
	) {
		throw new IdentityCoreCutoverError(
			'Identity snapshot requires the legacy Core source to be fenced by this revision'
		);
	}
};

const assertPreflight = (
	result: Awaited<ReturnType<typeof readPreflight>>
): void => {
	if (result.emailCollisionGroups > 0) {
		throw new IdentityCoreCutoverError(
			'Identity preflight found normalized email collisions'
		);
	}
	if (result.phoneCollisionGroups > 0) {
		throw new IdentityCoreCutoverError(
			'Identity preflight found normalized phone collisions'
		);
	}
	if (
		result.reportingVersionCoverageFailures > 0 ||
		result.billingVersionCoverageFailures > 0
	) {
		throw new IdentityCoreCutoverError(
			'Identity preflight found missing or invalid projection version anchors'
		);
	}
};

const snapshot = async (client: PrismaClient) =>
	client.$transaction(
		async transaction => {
			await transaction.$executeRaw`SET TRANSACTION READ ONLY`;
			const [
				timestampRows,
				counts,
				users,
				authSettings,
				reportingVersions,
				billingVersions,
				reportingSequenceRows,
				billingSequenceRows
			] = await Promise.all([
				transaction.$queryRaw<TimestampRow[]>(Prisma.sql`
					SELECT transaction_timestamp() AS value
				`),
				readPreflight(transaction),
				transaction.user.findMany({
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
				transaction.siteSettings.findUnique({
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
				transaction.$queryRaw<VersionRow[]>(Prisma.sql`
					SELECT aggregate_type AS "aggregateType",
						aggregate_id AS "aggregateId", version, source_sequence AS "sourceSequence"
					FROM reporting_projection_versions
					WHERE aggregate_type = 'identity.user'
					ORDER BY aggregate_id ASC
				`),
				transaction.$queryRaw<VersionRow[]>(Prisma.sql`
					SELECT aggregate_type AS "aggregateType",
						aggregate_id AS "aggregateId", version, source_sequence AS "sourceSequence"
					FROM billing_source_aggregate_versions
					WHERE aggregate_type = 'billing.identity'
					ORDER BY aggregate_id ASC
				`),
				transaction.$queryRaw<BigIntRow[]>(Prisma.sql`
					SELECT CASE WHEN "is_called" THEN "last_value" ELSE 0 END AS value
					FROM reporting_source_sequence
				`),
				transaction.$queryRaw<BigIntRow[]>(Prisma.sql`
					SELECT CASE WHEN "is_called" THEN "last_value" ELSE 0 END AS value
					FROM billing_source_sequence
				`)
			]);
			assertPreflight(counts);
			assertIdentityCoreSourceFenced(counts);
			assertIdentityCoreOutboxDrained(counts.legacyIdentityOutboxPending);
			assertIdentityCoreDestinationFailuresDrained(
				counts.legacyDestinationFailuresUnresolved
			);
			if (!authSettings) {
				throw new IdentityCoreCutoverError(
					'Identity preflight found no SiteSettings singleton'
				);
			}
			const reportingSequence = reportingSequenceRows[0]?.value;
			const billingSequence = billingSequenceRows[0]?.value;
			if (
				reportingSequence === undefined ||
				billingSequence === undefined ||
				reportingSequence < BigInt(highWater(reportingVersions)) ||
				billingSequence < BigInt(highWater(billingVersions))
			) {
				throw new IdentityCoreCutoverError(
					'Identity source sequence high-water is missing or inconsistent'
				);
			}
			return {
				schemaVersion: 1,
				snapshotId: randomUUID(),
				createdAt: timestampRows[0]?.value.toISOString(),
				counts,
				authSettings,
				users,
				versions: {
					reporting: bigintStrings(reportingVersions),
					billing: bigintStrings(billingVersions),
					reportingHighWater: reportingSequence.toString(),
					billingHighWater: billingSequence.toString()
				}
			};
		},
		{
			isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
			maxWait: 10_000,
			timeout: 15 * 60 * 1_000
		}
	);

const writeAtomic = async (file: string, body: string): Promise<void> => {
	const parent = dirname(file);
	const temporary = join(parent, `.${basename(file)}.${randomUUID()}.tmp`);
	try {
		const target = await lstat(file).catch(() => null);
		if (target?.isSymbolicLink()) {
			throw new IdentityCoreCutoverError(
				'Identity snapshot target must not be a symbolic link'
			);
		}
		const handle = await open(temporary, 'wx', 0o600);
		try {
			await handle.writeFile(body, { encoding: 'utf8' });
			await handle.sync();
		} finally {
			await handle.close();
		}
		await chmod(temporary, 0o600);
		await rename(temporary, file);
		await chmod(file, 0o600);
	} catch (error) {
		await unlink(temporary).catch(() => undefined);
		throw error;
	}
};

const changeFence = async (
	client: PrismaClient,
	action: 'fence' | 'unfence'
): Promise<Record<string, unknown>> => {
	const expectedRevision = revision();
	return client.$transaction(
		async transaction => {
			if (action === 'fence') {
				const current = await readFenceState(transaction);
				if (
					current.ownership === 'FENCED' &&
					current.fencedRevision === expectedRevision
				) {
					return { ok: true, action, ...serializeFence(current) };
				}
				const preflight = await readPreflight(transaction);
				assertPreflight(preflight);
				assertIdentityCoreSourceOpen(preflight);
				assertIdentityCoreOutboxDrained(
					preflight.legacyIdentityOutboxPending
				);
				assertIdentityCoreDestinationFailuresDrained(
					preflight.legacyDestinationFailuresUnresolved
				);
			}

			const functionName =
				action === 'fence'
					? Prisma.raw('"fence_identity_core_source"')
					: Prisma.raw('"unfence_identity_core_source"');
			const rows = await transaction.$queryRaw<FenceRow[]>(Prisma.sql`
				SELECT
					"ownership",
					"generation",
					"fenced_revision" AS "fencedRevision",
					"fenced_at" AS "fencedAt"
				FROM ${functionName}(${expectedRevision})
			`);
			if (rows.length !== 1 || !rows[0]) {
				throw new IdentityCoreCutoverError(
					`Identity Core source ${action} returned no state`
				);
			}
			const state = rows[0];
			if (
				(action === 'fence' &&
					(state.ownership !== 'FENCED' ||
						state.fencedRevision !== expectedRevision)) ||
				(action === 'unfence' &&
					(state.ownership !== 'OPEN' || state.fencedRevision !== null))
			) {
				throw new IdentityCoreCutoverError(
					`Identity Core source ${action} returned an invalid state`
				);
			}
			return { ok: true, action, ...serializeFence(state) };
		},
		{
			isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
			maxWait: 10_000,
			timeout: 60_000
		}
	);
};

export const runIdentityCoreCutover = async (
	args: CutoverArgs
): Promise<Record<string, unknown>> => {
	const client = new PrismaClient({
		datasources: { db: { url: databaseUrl() } }
	});
	try {
		await client.$connect();
		if (args.action === 'status') {
			return {
				ok: true,
				action: args.action,
				...serializeFence(await readFenceState(client))
			};
		}
		if (args.action === 'preflight') {
			const result = await readPreflight(client);
			assertPreflight(result);
			assertIdentityCoreSourceOpen(result);
			return { ok: true, action: args.action, ...result };
		}
		if (args.action === 'fence' || args.action === 'unfence') {
			return await changeFence(client, args.action);
		}
		const value = await snapshot(client);
		const body = `${JSON.stringify(value)}\n`;
		await writeAtomic(args.file!, body);
		return {
			ok: true,
			action: args.action,
			snapshotId: value.snapshotId,
			sha256: createHash('sha256').update(body).digest('hex'),
			counts: value.counts,
			reportingHighWater: value.versions.reportingHighWater,
			billingHighWater: value.versions.billingHighWater
		};
	} finally {
		await client.$disconnect();
	}
};

if (require.main === module) {
	runIdentityCoreCutover(
		parseIdentityCoreCutoverArgs(process.argv.slice(2))
	)
		.then(result => process.stdout.write(`${JSON.stringify(result)}\n`))
		.catch(error => {
			process.stderr.write(
				`${JSON.stringify({
					ok: false,
					error:
						error instanceof IdentityCoreCutoverError
							? error.message
							: 'Identity Core cutover failed'
				})}\n`
			);
			process.exitCode = 1;
		});
}
