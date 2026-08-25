import {
	OperationsCoreOwnership,
	Prisma,
	PrismaClient
} from '@prisma/client';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { isAbsolute } from 'node:path';

const ACTIONS = [
	'status',
	'prepare',
	'fence',
	'export',
	'activate'
] as const;
type Action = (typeof ACTIONS)[number];

type Args = {
	action: Action;
	revision?: string;
	file?: string;
	sha256?: string;
	notes?: number;
	events?: number;
};

type OperationsCoreSourcePresence = {
	notesPresent: boolean;
	adminEventLogsPresent: boolean;
	statePresent: boolean;
	writeGuardPresent: boolean;
	stateGuardPresent: boolean;
	ownershipTypePresent: boolean;
};

export class OperationsCoreCutoverError extends Error {}

export function classifyOperationsCoreSourcePresence(
	presence: OperationsCoreSourcePresence
): 'present' | 'removed' {
	const values = Object.values(presence);
	if (values.every(Boolean)) return 'present';
	if (values.every(value => !value)) return 'removed';
	throw new OperationsCoreCutoverError(
		'Legacy Operations Core source is only partially present'
	);
}

function revision(value: string | undefined): string {
	if (!value || !/^[0-9a-f]{40}$/.test(value)) {
		throw new OperationsCoreCutoverError(
			'--revision must be a 40-character lowercase Git SHA'
		);
	}
	return value;
}

export function parseOperationsCoreCutoverArgs(
	argv: readonly string[]
): Args {
	const [rawAction, ...rest] = argv;
	if (!ACTIONS.includes(rawAction as Action)) {
		throw new OperationsCoreCutoverError(
			'Unsupported Operations Core cutover action'
		);
	}
	const action = rawAction as Action;
	if (action === 'status') {
		if (rest.length !== 0) {
			throw new OperationsCoreCutoverError('status accepts no arguments');
		}
		return { action };
	}
	const options = new Map<string, string>();
	for (let index = 0; index < rest.length; index += 2) {
		const key = rest[index];
		const value = rest[index + 1];
		if (!key?.startsWith('--') || !value || options.has(key)) {
			throw new OperationsCoreCutoverError(
				'Invalid Operations Core cutover arguments'
			);
		}
		options.set(key, value);
	}
	const sourceRevision = revision(options.get('--revision'));
	if (action === 'prepare' || action === 'fence') {
		if (options.size !== 1) {
			throw new OperationsCoreCutoverError(
				`${action} accepts only --revision`
			);
		}
		return { action, revision: sourceRevision };
	}
	if (action === 'export') {
		const file = options.get('--file');
		if (
			options.size !== 2 ||
			!file ||
			!isAbsolute(file) ||
			file.includes('\0')
		) {
			throw new OperationsCoreCutoverError(
				'export requires --revision and --file <absolute-path>'
			);
		}
		return { action, revision: sourceRevision, file };
	}
	const sha256 = options.get('--sha256');
	const rawNotes = options.get('--notes');
	const rawEvents = options.get('--events');
	if (
		options.size !== 4 ||
		!sha256 ||
		!/^[0-9a-f]{64}$/.test(sha256) ||
		!rawNotes ||
		!/^\d+$/.test(rawNotes) ||
		!rawEvents ||
		!/^\d+$/.test(rawEvents)
	) {
		throw new OperationsCoreCutoverError(
			'activate requires --revision, --sha256, --notes and --events'
		);
	}
	const notes = Number(rawNotes);
	const events = Number(rawEvents);
	if (!Number.isSafeInteger(notes) || !Number.isSafeInteger(events)) {
		throw new OperationsCoreCutoverError(
			'Activation counts are too large'
		);
	}
	return {
		action,
		revision: sourceRevision,
		sha256,
		notes,
		events
	};
}

async function lockState(transaction: Prisma.TransactionClient) {
	await transaction.$queryRaw`
		SELECT "id"
		FROM "public"."operations_core_state"
		WHERE "id" = 'singleton'
		FOR UPDATE
	`;
	return transaction.operationsCoreState.findUniqueOrThrow({
		where: { id: 'singleton' }
	});
}

function assertCoreOwnership(ownership: OperationsCoreOwnership): void {
	if (ownership !== OperationsCoreOwnership.CORE) {
		throw new OperationsCoreCutoverError(
			'Operations ownership has already left Core'
		);
	}
}

async function status(client: PrismaClient): Promise<void> {
	const [presence] = await client.$queryRaw<
		OperationsCoreSourcePresence[]
	>(Prisma.sql`
		SELECT
			to_regclass('public.notes') IS NOT NULL AS "notesPresent",
			to_regclass('public.admin_event_logs') IS NOT NULL AS "adminEventLogsPresent",
			to_regclass('public.operations_core_state') IS NOT NULL AS "statePresent",
			to_regprocedure('public.operations_core_source_write_guard()') IS NOT NULL AS "writeGuardPresent",
			to_regprocedure('public.operations_core_state_transition_guard()') IS NOT NULL AS "stateGuardPresent",
			to_regtype('public."OperationsCoreOwnership"') IS NOT NULL AS "ownershipTypePresent"
	`);
	if (!presence) {
		throw new OperationsCoreCutoverError(
			'Could not inspect the legacy Operations Core source'
		);
	}
	if (classifyOperationsCoreSourcePresence(presence) === 'removed') {
		process.stdout.write(`${JSON.stringify({ source: 'removed' })}\n`);
		return;
	}
	const state = await client.operationsCoreState.findUniqueOrThrow({
		where: { id: 'singleton' }
	});
	const [notes, adminEventLogs] = await Promise.all([
		client.note.count(),
		client.adminEventLog.count()
	]);
	process.stdout.write(
		`${JSON.stringify({
			ownership: state.ownership,
			sourceWritesEnabled: state.sourceWritesEnabled,
			legacyRoutesEnabled: state.legacyRoutesEnabled,
			generation: state.generation.toString(),
			preparedRevision: state.preparedRevision,
			ownershipRevision: state.ownershipRevision,
			snapshotSha256: state.sourceSnapshotSha256,
			notes,
			adminEventLogs
		})}\n`
	);
}

async function prepare(client: PrismaClient, sourceRevision: string) {
	await client.$transaction(
		async transaction => {
			const state = await lockState(transaction);
			assertCoreOwnership(state.ownership);
			if (
				state.preparedRevision &&
				state.preparedRevision !== sourceRevision
			) {
				throw new OperationsCoreCutoverError(
					'Operations Core is prepared for another revision'
				);
			}
			if (state.preparedRevision === sourceRevision) return;
			await transaction.operationsCoreState.update({
				where: { id: 'singleton' },
				data: {
					preparedRevision: sourceRevision,
					generation: { increment: 1 }
				}
			});
		},
		{ isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
	);
	process.stdout.write(`${JSON.stringify({ prepared: true })}\n`);
}

async function fence(client: PrismaClient, sourceRevision: string) {
	await client.$transaction(
		async transaction => {
			const state = await lockState(transaction);
			assertCoreOwnership(state.ownership);
			if (state.preparedRevision !== sourceRevision) {
				throw new OperationsCoreCutoverError(
					'Operations Core must be prepared for this revision'
				);
			}
			if (!state.sourceWritesEnabled) return;
			await transaction.operationsCoreState.update({
				where: { id: 'singleton' },
				data: {
					sourceWritesEnabled: false,
					fencedAt: new Date(),
					generation: { increment: 1 }
				}
			});
		},
		{ isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
	);
	process.stdout.write(`${JSON.stringify({ fenced: true })}\n`);
}

async function exportSnapshot(
	client: PrismaClient,
	sourceRevision: string,
	file: string
) {
	const snapshot = await client.$transaction(
		async transaction => {
			const state = await lockState(transaction);
			assertCoreOwnership(state.ownership);
			if (
				state.preparedRevision !== sourceRevision ||
				state.sourceWritesEnabled ||
				!state.fencedAt
			) {
				throw new OperationsCoreCutoverError(
					'Operations Core source must be prepared and fenced before export'
				);
			}
			const [notes, adminEventLogs] = await Promise.all([
				transaction.note.findMany({ orderBy: { id: 'asc' } }),
				transaction.adminEventLog.findMany({
					orderBy: [{ createdAt: 'asc' }, { id: 'asc' }]
				})
			]);
			return {
				schemaVersion: 1 as const,
				sourceRevision,
				createdAt: new Date().toISOString(),
				counts: {
					notes: notes.length,
					adminEventLogs: adminEventLogs.length
				},
				notes,
				adminEventLogs
			};
		},
		{ isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
	);
	const body = `${JSON.stringify(snapshot)}\n`;
	const sha256 = createHash('sha256').update(body).digest('hex');
	const handle = await open(
		file,
		constants.O_CREAT |
			constants.O_EXCL |
			constants.O_WRONLY |
			constants.O_NOFOLLOW,
		0o600
	);
	try {
		await handle.writeFile(body, 'utf8');
		await handle.sync();
	} finally {
		await handle.close();
	}
	await client.$transaction(
		async transaction => {
			const state = await lockState(transaction);
			assertCoreOwnership(state.ownership);
			if (
				state.preparedRevision !== sourceRevision ||
				state.sourceWritesEnabled
			) {
				throw new OperationsCoreCutoverError(
					'Operations Core source changed while exporting'
				);
			}
			if (
				state.sourceSnapshotSha256 &&
				(state.sourceSnapshotSha256 !== sha256 ||
					state.sourceNoteCount !== BigInt(snapshot.counts.notes) ||
					state.sourceEventCount !==
						BigInt(snapshot.counts.adminEventLogs))
			) {
				throw new OperationsCoreCutoverError(
					'Operations Core already exported another snapshot'
				);
			}
			await transaction.operationsCoreState.update({
				where: { id: 'singleton' },
				data: {
					sourceSnapshotSha256: sha256,
					sourceNoteCount: BigInt(snapshot.counts.notes),
					sourceEventCount: BigInt(snapshot.counts.adminEventLogs),
					exportedAt: state.exportedAt || new Date()
				}
			});
		},
		{ isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
	);
	process.stdout.write(
		`${JSON.stringify({
			exported: true,
			sha256,
			notes: snapshot.counts.notes,
			events: snapshot.counts.adminEventLogs
		})}\n`
	);
}

async function activate(
	client: PrismaClient,
	sourceRevision: string,
	sha256: string,
	notes: number,
	events: number
) {
	await client.$transaction(
		async transaction => {
			const state = await lockState(transaction);
			if (state.ownership === OperationsCoreOwnership.OPERATIONS) {
				if (
					state.ownershipRevision === sourceRevision &&
					state.sourceSnapshotSha256 === sha256
				) {
					return;
				}
				throw new OperationsCoreCutoverError(
					'Operations ownership is active for another snapshot'
				);
			}
			if (
				state.preparedRevision !== sourceRevision ||
				state.sourceSnapshotSha256 !== sha256 ||
				state.sourceNoteCount !== BigInt(notes) ||
				state.sourceEventCount !== BigInt(events) ||
				state.sourceWritesEnabled ||
				!state.exportedAt
			) {
				throw new OperationsCoreCutoverError(
					'Operations activation does not match the fenced export'
				);
			}
			await transaction.operationsCoreState.update({
				where: { id: 'singleton' },
				data: {
					ownership: OperationsCoreOwnership.OPERATIONS,
					legacyRoutesEnabled: false,
					ownershipRevision: sourceRevision,
					activatedAt: new Date(),
					generation: { increment: 1 }
				}
			});
		},
		{ isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
	);
	process.stdout.write(`${JSON.stringify({ active: true, sha256 })}\n`);
}

export async function runOperationsCoreCutover(
	argv: readonly string[],
	client = new PrismaClient({
		datasourceUrl:
			process.env.DATABASE_URL_PRODUCTION || process.env.DATABASE_URL
	})
): Promise<void> {
	const args = parseOperationsCoreCutoverArgs(argv);
	try {
		if (args.action === 'status') return await status(client);
		if (args.action === 'prepare') {
			return await prepare(client, args.revision!);
		}
		if (args.action === 'fence') {
			return await fence(client, args.revision!);
		}
		if (args.action === 'export') {
			return await exportSnapshot(client, args.revision!, args.file!);
		}
		await activate(
			client,
			args.revision!,
			args.sha256!,
			args.notes!,
			args.events!
		);
	} finally {
		await client.$disconnect();
	}
}

if (require.main === module) {
	runOperationsCoreCutover(process.argv.slice(2)).catch(error => {
		const message =
			error instanceof OperationsCoreCutoverError
				? error.message
				: 'Operations Core cutover command failed';
		process.stderr.write(`${message}\n`);
		process.exitCode = 1;
	});
}
