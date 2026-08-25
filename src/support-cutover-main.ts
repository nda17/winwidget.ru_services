import {
	Prisma,
	PrismaClient,
	SupportCoreOwnership
} from '@prisma/client';
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { isAbsolute } from 'node:path';

const ACTIONS = [
	'status',
	'preflight',
	'prepare',
	'fence',
	'export',
	'activate',
	'abort'
] as const;
type Action = (typeof ACTIONS)[number];

type Args = {
	action: Action;
	revision?: string;
	file?: string;
	sha256?: string;
	fingerprint?: string;
	systemId?: string;
	mappingCount?: string;
	highWatermark?: string;
};

type CoreState = {
	id: string;
	ownership: SupportCoreOwnership;
	admissionEnabled: boolean;
	reconcilerEnabled: boolean;
	activeTaskCount: number;
	generation: bigint;
	preparedRevision: string | null;
	sourceRevision: string | null;
	ownershipRevision: string | null;
	sourceDatabaseSystemId: string | null;
	sourceFingerprint: string | null;
	sourceSnapshotSha256: string | null;
	sourceMappingCount: bigint | null;
	sourceHighWatermark: bigint | null;
	fencedAt: Date | null;
	exportedAt: Date | null;
	activatedAt: Date | null;
};

type SourceSettings = {
	id: string;
	dailySummaryChatId: string;
	supportThreadId: number | null;
	updatedAt: Date;
};

type SourceMapping = {
	id: string;
	adminChatId: string;
	adminMessageId: number;
	userChatId: string;
	telegramUserId: string | null;
	username: string | null;
	firstName: string | null;
	lastName: string | null;
	text: string | null;
	createdAt: Date;
};

type SourceAnchor = { systemId: string; highWatermark: bigint };

export type SupportCoreSnapshot = {
	schemaVersion: 1;
	snapshotId: string;
	createdAt: string;
	sourceRevision: string;
	sourceDatabaseSystemId: string;
	sourceFingerprint: string;
	sourceHighWatermark: string;
	counts: { routingSettings: 1; messageMappings: number };
	routingSettings: {
		id: 'singleton';
		adminChatId: string;
		supportThreadId: number;
		updatedAt: string;
	};
	mappings: Array<{
		sourceId: string;
		adminChatId: string;
		adminMessageId: number;
		userChatId: string;
		telegramUserId: string | null;
		username: string | null;
		firstName: string | null;
		lastName: string | null;
		text: string | null;
		createdAt: string;
	}>;
};

export class SupportCoreCutoverError extends Error {}

export function parseSupportCoreCutoverArgs(
	argv: readonly string[]
): Args {
	const [rawAction, ...rest] = argv;
	if (!ACTIONS.includes(rawAction as Action)) {
		throw new SupportCoreCutoverError(
			'Unsupported Support Core cutover action'
		);
	}
	const action = rawAction as Action;
	if (action === 'status') {
		if (rest.length)
			throw new SupportCoreCutoverError('status accepts no arguments');
		return { action };
	}
	const options = new Map<string, string>();
	for (let index = 0; index < rest.length; index += 2) {
		const key = rest[index];
		const value = rest[index + 1];
		if (!key?.startsWith('--') || !value || options.has(key)) {
			throw new SupportCoreCutoverError('Invalid Support Core arguments');
		}
		options.set(key, value);
	}
	const revision = options.get('--revision');
	if (!revision || !/^[0-9a-f]{40}$/.test(revision)) {
		throw new SupportCoreCutoverError(
			'Support Core action requires --revision <40-character-sha>'
		);
	}
	if (['preflight', 'prepare', 'fence', 'abort'].includes(action)) {
		if (options.size !== 1) {
			throw new SupportCoreCutoverError(
				`${action} accepts only --revision`
			);
		}
		return { action, revision };
	}
	const file = options.get('--file');
	if (!file || !isAbsolute(file) || file.includes('\0')) {
		throw new SupportCoreCutoverError(
			'Support snapshot path must be absolute'
		);
	}
	if (action === 'export') {
		if (options.size !== 2) {
			throw new SupportCoreCutoverError(
				'export accepts --revision and --file'
			);
		}
		return { action, revision, file };
	}
	const sha256 = options.get('--sha256');
	const fingerprint = options.get('--fingerprint');
	const systemId = options.get('--system-id');
	const mappingCount = options.get('--mapping-count');
	const highWatermark = options.get('--high-watermark');
	if (
		options.size !== 7 ||
		!sha256 ||
		!/^[0-9a-f]{64}$/.test(sha256) ||
		!fingerprint ||
		!/^[0-9a-f]{64}$/.test(fingerprint) ||
		!systemId ||
		!/^[1-9][0-9]{0,31}$/.test(systemId) ||
		mappingCount === undefined ||
		!/^(0|[1-9][0-9]*)$/.test(mappingCount) ||
		!highWatermark ||
		!/^[1-9][0-9]*$/.test(highWatermark)
	) {
		throw new SupportCoreCutoverError(
			'activate requires every immutable Support source anchor'
		);
	}
	return {
		action,
		revision,
		file,
		sha256,
		fingerprint,
		systemId,
		mappingCount,
		highWatermark
	};
}

export function canonicalSupportCoreJson(value: unknown): string {
	if (Array.isArray(value)) {
		return `[${value.map(item => canonicalSupportCoreJson(item)).join(',')}]`;
	}
	if (value && typeof value === 'object') {
		return `{${Object.entries(value as Record<string, unknown>)
			.sort(([left], [right]) => left.localeCompare(right))
			.map(
				([key, item]) =>
					`${JSON.stringify(key)}:${canonicalSupportCoreJson(item)}`
			)
			.join(',')}}`;
	}
	return JSON.stringify(value);
}

export function supportCoreSnapshotFingerprint(
	snapshot:
		| Omit<SupportCoreSnapshot, 'sourceFingerprint'>
		| SupportCoreSnapshot
): string {
	const semantic = { ...(snapshot as SupportCoreSnapshot) };
	delete (semantic as Partial<SupportCoreSnapshot>).sourceFingerprint;
	return createHash('sha256')
		.update(canonicalSupportCoreJson(semantic))
		.digest('hex');
}

async function state(
	client: PrismaClient | Prisma.TransactionClient
): Promise<CoreState> {
	const rows = await client.$queryRaw<CoreState[]>(Prisma.sql`
		SELECT "id", "ownership",
			"admission_enabled" AS "admissionEnabled",
			"reconciler_enabled" AS "reconcilerEnabled",
			"active_task_count" AS "activeTaskCount",
			"generation",
			"prepared_revision" AS "preparedRevision",
			"source_revision" AS "sourceRevision",
			"ownership_revision" AS "ownershipRevision",
			"source_database_system_id" AS "sourceDatabaseSystemId",
			"source_fingerprint" AS "sourceFingerprint",
			"source_snapshot_sha256" AS "sourceSnapshotSha256",
			"source_mapping_count" AS "sourceMappingCount",
			"source_high_watermark" AS "sourceHighWatermark",
			"fenced_at" AS "fencedAt", "exported_at" AS "exportedAt",
			"activated_at" AS "activatedAt"
		FROM "public"."support_core_state"
		WHERE "id" = 'singleton'
	`);
	if (rows.length !== 1) {
		throw new SupportCoreCutoverError('Support Core state is missing');
	}
	return rows[0]!;
}

async function lockState(
	transaction: Prisma.TransactionClient
): Promise<void> {
	await transaction.$queryRaw`
		SELECT "id" FROM "public"."support_core_state"
		WHERE "id" = 'singleton' FOR UPDATE
	`;
}

async function source(
	client: PrismaClient | Prisma.TransactionClient
): Promise<{
	settings: SourceSettings;
	mappings: SourceMapping[];
	anchor: SourceAnchor;
}> {
	const [settings, mappings, anchors] = await Promise.all([
		client.$queryRaw<SourceSettings[]>(Prisma.sql`
			SELECT "id", "daily_summary_chat_id" AS "dailySummaryChatId",
				"support_thread_id" AS "supportThreadId", "updated_at" AS "updatedAt"
			FROM "public"."telegram_bot_settings" WHERE "id" = 'singleton'
		`),
		client.$queryRaw<SourceMapping[]>(Prisma.sql`
			SELECT "id", "admin_chat_id" AS "adminChatId",
				"admin_message_id" AS "adminMessageId",
				"user_chat_id" AS "userChatId",
				"telegram_user_id" AS "telegramUserId", "username",
				"first_name" AS "firstName", "last_name" AS "lastName",
				"text", "created_at" AS "createdAt"
			FROM "public"."telegram_support_messages"
			ORDER BY "created_at" ASC, "id" ASC
		`),
		client.$queryRaw<SourceAnchor[]>(Prisma.sql`
			SELECT (pg_control_system()).system_identifier::text AS "systemId",
				txid_current() AS "highWatermark"
		`)
	]);
	const config = settings[0];
	const anchor = anchors[0];
	if (
		settings.length !== 1 ||
		config?.id !== 'singleton' ||
		!config.dailySummaryChatId.trim() ||
		!config.supportThreadId ||
		config.supportThreadId < 1 ||
		!anchor ||
		!/^[1-9][0-9]*$/.test(anchor.systemId) ||
		anchor.highWatermark < 1n ||
		mappings.some(
			item =>
				item.adminChatId !== config.dailySummaryChatId.trim() ||
				item.adminMessageId < 1 ||
				!item.userChatId
		)
	) {
		throw new SupportCoreCutoverError(
			'Support Core source anchors are invalid'
		);
	}
	return { settings: config, mappings, anchor };
}

function snapshot(
	revision: string,
	input: Awaited<ReturnType<typeof source>>,
	identity?: {
		snapshotId: string;
		createdAt: string;
		highWatermark: string;
	}
): SupportCoreSnapshot {
	const value: SupportCoreSnapshot = {
		schemaVersion: 1,
		snapshotId: identity?.snapshotId || randomUUID(),
		createdAt: identity?.createdAt || new Date().toISOString(),
		sourceRevision: revision,
		sourceDatabaseSystemId: input.anchor.systemId,
		sourceFingerprint: '',
		sourceHighWatermark:
			identity?.highWatermark || input.anchor.highWatermark.toString(),
		counts: { routingSettings: 1, messageMappings: input.mappings.length },
		routingSettings: {
			id: 'singleton',
			adminChatId: input.settings.dailySummaryChatId.trim(),
			supportThreadId: input.settings.supportThreadId!,
			updatedAt: input.settings.updatedAt.toISOString()
		},
		mappings: input.mappings.map(item => ({
			sourceId: item.id,
			adminChatId: item.adminChatId,
			adminMessageId: item.adminMessageId,
			userChatId: item.userChatId,
			telegramUserId: item.telegramUserId,
			username: item.username,
			firstName: item.firstName,
			lastName: item.lastName,
			text: item.text,
			createdAt: item.createdAt.toISOString()
		}))
	};
	value.sourceFingerprint = supportCoreSnapshotFingerprint(value);
	return value;
}

async function preflight(client: PrismaClient, revision: string) {
	const current = await state(client);
	if (
		current.ownership !== SupportCoreOwnership.CORE ||
		!current.admissionEnabled ||
		!current.reconcilerEnabled ||
		current.generation !== 0n ||
		(current.preparedRevision !== null &&
			current.preparedRevision !== revision)
	) {
		throw new SupportCoreCutoverError(
			'Support Core preflight requires an open source'
		);
	}
	const input = await source(client);
	return {
		ok: true,
		action: 'preflight',
		revision,
		sourceDatabaseSystemId: input.anchor.systemId,
		mappingCount: input.mappings.length,
		highWatermark: input.anchor.highWatermark.toString()
	};
}

async function prepare(client: PrismaClient, revision: string) {
	await preflight(client, revision);
	const changed = await client.supportCoreState.updateMany({
		where: {
			id: 'singleton',
			ownership: SupportCoreOwnership.CORE,
			admissionEnabled: true,
			reconcilerEnabled: true,
			generation: 0n,
			OR: [{ preparedRevision: null }, { preparedRevision: revision }]
		},
		data: { preparedRevision: revision }
	});
	if (changed.count !== 1)
		throw new SupportCoreCutoverError('Support prepare CAS failed');
	return { ok: true, action: 'prepare', revision };
}

async function fence(client: PrismaClient, revision: string) {
	return client.$transaction(async transaction => {
		await lockState(transaction);
		const current = await state(transaction);
		if (
			current.ownership === SupportCoreOwnership.CORE &&
			current.preparedRevision === revision &&
			!current.admissionEnabled &&
			!current.reconcilerEnabled &&
			current.activeTaskCount === 0 &&
			current.generation === 1n &&
			current.ownershipRevision === null &&
			current.fencedAt !== null &&
			current.activatedAt === null
		) {
			return {
				ok: true,
				action: 'fence',
				activeTaskCount: 0,
				fencedAt: current.fencedAt?.toISOString() || null,
				resumed: true
			};
		}
		if (
			current.ownership !== SupportCoreOwnership.CORE ||
			current.preparedRevision !== revision ||
			current.generation !== 0n ||
			!current.admissionEnabled ||
			!current.reconcilerEnabled ||
			current.activeTaskCount !== 0
		) {
			throw new SupportCoreCutoverError(
				'Support fence requires the prepared open source'
			);
		}
		const fencedAt = new Date();
		await transaction.supportCoreState.update({
			where: { id: 'singleton' },
			data: {
				admissionEnabled: false,
				reconcilerEnabled: false,
				generation: 1n,
				fencedAt
			}
		});
		return {
			ok: true,
			action: 'fence',
			activeTaskCount: current.activeTaskCount,
			fencedAt: fencedAt.toISOString()
		};
	});
}

async function writeSnapshot(file: string, value: SupportCoreSnapshot) {
	let handle;
	try {
		handle = await open(
			file,
			constants.O_WRONLY |
				constants.O_CREAT |
				constants.O_EXCL |
				(constants.O_NOFOLLOW || 0),
			0o600
		);
		const bytes = Buffer.from(`${canonicalSupportCoreJson(value)}\n`);
		await handle.writeFile(bytes);
		await handle.sync();
		return createHash('sha256').update(bytes).digest('hex');
	} catch (error) {
		throw new SupportCoreCutoverError(
			error instanceof Error && 'code' in error && error.code === 'EEXIST'
				? 'Support snapshot path already exists'
				: 'Support snapshot cannot be written safely'
		);
	} finally {
		await handle?.close();
	}
}

async function loadExistingSnapshot(
	file: string,
	revision: string,
	input: Awaited<ReturnType<typeof source>>
): Promise<{ value: SupportCoreSnapshot; sha256: string } | null> {
	let handle;
	try {
		handle = await open(
			file,
			constants.O_RDONLY | (constants.O_NOFOLLOW || 0)
		);
	} catch (error) {
		if (
			error instanceof Error &&
			'code' in error &&
			error.code === 'ENOENT'
		) {
			return null;
		}
		throw new SupportCoreCutoverError(
			'Support snapshot cannot be opened safely for resume'
		);
	}
	try {
		const metadata = await handle.stat();
		if (
			!metadata.isFile() ||
			metadata.size < 2 ||
			metadata.size > 64 * 1024 * 1024 ||
			(metadata.mode & 0o777) !== 0o600
		) {
			throw new SupportCoreCutoverError(
				'Support resume snapshot file is unsafe'
			);
		}
		const bytes = await handle.readFile();
		let parsed: SupportCoreSnapshot;
		try {
			parsed = JSON.parse(bytes.toString('utf8')) as SupportCoreSnapshot;
		} catch {
			throw new SupportCoreCutoverError(
				'Support resume snapshot is not JSON'
			);
		}
		if (
			parsed.schemaVersion !== 1 ||
			!/^[-0-9a-f]{36}$/i.test(parsed.snapshotId || '') ||
			Number.isNaN(Date.parse(parsed.createdAt)) ||
			new Date(parsed.createdAt).toISOString() !== parsed.createdAt ||
			parsed.sourceRevision !== revision ||
			!/^[1-9][0-9]*$/.test(parsed.sourceHighWatermark || '')
		) {
			throw new SupportCoreCutoverError(
				'Support resume snapshot identity is invalid'
			);
		}
		const expected = snapshot(revision, input, {
			snapshotId: parsed.snapshotId,
			createdAt: parsed.createdAt,
			highWatermark: parsed.sourceHighWatermark
		});
		if (
			canonicalSupportCoreJson(expected) !==
			canonicalSupportCoreJson(parsed)
		) {
			throw new SupportCoreCutoverError(
				'Support resume snapshot differs from the fenced Core source'
			);
		}
		return {
			value: parsed,
			sha256: createHash('sha256').update(bytes).digest('hex')
		};
	} finally {
		await handle.close();
	}
}

async function exportSnapshot(
	client: PrismaClient,
	revision: string,
	file: string
) {
	const candidate = await client.$transaction(
		async transaction => {
			await lockState(transaction);
			const current = await state(transaction);
			if (
				current.ownership !== SupportCoreOwnership.CORE ||
				current.preparedRevision !== revision ||
				current.admissionEnabled ||
				current.reconcilerEnabled ||
				current.activeTaskCount !== 0 ||
				current.generation < 1n
			) {
				throw new SupportCoreCutoverError(
					'Support export requires a drained, fenced, unexported source'
				);
			}
			const input = await source(transaction);
			const existing = await loadExistingSnapshot(file, revision, input);
			return {
				current,
				value: existing?.value || snapshot(revision, input),
				existingSha256: existing?.sha256 || null
			};
		},
		{ isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
	);
	const { value } = candidate;
	const sha256 =
		candidate.existingSha256 || (await writeSnapshot(file, value));
	if (candidate.current.sourceSnapshotSha256 === null) {
		const changed = await client.supportCoreState.updateMany({
			where: {
				id: 'singleton',
				ownership: SupportCoreOwnership.CORE,
				admissionEnabled: false,
				reconcilerEnabled: false,
				activeTaskCount: 0,
				preparedRevision: revision,
				sourceSnapshotSha256: null
			},
			data: {
				sourceRevision: revision,
				sourceDatabaseSystemId: value.sourceDatabaseSystemId,
				sourceFingerprint: value.sourceFingerprint,
				sourceSnapshotSha256: sha256,
				sourceMappingCount: BigInt(value.counts.messageMappings),
				sourceHighWatermark: BigInt(value.sourceHighWatermark),
				exportedAt: new Date()
			}
		});
		if (changed.count !== 1) {
			throw new SupportCoreCutoverError(
				'Support export anchor CAS failed; preserve the mode-0600 file for audit'
			);
		}
	} else if (
		candidate.current.sourceRevision !== revision ||
		candidate.current.sourceDatabaseSystemId !==
			value.sourceDatabaseSystemId ||
		candidate.current.sourceFingerprint !== value.sourceFingerprint ||
		candidate.current.sourceSnapshotSha256 !== sha256 ||
		candidate.current.sourceMappingCount !==
			BigInt(value.counts.messageMappings) ||
		candidate.current.sourceHighWatermark !==
			BigInt(value.sourceHighWatermark) ||
		!candidate.current.exportedAt
	) {
		throw new SupportCoreCutoverError(
			'Support exported anchors cannot be resumed'
		);
	}
	return {
		ok: true,
		action: 'export',
		file,
		sha256,
		fingerprint: value.sourceFingerprint,
		systemId: value.sourceDatabaseSystemId,
		mappingCount: value.counts.messageMappings,
		highWatermark: value.sourceHighWatermark
	};
}

async function readSnapshotSha(file: string): Promise<string> {
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
			metadata.size > 64 * 1024 * 1024 ||
			(metadata.mode & 0o777) !== 0o600
		) {
			throw new SupportCoreCutoverError('Support snapshot file is unsafe');
		}
		return createHash('sha256')
			.update(await handle.readFile())
			.digest('hex');
	} finally {
		await handle?.close();
	}
}

async function activate(client: PrismaClient, args: Args) {
	if ((await readSnapshotSha(args.file!)) !== args.sha256) {
		throw new SupportCoreCutoverError(
			'Support activation snapshot SHA-256 mismatch'
		);
	}
	return client.$transaction(async transaction => {
		await lockState(transaction);
		const current = await state(transaction);
		if (
			current.ownership === SupportCoreOwnership.SUPPORT &&
			current.preparedRevision === args.revision &&
			current.sourceRevision === args.revision &&
			current.ownershipRevision === args.revision &&
			!current.admissionEnabled &&
			!current.reconcilerEnabled &&
			current.activeTaskCount === 0 &&
			current.sourceSnapshotSha256 === args.sha256 &&
			current.sourceFingerprint === args.fingerprint &&
			current.sourceDatabaseSystemId === args.systemId &&
			current.sourceMappingCount === BigInt(args.mappingCount!) &&
			current.sourceHighWatermark === BigInt(args.highWatermark!) &&
			current.activatedAt
		) {
			return {
				ok: true,
				action: 'activate',
				activatedAt: current.activatedAt.toISOString(),
				resumed: true
			};
		}
		if (
			current.ownership !== SupportCoreOwnership.CORE ||
			current.preparedRevision !== args.revision ||
			current.sourceRevision !== args.revision ||
			current.admissionEnabled ||
			current.reconcilerEnabled ||
			current.activeTaskCount !== 0 ||
			current.sourceSnapshotSha256 !== args.sha256 ||
			current.sourceFingerprint !== args.fingerprint ||
			current.sourceDatabaseSystemId !== args.systemId ||
			current.sourceMappingCount !== BigInt(args.mappingCount!) ||
			current.sourceHighWatermark !== BigInt(args.highWatermark!) ||
			!current.fencedAt ||
			!current.exportedAt ||
			current.exportedAt < current.fencedAt
		) {
			throw new SupportCoreCutoverError(
				'Support activation anchors differ from Core state'
			);
		}
		const activatedAt = new Date();
		await transaction.supportCoreState.update({
			where: { id: 'singleton' },
			data: {
				ownership: SupportCoreOwnership.SUPPORT,
				ownershipRevision: args.revision,
				activatedAt
			}
		});
		return {
			ok: true,
			action: 'activate',
			activatedAt: activatedAt.toISOString()
		};
	});
}

async function abort(client: PrismaClient, revision: string) {
	return client.$transaction(async transaction => {
		await lockState(transaction);
		const current = await state(transaction);
		if (
			current.ownership !== SupportCoreOwnership.CORE ||
			current.preparedRevision !== revision ||
			current.activeTaskCount !== 0 ||
			current.activatedAt !== null
		) {
			throw new SupportCoreCutoverError('Support abort is no longer safe');
		}
		await transaction.supportCoreState.update({
			where: { id: 'singleton' },
			data: {
				admissionEnabled: true,
				reconcilerEnabled: true,
				generation: 0n,
				preparedRevision: null,
				sourceRevision: null,
				sourceDatabaseSystemId: null,
				sourceFingerprint: null,
				sourceSnapshotSha256: null,
				sourceMappingCount: null,
				sourceHighWatermark: null,
				fencedAt: null,
				exportedAt: null
			}
		});
		return { ok: true, action: 'abort' };
	});
}

function serializeState(current: CoreState) {
	return {
		action: 'status',
		ownership: current.ownership,
		admissionEnabled: current.admissionEnabled,
		reconcilerEnabled: current.reconcilerEnabled,
		activeTaskCount: current.activeTaskCount,
		generation: current.generation.toString(),
		preparedRevision: current.preparedRevision,
		sourceRevision: current.sourceRevision,
		ownershipRevision: current.ownershipRevision,
		sourceDatabaseSystemId: current.sourceDatabaseSystemId,
		sourceFingerprint: current.sourceFingerprint,
		sourceSnapshotSha256: current.sourceSnapshotSha256,
		sourceMappingCount: current.sourceMappingCount?.toString() || null,
		sourceHighWatermark: current.sourceHighWatermark?.toString() || null,
		fencedAt: current.fencedAt?.toISOString() || null,
		exportedAt: current.exportedAt?.toISOString() || null,
		activatedAt: current.activatedAt?.toISOString() || null
	};
}

export async function runSupportCoreCutover(
	args: Args,
	client = new PrismaClient()
): Promise<unknown> {
	try {
		switch (args.action) {
			case 'status':
				return serializeState(await state(client));
			case 'preflight':
				return await preflight(client, args.revision!);
			case 'prepare':
				return await prepare(client, args.revision!);
			case 'fence':
				return await fence(client, args.revision!);
			case 'export':
				return await exportSnapshot(client, args.revision!, args.file!);
			case 'activate':
				return await activate(client, args);
			case 'abort':
				return await abort(client, args.revision!);
		}
	} finally {
		await client.$disconnect();
	}
}

if (require.main === module) {
	void runSupportCoreCutover(
		parseSupportCoreCutoverArgs(process.argv.slice(2))
	)
		.then(result => process.stdout.write(`${JSON.stringify(result)}\n`))
		.catch(error => {
			process.stderr.write(
				`${error instanceof Error ? error.message : 'Support Core cutover failed'}\n`
			);
			process.exitCode = 1;
		});
}
