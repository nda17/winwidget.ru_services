import {
	OperationsDatabasePhase,
	PrismaClient
} from '@prisma/operations-client';
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import {
	OPERATIONS_NOTIFICATION_ROUTING_CHANGED_EVENT_TYPE,
	OPERATIONS_NOTIFICATION_ROUTING_CHANGED_ROUTING_KEY
} from '../messaging/operations-messaging.constants';
import { ensureSchedulesSeparated } from '../telegram/telegram-settings.service';

const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;
const SHA_PATTERN = /^[0-9a-f]{64}$/;
const REVISION_PATTERN = /^[0-9a-f]{40}$/;
const UUID_PATTERN =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface OperationsControlPlaneSnapshot {
	schemaVersion: 1;
	sourceRevision: string;
	createdAt: string;
	telegramBotSettings: {
		dailySummaryChatId: string;
		databaseBackupThreadId: number | null;
		paymentsThreadId: number | null;
		operationalAlertsThreadId: number | null;
		databaseBackupEnabled: boolean;
		databaseBackupTime: string;
		databaseBackupLastSentPeriodStart: string | null;
		databaseBackupLastSentAt: string | null;
	};
	reportingSchedulePolicy: {
		reservationTime: string;
		reservationGeneration: string;
		confirmedChangeId: string | null;
		pendingChangeId: string | null;
		pendingTime: string | null;
		pendingGeneration: string | null;
	};
}

export function parseControlPlaneSnapshot(
	value: unknown
): OperationsControlPlaneSnapshot {
	const root = exactRecord(value, [
		'schemaVersion',
		'sourceRevision',
		'createdAt',
		'telegramBotSettings',
		'reportingSchedulePolicy'
	]);
	if (
		root.schemaVersion !== 1 ||
		typeof root.sourceRevision !== 'string' ||
		!REVISION_PATTERN.test(root.sourceRevision) ||
		!iso(root.createdAt)
	) {
		throw new Error('Control-plane snapshot header is invalid');
	}
	const telegram = exactRecord(root.telegramBotSettings, [
		'dailySummaryChatId',
		'databaseBackupThreadId',
		'paymentsThreadId',
		'operationalAlertsThreadId',
		'databaseBackupEnabled',
		'databaseBackupTime',
		'databaseBackupLastSentPeriodStart',
		'databaseBackupLastSentAt'
	]);
	const threadIds = [
		telegram.databaseBackupThreadId,
		telegram.paymentsThreadId,
		telegram.operationalAlertsThreadId
	];
	if (
		typeof telegram.dailySummaryChatId !== 'string' ||
		telegram.dailySummaryChatId.length > 100 ||
		typeof telegram.databaseBackupEnabled !== 'boolean' ||
		typeof telegram.databaseBackupTime !== 'string' ||
		!TIME_PATTERN.test(telegram.databaseBackupTime) ||
		threadIds.some(
			item =>
				item !== null && (!Number.isSafeInteger(item) || Number(item) < 1)
		) ||
		!nullableIso(telegram.databaseBackupLastSentPeriodStart) ||
		!nullableIso(telegram.databaseBackupLastSentAt)
	) {
		throw new Error('Telegram settings snapshot is invalid');
	}
	const chatId = telegram.dailySummaryChatId.trim();
	if (
		(!chatId && threadIds.some(item => item !== null)) ||
		(telegram.databaseBackupEnabled &&
			(!chatId || telegram.databaseBackupThreadId === null))
	) {
		throw new Error('Telegram settings snapshot is inconsistent');
	}
	const policy = exactRecord(root.reportingSchedulePolicy, [
		'reservationTime',
		'reservationGeneration',
		'confirmedChangeId',
		'pendingChangeId',
		'pendingTime',
		'pendingGeneration'
	]);
	if (
		typeof policy.reservationTime !== 'string' ||
		!TIME_PATTERN.test(policy.reservationTime) ||
		typeof policy.reservationGeneration !== 'string' ||
		!/^(?:0|[1-9]\d*)$/.test(policy.reservationGeneration) ||
		!nullableUuid(policy.confirmedChangeId) ||
		!nullableUuid(policy.pendingChangeId) ||
		(policy.pendingTime !== null &&
			(typeof policy.pendingTime !== 'string' ||
				!TIME_PATTERN.test(policy.pendingTime))) ||
		(policy.pendingGeneration !== null &&
			(typeof policy.pendingGeneration !== 'string' ||
				!/^(?:0|[1-9]\d*)$/.test(policy.pendingGeneration))) ||
		(policy.pendingChangeId === null) !== (policy.pendingTime === null) ||
		(policy.pendingTime === null) !== (policy.pendingGeneration === null)
	) {
		throw new Error('Reporting schedule policy snapshot is invalid');
	}
	ensureSchedulesSeparated(
		policy.reservationTime,
		telegram.databaseBackupTime
	);
	if (policy.pendingTime !== null) {
		ensureSchedulesSeparated(
			policy.pendingTime as string,
			telegram.databaseBackupTime
		);
	}
	return {
		schemaVersion: 1,
		sourceRevision: root.sourceRevision,
		createdAt: root.createdAt as string,
		telegramBotSettings: {
			dailySummaryChatId: telegram.dailySummaryChatId,
			databaseBackupThreadId: telegram.databaseBackupThreadId as
				| number
				| null,
			paymentsThreadId: telegram.paymentsThreadId as number | null,
			operationalAlertsThreadId: telegram.operationalAlertsThreadId as
				| number
				| null,
			databaseBackupEnabled: telegram.databaseBackupEnabled,
			databaseBackupTime: telegram.databaseBackupTime,
			databaseBackupLastSentPeriodStart:
				telegram.databaseBackupLastSentPeriodStart as string | null,
			databaseBackupLastSentAt: telegram.databaseBackupLastSentAt as
				| string
				| null
		},
		reportingSchedulePolicy: {
			reservationTime: policy.reservationTime,
			reservationGeneration: policy.reservationGeneration,
			confirmedChangeId: policy.confirmedChangeId as string | null,
			pendingChangeId: policy.pendingChangeId as string | null,
			pendingTime: policy.pendingTime as string | null,
			pendingGeneration: policy.pendingGeneration as string | null
		}
	};
}

async function main(): Promise<void> {
	const [, , fileFlag, file, shaFlag, expectedSha] = process.argv;
	if (
		fileFlag !== '--file' ||
		!file ||
		!isAbsolute(file) ||
		shaFlag !== '--sha256' ||
		!expectedSha ||
		!SHA_PATTERN.test(expectedSha)
	) {
		throw new Error(
			'control-plane bootstrap requires --file <absolute-path> --sha256 <hex>'
		);
	}
	const handle = await open(
		file,
		constants.O_RDONLY | constants.O_NOFOLLOW
	);
	let body: string;
	try {
		const stats = await handle.stat();
		if (!stats.isFile() || stats.size < 2 || stats.size > 128 * 1024) {
			throw new Error('Control-plane snapshot size is invalid');
		}
		body = await handle.readFile('utf8');
	} finally {
		await handle.close();
	}
	const sha256 = createHash('sha256').update(body).digest('hex');
	if (sha256 !== expectedSha) throw new Error('Snapshot SHA-256 mismatch');
	const snapshot = parseControlPlaneSnapshot(JSON.parse(body));
	const databaseUrl = process.env.OPERATIONS_DATABASE_URL?.trim();
	if (!databaseUrl) throw new Error('OPERATIONS_DATABASE_URL is required');
	const client = new PrismaClient({
		datasources: { db: { url: databaseUrl } }
	});
	try {
		await client.$transaction(async transaction => {
			const ownership =
				await transaction.operationsOwnershipState.findUniqueOrThrow({
					where: { id: 'singleton' }
				});
			if (ownership.phase !== OperationsDatabasePhase.ACTIVE) {
				throw new Error(
					'Operations ownership must be ACTIVE before bootstrap'
				);
			}
			const existing =
				await transaction.operationsControlPlaneBootstrapState.findUnique({
					where: { id: 'singleton' }
				});
			if (existing) {
				if (
					existing.sourceSha256 === sha256 &&
					existing.sourceRevision === snapshot.sourceRevision
				) {
					return;
				}
				throw new Error(
					'Control-plane bootstrap already completed differently'
				);
			}
			const [settings, policy] = await Promise.all([
				transaction.telegramBotSettings.findUniqueOrThrow({
					where: { id: 'singleton' }
				}),
				transaction.reportingSchedulePolicy.findUniqueOrThrow({
					where: { id: 'singleton' }
				})
			]);
			if (
				settings.dailySummaryChatId ||
				settings.databaseBackupThreadId ||
				settings.paymentsThreadId ||
				settings.operationalAlertsThreadId ||
				settings.databaseBackupEnabled !== true ||
				settings.databaseBackupTime !== '01:45' ||
				settings.databaseBackupLastSentPeriodStart ||
				settings.databaseBackupLastSentAt ||
				policy.reservationGeneration !== 0n ||
				policy.reservationTime !== '01:50' ||
				policy.confirmedChangeId ||
				policy.pendingChangeId ||
				policy.pendingTime ||
				policy.pendingGeneration !== null
			) {
				throw new Error('Control-plane target is not pristine');
			}
			await transaction.telegramBotSettings.update({
				where: { id: 'singleton' },
				data: {
					...snapshot.telegramBotSettings,
					databaseBackupLastSentPeriodStart: snapshot.telegramBotSettings
						.databaseBackupLastSentPeriodStart
						? new Date(
								snapshot.telegramBotSettings
									.databaseBackupLastSentPeriodStart
							)
						: null,
					databaseBackupLastSentAt: snapshot.telegramBotSettings
						.databaseBackupLastSentAt
						? new Date(
								snapshot.telegramBotSettings.databaseBackupLastSentAt
							)
						: null
				}
			});
			await transaction.reportingSchedulePolicy.update({
				where: { id: 'singleton' },
				data: {
					reservationTime:
						snapshot.reportingSchedulePolicy.reservationTime,
					reservationGeneration: BigInt(
						snapshot.reportingSchedulePolicy.reservationGeneration
					),
					confirmedChangeId:
						snapshot.reportingSchedulePolicy.confirmedChangeId,
					pendingChangeId:
						snapshot.reportingSchedulePolicy.pendingChangeId,
					pendingTime: snapshot.reportingSchedulePolicy.pendingTime,
					pendingGeneration:
						snapshot.reportingSchedulePolicy.pendingGeneration === null
							? null
							: BigInt(snapshot.reportingSchedulePolicy.pendingGeneration)
				}
			});
			const routingEventId = randomUUID();
			await transaction.outboxEvent.create({
				data: {
					eventId: routingEventId,
					messageId: routingEventId,
					deduplicationKey: `operations-control-bootstrap-routing:${sha256}`,
					eventType: OPERATIONS_NOTIFICATION_ROUTING_CHANGED_EVENT_TYPE,
					aggregateType: 'telegram-bot-settings',
					aggregateId: 'singleton',
					routingKey: OPERATIONS_NOTIFICATION_ROUTING_CHANGED_ROUTING_KEY,
					payload: {
						schemaVersion: 1,
						eventId: routingEventId,
						operationalAlertsThreadId:
							snapshot.telegramBotSettings.operationalAlertsThreadId,
						changedAt: snapshot.createdAt
					},
					headers: {}
				}
			});
			await transaction.operationsControlPlaneBootstrapState.create({
				data: {
					sourceRevision: snapshot.sourceRevision,
					sourceSha256: sha256
				}
			});
		});
		process.stdout.write(
			JSON.stringify({
				imported: true,
				sourceRevision: snapshot.sourceRevision
			}) + '\n'
		);
	} finally {
		await client.$disconnect();
	}
}

function exactRecord(
	value: unknown,
	expectedKeys: readonly string[]
): Record<string, unknown> {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		throw new Error('Snapshot object is invalid');
	}
	const record = value as Record<string, unknown>;
	const actual = Object.keys(record).sort();
	const expected = [...expectedKeys].sort();
	if (
		actual.length !== expected.length ||
		!actual.every((key, index) => key === expected[index])
	) {
		throw new Error('Snapshot contains unexpected fields');
	}
	return record;
}

function iso(value: unknown): value is string {
	return (
		typeof value === 'string' &&
		Number.isFinite(Date.parse(value)) &&
		new Date(value).toISOString() === value
	);
}

function nullableIso(value: unknown): value is string | null {
	return value === null || iso(value);
}

function nullableUuid(value: unknown): value is string | null {
	return (
		value === null ||
		(typeof value === 'string' && UUID_PATTERN.test(value))
	);
}

if (require.main === module) {
	void main().catch(error => {
		process.stderr.write(
			`${error instanceof Error ? error.message : String(error)}\n`
		);
		process.exitCode = 1;
	});
}
