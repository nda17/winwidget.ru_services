import { createHash } from 'node:crypto';
import {
	AUTO_RENEWAL_CONSENT_TEXT,
	AUTO_RENEWAL_CONSENT_VERSION
} from '../domain/billing-legal.constants';

export interface AggregateContinuityRow {
	aggregateType: string;
	aggregateId: string;
	aggregateVersion: string;
	lastSourceSequence: string;
}

export interface FrozenBillingSnapshot {
	schemaVersion: 1;
	action: 'freeze-export';
	revision: string;
	generation: string;
	frozenAt: string;
	sourceCutoff: string;
	sourceFingerprint: string;
	coreState: Record<string, unknown>;
	continuity: {
		reportingHighWater: string;
		billingHighWater: string;
		maxHighWater: string;
		nextSourceSequence: string;
		entityCounts: Record<string, number>;
		reportingAggregateVersions: AggregateContinuityRow[];
		billingAggregateVersions: AggregateContinuityRow[];
	};
	identity: Record<string, unknown>[];
	notificationRouting: Record<string, unknown>[];
	offer: Record<string, unknown>;
	settings: Record<string, unknown>;
	payments: Record<string, unknown>[];
	paymentReceipts: Record<string, unknown>[];
	subscriptions: Record<string, unknown>[];
	subscriptionHistory: Record<string, unknown>[];
	subscriptionExpiryReminders: Record<string, unknown>[];
	autoRenewals: Record<string, unknown>[];
	autoRenewalConsentEvents: Record<string, unknown>[];
	tariffPrices: Record<string, unknown>[];
	affiliateReferrals: Record<string, unknown>[];
	integrationDeliveryFailures: Record<string, unknown>[];
	integrationDeliveryReceipts: Record<string, unknown>[];
}

const DECIMAL_PATTERN = /^(0|[1-9]\d*)$/;
const SHA_PATTERN = /^[0-9a-f]{64}$/;
const REVISION_PATTERN = /^[0-9a-f]{40}$/;
const ARRAY_KEYS = [
	'identity',
	'notificationRouting',
	'payments',
	'paymentReceipts',
	'subscriptions',
	'subscriptionHistory',
	'subscriptionExpiryReminders',
	'autoRenewals',
	'autoRenewalConsentEvents',
	'tariffPrices',
	'affiliateReferrals',
	'integrationDeliveryFailures',
	'integrationDeliveryReceipts'
] as const;

const ENTITY_COUNT_KEYS = [...ARRAY_KEYS, 'settings', 'offer'] as const;
const TOP_LEVEL_KEYS = [
	'schemaVersion',
	'action',
	'revision',
	'generation',
	'frozenAt',
	'sourceCutoff',
	'sourceFingerprint',
	'coreState',
	'continuity',
	...ARRAY_KEYS,
	'settings',
	'offer'
].sort();
const CORE_STATE_KEYS = [
	'id',
	'ownership',
	'sourceProducersEnabled',
	'legacyRoutesEnabled',
	'schedulerEnabled',
	'legacyConsumerEnabled',
	'projectionConsumerEnabled',
	'generation',
	'preparedRevision',
	'ownershipRevision',
	'activatedAt',
	'updatedAt'
].sort();
const CONTINUITY_KEYS = [
	'reportingHighWater',
	'billingHighWater',
	'maxHighWater',
	'nextSourceSequence',
	'entityCounts',
	'reportingAggregateVersions',
	'billingAggregateVersions'
].sort();
const IDENTITY_KEYS = [
	'id',
	'name',
	'email',
	'phone',
	'status',
	'deletedAt',
	'roles',
	'telegramChatId',
	'telegramChannelActive',
	'createdAt',
	'updatedAt'
].sort();
const ROUTING_KEYS = [
	'id',
	'telegramChatId',
	'paymentsThreadId',
	'updatedAt'
].sort();
const SETTINGS_KEYS = [
	'id',
	'paymentEnabled',
	'autoRenewalSignupEnabled',
	'autoRenewalChargesEnabled',
	'autoRenewalChargesEnabledAt',
	'affiliateProgramEnabled',
	'affiliateCashbackPercent',
	'updatedAt'
].sort();

export function parseFrozenBillingSnapshot(
	raw: string
): FrozenBillingSnapshot {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		throw new Error('SNAPSHOT_JSON_INVALID');
	}
	if (!record(parsed)) throw new Error('SNAPSHOT_OBJECT_INVALID');
	const value = parsed as Record<string, unknown>;
	if (
		!exactKeys(value, TOP_LEVEL_KEYS) ||
		value.schemaVersion !== 1 ||
		value.action !== 'freeze-export' ||
		typeof value.revision !== 'string' ||
		!REVISION_PATTERN.test(value.revision) ||
		!decimal(value.generation) ||
		!iso(value.frozenAt) ||
		!iso(value.sourceCutoff) ||
		typeof value.sourceFingerprint !== 'string' ||
		!SHA_PATTERN.test(value.sourceFingerprint) ||
		!record(value.coreState) ||
		!record(value.continuity) ||
		!record(value.settings) ||
		!record(value.offer) ||
		ARRAY_KEYS.some(key => !arrayOfRecords(value[key]))
	) {
		throw new Error('SNAPSHOT_CONTRACT_INVALID');
	}
	assertFrozenCoreState(value.coreState as Record<string, unknown>, value);
	assertSourceRows(value);
	if (record(value.offer)) {
		const offer = value.offer as Record<string, unknown>;
		const keys = [
			'id',
			'content',
			'sha256',
			'updatedAt',
			'consentVersion',
			'consentText'
		].sort();
		if (
			Object.keys(offer).length !== keys.length ||
			Object.keys(offer)
				.sort()
				.some((key, index) => key !== keys[index]) ||
			offer.id !== 'offer' ||
			typeof offer.content !== 'string' ||
			typeof offer.sha256 !== 'string' ||
			!SHA_PATTERN.test(offer.sha256) ||
			createHash('sha256').update(offer.content, 'utf8').digest('hex') !==
				offer.sha256 ||
			!iso(offer.updatedAt) ||
			offer.consentVersion !== AUTO_RENEWAL_CONSENT_VERSION ||
			offer.consentText !== AUTO_RENEWAL_CONSENT_TEXT
		) {
			throw new Error('SNAPSHOT_OFFER_INVALID');
		}
	}
	const continuity = value.continuity as Record<string, unknown>;
	if (
		!exactKeys(continuity, CONTINUITY_KEYS) ||
		!decimal(continuity.reportingHighWater) ||
		!decimal(continuity.billingHighWater) ||
		!decimal(continuity.maxHighWater) ||
		!decimal(continuity.nextSourceSequence) ||
		!record(continuity.entityCounts) ||
		!arrayOfContinuity(continuity.reportingAggregateVersions) ||
		!arrayOfContinuity(continuity.billingAggregateVersions)
	) {
		throw new Error('SNAPSHOT_CONTINUITY_INVALID');
	}
	const entityCounts = continuity.entityCounts as Record<string, unknown>;
	if (
		Object.keys(entityCounts).length !== ENTITY_COUNT_KEYS.length ||
		Object.keys(entityCounts)
			.sort()
			.some(
				(key, index) => key !== [...ENTITY_COUNT_KEYS].sort()[index]
			) ||
		ENTITY_COUNT_KEYS.some(
			key =>
				!Number.isSafeInteger(entityCounts[key]) ||
				Number(entityCounts[key]) < 0
		)
	) {
		throw new Error('SNAPSHOT_ENTITY_COUNTS_INVALID');
	}
	for (const key of ARRAY_KEYS) {
		if (entityCounts[key] !== (value[key] as unknown[]).length) {
			throw new Error(`SNAPSHOT_ENTITY_COUNT_MISMATCH_${key}`);
		}
	}
	if (
		entityCounts.settings !== (value.settings ? 1 : 0) ||
		entityCounts.offer !== 1
	) {
		throw new Error('SNAPSHOT_SINGLETON_COUNT_MISMATCH');
	}
	assertUniqueSnapshotIds(value);
	assertDeliveryContinuity(value);
	assertContinuity(value, continuity);
	const maximum = BigInt(continuity.maxHighWater as string);
	if (
		maximum !==
			(BigInt(continuity.reportingHighWater as string) >
			BigInt(continuity.billingHighWater as string)
				? BigInt(continuity.reportingHighWater as string)
				: BigInt(continuity.billingHighWater as string)) ||
		BigInt(continuity.nextSourceSequence as string) !== maximum + 1n
	) {
		throw new Error('SNAPSHOT_HIGH_WATER_INVALID');
	}
	if (computeSnapshotFingerprint(value) !== value.sourceFingerprint) {
		throw new Error('SNAPSHOT_FINGERPRINT_MISMATCH');
	}
	return value as unknown as FrozenBillingSnapshot;
}

function assertFrozenCoreState(
	coreState: Record<string, unknown>,
	snapshot: Record<string, unknown>
): void {
	if (
		!exactKeys(coreState, CORE_STATE_KEYS) ||
		coreState.id !== 'singleton' ||
		coreState.ownership !== 'CORE' ||
		coreState.sourceProducersEnabled !== false ||
		coreState.legacyRoutesEnabled !== true ||
		coreState.schedulerEnabled !== false ||
		coreState.legacyConsumerEnabled !== false ||
		coreState.projectionConsumerEnabled !== true ||
		coreState.generation !== snapshot.generation ||
		coreState.preparedRevision !== snapshot.revision ||
		coreState.ownershipRevision !== null ||
		coreState.activatedAt !== null ||
		!iso(coreState.updatedAt)
	) {
		throw new Error('SNAPSHOT_CORE_STATE_INVALID');
	}
}

function assertSourceRows(value: Record<string, unknown>): void {
	for (const row of value.identity as Record<string, unknown>[]) {
		if (
			!exactKeys(row, IDENTITY_KEYS) ||
			typeof row.id !== 'string' ||
			!row.id ||
			typeof row.status !== 'string' ||
			!Array.isArray(row.roles) ||
			!row.roles.every(role => typeof role === 'string') ||
			typeof row.telegramChannelActive !== 'boolean' ||
			!nullableIso(row.deletedAt) ||
			!iso(row.createdAt) ||
			!iso(row.updatedAt)
		) {
			throw new Error('SNAPSHOT_IDENTITY_INVALID');
		}
	}
	for (const row of value.notificationRouting as Record<
		string,
		unknown
	>[]) {
		if (
			!exactKeys(row, ROUTING_KEYS) ||
			typeof row.id !== 'string' ||
			!row.id ||
			!iso(row.updatedAt)
		) {
			throw new Error('SNAPSHOT_NOTIFICATION_ROUTING_INVALID');
		}
	}
	const settings = value.settings as Record<string, unknown>;
	if (
		!exactKeys(settings, SETTINGS_KEYS) ||
		settings.id !== 'singleton' ||
		typeof settings.paymentEnabled !== 'boolean' ||
		typeof settings.autoRenewalSignupEnabled !== 'boolean' ||
		typeof settings.autoRenewalChargesEnabled !== 'boolean' ||
		!iso(settings.autoRenewalChargesEnabledAt) ||
		typeof settings.affiliateProgramEnabled !== 'boolean' ||
		!Number.isSafeInteger(settings.affiliateCashbackPercent) ||
		Number(settings.affiliateCashbackPercent) < 1 ||
		Number(settings.affiliateCashbackPercent) > 50 ||
		!iso(settings.updatedAt)
	) {
		throw new Error('SNAPSHOT_SETTINGS_INVALID');
	}
}

function assertContinuity(
	value: Record<string, unknown>,
	continuity: Record<string, unknown>
): void {
	const reporting =
		continuity.reportingAggregateVersions as AggregateContinuityRow[];
	const billing =
		continuity.billingAggregateVersions as AggregateContinuityRow[];
	const seen = new Set<string>();
	for (const [rows, highWater, source] of [
		[
			reporting,
			BigInt(continuity.reportingHighWater as string),
			'REPORTING'
		],
		[billing, BigInt(continuity.billingHighWater as string), 'BILLING']
	] as const) {
		for (const row of rows) {
			const key = `${row.aggregateType}\0${row.aggregateId}`;
			const sequence = BigInt(row.lastSourceSequence);
			if (
				seen.has(key) ||
				BigInt(row.aggregateVersion) < 1n ||
				sequence < 1n ||
				sequence > highWater
			) {
				throw new Error(`SNAPSHOT_${source}_CONTINUITY_INVALID`);
			}
			seen.add(key);
		}
	}
	const reportingMap = new Set(
		reporting.map(row => `${row.aggregateType}\0${row.aggregateId}`)
	);
	const billingMap = new Set(
		billing.map(row => `${row.aggregateType}\0${row.aggregateId}`)
	);
	for (const row of value.identity as Record<string, unknown>[]) {
		if (!billingMap.has(`billing.identity\0${row.id}`)) {
			throw new Error('SNAPSHOT_IDENTITY_CONTINUITY_MISSING');
		}
	}
	for (const row of value.notificationRouting as Record<
		string,
		unknown
	>[]) {
		if (!billingMap.has(`billing.notification-routing\0${row.id}`)) {
			throw new Error('SNAPSHOT_NOTIFICATION_ROUTING_CONTINUITY_MISSING');
		}
	}
	for (const [aggregateType, aggregateId] of [
		['billing.settings', 'singleton'],
		['billing.offer', 'offer']
	] as const) {
		if (!billingMap.has(`${aggregateType}\0${aggregateId}`)) {
			throw new Error('SNAPSHOT_SINGLETON_CONTINUITY_MISSING');
		}
	}
	for (const row of value.payments as Record<string, unknown>[]) {
		if (!reportingMap.has(`billing.payment\0${row.id}`)) {
			throw new Error('SNAPSHOT_PAYMENT_CONTINUITY_MISSING');
		}
	}
	for (const row of value.subscriptions as Record<string, unknown>[]) {
		if (!reportingMap.has(`billing.subscription\0${row.id}`)) {
			throw new Error('SNAPSHOT_SUBSCRIPTION_CONTINUITY_MISSING');
		}
	}
}

function assertUniqueSnapshotIds(value: Record<string, unknown>): void {
	for (const key of ARRAY_KEYS) {
		const seen = new Set<string>();
		for (const row of value[key] as Record<string, unknown>[]) {
			if (typeof row.id !== 'string' || !row.id || seen.has(row.id)) {
				throw new Error(`SNAPSHOT_UNIQUE_ID_INVALID_${key}`);
			}
			seen.add(row.id);
		}
	}
}

function assertDeliveryContinuity(value: Record<string, unknown>): void {
	const failures = value.integrationDeliveryFailures as Record<
		string,
		unknown
	>[];
	const receipts = value.integrationDeliveryReceipts as Record<
		string,
		unknown
	>[];
	const failureKeys = [
		'id',
		'eventId',
		'integration',
		'routingKey',
		'payload',
		'attempts',
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
		'createdAt',
		'updatedAt'
	].sort();
	const receiptKeys = [
		'id',
		'eventId',
		'integration',
		'status',
		'lockedAt',
		'deliveredAt',
		'retryAttempt',
		'retryAvailableAt',
		'retryToken',
		'createdAt'
	].sort();
	const pairs = new Set<string>();
	for (const row of failures) {
		if (
			!exactKeys(row, failureKeys) ||
			!uuid(row.id) ||
			!uuid(row.eventId) ||
			row.integration !== 'auto-renewal' ||
			typeof row.routingKey !== 'string' ||
			!record(row.payload) ||
			!Number.isSafeInteger(row.attempts) ||
			Number(row.attempts) < 0 ||
			typeof row.lastError !== 'string' ||
			!iso(row.failedAt) ||
			!iso(row.createdAt) ||
			!iso(row.updatedAt) ||
			row.retryingAt !== null ||
			row.activeRetryToken !== null ||
			!nullableIso(row.firstFailedAt) ||
			!nullableIso(row.resolvedAt)
		) {
			throw new Error('SNAPSHOT_DELIVERY_FAILURE_INVALID');
		}
		const pair = `${row.eventId}\0${row.integration}`;
		if (pairs.has(pair))
			throw new Error('SNAPSHOT_DELIVERY_FAILURE_PAIR_DUPLICATE');
		pairs.add(pair);
	}
	pairs.clear();
	for (const row of receipts) {
		if (
			!exactKeys(row, receiptKeys) ||
			!uuid(row.id) ||
			!uuid(row.eventId) ||
			row.integration !== 'auto-renewal' ||
			![
				'RETRY_SCHEDULED',
				'DELIVERED',
				'DEAD_LETTERED',
				'CLOSED_NO_RETRY'
			].includes(String(row.status)) ||
			!iso(row.lockedAt) ||
			!nullableIso(row.deliveredAt) ||
			!nullableIso(row.retryAvailableAt) ||
			(row.retryToken !== null && !uuid(row.retryToken)) ||
			!iso(row.createdAt)
		) {
			throw new Error('SNAPSHOT_DELIVERY_RECEIPT_INVALID');
		}
		const pair = `${row.eventId}\0${row.integration}`;
		if (pairs.has(pair))
			throw new Error('SNAPSHOT_DELIVERY_RECEIPT_PAIR_DUPLICATE');
		pairs.add(pair);
	}
}

export function computeSnapshotFingerprint(
	value: Record<string, unknown>
): string {
	const copy = { ...value };
	delete copy.sourceFingerprint;
	return createHash('sha256')
		.update(JSON.stringify(copy), 'utf8')
		.digest('hex');
}

function arrayOfContinuity(
	value: unknown
): value is AggregateContinuityRow[] {
	return (
		Array.isArray(value) &&
		value.every(
			item =>
				record(item) &&
				exactKeys(item, [
					'aggregateId',
					'aggregateType',
					'aggregateVersion',
					'lastSourceSequence'
				]) &&
				typeof item.aggregateType === 'string' &&
				Boolean(item.aggregateType) &&
				typeof item.aggregateId === 'string' &&
				Boolean(item.aggregateId) &&
				decimal(item.aggregateVersion) &&
				decimal(item.lastSourceSequence)
		)
	);
}

function arrayOfRecords(
	value: unknown
): value is Record<string, unknown>[] {
	return Array.isArray(value) && value.every(record);
}

function record(value: unknown): value is Record<string, unknown> {
	return (
		Boolean(value) && typeof value === 'object' && !Array.isArray(value)
	);
}

function decimal(value: unknown): value is string {
	return typeof value === 'string' && DECIMAL_PATTERN.test(value);
}

function iso(value: unknown): value is string {
	return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function nullableIso(value: unknown): boolean {
	return value === null || iso(value);
}

function exactKeys(
	value: Record<string, unknown>,
	expectedSorted: readonly string[]
): boolean {
	const actual = Object.keys(value).sort();
	return (
		actual.length === expectedSorted.length &&
		actual.every((key, index) => key === expectedSorted[index])
	);
}

function uuid(value: unknown): value is string {
	return (
		typeof value === 'string' &&
		/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
			value
		)
	);
}
