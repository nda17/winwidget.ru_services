import {
	Prisma,
	PrismaClient,
	ServiceDatabasePhase,
	SupportMappingKind
} from '@prisma/support-client';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { isAbsolute } from 'node:path';

const ACTIONS = [
	'status',
	'validate-shadow',
	'import',
	'activate',
	'verify',
	'abort'
] as const;
type Action = (typeof ACTIONS)[number];
const MAX_SNAPSHOT_BYTES = 64 * 1024 * 1024;
const UUID =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type SnapshotMapping = {
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
};

export type SupportCutoverSnapshot = {
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
	mappings: SnapshotMapping[];
};

type Args = { action: Action; file?: string; sha256?: string };
type LoadedSnapshot = { snapshot: SupportCutoverSnapshot; sha256: string };

export class SupportCutoverError extends Error {}

export function parseSupportCutoverArgs(argv: readonly string[]): Args {
	const [rawAction, ...rest] = argv;
	if (!ACTIONS.includes(rawAction as Action)) {
		throw new SupportCutoverError('Unsupported Support cutover action');
	}
	const action = rawAction as Action;
	if (['status', 'validate-shadow', 'verify'].includes(action)) {
		if (rest.length)
			throw new SupportCutoverError(`${action} accepts no arguments`);
		return { action };
	}
	if (action === 'activate' || action === 'abort') {
		if (
			rest.length !== 2 ||
			rest[0] !== '--sha256' ||
			!/^[0-9a-f]{64}$/.test(rest[1] || '')
		) {
			throw new SupportCutoverError(`${action} requires --sha256 <hex>`);
		}
		return { action, sha256: rest[1] };
	}
	if (
		rest.length !== 4 ||
		rest[0] !== '--file' ||
		!rest[1] ||
		!isAbsolute(rest[1]) ||
		rest[1].includes('\0') ||
		rest[2] !== '--sha256' ||
		!/^[0-9a-f]{64}$/.test(rest[3] || '')
	) {
		throw new SupportCutoverError(
			'import requires --file <absolute-path> --sha256 <hex>'
		);
	}
	return { action, file: rest[1], sha256: rest[3] };
}

export function canonicalSupportJson(value: unknown): string {
	if (Array.isArray(value)) {
		return `[${value.map(item => canonicalSupportJson(item)).join(',')}]`;
	}
	if (value && typeof value === 'object') {
		return `{${Object.entries(value as Record<string, unknown>)
			.sort(([left], [right]) => left.localeCompare(right))
			.map(
				([key, item]) =>
					`${JSON.stringify(key)}:${canonicalSupportJson(item)}`
			)
			.join(',')}}`;
	}
	return JSON.stringify(value);
}

export function supportSnapshotFingerprint(
	snapshot:
		| Omit<SupportCutoverSnapshot, 'sourceFingerprint'>
		| SupportCutoverSnapshot
): string {
	const semantic = { ...(snapshot as SupportCutoverSnapshot) };
	delete (semantic as Partial<SupportCutoverSnapshot>).sourceFingerprint;
	return createHash('sha256')
		.update(canonicalSupportJson(semantic))
		.digest('hex');
}

export async function loadSupportSnapshot(
	file: string,
	expectedSha256: string
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
			metadata.size > MAX_SNAPSHOT_BYTES ||
			(metadata.mode & 0o777) !== 0o600
		) {
			throw new SupportCutoverError(
				'Support snapshot must be a bounded mode-0600 regular file'
			);
		}
		const bytes = await handle.readFile();
		const sha256 = createHash('sha256').update(bytes).digest('hex');
		if (sha256 !== expectedSha256) {
			throw new SupportCutoverError('Support snapshot SHA-256 mismatch');
		}
		let value: unknown;
		try {
			value = JSON.parse(bytes.toString('utf8'));
		} catch {
			throw new SupportCutoverError('Support snapshot is not valid JSON');
		}
		return { snapshot: parseSupportSnapshot(value), sha256 };
	} catch (error) {
		if (error instanceof SupportCutoverError) throw error;
		throw new SupportCutoverError(
			'Support snapshot cannot be read safely'
		);
	} finally {
		await handle?.close();
	}
}

export function parseSupportSnapshot(
	value: unknown
): SupportCutoverSnapshot {
	const snapshot = record(value, 'snapshot');
	exact(snapshot, [
		'counts',
		'createdAt',
		'mappings',
		'routingSettings',
		'schemaVersion',
		'snapshotId',
		'sourceDatabaseSystemId',
		'sourceFingerprint',
		'sourceHighWatermark',
		'sourceRevision'
	]);
	if (
		snapshot.schemaVersion !== 1 ||
		typeof snapshot.snapshotId !== 'string' ||
		!UUID.test(snapshot.snapshotId) ||
		!isoDate(snapshot.createdAt) ||
		typeof snapshot.sourceRevision !== 'string' ||
		!/^[0-9a-f]{40}$/.test(snapshot.sourceRevision) ||
		typeof snapshot.sourceDatabaseSystemId !== 'string' ||
		!/^[1-9][0-9]{0,31}$/.test(snapshot.sourceDatabaseSystemId) ||
		typeof snapshot.sourceFingerprint !== 'string' ||
		!/^[0-9a-f]{64}$/.test(snapshot.sourceFingerprint) ||
		typeof snapshot.sourceHighWatermark !== 'string' ||
		!/^[1-9][0-9]*$/.test(snapshot.sourceHighWatermark)
	) {
		invalid('snapshot identity');
	}
	const counts = record(snapshot.counts, 'snapshot.counts');
	exact(counts, ['messageMappings', 'routingSettings']);
	const routing = record(
		snapshot.routingSettings,
		'snapshot.routingSettings'
	);
	exact(routing, ['adminChatId', 'id', 'supportThreadId', 'updatedAt']);
	if (
		counts.routingSettings !== 1 ||
		!Number.isSafeInteger(counts.messageMappings) ||
		Number(counts.messageMappings) < 0 ||
		routing.id !== 'singleton' ||
		typeof routing.adminChatId !== 'string' ||
		!/^-[1-9][0-9]*$/.test(routing.adminChatId) ||
		!positiveInteger(routing.supportThreadId) ||
		!isoDate(routing.updatedAt) ||
		!Array.isArray(snapshot.mappings) ||
		snapshot.mappings.length !== counts.messageMappings
	) {
		invalid('snapshot Support source counts or routing settings');
	}
	const mappings = snapshot.mappings.map((item, index) =>
		parseMapping(item, index, routing.adminChatId as string)
	);
	if (
		new Set(mappings.map(item => item.sourceId)).size !==
			mappings.length ||
		new Set(
			mappings.map(item => `${item.adminChatId}:${item.adminMessageId}`)
		).size !== mappings.length
	) {
		invalid('snapshot mapping uniqueness');
	}
	const parsed: SupportCutoverSnapshot = {
		schemaVersion: 1,
		snapshotId: snapshot.snapshotId as string,
		createdAt: snapshot.createdAt as string,
		sourceRevision: snapshot.sourceRevision as string,
		sourceDatabaseSystemId: snapshot.sourceDatabaseSystemId as string,
		sourceFingerprint: snapshot.sourceFingerprint as string,
		sourceHighWatermark: snapshot.sourceHighWatermark as string,
		counts: { routingSettings: 1, messageMappings: mappings.length },
		routingSettings: {
			id: 'singleton',
			adminChatId: routing.adminChatId as string,
			supportThreadId: routing.supportThreadId as number,
			updatedAt: routing.updatedAt as string
		},
		mappings
	};
	if (supportSnapshotFingerprint(parsed) !== parsed.sourceFingerprint) {
		invalid('snapshot.sourceFingerprint');
	}
	return parsed;
}

function parseMapping(
	value: unknown,
	index: number,
	adminChatId: string
): SnapshotMapping {
	const mapping = record(value, `snapshot.mappings[${index}]`);
	exact(mapping, [
		'adminChatId',
		'adminMessageId',
		'createdAt',
		'firstName',
		'lastName',
		'sourceId',
		'telegramUserId',
		'text',
		'userChatId',
		'username'
	]);
	if (
		typeof mapping.sourceId !== 'string' ||
		!/^[A-Za-z0-9_-]{1,128}$/.test(mapping.sourceId) ||
		mapping.adminChatId !== adminChatId ||
		!positiveInteger(mapping.adminMessageId) ||
		typeof mapping.userChatId !== 'string' ||
		!/^-?[1-9][0-9]*$/.test(mapping.userChatId) ||
		!nullableString(mapping.telegramUserId, 64) ||
		!nullableString(mapping.username, 255) ||
		!nullableString(mapping.firstName, 255) ||
		!nullableString(mapping.lastName, 255) ||
		!nullableString(mapping.text, 16 * 1024) ||
		!isoDate(mapping.createdAt)
	) {
		invalid(`snapshot.mappings[${index}]`);
	}
	return mapping as unknown as SnapshotMapping;
}

async function shadowState(client: PrismaClient) {
	const [
		identity,
		settings,
		mappingCount,
		inboxCount,
		outboxCount,
		receiptCount,
		failureCount
	] = await Promise.all([
		client.serviceIdentity.findUnique({ where: { id: 'singleton' } }),
		client.routingSettings.findUnique({ where: { id: 'singleton' } }),
		client.supportMessageMapping.count(),
		client.telegramWebhookInbox.count(),
		client.outboxEvent.count(),
		client.consumerReceipt.count(),
		client.consumerFailure.count()
	]);
	if (!identity || !settings) {
		throw new SupportCutoverError(
			'Support database singleton markers are missing'
		);
	}
	return {
		identity,
		settings,
		counts: {
			mappings: mappingCount,
			inbox: inboxCount,
			outbox: outboxCount,
			receipts: receiptCount,
			failures: failureCount
		}
	};
}

async function validateShadow(client: PrismaClient) {
	const state = await shadowState(client);
	if (
		state.identity.serviceName !== 'support-service' ||
		state.identity.phase !== ServiceDatabasePhase.SHADOW ||
		state.identity.ownershipGeneration !== 0n ||
		state.identity.sourceDatabaseSystemId !== null ||
		state.identity.sourceRevision !== null ||
		state.identity.ownershipRevision !== null ||
		state.identity.sourceFingerprint !== null ||
		state.identity.sourceSnapshotSha256 !== null ||
		state.identity.sourceSnapshotCounts !== null ||
		state.identity.sourceHighWatermark !== null ||
		state.identity.importedAt !== null ||
		state.identity.activatedAt !== null ||
		state.settings.adminChatId !== '' ||
		state.settings.supportThreadId !== null ||
		Object.values(state.counts).some(count => count !== 0)
	) {
		throw new SupportCutoverError(
			'Support shadow database is not pristine'
		);
	}
	return {
		ok: true,
		action: 'validate-shadow',
		databaseId: state.identity.databaseId
	};
}

async function importSnapshot(
	client: PrismaClient,
	loaded: LoadedSnapshot
) {
	await client.$transaction(
		async transaction => {
			const state = await transaction.serviceIdentity.findUnique({
				where: { id: 'singleton' }
			});
			if (!state) {
				throw new SupportCutoverError(
					'Support import requires a service identity'
				);
			}
			const settings = await transaction.routingSettings.findUnique({
				where: { id: 'singleton' }
			});
			const mappingCount = await transaction.supportMessageMapping.count();
			const counts = state.sourceSnapshotCounts as {
				messageMappings?: unknown;
				routingSettings?: unknown;
			} | null;
			const resumablePhase =
				(state.phase === ServiceDatabasePhase.SHADOW &&
					state.ownershipGeneration === 0n &&
					state.ownershipRevision === null) ||
				(state.phase === ServiceDatabasePhase.ACTIVE &&
					state.ownershipGeneration >= 1n &&
					state.ownershipRevision === state.sourceRevision);
			if (
				resumablePhase &&
				state.sourceSnapshotSha256 === loaded.sha256 &&
				state.sourceDatabaseSystemId ===
					loaded.snapshot.sourceDatabaseSystemId &&
				state.sourceRevision === loaded.snapshot.sourceRevision &&
				state.sourceFingerprint === loaded.snapshot.sourceFingerprint &&
				state.sourceHighWatermark ===
					BigInt(loaded.snapshot.sourceHighWatermark) &&
				counts?.routingSettings === 1 &&
				counts.messageMappings ===
					loaded.snapshot.counts.messageMappings &&
				state.importedAt &&
				settings?.adminChatId ===
					loaded.snapshot.routingSettings.adminChatId &&
				settings.supportThreadId ===
					loaded.snapshot.routingSettings.supportThreadId &&
				mappingCount === loaded.snapshot.mappings.length &&
				(await transaction.telegramWebhookInbox.count()) === 0 &&
				(await transaction.outboxEvent.count()) === 0 &&
				(await transaction.consumerReceipt.count()) === 0 &&
				(await transaction.consumerFailure.count()) === 0
			) {
				return;
			}
			if (
				state.phase !== ServiceDatabasePhase.SHADOW ||
				state.ownershipGeneration !== 0n ||
				state.importedAt !== null ||
				mappingCount !== 0 ||
				(await transaction.telegramWebhookInbox.count()) !== 0 ||
				(await transaction.outboxEvent.count()) !== 0
			) {
				throw new SupportCutoverError(
					'Support import requires a pristine shadow'
				);
			}
			await transaction.routingSettings.update({
				where: { id: 'singleton' },
				data: {
					adminChatId: loaded.snapshot.routingSettings.adminChatId,
					supportThreadId: loaded.snapshot.routingSettings.supportThreadId,
					aggregateVersion: 1n,
					updatedAt: new Date(loaded.snapshot.routingSettings.updatedAt)
				}
			});
			for (
				let offset = 0;
				offset < loaded.snapshot.mappings.length;
				offset += 500
			) {
				await transaction.supportMessageMapping.createMany({
					data: loaded.snapshot.mappings
						.slice(offset, offset + 500)
						.map(item => ({
							legacySourceId: item.sourceId,
							kind: SupportMappingKind.USER_COPY,
							adminChatId: item.adminChatId,
							adminMessageId: item.adminMessageId,
							userChatId: item.userChatId,
							telegramUserId: item.telegramUserId,
							username: item.username,
							firstName: item.firstName,
							lastName: item.lastName,
							text: item.text,
							createdAt: new Date(item.createdAt)
						}))
				});
			}
			await transaction.serviceIdentity.update({
				where: { id: 'singleton' },
				data: {
					sourceDatabaseSystemId: loaded.snapshot.sourceDatabaseSystemId,
					sourceRevision: loaded.snapshot.sourceRevision,
					sourceFingerprint: loaded.snapshot.sourceFingerprint,
					sourceSnapshotSha256: loaded.sha256,
					sourceSnapshotCounts: loaded.snapshot.counts,
					sourceHighWatermark: BigInt(loaded.snapshot.sourceHighWatermark),
					importedAt: new Date()
				}
			});
		},
		{
			isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
			timeout: 60_000
		}
	);
	return { ok: true, action: 'import', sha256: loaded.sha256 };
}

async function activate(client: PrismaClient, sha256: string) {
	return client.$transaction(async transaction => {
		const identity = await transaction.serviceIdentity.findUnique({
			where: { id: 'singleton' }
		});
		const settings = await transaction.routingSettings.findUnique({
			where: { id: 'singleton' }
		});
		if (
			identity?.phase === ServiceDatabasePhase.ACTIVE &&
			identity.ownershipGeneration >= 1n &&
			identity.sourceSnapshotSha256 === sha256 &&
			identity.ownershipRevision === identity.sourceRevision &&
			identity.sourceDatabaseSystemId &&
			identity.sourceFingerprint &&
			identity.sourceSnapshotCounts &&
			identity.sourceHighWatermark !== null &&
			identity.importedAt &&
			identity.activatedAt &&
			settings?.adminChatId &&
			settings.supportThreadId
		) {
			return {
				ok: true,
				action: 'activate',
				activatedAt: identity.activatedAt.toISOString(),
				resumed: true
			};
		}
		if (
			!identity ||
			identity.phase !== ServiceDatabasePhase.SHADOW ||
			identity.sourceSnapshotSha256 !== sha256 ||
			!identity.sourceDatabaseSystemId ||
			!identity.sourceRevision ||
			identity.ownershipRevision !== null ||
			!identity.sourceFingerprint ||
			!identity.sourceSnapshotCounts ||
			identity.sourceHighWatermark === null ||
			!identity.importedAt ||
			!settings?.adminChatId ||
			!settings.supportThreadId
		) {
			throw new SupportCutoverError(
				'Support activation anchors are incomplete'
			);
		}
		const expectedCount = (
			identity.sourceSnapshotCounts as { messageMappings?: unknown }
		).messageMappings;
		if (
			!Number.isSafeInteger(expectedCount) ||
			(await transaction.supportMessageMapping.count()) !== expectedCount
		) {
			throw new SupportCutoverError(
				'Support activation mapping count differs'
			);
		}
		const activatedAt = new Date();
		await transaction.serviceIdentity.update({
			where: { id: 'singleton' },
			data: {
				phase: ServiceDatabasePhase.ACTIVE,
				ownershipGeneration: 1n,
				ownershipRevision: identity.sourceRevision,
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

async function verify(client: PrismaClient) {
	const state = await shadowState(client);
	if (
		state.identity.phase !== ServiceDatabasePhase.ACTIVE ||
		state.identity.ownershipGeneration < 1n ||
		!state.identity.sourceDatabaseSystemId ||
		!state.identity.sourceRevision ||
		state.identity.ownershipRevision !== state.identity.sourceRevision ||
		!state.identity.sourceFingerprint ||
		!state.identity.sourceSnapshotSha256 ||
		!state.identity.importedAt ||
		!state.identity.activatedAt ||
		state.identity.activatedAt < state.identity.importedAt ||
		!state.settings.adminChatId ||
		!state.settings.supportThreadId ||
		state.counts.inbox !== 0 ||
		state.counts.outbox !== 0 ||
		state.counts.receipts !== 0 ||
		state.counts.failures !== 0
	) {
		throw new SupportCutoverError('Support active verification failed');
	}
	return { ok: true, action: 'verify', mappings: state.counts.mappings };
}

async function abort(client: PrismaClient, sha256: string) {
	return client.$transaction(async transaction => {
		const identity = await transaction.serviceIdentity.findUnique({
			where: { id: 'singleton' }
		});
		if (
			!identity ||
			identity.phase !== ServiceDatabasePhase.SHADOW ||
			identity.sourceSnapshotSha256 !== sha256 ||
			(await transaction.telegramWebhookInbox.count()) !== 0 ||
			(await transaction.outboxEvent.count()) !== 0
		) {
			throw new SupportCutoverError(
				'Support abort is allowed only for an imported shadow'
			);
		}
		await transaction.supportMessageMapping.deleteMany();
		await transaction.routingSettings.update({
			where: { id: 'singleton' },
			data: {
				adminChatId: '',
				supportThreadId: null,
				aggregateVersion: 0n
			}
		});
		await transaction.serviceIdentity.update({
			where: { id: 'singleton' },
			data: {
				sourceDatabaseSystemId: null,
				sourceRevision: null,
				ownershipRevision: null,
				sourceFingerprint: null,
				sourceSnapshotSha256: null,
				sourceSnapshotCounts: Prisma.JsonNull,
				sourceHighWatermark: null,
				importedAt: null
			}
		});
		return { ok: true, action: 'abort' };
	});
}

function status(client: PrismaClient) {
	return shadowState(client).then(state => ({
		action: 'status',
		databaseId: state.identity.databaseId,
		phase: state.identity.phase,
		ownershipGeneration: state.identity.ownershipGeneration.toString(),
		sourceDatabaseSystemId: state.identity.sourceDatabaseSystemId,
		sourceRevision: state.identity.sourceRevision,
		ownershipRevision: state.identity.ownershipRevision,
		sourceFingerprint: state.identity.sourceFingerprint,
		sourceSnapshotSha256: state.identity.sourceSnapshotSha256,
		sourceHighWatermark:
			state.identity.sourceHighWatermark?.toString() || null,
		importedAt: state.identity.importedAt?.toISOString() || null,
		activatedAt: state.identity.activatedAt?.toISOString() || null,
		counts: state.counts
	}));
}

function record(value: unknown, name: string): Record<string, unknown> {
	if (!value || typeof value !== 'object' || Array.isArray(value))
		invalid(name);
	return value as Record<string, unknown>;
}

function exact(value: Record<string, unknown>, keys: string[]): void {
	const actual = Object.keys(value).sort();
	const expected = [...keys].sort();
	if (
		actual.length !== expected.length ||
		actual.some((key, index) => key !== expected[index])
	) {
		invalid('snapshot shape');
	}
}

function invalid(name: string): never {
	throw new SupportCutoverError(`Invalid ${name}`);
}

function isoDate(value: unknown): value is string {
	return (
		typeof value === 'string' &&
		!Number.isNaN(Date.parse(value)) &&
		new Date(value).toISOString() === value
	);
}

function positiveInteger(value: unknown): value is number {
	return Number.isSafeInteger(value) && Number(value) > 0;
}

function nullableString(value: unknown, maxBytes: number): boolean {
	return (
		value === null ||
		(typeof value === 'string' &&
			Buffer.byteLength(value, 'utf8') <= maxBytes)
	);
}

export async function runSupportCutover(
	args: Args,
	client = new PrismaClient()
): Promise<unknown> {
	try {
		switch (args.action) {
			case 'status':
				return await status(client);
			case 'validate-shadow':
				return await validateShadow(client);
			case 'import':
				return await importSnapshot(
					client,
					await loadSupportSnapshot(args.file!, args.sha256!)
				);
			case 'activate':
				return await activate(client, args.sha256!);
			case 'verify':
				return await verify(client);
			case 'abort':
				return await abort(client, args.sha256!);
		}
	} finally {
		await client.$disconnect();
	}
}

if (require.main === module) {
	void runSupportCutover(parseSupportCutoverArgs(process.argv.slice(2)))
		.then(result => process.stdout.write(`${JSON.stringify(result)}\n`))
		.catch(error => {
			process.stderr.write(
				`${error instanceof Error ? error.message : 'Support cutover failed'}\n`
			);
			process.exitCode = 1;
		});
}
