import {
	BillingOwnershipPhase,
	OutboxStatus,
	Prisma,
	PrismaClient,
	ProviderOperationStatus,
	ServiceDatabasePhase
} from '@prisma/billing-client';
import {
	chmod,
	lstat,
	open,
	readFile,
	realpath,
	rename,
	stat,
	unlink
} from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import {
	BILLING_EVENT_TYPES,
	BILLING_EVENTS_EXCHANGE
} from './messaging/billing-messaging.constants';
import {
	parseFrozenBillingSnapshot,
	type AggregateContinuityRow,
	type FrozenBillingSnapshot
} from './cutover/frozen-snapshot';
import { billingCommandRequestHash } from './domain/billing-command-idempotency';

type Action =
	| 'status'
	| 'import-frozen'
	| 'verify-import'
	| 'seed-core-read-events'
	| 'activate'
	| 'complete';

interface CliOptions {
	action: Action;
	evidenceFile: string;
	snapshotFile?: string;
	revision?: string;
	generation?: bigint;
}

interface Evidence {
	schemaVersion: 1;
	service: 'billing-service';
	action: Action;
	status: 'ok' | 'failed';
	revision: string | null;
	generation: string | null;
	observedAt: string;
	ownership: Record<string, unknown> | null;
	sourceFingerprint: string | null;
	counts: Record<string, number>;
	eventTypes: Record<
		string,
		{ sourceRows: number; eventsEnqueued: number }
	>;
	tableFingerprints?: Record<string, string>;
	errorCode?: string;
	errorSafe?: string;
}

interface ImportSpec {
	property: keyof FrozenBillingSnapshot;
	delegate: string;
	key: string;
	fields: readonly string[];
	dates: readonly string[];
	bigints?: readonly string[];
}

const MUTATING_ACTIONS = new Set<Action>([
	'import-frozen',
	'seed-core-read-events',
	'activate',
	'complete'
]);
const SNAPSHOT_ACTIONS = new Set<Action>([
	'import-frozen',
	'verify-import'
]);
const REVISION_PATTERN = /^[0-9a-f]{40}$/i;
const DECIMAL_PATTERN = /^[1-9]\d*$/;
const SEED_PREFIX = 'cutover-seed:';
const REQUIRED_SEED_EVENT_TYPES = [
	BILLING_EVENT_TYPES.paymentDetailsChanged,
	BILLING_EVENT_TYPES.subscriptionDetailsChanged,
	BILLING_EVENT_TYPES.affiliateChanged,
	BILLING_EVENT_TYPES.settingsChanged
] as const;

const IMPORT_SPECS: readonly ImportSpec[] = [
	{
		property: 'identity',
		delegate: 'identityContactProjection',
		key: 'userId',
		fields: [
			'userId',
			'name',
			'email',
			'phone',
			'status',
			'roles',
			'telegramChatId',
			'telegramChannelActive',
			'deletedAt',
			'tombstone',
			'projectionVersion',
			'sourceSequence',
			'lastEventId',
			'sourceCreatedAt',
			'sourceUpdatedAt',
			'createdAt',
			'updatedAt'
		],
		dates: [
			'deletedAt',
			'sourceCreatedAt',
			'sourceUpdatedAt',
			'createdAt',
			'updatedAt'
		],
		bigints: ['projectionVersion', 'sourceSequence']
	},
	{
		property: 'notificationRouting',
		delegate: 'notificationRoutingProjection',
		key: 'id',
		fields: [
			'id',
			'telegramChatId',
			'paymentsThreadId',
			'projectionVersion',
			'sourceSequence',
			'tombstone',
			'lastEventId',
			'sourceUpdatedAt',
			'createdAt',
			'updatedAt'
		],
		dates: ['sourceUpdatedAt', 'createdAt', 'updatedAt'],
		bigints: ['projectionVersion', 'sourceSequence']
	},
	{
		property: 'payments',
		delegate: 'payment',
		key: 'id',
		fields: [
			'id',
			'userId',
			'yookassaId',
			'providerIdempotencyKey',
			'recurringCycleKey',
			'recurringAttempt',
			'kind',
			'amount',
			'currency',
			'confirmationUrl',
			'status',
			'providerStatus',
			'plan',
			'billingPeriod',
			'autoRenew',
			'consentVersion',
			'consentText',
			'consentedAt',
			'consentIp',
			'consentUserAgent',
			'offerSnapshot',
			'offerSha256',
			'offerUpdatedAt',
			'customerEmail',
			'customerPhone',
			'paymentMethodCiphertext',
			'providerCreatedAt',
			'checkoutExpiresAt',
			'providerExpiresAt',
			'lastProviderCheckedAt',
			'succeededAt',
			'cancelledAt',
			'cancellationReason',
			'receiptSyncEligible',
			'providerSnapshot',
			'aggregateVersion',
			'sourceSequence',
			'createdAt',
			'updatedAt'
		],
		dates: [
			'consentedAt',
			'offerUpdatedAt',
			'providerCreatedAt',
			'checkoutExpiresAt',
			'providerExpiresAt',
			'lastProviderCheckedAt',
			'succeededAt',
			'cancelledAt',
			'createdAt',
			'updatedAt'
		],
		bigints: ['aggregateVersion', 'sourceSequence']
	},
	{
		property: 'paymentReceipts',
		delegate: 'paymentReceipt',
		key: 'id',
		fields: [
			'id',
			'paymentId',
			'providerReceiptId',
			'status',
			'type',
			'fiscalDocumentNumber',
			'fiscalStorageNumber',
			'fiscalAttribute',
			'registeredAt',
			'publicUrl',
			'raw',
			'createdAt',
			'updatedAt'
		],
		dates: ['registeredAt', 'createdAt', 'updatedAt']
	},
	{
		property: 'subscriptions',
		delegate: 'subscription',
		key: 'id',
		fields: [
			'id',
			'userId',
			'plan',
			'billingPeriod',
			'status',
			'startsAt',
			'expiresAt',
			'leadsThisPeriod',
			'periodResetsAt',
			'aggregateVersion',
			'sourceSequence',
			'createdAt',
			'updatedAt'
		],
		dates: [
			'startsAt',
			'expiresAt',
			'periodResetsAt',
			'createdAt',
			'updatedAt'
		],
		bigints: ['aggregateVersion', 'sourceSequence']
	},
	{
		property: 'subscriptionHistory',
		delegate: 'subscriptionHistory',
		key: 'id',
		fields: [
			'id',
			'subscriptionId',
			'userId',
			'adminId',
			'action',
			'days',
			'oldExpiresAt',
			'newExpiresAt',
			'targetAudience',
			'targetLabel',
			'affectedUsersCount',
			'createdAt'
		],
		dates: ['oldExpiresAt', 'newExpiresAt', 'createdAt']
	},
	{
		property: 'subscriptionExpiryReminders',
		delegate: 'subscriptionExpiryReminder',
		key: 'id',
		fields: [
			'id',
			'subscriptionId',
			'userId',
			'daysBeforeExpiry',
			'expiresAt',
			'sentTo',
			'status',
			'lockedAt',
			'lockedBy',
			'attempts',
			'availableAt',
			'lastError',
			'sentAt'
		],
		dates: ['expiresAt', 'lockedAt', 'availableAt', 'sentAt']
	},
	{
		property: 'autoRenewals',
		delegate: 'autoRenewal',
		key: 'id',
		fields: [
			'id',
			'userId',
			'status',
			'plan',
			'billingPeriod',
			'amount',
			'pendingAmount',
			'priceChangeDetectedAt',
			'currency',
			'paymentMethodCiphertext',
			'paymentMethodType',
			'paymentMethodTitle',
			'paymentMethodLast4',
			'paymentMethodSavedAt',
			'consentVersion',
			'consentText',
			'consentedAt',
			'offerSnapshot',
			'offerSha256',
			'offerUpdatedAt',
			'nextChargeAt',
			'retryStartedAt',
			'retryAttempt',
			'nextRetryAt',
			'dispatchPending',
			'disabledAt',
			'disableReason',
			'lastChargeAttemptAt',
			'lastChargeErrorCode',
			'stateVersion',
			'createdAt',
			'updatedAt'
		],
		dates: [
			'priceChangeDetectedAt',
			'paymentMethodSavedAt',
			'consentedAt',
			'offerUpdatedAt',
			'nextChargeAt',
			'retryStartedAt',
			'nextRetryAt',
			'disabledAt',
			'lastChargeAttemptAt',
			'createdAt',
			'updatedAt'
		]
	},
	{
		property: 'autoRenewalConsentEvents',
		delegate: 'autoRenewalConsentEvent',
		key: 'id',
		fields: [
			'id',
			'autoRenewalId',
			'userId',
			'type',
			'actorUserId',
			'actorRole',
			'source',
			'reason',
			'consentVersion',
			'consentText',
			'offerSnapshot',
			'offerSha256',
			'offerUpdatedAt',
			'plan',
			'billingPeriod',
			'amount',
			'currency',
			'ip',
			'userAgent',
			'metadata',
			'createdAt'
		],
		dates: ['offerUpdatedAt', 'createdAt']
	},
	{
		property: 'tariffPrices',
		delegate: 'tariffPrice',
		key: 'id',
		fields: [
			'id',
			'plan',
			'billingPeriod',
			'amount',
			'createdAt',
			'updatedAt'
		],
		dates: ['createdAt', 'updatedAt']
	},
	{
		property: 'affiliateReferrals',
		delegate: 'affiliateReferral',
		key: 'id',
		fields: [
			'id',
			'referrerId',
			'referredUserId',
			'firstPaymentId',
			'status',
			'paymentAmount',
			'cashbackPercent',
			'cashbackAmount',
			'availableAt',
			'cancelledAt',
			'paidAt',
			'aggregateVersion',
			'sourceSequence',
			'createdAt',
			'updatedAt'
		],
		dates: [
			'availableAt',
			'cancelledAt',
			'paidAt',
			'createdAt',
			'updatedAt'
		],
		bigints: ['aggregateVersion', 'sourceSequence']
	},
	{
		property: 'integrationDeliveryFailures',
		delegate: 'integrationDeliveryFailure',
		key: 'id',
		fields: [
			'id',
			'eventId',
			'consumer',
			'routingKey',
			'payload',
			'attempt',
			'lastError',
			'category',
			'normalizedCode',
			'safeReason',
			'httpStatus',
			'providerCode',
			'retryable',
			'classificationVersion',
			'firstFailedAt',
			'failedAt',
			'retryingAt',
			'activeRetryToken',
			'resolvedAt',
			'resolution',
			'resolutionComment',
			'resolvedById',
			'errorCode',
			'errorSafe',
			'status',
			'createdAt',
			'updatedAt'
		],
		dates: [
			'firstFailedAt',
			'failedAt',
			'retryingAt',
			'resolvedAt',
			'createdAt',
			'updatedAt'
		]
	},
	{
		property: 'integrationDeliveryReceipts',
		delegate: 'integrationDeliveryReceipt',
		key: 'id',
		fields: [
			'id',
			'eventId',
			'consumer',
			'status',
			'lockedAt',
			'deliveredAt',
			'attempt',
			'retryAvailableAt',
			'retryToken',
			'createdAt'
		],
		dates: ['lockedAt', 'deliveredAt', 'retryAvailableAt', 'createdAt']
	}
];

async function main(): Promise<void> {
	let options: CliOptions | null = null;
	let prisma: PrismaClient | null = null;
	try {
		options = parseArgs(process.argv.slice(2));
		if (!process.env.BILLING_DATABASE_URL?.trim()) {
			throw new Error('BILLING_DATABASE_URL_MISSING');
		}
		prisma = new PrismaClient();
		const evidence = await execute(prisma, options);
		await writeEvidence(options.evidenceFile, evidence);
		process.stdout.write(`${JSON.stringify(evidence)}\n`);
	} catch (error) {
		const errorCode = safeCode(error);
		const evidence = failureEvidence(options, errorCode);
		if (options?.evidenceFile) {
			await writeEvidence(options.evidenceFile, evidence).catch(
				() => undefined
			);
		}
		process.stderr.write(`${JSON.stringify(evidence)}\n`);
		process.exitCode = 1;
	} finally {
		await prisma?.$disconnect().catch(() => undefined);
	}
}

async function execute(
	prisma: PrismaClient,
	options: CliOptions
): Promise<Evidence> {
	switch (options.action) {
		case 'status':
			return statusEvidence(prisma, options.action);
		case 'import-frozen':
			return importFrozen(prisma, options);
		case 'verify-import':
			return verifyImport(prisma, options);
		case 'seed-core-read-events':
			return seedCoreReadEvents(prisma, options);
		case 'activate':
			return transition(prisma, options, BillingOwnershipPhase.ACTIVE);
		case 'complete':
			return transition(prisma, options, BillingOwnershipPhase.COMPLETE);
	}
}

async function importFrozen(
	prisma: PrismaClient,
	options: CliOptions
): Promise<Evidence> {
	const snapshot = await loadSnapshot(options);
	assertSnapshotArgs(snapshot, options);
	const continuity = continuityMap(snapshot);
	const existingMarker = await prisma.billingOwnershipMarker.findUnique({
		where: { id: 'singleton' }
	});
	if (existingMarker) {
		assertMarker(existingMarker, options);
		if (
			existingMarker.phase !== BillingOwnershipPhase.PREPARED ||
			existingMarker.sourceFingerprint !== snapshot.sourceFingerprint
		) {
			throw new Error('IMPORT_AFTER_PREPARED_FORBIDDEN');
		}
		return verifyImport(prisma, options);
	}
	await prisma.$transaction(
		async transaction => {
			const marker = await transaction.billingOwnershipMarker.findUnique({
				where: { id: 'singleton' }
			});
			if (marker) throw new Error('CONCURRENT_IMPORT_DETECTED');
			const existing = await Promise.all([
				transaction.payment.count(),
				transaction.paymentReceipt.count(),
				transaction.subscription.count(),
				transaction.subscriptionHistory.count(),
				transaction.subscriptionExpiryReminder.count(),
				transaction.autoRenewal.count(),
				transaction.autoRenewalConsentEvent.count(),
				transaction.tariffPrice.count(),
				transaction.affiliateReferral.count(),
				transaction.integrationDeliveryFailure.count({
					where: { consumer: 'auto-renewal-charge' }
				}),
				transaction.integrationDeliveryReceipt.count({
					where: { consumer: 'auto-renewal-charge' }
				})
			]);
			if (existing.some(count => count > 0))
				throw new Error('TARGET_BILLING_DATA_NOT_EMPTY');
			for (const spec of IMPORT_SPECS) {
				for (const source of snapshot[spec.property] as Record<
					string,
					unknown
				>[]) {
					const row = convertRow(source, spec);
					applyContinuity(row, spec.property, continuity);
					await upsertDynamic(transaction, spec.delegate, spec.key, row);
				}
			}
			const offerContinuity = continuity.get('billing.offer:offer');
			if (!offerContinuity)
				throw new Error(
					'SNAPSHOT_AGGREGATE_CONTINUITY_MISSING_billing.offer'
				);
			const offer = snapshot.offer;
			await transaction.billingOfferProjection.upsert({
				where: { id: 'offer' },
				create: {
					id: 'offer',
					content: String(offer.content),
					sha256: String(offer.sha256),
					consentVersion: String(offer.consentVersion),
					consentText: String(offer.consentText),
					sourceUpdatedAt: new Date(String(offer.updatedAt)),
					projectionVersion: BigInt(offerContinuity.aggregateVersion),
					sourceSequence: BigInt(offerContinuity.lastSourceSequence),
					tombstone: false
				},
				update: {}
			});
			if (snapshot.settings) {
				const row = convertSettings(snapshot);
				applyContinuity(row, 'settings', continuity);
				await transaction.billingSettings.upsert({
					where: { id: 'singleton' },
					create: row as Prisma.BillingSettingsUncheckedCreateInput,
					update: row as Prisma.BillingSettingsUncheckedUpdateInput
				});
			}
			await transaction.billingSourceSequence.upsert({
				where: { id: 'billing' },
				create: {
					id: 'billing',
					nextValue: BigInt(snapshot.continuity.nextSourceSequence)
				},
				update: {
					nextValue: BigInt(snapshot.continuity.nextSourceSequence)
				}
			});
			await transaction.serviceIdentity.upsert({
				where: { id: 'singleton' },
				create: {
					id: 'singleton',
					serviceName: 'billing-service',
					phase: ServiceDatabasePhase.IMPORTED,
					ownershipGeneration: options.generation!,
					sourceFingerprint: snapshot.sourceFingerprint,
					sourceSnapshot: snapshotSummary(snapshot),
					sourceHighWatermark: BigInt(snapshot.continuity.maxHighWater),
					importedAt: new Date()
				},
				update: {
					phase: ServiceDatabasePhase.IMPORTED,
					ownershipGeneration: options.generation!,
					sourceFingerprint: snapshot.sourceFingerprint,
					sourceSnapshot: snapshotSummary(snapshot),
					sourceHighWatermark: BigInt(snapshot.continuity.maxHighWater),
					importedAt: new Date()
				}
			});
			await transaction.billingOwnershipMarker.upsert({
				where: { id: 'singleton' },
				create: {
					id: 'singleton',
					phase: BillingOwnershipPhase.PREPARED,
					generation: options.generation!,
					preparedRevision: options.revision!,
					sourceCutoff: new Date(snapshot.sourceCutoff),
					sourceHighWatermark: BigInt(snapshot.continuity.maxHighWater),
					sourceFingerprint: snapshot.sourceFingerprint
				},
				update: {}
			});
		},
		{
			isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
			timeout: 120_000
		}
	);
	return statusEvidence(prisma, options.action);
}

async function verifyImport(
	prisma: PrismaClient,
	options: CliOptions
): Promise<Evidence> {
	const snapshot = await loadSnapshot(options);
	assertSnapshotArgs(snapshot, options);
	const marker = await prisma.billingOwnershipMarker.findUnique({
		where: { id: 'singleton' }
	});
	if (!marker) throw new Error('OWNERSHIP_MARKER_MISSING');
	assertMarker(marker, options);
	if (marker.sourceFingerprint !== snapshot.sourceFingerprint)
		throw new Error('IMPORT_FINGERPRINT_MISMATCH');
	const counts = await canonicalCounts(prisma);
	const expected = snapshotCounts(snapshot);
	for (const [key, count] of Object.entries(expected)) {
		if ((counts[key] || 0) !== count)
			throw new Error(`IMPORT_COUNT_MISMATCH_${key}`);
	}
	const verification = await verifyCanonicalImport(prisma, snapshot);
	const evidence = await statusEvidence(prisma, options.action);
	evidence.tableFingerprints = verification.tableFingerprints;
	evidence.counts.relationshipViolations =
		verification.relationshipViolations;
	evidence.counts.continuityViolations = verification.continuityViolations;
	return evidence;
}

async function seedCoreReadEvents(
	prisma: PrismaClient,
	options: CliOptions
): Promise<Evidence> {
	const marker = await requireMarker(
		prisma,
		options,
		BillingOwnershipPhase.PREPARED
	);
	const enqueued: Record<
		string,
		{ sourceRows: number; eventsEnqueued: number }
	> = {};
	let seedPendingOutboxAtCommit = 0;
	await prisma.$transaction(
		async transaction => {
			const payments = await transaction.payment.findMany({
				orderBy: { id: 'asc' }
			});
			const subscriptions = await transaction.subscription.findMany({
				orderBy: { id: 'asc' }
			});
			const affiliates = await transaction.affiliateReferral.findMany({
				orderBy: { id: 'asc' }
			});
			const settings = await transaction.billingSettings.findUnique({
				where: { id: 'singleton' }
			});
			if (!settings) throw new Error('SETTINGS_SINGLETON_MISSING');
			enqueued[BILLING_EVENT_TYPES.paymentDetailsChanged] = await seedRows(
				transaction,
				marker.sourceFingerprint,
				BILLING_EVENT_TYPES.paymentDetailsChanged,
				'billing.payment',
				payments,
				paymentDetailsState
			);
			enqueued[BILLING_EVENT_TYPES.subscriptionDetailsChanged] =
				await seedRows(
					transaction,
					marker.sourceFingerprint,
					BILLING_EVENT_TYPES.subscriptionDetailsChanged,
					'billing.subscription',
					subscriptions,
					subscriptionDetailsState
				);
			for (const affiliate of affiliates) {
				if (affiliate.aggregateVersion === 0n) {
					await transaction.$executeRaw(
						Prisma.sql`UPDATE "billing"."affiliate_referrals" SET "aggregate_version" = 1 WHERE "id" = ${affiliate.id}`
					);
					affiliate.aggregateVersion = 1n;
				}
			}
			enqueued[BILLING_EVENT_TYPES.affiliateChanged] = await seedRows(
				transaction,
				marker.sourceFingerprint,
				BILLING_EVENT_TYPES.affiliateChanged,
				'billing.affiliate',
				affiliates,
				affiliateState
			);
			enqueued[BILLING_EVENT_TYPES.settingsChanged] = await seedRows(
				transaction,
				marker.sourceFingerprint,
				BILLING_EVENT_TYPES.settingsChanged,
				'billing.settings',
				[settings],
				settingsState
			);
			for (const eventType of REQUIRED_SEED_EVENT_TYPES) {
				const commandId = seedCompletionId(
					marker.sourceFingerprint,
					eventType
				);
				await transaction.billingCommandReceipt.upsert({
					where: { commandId },
					create: {
						commandId,
						commandType: 'CUTOVER_SEED_COMPLETE',
						requestHash: billingCommandRequestHash(
							'CUTOVER_SEED_COMPLETE',
							{
								commandId,
								sourceFingerprint: marker.sourceFingerprint,
								eventType
							}
						),
						requestHashVersion: 1,
						result: {
							eventType,
							sourceRows: enqueued[eventType].sourceRows,
							eventsEnqueued: enqueued[eventType].eventsEnqueued
						}
					},
					update: {}
				});
			}
			seedPendingOutboxAtCommit = await transaction.outboxEvent.count({
				where: {
					deduplicationKey: {
						startsWith: `${SEED_PREFIX}${marker.sourceFingerprint}:`
					},
					status: { not: OutboxStatus.PUBLISHED }
				}
			});
		},
		{
			isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
			timeout: 120_000
		}
	);
	const evidence = await statusEvidence(prisma, options.action);
	evidence.eventTypes = enqueued;
	evidence.counts.seedPendingOutboxAtCommit = seedPendingOutboxAtCommit;
	return evidence;
}

async function transition(
	prisma: PrismaClient,
	options: CliOptions,
	target: BillingOwnershipPhase
): Promise<Evidence> {
	await prisma.$transaction(
		async transaction => {
			const marker = await transaction.billingOwnershipMarker.findUnique({
				where: { id: 'singleton' }
			});
			if (!marker) throw new Error('OWNERSHIP_MARKER_MISSING');
			assertMarker(marker, options);
			if (
				marker.phase === target ||
				(target === BillingOwnershipPhase.ACTIVE &&
					marker.phase === BillingOwnershipPhase.COMPLETE)
			)
				return;
			if (target === BillingOwnershipPhase.ACTIVE) {
				if (marker.phase !== BillingOwnershipPhase.PREPARED)
					throw new Error('OWNERSHIP_TRANSITION_INVALID');
				const pending = await transaction.outboxEvent.count({
					where: {
						deduplicationKey: { startsWith: SEED_PREFIX },
						status: { not: OutboxStatus.PUBLISHED }
					}
				});
				if (pending !== 0) throw new Error('SEED_OUTBOX_NOT_DRAINED');
				for (const eventType of REQUIRED_SEED_EVENT_TYPES) {
					const completion =
						await transaction.billingCommandReceipt.findUnique({
							where: {
								commandId: seedCompletionId(
									marker.sourceFingerprint,
									eventType
								)
							}
						});
					if (
						!completion ||
						completion.commandType !== 'CUTOVER_SEED_COMPLETE'
					) {
						throw new Error(
							`SEED_COMPLETION_MISSING_${eventType.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`
						);
					}
					const result = completion.result as Record<string, unknown>;
					const sourceRows = result.sourceRows;
					if (
						!Number.isSafeInteger(sourceRows) ||
						Number(sourceRows) < 0
					) {
						throw new Error('SEED_COMPLETION_INVALID');
					}
					const durableEvents = await transaction.outboxEvent.count({
						where: {
							eventType,
							deduplicationKey: {
								startsWith: `${SEED_PREFIX}${marker.sourceFingerprint}:${eventType}:`
							}
						}
					});
					if (durableEvents !== sourceRows)
						throw new Error('SEED_EVENT_COUNT_MISMATCH');
				}
				await transaction.billingOwnershipMarker.update({
					where: { id: 'singleton' },
					data: {
						phase: target,
						ownershipRevision: options.revision!,
						activatedAt: new Date()
					}
				});
				await transaction.serviceIdentity.update({
					where: { id: 'singleton' },
					data: {
						phase: ServiceDatabasePhase.ACTIVE,
						activatedAt: new Date()
					}
				});
			} else {
				if (marker.phase !== BillingOwnershipPhase.ACTIVE)
					throw new Error('OWNERSHIP_TRANSITION_INVALID');
				await transaction.billingOwnershipMarker.update({
					where: { id: 'singleton' },
					data: {
						phase: target,
						cleanupRevision: options.revision!,
						completedAt: new Date()
					}
				});
			}
		},
		{ isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
	);
	return statusEvidence(prisma, options.action);
}

async function statusEvidence(
	prisma: PrismaClient,
	action: Action
): Promise<Evidence> {
	const [
		marker,
		identity,
		counts,
		pendingOutbox,
		providerOperationsInFlight
	] = await Promise.all([
		prisma.billingOwnershipMarker.findUnique({
			where: { id: 'singleton' }
		}),
		prisma.serviceIdentity.findUnique({ where: { id: 'singleton' } }),
		canonicalCounts(prisma),
		prisma.outboxEvent.count({
			where: { status: { not: OutboxStatus.PUBLISHED } }
		}),
		prisma.providerOperation.count({
			where: {
				status: {
					in: [
						ProviderOperationStatus.PROCESSING,
						ProviderOperationStatus.UNKNOWN
					]
				}
			}
		})
	]);
	return {
		schemaVersion: 1,
		service: 'billing-service',
		action,
		status: 'ok',
		revision:
			marker?.cleanupRevision ||
			marker?.ownershipRevision ||
			marker?.preparedRevision ||
			null,
		generation: marker?.generation.toString() || null,
		observedAt: new Date().toISOString(),
		ownership: marker
			? {
					phase: marker.phase,
					generation: marker.generation.toString(),
					preparedRevision: marker.preparedRevision,
					ownershipRevision: marker.ownershipRevision,
					cleanupRevision: marker.cleanupRevision
				}
			: null,
		sourceFingerprint:
			marker?.sourceFingerprint || identity?.sourceFingerprint || null,
		counts: { ...counts, pendingOutbox, providerOperationsInFlight },
		eventTypes: {}
	};
}

async function canonicalCounts(
	prisma: PrismaClient
): Promise<Record<string, number>> {
	const values = await Promise.all([
		prisma.payment.count(),
		prisma.paymentReceipt.count(),
		prisma.subscription.count(),
		prisma.subscriptionHistory.count(),
		prisma.subscriptionExpiryReminder.count(),
		prisma.autoRenewal.count(),
		prisma.autoRenewalConsentEvent.count(),
		prisma.tariffPrice.count(),
		prisma.affiliateReferral.count(),
		prisma.identityContactProjection.count(),
		prisma.notificationRoutingProjection.count(),
		prisma.billingOfferProjection.count(),
		prisma.billingSettings.count(),
		prisma.integrationDeliveryFailure.count({
			where: { consumer: 'auto-renewal-charge' }
		}),
		prisma.integrationDeliveryReceipt.count({
			where: { consumer: 'auto-renewal-charge' }
		})
	]);
	const keys = [
		'payments',
		'paymentReceipts',
		'subscriptions',
		'subscriptionHistory',
		'subscriptionExpiryReminders',
		'autoRenewals',
		'autoRenewalConsentEvents',
		'tariffPrices',
		'affiliateReferrals',
		'identity',
		'notificationRouting',
		'offer',
		'settings',
		'integrationDeliveryFailures',
		'integrationDeliveryReceipts'
	];
	return Object.fromEntries(
		keys.map((key, index) => [key, values[index]])
	);
}

async function verifyCanonicalImport(
	prisma: PrismaClient,
	snapshot: FrozenBillingSnapshot
): Promise<{
	tableFingerprints: Record<string, string>;
	relationshipViolations: number;
	continuityViolations: number;
}> {
	const continuity = continuityMap(snapshot);
	const tableFingerprints: Record<string, string> = {};
	for (const spec of IMPORT_SPECS) {
		const expectedRows = (
			snapshot[spec.property] as Record<string, unknown>[]
		)
			.map(source => {
				const row = convertRow(source, spec);
				applyContinuity(row, spec.property, continuity);
				return row;
			})
			.sort((left, right) =>
				String(left[spec.key]).localeCompare(String(right[spec.key]))
			);
		const delegate = (
			prisma as unknown as Record<
				string,
				{
					findMany(args: unknown): Promise<Record<string, unknown>[]>;
				}
			>
		)[spec.delegate];
		if (!delegate)
			throw new Error(
				`VERIFY_DELEGATE_MISSING_${spec.delegate.toUpperCase()}`
			);
		const deliveryWhere =
			spec.property === 'integrationDeliveryFailures' ||
			spec.property === 'integrationDeliveryReceipts'
				? { consumer: 'auto-renewal-charge' }
				: undefined;
		const actualRows = await delegate.findMany({
			where: deliveryWhere,
			orderBy: { [spec.key]: 'asc' }
		});
		const expectedComparable = expectedRows.map(row =>
			comparableRow(row, Object.keys(row))
		);
		const actualComparable = actualRows.map((row, index) =>
			comparableRow(row, Object.keys(expectedRows[index] || {}))
		);
		const expectedFingerprint = canonicalFingerprint(expectedComparable);
		const actualFingerprint = canonicalFingerprint(actualComparable);
		if (expectedFingerprint !== actualFingerprint) {
			throw new Error(
				`IMPORT_FIELD_FINGERPRINT_MISMATCH_${String(spec.property).toUpperCase()}`
			);
		}
		tableFingerprints[String(spec.property)] = actualFingerprint;
	}

	const offerContinuity = continuity.get('billing.offer:offer');
	if (!offerContinuity)
		throw new Error('SNAPSHOT_AGGREGATE_CONTINUITY_MISSING_BILLING_OFFER');
	const expectedOffer: Record<string, unknown> = {
		id: 'offer',
		content: snapshot.offer.content,
		sha256: snapshot.offer.sha256,
		consentVersion: snapshot.offer.consentVersion,
		consentText: snapshot.offer.consentText,
		sourceUpdatedAt: new Date(String(snapshot.offer.updatedAt)),
		projectionVersion: BigInt(offerContinuity.aggregateVersion),
		sourceSequence: BigInt(offerContinuity.lastSourceSequence),
		tombstone: false
	};
	const actualOffer = await prisma.billingOfferProjection.findUnique({
		where: { id: 'offer' }
	});
	if (!actualOffer) throw new Error('IMPORT_OFFER_MISSING');
	const expectedOfferFingerprint = canonicalFingerprint([
		comparableRow(expectedOffer, Object.keys(expectedOffer))
	]);
	const actualOfferFingerprint = canonicalFingerprint([
		comparableRow(
			actualOffer as unknown as Record<string, unknown>,
			Object.keys(expectedOffer)
		)
	]);
	if (expectedOfferFingerprint !== actualOfferFingerprint)
		throw new Error('IMPORT_FIELD_FINGERPRINT_MISMATCH_OFFER');
	tableFingerprints.offer = actualOfferFingerprint;

	const expectedSettings = convertSettings(snapshot);
	applyContinuity(expectedSettings, 'settings', continuity);
	const actualSettings = await prisma.billingSettings.findUnique({
		where: { id: 'singleton' }
	});
	if (!actualSettings) throw new Error('IMPORT_SETTINGS_MISSING');
	const expectedSettingsFingerprint = canonicalFingerprint([
		comparableRow(expectedSettings, Object.keys(expectedSettings))
	]);
	const actualSettingsFingerprint = canonicalFingerprint([
		comparableRow(
			actualSettings as unknown as Record<string, unknown>,
			Object.keys(expectedSettings)
		)
	]);
	if (expectedSettingsFingerprint !== actualSettingsFingerprint)
		throw new Error('IMPORT_FIELD_FINGERPRINT_MISMATCH_SETTINGS');
	tableFingerprints.settings = actualSettingsFingerprint;

	const relationshipRows = await prisma.$queryRaw<
		Array<{ violations: bigint }>
	>(Prisma.sql`
		SELECT (
			(SELECT COUNT(*) FROM "billing"."payments" p LEFT JOIN "billing"."identity_contact_projections" i ON i."user_id" = p."user_id" WHERE i."user_id" IS NULL) +
			(SELECT COUNT(*) FROM "billing"."payment_receipts" r LEFT JOIN "billing"."payments" p ON p."id" = r."payment_id" WHERE p."id" IS NULL) +
			(SELECT COUNT(*) FROM "billing"."subscriptions" s LEFT JOIN "billing"."identity_contact_projections" i ON i."user_id" = s."user_id" WHERE i."user_id" IS NULL) +
			(SELECT COUNT(*) FROM "billing"."subscription_history" h LEFT JOIN "billing"."subscriptions" s ON s."id" = h."subscription_id" WHERE h."subscription_id" IS NOT NULL AND s."id" IS NULL) +
			(SELECT COUNT(*) FROM "billing"."subscription_expiry_reminders" r LEFT JOIN "billing"."subscriptions" s ON s."id" = r."subscription_id" WHERE s."id" IS NULL) +
			(SELECT COUNT(*) FROM "billing"."auto_renewals" a LEFT JOIN "billing"."identity_contact_projections" i ON i."user_id" = a."user_id" WHERE i."user_id" IS NULL) +
			(SELECT COUNT(*) FROM "billing"."auto_renewal_consent_events" c LEFT JOIN "billing"."auto_renewals" a ON a."id" = c."auto_renewal_id" WHERE a."id" IS NULL) +
			(SELECT COUNT(*) FROM "billing"."affiliate_referrals" a LEFT JOIN "billing"."identity_contact_projections" r ON r."user_id" = a."referrer_id" LEFT JOIN "billing"."identity_contact_projections" u ON u."user_id" = a."referred_user_id" WHERE r."user_id" IS NULL OR u."user_id" IS NULL) +
			(SELECT COUNT(*) FROM "billing"."affiliate_referrals" a LEFT JOIN "billing"."payments" p ON p."id" = a."first_payment_id" WHERE a."first_payment_id" IS NOT NULL AND p."id" IS NULL) +
			(SELECT COUNT(*) FROM "billing"."integration_delivery_failures" f LEFT JOIN "billing"."integration_delivery_receipts" r ON r."event_id" = f."event_id" AND r."integration" = f."integration" WHERE f."integration" = 'auto-renewal-charge' AND r."id" IS NULL)
		)::bigint AS "violations"
	`);
	const relationshipViolations = Number(
		relationshipRows[0]?.violations || 0n
	);
	if (relationshipViolations !== 0)
		throw new Error('IMPORT_RELATIONSHIP_VIOLATION');

	const [
		paymentVersions,
		subscriptionVersions,
		identityVersions,
		routingVersions,
		settingsVersions,
		offerVersions,
		sequence
	] = await Promise.all([
		prisma.payment.count({
			where: {
				OR: [
					{ aggregateVersion: { lt: 1n } },
					{ sourceSequence: { lt: 1n } }
				]
			}
		}),
		prisma.subscription.count({
			where: {
				OR: [
					{ aggregateVersion: { lt: 1n } },
					{ sourceSequence: { lt: 1n } }
				]
			}
		}),
		prisma.identityContactProjection.count({
			where: {
				OR: [
					{ projectionVersion: { lt: 1n } },
					{ sourceSequence: { lt: 1n } }
				]
			}
		}),
		prisma.notificationRoutingProjection.count({
			where: {
				OR: [
					{ projectionVersion: { lt: 1n } },
					{ sourceSequence: { lt: 1n } }
				]
			}
		}),
		prisma.billingSettings.count({
			where: {
				OR: [
					{ aggregateVersion: { lt: 1n } },
					{ sourceSequence: { lt: 1n } }
				]
			}
		}),
		prisma.billingOfferProjection.count({
			where: {
				OR: [
					{ projectionVersion: { lt: 1n } },
					{ sourceSequence: { lt: 1n } }
				]
			}
		}),
		prisma.billingSourceSequence.findUnique({ where: { id: 'billing' } })
	]);
	const continuityViolations =
		paymentVersions +
		subscriptionVersions +
		identityVersions +
		routingVersions +
		settingsVersions +
		offerVersions +
		(!sequence ||
		sequence.nextValue <= BigInt(snapshot.continuity.maxHighWater)
			? 1
			: 0);
	if (continuityViolations !== 0)
		throw new Error('IMPORT_CONTINUITY_VIOLATION');
	return {
		tableFingerprints,
		relationshipViolations,
		continuityViolations
	};
}

function comparableRow(
	row: Record<string, unknown>,
	fields: readonly string[]
): Record<string, unknown> {
	return Object.fromEntries(
		[...fields]
			.sort()
			.map(field => [field, normalizeCanonical(row[field])])
	);
}

function normalizeCanonical(value: unknown): unknown {
	if (value instanceof Date) return value.toISOString();
	if (typeof value === 'bigint') return value.toString();
	if (Array.isArray(value)) return value.map(normalizeCanonical);
	if (value && typeof value === 'object') {
		const record = value as Record<string, unknown>;
		return Object.fromEntries(
			Object.keys(record)
				.sort()
				.map(key => [key, normalizeCanonical(record[key])])
		);
	}
	return value;
}

function canonicalFingerprint(value: unknown): string {
	return createHash('sha256')
		.update(JSON.stringify(normalizeCanonical(value)), 'utf8')
		.digest('hex');
}

async function seedRows<
	T extends { id: string; aggregateVersion: bigint; updatedAt: Date }
>(
	transaction: Prisma.TransactionClient,
	fingerprint: string,
	eventType: string,
	aggregateType: string,
	rows: T[],
	state: (row: T) => Record<string, unknown>
): Promise<{ sourceRows: number; eventsEnqueued: number }> {
	for (const row of rows) {
		if (row.aggregateVersion < 1n)
			throw new Error(`AGGREGATE_VERSION_MISSING_${aggregateType}`);
		const deduplicationKey = `${SEED_PREFIX}${fingerprint}:${eventType}:${row.id}:${row.aggregateVersion}`;
		const existing = await transaction.outboxEvent.findUnique({
			where: { deduplicationKey },
			select: { id: true }
		});
		if (existing) continue;
		const sequence = await nextSequence(transaction);
		const eventId = randomUUID();
		await transaction.outboxEvent.create({
			data: {
				eventId,
				deduplicationKey,
				eventType,
				aggregateType,
				aggregateId: row.id,
				aggregateVersion: row.aggregateVersion,
				sourceSequence: sequence,
				exchange: BILLING_EVENTS_EXCHANGE,
				routingKey: eventType,
				payload: {
					schemaVersion: 1,
					eventType,
					eventId,
					aggregateId: row.id,
					aggregateVersion: row.aggregateVersion.toString(),
					sourceSequence: sequence.toString(),
					occurredAt: row.updatedAt.toISOString(),
					tombstone: false,
					state: state(row)
				} as Prisma.InputJsonValue
			}
		});
		await updateSeedSourceSequence(
			transaction,
			aggregateType,
			row.id,
			sequence
		);
	}
	const durableEvents = await transaction.outboxEvent.count({
		where: {
			eventType,
			deduplicationKey: {
				startsWith: `${SEED_PREFIX}${fingerprint}:${eventType}:`
			}
		}
	});
	return { sourceRows: rows.length, eventsEnqueued: durableEvents };
}

async function updateSeedSourceSequence(
	transaction: Prisma.TransactionClient,
	aggregateType: string,
	id: string,
	sourceSequence: bigint
): Promise<void> {
	if (aggregateType === 'billing.payment') {
		await transaction.$executeRaw(
			Prisma.sql`UPDATE "billing"."payments" SET "source_sequence" = ${sourceSequence} WHERE "id" = ${id}`
		);
		return;
	}
	if (aggregateType === 'billing.subscription') {
		await transaction.$executeRaw(
			Prisma.sql`UPDATE "billing"."subscriptions" SET "source_sequence" = ${sourceSequence} WHERE "id" = ${id}`
		);
		return;
	}
	if (aggregateType === 'billing.affiliate') {
		await transaction.$executeRaw(
			Prisma.sql`UPDATE "billing"."affiliate_referrals" SET "source_sequence" = ${sourceSequence} WHERE "id" = ${id}`
		);
		return;
	}
	if (aggregateType === 'billing.settings') {
		await transaction.$executeRaw(
			Prisma.sql`UPDATE "billing"."settings" SET "source_sequence" = ${sourceSequence} WHERE "id" = ${id}`
		);
	}
}

function seedCompletionId(fingerprint: string, eventType: string): string {
	return `${SEED_PREFIX}complete:${fingerprint}:${eventType}`;
}

function paymentDetailsState(row: any): Record<string, unknown> {
	return {
		id: row.id,
		userId: row.userId,
		yookassaId: row.yookassaId,
		status: row.status,
		amount: row.amount,
		plan: row.plan,
		billingPeriod: row.billingPeriod,
		createdAt: row.createdAt.toISOString(),
		updatedAt: row.updatedAt.toISOString()
	};
}
function subscriptionDetailsState(row: any): Record<string, unknown> {
	return {
		id: row.id,
		userId: row.userId,
		plan: row.plan,
		billingPeriod: row.billingPeriod,
		status: row.status,
		startsAt: row.startsAt.toISOString(),
		expiresAt: row.expiresAt?.toISOString() || null,
		leadsThisPeriod: row.leadsThisPeriod,
		periodResetsAt: row.periodResetsAt?.toISOString() || null,
		createdAt: row.createdAt.toISOString(),
		updatedAt: row.updatedAt.toISOString()
	};
}
function affiliateState(row: any): Record<string, unknown> {
	return {
		id: row.id,
		referrerId: row.referrerId,
		referredUserId: row.referredUserId,
		firstPaymentId: row.firstPaymentId,
		status: row.status,
		cashbackAmount: row.cashbackAmount,
		availableAt: row.availableAt?.toISOString() || null,
		cancelledAt: row.cancelledAt?.toISOString() || null,
		updatedAt: row.updatedAt.toISOString()
	};
}
function settingsState(row: any): Record<string, unknown> {
	return {
		id: row.id,
		paymentEnabled: row.paymentEnabled,
		autoRenewalSignupEnabled: row.autoRenewalSignupEnabled,
		autoRenewalChargesEnabled: row.autoRenewalChargesEnabled,
		autoRenewalChargesEnabledAt:
			row.autoRenewalChargesEnabledAt.toISOString(),
		affiliateProgramEnabled: row.affiliateProgramEnabled,
		affiliateCashbackPercent: row.affiliateCashbackPercent,
		updatedAt: row.updatedAt.toISOString()
	};
}

function convertSettings(
	snapshot: FrozenBillingSnapshot
): Record<string, unknown> {
	const source = snapshot.settings!;
	const offer = snapshot.offer;
	return convertRow(
		{
			...source,
			id: 'singleton',
			consentVersion: offer.consentVersion || 'auto-renewal-2026-07-28-v4',
			consentText: offer.consentText || '',
			offerSnapshot: offer.content || '',
			offerSectionHash: offer.sha256 || '',
			offerUpdatedAt: offer.updatedAt || null
		},
		{
			property: 'settings',
			delegate: 'billingSettings',
			key: 'id',
			fields: [
				'id',
				'paymentEnabled',
				'autoRenewalSignupEnabled',
				'autoRenewalChargesEnabled',
				'autoRenewalChargesEnabledAt',
				'affiliateProgramEnabled',
				'affiliateCashbackPercent',
				'consentVersion',
				'consentText',
				'offerSectionHash',
				'offerSnapshot',
				'offerUpdatedAt',
				'paymentNotificationDestination',
				'aggregateVersion',
				'sourceSequence',
				'createdAt',
				'updatedAt'
			],
			dates: [
				'autoRenewalChargesEnabledAt',
				'offerUpdatedAt',
				'createdAt',
				'updatedAt'
			],
			bigints: ['aggregateVersion', 'sourceSequence']
		}
	);
}

function convertRow(
	source: Record<string, unknown>,
	spec: ImportSpec
): Record<string, unknown> {
	const row: Record<string, unknown> = {};
	for (const field of spec.fields) {
		let value = source[field];
		if (
			field === 'userId' &&
			value === undefined &&
			typeof source.id === 'string'
		)
			value = source.id;
		if (field === 'consumer' && value === undefined) {
			value =
				source.integration === 'auto-renewal'
					? 'auto-renewal-charge'
					: source.integration;
		}
		if (field === 'attempt' && value === undefined) {
			value =
				spec.property === 'integrationDeliveryFailures'
					? source.attempts
					: spec.property === 'integrationDeliveryReceipts'
						? source.retryAttempt
						: value;
		}
		if (value === undefined) continue;
		if (value !== null && spec.dates.includes(field)) {
			if (typeof value !== 'string' || !Number.isFinite(Date.parse(value)))
				throw new Error(
					`SNAPSHOT_DATE_INVALID_${String(spec.property)}_${field}`
				);
			value = new Date(value);
		}
		if (value !== null && spec.bigints?.includes(field)) {
			if (typeof value !== 'string' || !/^\d+$/.test(value))
				throw new Error(
					`SNAPSHOT_BIGINT_INVALID_${String(spec.property)}_${field}`
				);
			value = BigInt(value);
		}
		row[field] = value;
	}
	if (spec.property === 'integrationDeliveryFailures') {
		row.errorCode = row.normalizedCode || null;
		row.errorSafe = row.safeReason || row.lastError;
		row.status = row.resolvedAt
			? 'RESOLVED'
			: row.retryingAt
				? 'RETRY_PENDING'
				: 'OPEN';
	}
	if (typeof row[spec.key] !== 'string' || !row[spec.key])
		throw new Error(`SNAPSHOT_KEY_INVALID_${String(spec.property)}`);
	return row;
}

function applyContinuity(
	row: Record<string, unknown>,
	property: keyof FrozenBillingSnapshot,
	map: Map<string, AggregateContinuityRow>
): void {
	const types: Partial<Record<keyof FrozenBillingSnapshot, string>> = {
		identity: 'billing.identity',
		notificationRouting: 'billing.notification-routing',
		payments: 'billing.payment',
		subscriptions: 'billing.subscription',
		settings: 'billing.settings'
	};
	const aggregateType = types[property];
	if (!aggregateType) return;
	const aggregateId = String(
		property === 'identity' ? row.userId : row.id
	);
	const continuity = map.get(`${aggregateType}:${aggregateId}`);
	if (!continuity)
		throw new Error(
			`SNAPSHOT_AGGREGATE_CONTINUITY_MISSING_${aggregateType}`
		);
	if (property === 'identity' || property === 'notificationRouting') {
		row.projectionVersion = BigInt(continuity.aggregateVersion);
		row.sourceSequence = BigInt(continuity.lastSourceSequence);
		row.tombstone = false;
		if (property === 'identity') {
			row.sourceCreatedAt = row.sourceCreatedAt || row.createdAt;
			row.sourceUpdatedAt = row.sourceUpdatedAt || row.updatedAt;
		}
		if (property === 'notificationRouting') {
			row.sourceUpdatedAt = row.sourceUpdatedAt || row.updatedAt;
		}
		return;
	}
	row.aggregateVersion = BigInt(continuity.aggregateVersion);
	row.sourceSequence = BigInt(continuity.lastSourceSequence);
}

async function upsertDynamic(
	transaction: Prisma.TransactionClient,
	delegateName: string,
	key: string,
	row: Record<string, unknown>
): Promise<void> {
	const delegate = (
		transaction as unknown as Record<
			string,
			{ upsert(args: unknown): Promise<unknown> }
		>
	)[delegateName];
	if (!delegate)
		throw new Error(`IMPORT_DELEGATE_MISSING_${delegateName}`);
	await delegate.upsert({
		where: { [key]: row[key] },
		create: row,
		update: row
	});
}

function continuityMap(
	snapshot: FrozenBillingSnapshot
): Map<string, AggregateContinuityRow> {
	return new Map(
		[
			...snapshot.continuity.reportingAggregateVersions,
			...snapshot.continuity.billingAggregateVersions
		].map(row => [`${row.aggregateType}:${row.aggregateId}`, row])
	);
}

function snapshotSummary(
	snapshot: FrozenBillingSnapshot
): Prisma.InputJsonValue {
	return {
		schemaVersion: 1,
		revision: snapshot.revision,
		generation: snapshot.generation,
		frozenAt: snapshot.frozenAt,
		sourceCutoff: snapshot.sourceCutoff,
		counts: snapshotCounts(snapshot)
	};
}
function snapshotCounts(
	snapshot: FrozenBillingSnapshot
): Record<string, number> {
	return {
		identity: snapshot.identity.length,
		notificationRouting: snapshot.notificationRouting.length,
		offer: 1,
		settings: snapshot.settings ? 1 : 0,
		payments: snapshot.payments.length,
		paymentReceipts: snapshot.paymentReceipts.length,
		subscriptions: snapshot.subscriptions.length,
		subscriptionHistory: snapshot.subscriptionHistory.length,
		subscriptionExpiryReminders:
			snapshot.subscriptionExpiryReminders.length,
		autoRenewals: snapshot.autoRenewals.length,
		autoRenewalConsentEvents: snapshot.autoRenewalConsentEvents.length,
		tariffPrices: snapshot.tariffPrices.length,
		affiliateReferrals: snapshot.affiliateReferrals.length,
		integrationDeliveryFailures:
			snapshot.integrationDeliveryFailures.length,
		integrationDeliveryReceipts:
			snapshot.integrationDeliveryReceipts.length
	};
}

async function nextSequence(
	transaction: Prisma.TransactionClient
): Promise<bigint> {
	const state = await transaction.billingSourceSequence.update({
		where: { id: 'billing' },
		data: { nextValue: { increment: 1n } }
	});
	return state.nextValue - 1n;
}

async function loadSnapshot(
	options: CliOptions
): Promise<FrozenBillingSnapshot> {
	const path = options.snapshotFile!;
	await assertReadableRegularFile(path, 'SNAPSHOT_FILE_INVALID');
	return parseFrozenBillingSnapshot(await readFile(path, 'utf8'));
}
function assertSnapshotArgs(
	snapshot: FrozenBillingSnapshot,
	options: CliOptions
): void {
	if (
		snapshot.revision !== options.revision ||
		BigInt(snapshot.generation) !== options.generation
	)
		throw new Error('SNAPSHOT_ARGUMENT_MISMATCH');
}
function assertMarker(
	marker: { generation: bigint; preparedRevision: string },
	options: CliOptions
): void {
	if (
		marker.generation !== options.generation ||
		marker.preparedRevision !== options.revision
	)
		throw new Error('OWNERSHIP_MARKER_ARGUMENT_MISMATCH');
}
async function requireMarker(
	prisma: PrismaClient,
	options: CliOptions,
	phase: BillingOwnershipPhase
) {
	const marker = await prisma.billingOwnershipMarker.findUnique({
		where: { id: 'singleton' }
	});
	if (!marker) throw new Error('OWNERSHIP_MARKER_MISSING');
	assertMarker(marker, options);
	if (marker.phase !== phase) throw new Error('OWNERSHIP_PHASE_INVALID');
	return marker;
}

function parseArgs(argv: string[]): CliOptions {
	const action = argv.shift() as Action | undefined;
	if (
		!action ||
		![
			'status',
			'import-frozen',
			'verify-import',
			'seed-core-read-events',
			'activate',
			'complete'
		].includes(action)
	)
		throw new Error('CLI_ACTION_INVALID');
	const flags = new Map<string, string>();
	while (argv.length) {
		const key = argv.shift();
		const value = argv.shift();
		if (
			!key?.startsWith('--') ||
			!value ||
			value.startsWith('--') ||
			flags.has(key)
		)
			throw new Error('CLI_ARGUMENT_INVALID');
		flags.set(key, value);
	}
	const allowed = new Set([
		'--evidence-file',
		'--snapshot-file',
		'--revision',
		'--generation'
	]);
	if ([...flags.keys()].some(key => !allowed.has(key)))
		throw new Error('CLI_ARGUMENT_UNKNOWN');
	const evidenceFile = flags.get('--evidence-file');
	if (!evidenceFile) throw new Error('EVIDENCE_FILE_REQUIRED');
	assertAbsoluteNormalizedPath(evidenceFile, 'EVIDENCE_FILE_INVALID');
	const options: CliOptions = { action, evidenceFile };
	if (SNAPSHOT_ACTIONS.has(action)) {
		options.snapshotFile = flags.get('--snapshot-file');
		if (!options.snapshotFile) throw new Error('SNAPSHOT_FILE_REQUIRED');
		assertAbsoluteNormalizedPath(
			options.snapshotFile,
			'SNAPSHOT_FILE_INVALID'
		);
	}
	if (action !== 'status') {
		options.revision = flags.get('--revision');
		const generation = flags.get('--generation');
		if (!options.revision || !REVISION_PATTERN.test(options.revision))
			throw new Error('REVISION_INVALID');
		if (!generation || !DECIMAL_PATTERN.test(generation))
			throw new Error('GENERATION_INVALID');
		options.generation = BigInt(generation);
	}
	if (
		!MUTATING_ACTIONS.has(action) &&
		action !== 'verify-import' &&
		(flags.has('--revision') || flags.has('--generation'))
	)
		throw new Error('CLI_ARGUMENT_NOT_ALLOWED');
	return options;
}

async function writeEvidence(
	path: string,
	evidence: Evidence
): Promise<void> {
	assertAbsoluteNormalizedPath(path, 'EVIDENCE_FILE_INVALID');
	const directory = dirname(path);
	const canonicalDirectory = await realpath(directory);
	if (canonicalDirectory !== directory)
		throw new Error('EVIDENCE_DIRECTORY_SYMLINK');
	const directoryStat = await stat(directory);
	if (!directoryStat.isDirectory())
		throw new Error('EVIDENCE_DIRECTORY_INVALID');
	try {
		const current = await lstat(path);
		if (current.isSymbolicLink() || !current.isFile()) {
			throw new Error('EVIDENCE_FILE_INVALID');
		}
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
	}
	const temporary = join(
		directory,
		`.${path.slice(directory.length + 1)}.${process.pid}.${randomUUID()}.tmp`
	);
	let handle: Awaited<ReturnType<typeof open>> | null = null;
	try {
		handle = await open(temporary, 'wx', 0o600);
		await handle.writeFile(
			`${JSON.stringify(evidence, null, 2)}\n`,
			'utf8'
		);
		await handle.sync();
		await handle.close();
		handle = null;
		await chmod(temporary, 0o600);
		await rename(temporary, path);
		const directoryHandle = await open(directory, 'r');
		try {
			await directoryHandle.sync();
		} finally {
			await directoryHandle.close();
		}
	} catch (error) {
		await handle?.close().catch(() => undefined);
		await unlink(temporary).catch(() => undefined);
		throw error;
	}
}

function assertAbsoluteNormalizedPath(path: string, code: string): void {
	if (!isAbsolute(path) || resolve(path) !== path) throw new Error(code);
}

async function assertReadableRegularFile(
	path: string,
	code: string
): Promise<void> {
	assertAbsoluteNormalizedPath(path, code);
	const file = await lstat(path).catch(() => null);
	if (!file || file.isSymbolicLink() || !file.isFile())
		throw new Error(code);
	if ((await realpath(path)) !== path) throw new Error(code);
}
function failureEvidence(
	options: CliOptions | null,
	code: string
): Evidence {
	return {
		schemaVersion: 1,
		service: 'billing-service',
		action: options?.action || 'status',
		status: 'failed',
		revision: options?.revision || null,
		generation: options?.generation?.toString() || null,
		observedAt: new Date().toISOString(),
		ownership: null,
		sourceFingerprint: null,
		counts: {},
		eventTypes: {},
		errorCode: code,
		errorSafe: code
	};
}
function safeCode(error: unknown): string {
	const value = error instanceof Error ? error.message : 'CUTOVER_FAILED';
	return /^[A-Z0-9_:-]{1,160}$/.test(value) ? value : 'CUTOVER_FAILED';
}

void main();
