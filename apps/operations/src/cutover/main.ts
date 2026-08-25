import {
	OperationsDatabasePhase,
	Prisma,
	PrismaClient
} from '@prisma/operations-client';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open, readFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';

const MAX_SNAPSHOT_BYTES = 64 * 1024 * 1024;
const ACTIONS = ['status', 'import', 'activate'] as const;
type Action = (typeof ACTIONS)[number];

type Args = {
	action: Action;
	file?: string;
	sha256?: string;
};

type SnapshotNote = {
	id: string;
	text: string;
	done: boolean;
	createdAt: string;
	updatedAt: string;
};

type SnapshotJsonValue =
	| null
	| boolean
	| number
	| string
	| SnapshotJsonValue[]
	| { [key: string]: SnapshotJsonValue };

type SnapshotAdminEvent = {
	id: string;
	adminId: string | null;
	adminName: string | null;
	adminEmail: string | null;
	section: string;
	action: string;
	description: string;
	entityType: string | null;
	entityId: string | null;
	entityLabel: string | null;
	targetUserId: string | null;
	targetUserName: string | null;
	targetUserEmail: string | null;
	metadata: SnapshotJsonValue;
	ip: string | null;
	userAgent: string | null;
	createdAt: string;
};

export type OperationsCutoverSnapshot = {
	schemaVersion: 1;
	sourceRevision: string;
	createdAt: string;
	counts: {
		notes: number;
		adminEventLogs: number;
	};
	notes: SnapshotNote[];
	adminEventLogs: SnapshotAdminEvent[];
};

export class OperationsCutoverError extends Error {}

export function parseOperationsCutoverArgs(argv: readonly string[]): Args {
	const [rawAction, ...rest] = argv;
	if (!ACTIONS.includes(rawAction as Action)) {
		throw new OperationsCutoverError(
			'Unsupported Operations cutover action'
		);
	}
	const action = rawAction as Action;
	if (action === 'status') {
		if (rest.length !== 0) {
			throw new OperationsCutoverError('status accepts no arguments');
		}
		return { action };
	}
	if (action === 'activate') {
		if (
			rest.length !== 2 ||
			rest[0] !== '--sha256' ||
			!/^[0-9a-f]{64}$/.test(rest[1] || '')
		) {
			throw new OperationsCutoverError(
				'activate requires --sha256 <64-character-hex>'
			);
		}
		return { action, sha256: rest[1] };
	}
	if (
		rest.length !== 4 ||
		rest[0] !== '--file' ||
		rest[2] !== '--sha256' ||
		!rest[1] ||
		!isAbsolute(rest[1]) ||
		rest[1].includes('\0') ||
		!/^[0-9a-f]{64}$/.test(rest[3] || '')
	) {
		throw new OperationsCutoverError(
			'import requires --file <absolute-path> --sha256 <64-character-hex>'
		);
	}
	return { action, file: rest[1], sha256: rest[3] };
}

function asRecord(value: unknown, name: string): Record<string, unknown> {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		throw new OperationsCutoverError(`${name} must be an object`);
	}
	return value as Record<string, unknown>;
}

function requiredString(value: unknown, name: string): string {
	if (typeof value !== 'string' || value.length === 0) {
		throw new OperationsCutoverError(`${name} must be a non-empty string`);
	}
	return value;
}

function stringValue(value: unknown, name: string): string {
	if (typeof value !== 'string') {
		throw new OperationsCutoverError(`${name} must be a string`);
	}
	return value;
}

function nullableString(value: unknown, name: string): string | null {
	if (value === null) return null;
	return stringValue(value, name);
}

function jsonValue(value: unknown, name: string): SnapshotJsonValue {
	if (
		value === null ||
		typeof value === 'string' ||
		typeof value === 'boolean'
	) {
		return value;
	}
	if (typeof value === 'number') {
		if (!Number.isFinite(value)) {
			throw new OperationsCutoverError(
				`${name} contains a non-finite number`
			);
		}
		return value;
	}
	if (Array.isArray(value)) {
		return value.map((item, index) =>
			jsonValue(item, `${name}[${index}]`)
		);
	}
	const record = asRecord(value, name);
	return Object.fromEntries(
		Object.entries(record).map(([key, item]) => [
			key,
			jsonValue(item, `${name}.${key}`)
		])
	);
}

function isoDate(value: unknown, name: string): string {
	const raw = requiredString(value, name);
	const parsed = new Date(raw);
	if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== raw) {
		throw new OperationsCutoverError(`${name} must be an ISO timestamp`);
	}
	return raw;
}

function exactKeys(
	record: Record<string, unknown>,
	expected: readonly string[],
	name: string
): void {
	const actual = Object.keys(record).sort();
	const sortedExpected = [...expected].sort();
	if (JSON.stringify(actual) !== JSON.stringify(sortedExpected)) {
		throw new OperationsCutoverError(`${name} has unexpected fields`);
	}
}

export function parseOperationsSnapshot(
	value: unknown
): OperationsCutoverSnapshot {
	const root = asRecord(value, 'snapshot');
	exactKeys(
		root,
		[
			'schemaVersion',
			'sourceRevision',
			'createdAt',
			'counts',
			'notes',
			'adminEventLogs'
		],
		'snapshot'
	);
	if (root.schemaVersion !== 1) {
		throw new OperationsCutoverError(
			'Unsupported snapshot schema version'
		);
	}
	const sourceRevision = requiredString(
		root.sourceRevision,
		'snapshot.sourceRevision'
	);
	if (!/^[0-9a-f]{40}$/.test(sourceRevision)) {
		throw new OperationsCutoverError('Invalid snapshot source revision');
	}
	const counts = asRecord(root.counts, 'snapshot.counts');
	exactKeys(counts, ['notes', 'adminEventLogs'], 'snapshot.counts');
	if (
		!Number.isSafeInteger(counts.notes) ||
		Number(counts.notes) < 0 ||
		!Number.isSafeInteger(counts.adminEventLogs) ||
		Number(counts.adminEventLogs) < 0
	) {
		throw new OperationsCutoverError('Invalid snapshot counts');
	}
	if (!Array.isArray(root.notes) || !Array.isArray(root.adminEventLogs)) {
		throw new OperationsCutoverError('Snapshot rows must be arrays');
	}
	const notes = root.notes.map((value, index): SnapshotNote => {
		const row = asRecord(value, `notes[${index}]`);
		exactKeys(
			row,
			['id', 'text', 'done', 'createdAt', 'updatedAt'],
			`notes[${index}]`
		);
		if (typeof row.text !== 'string' || typeof row.done !== 'boolean') {
			throw new OperationsCutoverError(`Invalid notes[${index}] values`);
		}
		return {
			id: stringValue(row.id, `notes[${index}].id`),
			text: row.text,
			done: row.done,
			createdAt: isoDate(row.createdAt, `notes[${index}].createdAt`),
			updatedAt: isoDate(row.updatedAt, `notes[${index}].updatedAt`)
		};
	});
	const eventKeys = [
		'id',
		'adminId',
		'adminName',
		'adminEmail',
		'section',
		'action',
		'description',
		'entityType',
		'entityId',
		'entityLabel',
		'targetUserId',
		'targetUserName',
		'targetUserEmail',
		'metadata',
		'ip',
		'userAgent',
		'createdAt'
	] as const;
	const adminEventLogs = root.adminEventLogs.map(
		(value, index): SnapshotAdminEvent => {
			const row = asRecord(value, `adminEventLogs[${index}]`);
			exactKeys(row, eventKeys, `adminEventLogs[${index}]`);
			return {
				id: stringValue(row.id, `adminEventLogs[${index}].id`),
				adminId: nullableString(
					row.adminId,
					`adminEventLogs[${index}].adminId`
				),
				adminName: nullableString(
					row.adminName,
					`adminEventLogs[${index}].adminName`
				),
				adminEmail: nullableString(
					row.adminEmail,
					`adminEventLogs[${index}].adminEmail`
				),
				section: stringValue(
					row.section,
					`adminEventLogs[${index}].section`
				),
				action: stringValue(row.action, `adminEventLogs[${index}].action`),
				description: stringValue(
					row.description,
					`adminEventLogs[${index}].description`
				),
				entityType: nullableString(
					row.entityType,
					`adminEventLogs[${index}].entityType`
				),
				entityId: nullableString(
					row.entityId,
					`adminEventLogs[${index}].entityId`
				),
				entityLabel: nullableString(
					row.entityLabel,
					`adminEventLogs[${index}].entityLabel`
				),
				targetUserId: nullableString(
					row.targetUserId,
					`adminEventLogs[${index}].targetUserId`
				),
				targetUserName: nullableString(
					row.targetUserName,
					`adminEventLogs[${index}].targetUserName`
				),
				targetUserEmail: nullableString(
					row.targetUserEmail,
					`adminEventLogs[${index}].targetUserEmail`
				),
				metadata: jsonValue(
					row.metadata,
					`adminEventLogs[${index}].metadata`
				),
				ip: nullableString(row.ip, `adminEventLogs[${index}].ip`),
				userAgent: nullableString(
					row.userAgent,
					`adminEventLogs[${index}].userAgent`
				),
				createdAt: isoDate(
					row.createdAt,
					`adminEventLogs[${index}].createdAt`
				)
			};
		}
	);
	if (
		notes.length !== counts.notes ||
		adminEventLogs.length !== counts.adminEventLogs ||
		new Set(notes.map(row => row.id)).size !== notes.length ||
		new Set(adminEventLogs.map(row => row.id)).size !==
			adminEventLogs.length
	) {
		throw new OperationsCutoverError(
			'Snapshot counts or row identities do not match'
		);
	}
	return {
		schemaVersion: 1,
		sourceRevision,
		createdAt: isoDate(root.createdAt, 'snapshot.createdAt'),
		counts: {
			notes: Number(counts.notes),
			adminEventLogs: Number(counts.adminEventLogs)
		},
		notes,
		adminEventLogs
	};
}

async function loadSnapshot(file: string, expectedSha256: string) {
	const handle = await open(
		file,
		constants.O_RDONLY | constants.O_NOFOLLOW
	);
	try {
		const stats = await handle.stat();
		if (
			!stats.isFile() ||
			stats.size < 2 ||
			stats.size > MAX_SNAPSHOT_BYTES
		) {
			throw new OperationsCutoverError('Snapshot file size is invalid');
		}
		const body = await readFile(handle, 'utf8');
		const sha256 = createHash('sha256').update(body).digest('hex');
		if (sha256 !== expectedSha256) {
			throw new OperationsCutoverError('Snapshot SHA-256 does not match');
		}
		return { snapshot: parseOperationsSnapshot(JSON.parse(body)), sha256 };
	} finally {
		await handle.close();
	}
}

async function lockState(transaction: Prisma.TransactionClient) {
	await transaction.$queryRaw`
		SELECT "id"
		FROM "operations"."operations_ownership_state"
		WHERE "id" = 'singleton'
		FOR UPDATE
	`;
	return transaction.operationsOwnershipState.findUniqueOrThrow({
		where: { id: 'singleton' }
	});
}

async function verifyImportedCounts(
	client: PrismaClient | Prisma.TransactionClient,
	notes: bigint,
	events: bigint
): Promise<void> {
	const [noteCount, eventCount] = await Promise.all([
		client.note.count(),
		client.adminEventLog.count()
	]);
	if (BigInt(noteCount) !== notes || BigInt(eventCount) !== events) {
		throw new OperationsCutoverError(
			'Operations imported row counts do not match ownership state'
		);
	}
}

async function status(client: PrismaClient): Promise<void> {
	const state = await client.operationsOwnershipState.findUniqueOrThrow({
		where: { id: 'singleton' }
	});
	const [notes, adminEventLogs] = await Promise.all([
		client.note.count(),
		client.adminEventLog.count()
	]);
	process.stdout.write(
		`${JSON.stringify({
			phase: state.phase,
			sourceRevision: state.sourceRevision,
			snapshotSha256: state.sourceSnapshotSha256,
			notes,
			adminEventLogs
		})}\n`
	);
}

async function importSnapshot(
	client: PrismaClient,
	file: string,
	sha256: string
): Promise<void> {
	const loaded = await loadSnapshot(file, sha256);
	await client.$transaction(
		async transaction => {
			const state = await lockState(transaction);
			if (state.phase !== OperationsDatabasePhase.EMPTY) {
				if (
					state.sourceSnapshotSha256 !== sha256 ||
					state.sourceRevision !== loaded.snapshot.sourceRevision
				) {
					throw new OperationsCutoverError(
						'Operations already contains another cutover snapshot'
					);
				}
				await verifyImportedCounts(
					transaction,
					state.sourceNoteCount!,
					state.sourceEventCount!
				);
				return;
			}
			const [noteCount, eventCount] = await Promise.all([
				transaction.note.count(),
				transaction.adminEventLog.count()
			]);
			if (noteCount !== 0 || eventCount !== 0) {
				throw new OperationsCutoverError(
					'Operations target tables must be empty before import'
				);
			}
			if (loaded.snapshot.notes.length > 0) {
				await transaction.note.createMany({
					data: loaded.snapshot.notes.map(row => ({
						...row,
						createdAt: new Date(row.createdAt),
						updatedAt: new Date(row.updatedAt)
					}))
				});
			}
			if (loaded.snapshot.adminEventLogs.length > 0) {
				await transaction.adminEventLog.createMany({
					data: loaded.snapshot.adminEventLogs.map(row => ({
						...row,
						metadata:
							row.metadata === null
								? Prisma.JsonNull
								: (row.metadata as Prisma.InputJsonValue),
						createdAt: new Date(row.createdAt)
					}))
				});
			}
			await transaction.operationsOwnershipState.update({
				where: { id: 'singleton' },
				data: {
					phase: OperationsDatabasePhase.IMPORTED,
					sourceRevision: loaded.snapshot.sourceRevision,
					sourceSnapshotSha256: sha256,
					sourceNoteCount: BigInt(loaded.snapshot.counts.notes),
					sourceEventCount: BigInt(loaded.snapshot.counts.adminEventLogs),
					importedAt: new Date()
				}
			});
		},
		{ isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
	);
	process.stdout.write(`${JSON.stringify({ imported: true, sha256 })}\n`);
}

async function activate(
	client: PrismaClient,
	sha256: string
): Promise<void> {
	await client.$transaction(
		async transaction => {
			const state = await lockState(transaction);
			if (state.sourceSnapshotSha256 !== sha256) {
				throw new OperationsCutoverError(
					'Imported snapshot SHA-256 differs'
				);
			}
			if (state.phase === OperationsDatabasePhase.ACTIVE) return;
			if (state.phase !== OperationsDatabasePhase.IMPORTED) {
				throw new OperationsCutoverError(
					'Operations snapshot must be imported before activation'
				);
			}
			await verifyImportedCounts(
				transaction,
				state.sourceNoteCount!,
				state.sourceEventCount!
			);
			await transaction.operationsOwnershipState.update({
				where: { id: 'singleton' },
				data: {
					phase: OperationsDatabasePhase.ACTIVE,
					activatedAt: new Date()
				}
			});
		},
		{ isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
	);
	process.stdout.write(`${JSON.stringify({ active: true, sha256 })}\n`);
}

export async function runOperationsCutover(
	argv: readonly string[],
	client = new PrismaClient()
): Promise<void> {
	const args = parseOperationsCutoverArgs(argv);
	try {
		if (args.action === 'status') return await status(client);
		if (args.action === 'import') {
			return await importSnapshot(client, args.file!, args.sha256!);
		}
		await activate(client, args.sha256!);
	} finally {
		await client.$disconnect();
	}
}

if (require.main === module) {
	runOperationsCutover(process.argv.slice(2)).catch(error => {
		const message =
			error instanceof OperationsCutoverError
				? error.message
				: 'Operations cutover command failed';
		process.stderr.write(`${message}\n`);
		process.exitCode = 1;
	});
}
