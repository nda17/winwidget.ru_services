import { createHmac, timingSafeEqual } from 'node:crypto';

export const DATABASE_RESTORE_QUEUE_MANIFEST_VERSION = 1 as const;
export const DATABASE_RESTORE_TARGET_LOCK_VERSION = 1 as const;
export const DATABASE_RESTORE_TRANSITION_GATE_VERSION = 1 as const;
export const DATABASE_RESTORE_PRODUCTION_PERMIT_VERSION = 1 as const;
export const DATABASE_RESTORE_GLOBAL_GATE_VERSION = 1 as const;
export const DATABASE_RESTORE_PUBLISH_RECEIPT_VERSION = 1 as const;
export const DATABASE_RESTORE_MAX_FILE_SIZE_BYTES = 49 * 1024 * 1024;
export const DATABASE_RESTORE_MANIFEST_MAX_FILE_SIZE_BYTES = 64 * 1024;
// Covers the bounded upload/fsync/audit window after the signed global gate is
// acquired. The worker stays non-destructive and never releases an orphan gate.
export const DATABASE_RESTORE_PUBLICATION_GRACE_MS = 5 * 60 * 1000;

export const DATABASE_RESTORE_TARGETS = [
	'notification-delivery',
	'campaigns',
	'reporting',
	'widgets',
	'billing',
	'identity',
	'platform',
	'support',
	'operations'
] as const;

export type DatabaseRestoreTarget =
	(typeof DATABASE_RESTORE_TARGETS)[number];

export const DATABASE_RESTORE_STATUSES = [
	'QUEUED',
	'PROCESSING',
	'CANCELLED',
	'SUCCEEDED',
	'FAILED',
	'FAILED_FENCED'
] as const;

export type DatabaseRestoreStatus =
	(typeof DATABASE_RESTORE_STATUSES)[number];

export const DATABASE_RESTORE_TARGET_SETTINGS: ReadonlyArray<{
	id: DatabaseRestoreTarget;
	label: string;
	confirmation: string;
}> = [
	{
		id: 'notification-delivery',
		label: 'Notification Delivery',
		confirmation: 'ВОССТАНОВИТЬ NOTIFICATION DELIVERY'
	},
	{
		id: 'campaigns',
		label: 'Campaigns',
		confirmation: 'ВОССТАНОВИТЬ CAMPAIGNS'
	},
	{
		id: 'reporting',
		label: 'Reporting',
		confirmation: 'ВОССТАНОВИТЬ REPORTING'
	},
	{
		id: 'widgets',
		label: 'Widgets',
		confirmation: 'ВОССТАНОВИТЬ WIDGETS'
	},
	{
		id: 'billing',
		label: 'Billing',
		confirmation: 'ВОССТАНОВИТЬ BILLING'
	},
	{
		id: 'identity',
		label: 'Identity',
		confirmation: 'ВОССТАНОВИТЬ IDENTITY'
	},
	{
		id: 'platform',
		label: 'Platform',
		confirmation: 'ВОССТАНОВИТЬ PLATFORM'
	},
	{
		id: 'support',
		label: 'Support',
		confirmation: 'ВОССТАНОВИТЬ SUPPORT'
	},
	{
		id: 'operations',
		label: 'Operations',
		confirmation: 'ВОССТАНОВИТЬ OPERATIONS'
	}
];

export interface DatabaseRestoreJobError {
	code: string;
	message: string;
}

export interface DatabaseRestoreJobResult {
	safetyBackupFileName: string;
	safetyBackupSha256: string;
	restoredAt: string | null;
	verifiedAt: string | null;
}

export interface DatabaseRestoreJobPayload {
	version: typeof DATABASE_RESTORE_QUEUE_MANIFEST_VERSION;
	jobId: string;
	target: DatabaseRestoreTarget;
	status: DatabaseRestoreStatus;
	uploadFileName: string;
	originalFileName: string;
	fileSize: number;
	sha256: string;
	requestedBy: string;
	requestedAt: string;
	startedAt: string | null;
	finishedAt: string | null;
	attempt: number;
	error: DatabaseRestoreJobError | null;
	result: DatabaseRestoreJobResult | null;
}

export interface SignedDatabaseRestoreJobManifest extends DatabaseRestoreJobPayload {
	signature: string;
}

export interface PublicDatabaseRestoreJob {
	jobId: string;
	target: DatabaseRestoreTarget;
	status: DatabaseRestoreStatus;
	originalFileName: string;
	fileSize: number;
	sha256: string;
	requestedAt: string;
	startedAt: string | null;
	finishedAt: string | null;
	attempt: number;
	error: DatabaseRestoreJobError | null;
	canCancel: boolean;
	cancellationPending: boolean;
	cancellationRequested: boolean;
	publicationConfirmed: boolean;
}

export interface DatabaseRestoreTargetLockPayload {
	version: typeof DATABASE_RESTORE_TARGET_LOCK_VERSION;
	target: DatabaseRestoreTarget;
	jobId: string;
	createdAt: string;
}

export interface SignedDatabaseRestoreTargetLock extends DatabaseRestoreTargetLockPayload {
	signature: string;
}

export interface DatabaseRestoreTransitionGatePayload {
	version: typeof DATABASE_RESTORE_TRANSITION_GATE_VERSION;
	kind: 'DATABASE_RESTORE_TRANSITION_GATE';
	target: DatabaseRestoreTarget;
	jobId: string;
	createdAt: string;
}

export interface SignedDatabaseRestoreTransitionGate extends DatabaseRestoreTransitionGatePayload {
	signature: string;
}

export interface DatabaseRestoreProductionPermitPayload {
	version: typeof DATABASE_RESTORE_PRODUCTION_PERMIT_VERSION;
	kind: 'DATABASE_RESTORE_PRODUCTION_PERMIT';
	appRevision: string;
	target: DatabaseRestoreTarget;
	jobId: string;
	expiresAt: string;
	runId: string;
	evidence: string;
	incident: string;
}

export interface SignedDatabaseRestoreProductionPermit extends DatabaseRestoreProductionPermitPayload {
	signature: string;
}

export interface DatabaseRestoreGlobalGatePayload {
	version: typeof DATABASE_RESTORE_GLOBAL_GATE_VERSION;
	kind: 'DATABASE_RESTORE_GLOBAL_GATE';
	target: DatabaseRestoreTarget;
	jobId: string;
	createdAt: string;
}

export interface SignedDatabaseRestoreGlobalGate extends DatabaseRestoreGlobalGatePayload {
	signature: string;
}

export interface DatabaseRestorePublishReceiptPayload {
	version: typeof DATABASE_RESTORE_PUBLISH_RECEIPT_VERSION;
	kind: 'DATABASE_RESTORE_PUBLISH_RECEIPT';
	jobId: string;
	target: DatabaseRestoreTarget;
	manifestStatus: DatabaseRestoreStatus;
	manifestSignature: string;
	publishedAt: string;
	auditEventId: string;
	appRevision: string | null;
	permitSignature: string | null;
	permitExpiresAt: string | null;
	runId: string | null;
	evidence: string | null;
	incident: string | null;
}

export interface SignedDatabaseRestorePublishReceipt extends DatabaseRestorePublishReceiptPayload {
	signature: string;
}

const DATABASE_RESTORE_JOB_PAYLOAD_KEYS = [
	'attempt',
	'error',
	'fileSize',
	'finishedAt',
	'jobId',
	'originalFileName',
	'requestedAt',
	'requestedBy',
	'result',
	'sha256',
	'startedAt',
	'status',
	'target',
	'uploadFileName',
	'version'
] as const;

const DATABASE_RESTORE_MANIFEST_KEYS = [
	...DATABASE_RESTORE_JOB_PAYLOAD_KEYS,
	'signature'
].sort();

const DATABASE_RESTORE_TARGET_LOCK_PAYLOAD_KEYS = [
	'createdAt',
	'jobId',
	'target',
	'version'
] as const;
const DATABASE_RESTORE_TARGET_LOCK_KEYS = [
	...DATABASE_RESTORE_TARGET_LOCK_PAYLOAD_KEYS,
	'signature'
].sort();

const DATABASE_RESTORE_TRANSITION_GATE_PAYLOAD_KEYS = [
	'createdAt',
	'jobId',
	'kind',
	'target',
	'version'
] as const;
const DATABASE_RESTORE_TRANSITION_GATE_KEYS = [
	...DATABASE_RESTORE_TRANSITION_GATE_PAYLOAD_KEYS,
	'signature'
].sort();

const DATABASE_RESTORE_PRODUCTION_PERMIT_PAYLOAD_KEYS = [
	'appRevision',
	'evidence',
	'expiresAt',
	'incident',
	'jobId',
	'kind',
	'runId',
	'target',
	'version'
] as const;
const DATABASE_RESTORE_PRODUCTION_PERMIT_KEYS = [
	...DATABASE_RESTORE_PRODUCTION_PERMIT_PAYLOAD_KEYS,
	'signature'
].sort();

const DATABASE_RESTORE_GLOBAL_GATE_PAYLOAD_KEYS = [
	'createdAt',
	'jobId',
	'kind',
	'target',
	'version'
] as const;
const DATABASE_RESTORE_GLOBAL_GATE_KEYS = [
	...DATABASE_RESTORE_GLOBAL_GATE_PAYLOAD_KEYS,
	'signature'
].sort();

const DATABASE_RESTORE_PUBLISH_RECEIPT_PAYLOAD_KEYS = [
	'appRevision',
	'auditEventId',
	'evidence',
	'incident',
	'jobId',
	'kind',
	'manifestSignature',
	'manifestStatus',
	'permitExpiresAt',
	'permitSignature',
	'publishedAt',
	'runId',
	'target',
	'version'
] as const;
const DATABASE_RESTORE_PUBLISH_RECEIPT_KEYS = [
	...DATABASE_RESTORE_PUBLISH_RECEIPT_PAYLOAD_KEYS,
	'signature'
].sort();

const UUID_PATTERN =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const SIGNATURE_PATTERN = /^[0-9a-f]{64}$/;
const ERROR_CODE_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/;
const ACTOR_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const APP_REVISION_PATTERN = /^[0-9a-f]{40}$/;
const REFERENCE_PATTERN = /^[^\u0000-\u001f\u007f]{1,512}$/;

export function isDatabaseRestoreTarget(
	value: unknown
): value is DatabaseRestoreTarget {
	return DATABASE_RESTORE_TARGETS.includes(value as DatabaseRestoreTarget);
}

export function isDatabaseRestoreStatus(
	value: unknown
): value is DatabaseRestoreStatus {
	return DATABASE_RESTORE_STATUSES.includes(
		value as DatabaseRestoreStatus
	);
}

export function isDatabaseRestoreJobId(value: unknown): value is string {
	return typeof value === 'string' && UUID_PATTERN.test(value);
}

export function canonicalDatabaseRestoreJson(value: unknown): string {
	if (value === null) return 'null';
	if (typeof value === 'string' || typeof value === 'boolean') {
		return JSON.stringify(value);
	}
	if (typeof value === 'number') {
		if (!Number.isFinite(value)) {
			throw new Error(
				'Database restore manifest contains a non-finite number'
			);
		}
		return JSON.stringify(value);
	}
	if (Array.isArray(value)) {
		return `[${value.map(item => canonicalDatabaseRestoreJson(item)).join(',')}]`;
	}
	if (isPlainObject(value)) {
		return `{${Object.keys(value)
			.sort()
			.map(
				key =>
					`${JSON.stringify(key)}:${canonicalDatabaseRestoreJson(value[key])}`
			)
			.join(',')}}`;
	}

	throw new Error('Database restore manifest contains a non-JSON value');
}

export function signDatabaseRestoreJobPayload(
	payload: DatabaseRestoreJobPayload,
	secret: string
): SignedDatabaseRestoreJobManifest {
	assertDatabaseRestoreQueueSecret(secret);
	assertDatabaseRestoreJobPayload(payload);

	return {
		...payload,
		signature: createHmac('sha256', secret)
			.update(canonicalDatabaseRestoreJson(payload))
			.digest('hex')
	};
}

export function verifyDatabaseRestoreJobManifest(
	manifest: SignedDatabaseRestoreJobManifest,
	secret: string
): boolean {
	try {
		assertDatabaseRestoreQueueSecret(secret);
		assertDatabaseRestoreJobManifest(manifest);
		const { signature, ...payload } = manifest;
		const expected = createHmac('sha256', secret)
			.update(canonicalDatabaseRestoreJson(payload))
			.digest();
		const supplied = Buffer.from(signature, 'hex');

		return (
			supplied.length === expected.length &&
			timingSafeEqual(supplied, expected)
		);
	} catch {
		return false;
	}
}

export function parseAndVerifyDatabaseRestoreJobManifest(
	rawManifest: string,
	secret: string
): SignedDatabaseRestoreJobManifest {
	let parsed: unknown;
	try {
		parsed = JSON.parse(rawManifest);
	} catch {
		throw new Error('Database restore manifest is not valid JSON');
	}

	assertDatabaseRestoreJobManifest(parsed);
	if (!verifyDatabaseRestoreJobManifest(parsed, secret)) {
		throw new Error('Database restore manifest signature is invalid');
	}

	return parsed;
}

export function signDatabaseRestoreTargetLock(
	payload: DatabaseRestoreTargetLockPayload,
	secret: string
): SignedDatabaseRestoreTargetLock {
	assertDatabaseRestoreQueueSecret(secret);
	assertDatabaseRestoreTargetLockPayload(payload);

	return {
		...payload,
		signature: createHmac('sha256', secret)
			.update(canonicalDatabaseRestoreJson(payload))
			.digest('hex')
	};
}

export function verifyDatabaseRestoreTargetLock(
	lock: SignedDatabaseRestoreTargetLock,
	secret: string
): boolean {
	try {
		assertDatabaseRestoreQueueSecret(secret);
		assertDatabaseRestoreTargetLock(lock);
		const { signature, ...payload } = lock;
		const expected = createHmac('sha256', secret)
			.update(canonicalDatabaseRestoreJson(payload))
			.digest();
		const supplied = Buffer.from(signature, 'hex');

		return (
			supplied.length === expected.length &&
			timingSafeEqual(supplied, expected)
		);
	} catch {
		return false;
	}
}

export function parseAndVerifyDatabaseRestoreTargetLock(
	rawLock: string,
	secret: string
): SignedDatabaseRestoreTargetLock {
	let parsed: unknown;
	try {
		parsed = JSON.parse(rawLock);
	} catch {
		throw new Error('Database restore target lock is not valid JSON');
	}

	assertDatabaseRestoreTargetLock(parsed);
	if (!verifyDatabaseRestoreTargetLock(parsed, secret)) {
		throw new Error('Database restore target lock signature is invalid');
	}

	return parsed;
}

export function signDatabaseRestoreTransitionGate(
	payload: DatabaseRestoreTransitionGatePayload,
	secret: string
): SignedDatabaseRestoreTransitionGate {
	assertDatabaseRestoreQueueSecret(secret);
	assertDatabaseRestoreTransitionGatePayload(payload);

	return {
		...payload,
		signature: createHmac('sha256', secret)
			.update(canonicalDatabaseRestoreJson(payload))
			.digest('hex')
	};
}

export function verifyDatabaseRestoreTransitionGate(
	gate: SignedDatabaseRestoreTransitionGate,
	secret: string
): boolean {
	try {
		assertDatabaseRestoreQueueSecret(secret);
		assertDatabaseRestoreTransitionGate(gate);
		const { signature, ...payload } = gate;
		const expected = createHmac('sha256', secret)
			.update(canonicalDatabaseRestoreJson(payload))
			.digest();
		const supplied = Buffer.from(signature, 'hex');

		return (
			supplied.length === expected.length &&
			timingSafeEqual(supplied, expected)
		);
	} catch {
		return false;
	}
}

export function parseAndVerifyDatabaseRestoreTransitionGate(
	rawGate: string,
	secret: string
): SignedDatabaseRestoreTransitionGate {
	let parsed: unknown;
	try {
		parsed = JSON.parse(rawGate);
	} catch {
		throw new Error('Database restore transition gate is not valid JSON');
	}

	assertDatabaseRestoreTransitionGate(parsed);
	if (!verifyDatabaseRestoreTransitionGate(parsed, secret)) {
		throw new Error(
			'Database restore transition gate signature is invalid'
		);
	}

	return parsed;
}

export function signDatabaseRestoreProductionPermit(
	payload: DatabaseRestoreProductionPermitPayload,
	secret: string
): SignedDatabaseRestoreProductionPermit {
	assertDatabaseRestoreQueueSecret(secret);
	assertDatabaseRestoreProductionPermitPayload(payload);

	return {
		...payload,
		signature: createHmac('sha256', secret)
			.update(canonicalDatabaseRestoreJson(payload))
			.digest('hex')
	};
}

export function verifyDatabaseRestoreProductionPermit(
	permit: SignedDatabaseRestoreProductionPermit,
	secret: string
): boolean {
	try {
		assertDatabaseRestoreQueueSecret(secret);
		assertDatabaseRestoreProductionPermit(permit);
		const { signature, ...payload } = permit;
		const expected = createHmac('sha256', secret)
			.update(canonicalDatabaseRestoreJson(payload))
			.digest();
		const supplied = Buffer.from(signature, 'hex');

		return (
			supplied.length === expected.length &&
			timingSafeEqual(supplied, expected)
		);
	} catch {
		return false;
	}
}

export function parseAndVerifyDatabaseRestoreProductionPermit(
	rawPermit: string,
	secret: string
): SignedDatabaseRestoreProductionPermit {
	const parsed = parseDatabaseRestoreJson(
		rawPermit,
		'Database restore production permit is not valid JSON'
	);
	assertDatabaseRestoreProductionPermit(parsed);
	if (!verifyDatabaseRestoreProductionPermit(parsed, secret)) {
		throw new Error(
			'Database restore production permit signature is invalid'
		);
	}
	return parsed;
}

export function signDatabaseRestoreGlobalGate(
	payload: DatabaseRestoreGlobalGatePayload,
	secret: string
): SignedDatabaseRestoreGlobalGate {
	assertDatabaseRestoreQueueSecret(secret);
	assertDatabaseRestoreGlobalGatePayload(payload);

	return {
		...payload,
		signature: createHmac('sha256', secret)
			.update(canonicalDatabaseRestoreJson(payload))
			.digest('hex')
	};
}

export function parseAndVerifyDatabaseRestoreGlobalGate(
	rawGate: string,
	secret: string
): SignedDatabaseRestoreGlobalGate {
	const parsed = parseDatabaseRestoreJson(
		rawGate,
		'Database restore global gate is not valid JSON'
	);
	assertDatabaseRestoreGlobalGate(parsed);
	if (!verifySignedPayload(parsed, secret)) {
		throw new Error('Database restore global gate signature is invalid');
	}
	return parsed;
}

export function signDatabaseRestorePublishReceipt(
	payload: DatabaseRestorePublishReceiptPayload,
	secret: string
): SignedDatabaseRestorePublishReceipt {
	assertDatabaseRestoreQueueSecret(secret);
	assertDatabaseRestorePublishReceiptPayload(payload);

	return {
		...payload,
		signature: createHmac('sha256', secret)
			.update(canonicalDatabaseRestoreJson(payload))
			.digest('hex')
	};
}

export function parseAndVerifyDatabaseRestorePublishReceipt(
	rawReceipt: string,
	secret: string
): SignedDatabaseRestorePublishReceipt {
	const parsed = parseDatabaseRestoreJson(
		rawReceipt,
		'Database restore publish receipt is not valid JSON'
	);
	assertDatabaseRestorePublishReceipt(parsed);
	if (!verifySignedPayload(parsed, secret)) {
		throw new Error(
			'Database restore publish receipt signature is invalid'
		);
	}
	return parsed;
}

export function assertDatabaseRestoreJobPayload(
	value: unknown
): asserts value is DatabaseRestoreJobPayload {
	if (!isPlainObject(value)) {
		throw new Error('Database restore manifest payload must be an object');
	}
	assertExactKeys(value, DATABASE_RESTORE_JOB_PAYLOAD_KEYS);

	if (value.version !== DATABASE_RESTORE_QUEUE_MANIFEST_VERSION) {
		throw new Error('Unsupported database restore manifest version');
	}
	if (!isDatabaseRestoreJobId(value.jobId)) {
		throw new Error('Invalid database restore job id');
	}
	if (!isDatabaseRestoreTarget(value.target)) {
		throw new Error('Invalid database restore target');
	}
	if (!isDatabaseRestoreStatus(value.status)) {
		throw new Error('Invalid database restore status');
	}
	if (value.uploadFileName !== `${value.jobId}.dump`) {
		throw new Error('Invalid database restore upload file name');
	}
	assertOriginalFileName(value.originalFileName);
	if (
		typeof value.fileSize !== 'number' ||
		!Number.isSafeInteger(value.fileSize) ||
		value.fileSize < 1 ||
		value.fileSize > DATABASE_RESTORE_MAX_FILE_SIZE_BYTES
	) {
		throw new Error('Invalid database restore file size');
	}
	if (
		typeof value.sha256 !== 'string' ||
		!SHA256_PATTERN.test(value.sha256)
	) {
		throw new Error('Invalid database restore SHA-256');
	}
	if (
		typeof value.requestedBy !== 'string' ||
		!ACTOR_ID_PATTERN.test(value.requestedBy)
	) {
		throw new Error('Invalid database restore actor id');
	}
	assertIsoTimestamp(value.requestedAt, 'requestedAt');
	assertNullableIsoTimestamp(value.startedAt, 'startedAt');
	assertNullableIsoTimestamp(value.finishedAt, 'finishedAt');
	if (
		typeof value.attempt !== 'number' ||
		!Number.isSafeInteger(value.attempt) ||
		value.attempt < 0
	) {
		throw new Error('Invalid database restore attempt');
	}
	assertNullableJobError(value.error);
	assertNullableJobResult(value.result);
	assertStatusFields(value as unknown as DatabaseRestoreJobPayload);
}

export function assertDatabaseRestoreJobManifest(
	value: unknown
): asserts value is SignedDatabaseRestoreJobManifest {
	if (!isPlainObject(value)) {
		throw new Error('Database restore manifest must be an object');
	}
	assertExactKeys(value, DATABASE_RESTORE_MANIFEST_KEYS);
	if (
		typeof value.signature !== 'string' ||
		!SIGNATURE_PATTERN.test(value.signature)
	) {
		throw new Error('Invalid database restore manifest signature');
	}

	const payload = { ...value };
	delete payload.signature;
	assertDatabaseRestoreJobPayload(payload);
}

export function assertDatabaseRestoreTargetLockPayload(
	value: unknown
): asserts value is DatabaseRestoreTargetLockPayload {
	if (!isPlainObject(value)) {
		throw new Error(
			'Database restore target lock payload must be an object'
		);
	}
	assertExactKeys(value, DATABASE_RESTORE_TARGET_LOCK_PAYLOAD_KEYS);
	if (value.version !== DATABASE_RESTORE_TARGET_LOCK_VERSION) {
		throw new Error('Unsupported database restore target lock version');
	}
	if (!isDatabaseRestoreTarget(value.target)) {
		throw new Error('Invalid database restore target lock target');
	}
	if (!isDatabaseRestoreJobId(value.jobId)) {
		throw new Error('Invalid database restore target lock job id');
	}
	assertIsoTimestamp(value.createdAt, 'target lock createdAt');
}

export function assertDatabaseRestoreTargetLock(
	value: unknown
): asserts value is SignedDatabaseRestoreTargetLock {
	if (!isPlainObject(value)) {
		throw new Error('Database restore target lock must be an object');
	}
	assertExactKeys(value, DATABASE_RESTORE_TARGET_LOCK_KEYS);
	if (
		typeof value.signature !== 'string' ||
		!SIGNATURE_PATTERN.test(value.signature)
	) {
		throw new Error('Invalid database restore target lock signature');
	}

	const payload = { ...value };
	delete payload.signature;
	assertDatabaseRestoreTargetLockPayload(payload);
}

export function assertDatabaseRestoreTransitionGatePayload(
	value: unknown
): asserts value is DatabaseRestoreTransitionGatePayload {
	if (!isPlainObject(value)) {
		throw new Error(
			'Database restore transition gate payload must be an object'
		);
	}
	assertExactKeys(value, DATABASE_RESTORE_TRANSITION_GATE_PAYLOAD_KEYS);
	if (value.version !== DATABASE_RESTORE_TRANSITION_GATE_VERSION) {
		throw new Error(
			'Unsupported database restore transition gate version'
		);
	}
	if (value.kind !== 'DATABASE_RESTORE_TRANSITION_GATE') {
		throw new Error('Invalid database restore transition gate kind');
	}
	if (!isDatabaseRestoreTarget(value.target)) {
		throw new Error('Invalid database restore transition gate target');
	}
	if (!isDatabaseRestoreJobId(value.jobId)) {
		throw new Error('Invalid database restore transition gate job id');
	}
	assertIsoTimestamp(value.createdAt, 'transition gate createdAt');
}

export function assertDatabaseRestoreTransitionGate(
	value: unknown
): asserts value is SignedDatabaseRestoreTransitionGate {
	if (!isPlainObject(value)) {
		throw new Error('Database restore transition gate must be an object');
	}
	assertExactKeys(value, DATABASE_RESTORE_TRANSITION_GATE_KEYS);
	if (
		typeof value.signature !== 'string' ||
		!SIGNATURE_PATTERN.test(value.signature)
	) {
		throw new Error('Invalid database restore transition gate signature');
	}

	const payload = { ...value };
	delete payload.signature;
	assertDatabaseRestoreTransitionGatePayload(payload);
}

export function assertDatabaseRestoreProductionPermitPayload(
	value: unknown
): asserts value is DatabaseRestoreProductionPermitPayload {
	if (!isPlainObject(value)) {
		throw new Error(
			'Database restore production permit must be an object'
		);
	}
	assertExactKeys(value, DATABASE_RESTORE_PRODUCTION_PERMIT_PAYLOAD_KEYS);
	if (value.version !== DATABASE_RESTORE_PRODUCTION_PERMIT_VERSION) {
		throw new Error(
			'Unsupported database restore production permit version'
		);
	}
	if (value.kind !== 'DATABASE_RESTORE_PRODUCTION_PERMIT') {
		throw new Error('Invalid database restore production permit kind');
	}
	if (
		typeof value.appRevision !== 'string' ||
		!APP_REVISION_PATTERN.test(value.appRevision)
	) {
		throw new Error('Invalid database restore production permit revision');
	}
	if (!isDatabaseRestoreTarget(value.target)) {
		throw new Error('Invalid database restore production permit target');
	}
	if (!isDatabaseRestoreJobId(value.jobId)) {
		throw new Error('Invalid database restore production permit job id');
	}
	assertIsoTimestamp(value.expiresAt, 'production permit expiresAt');
	assertReference(value.runId, 'production permit runId');
	assertReference(value.evidence, 'production permit evidence');
	assertReference(value.incident, 'production permit incident');
}

export function assertDatabaseRestoreProductionPermit(
	value: unknown
): asserts value is SignedDatabaseRestoreProductionPermit {
	assertSignedPayload(
		value,
		DATABASE_RESTORE_PRODUCTION_PERMIT_KEYS,
		assertDatabaseRestoreProductionPermitPayload,
		'Database restore production permit'
	);
}

export function assertDatabaseRestoreGlobalGatePayload(
	value: unknown
): asserts value is DatabaseRestoreGlobalGatePayload {
	if (!isPlainObject(value)) {
		throw new Error('Database restore global gate must be an object');
	}
	assertExactKeys(value, DATABASE_RESTORE_GLOBAL_GATE_PAYLOAD_KEYS);
	if (value.version !== DATABASE_RESTORE_GLOBAL_GATE_VERSION) {
		throw new Error('Unsupported database restore global gate version');
	}
	if (value.kind !== 'DATABASE_RESTORE_GLOBAL_GATE') {
		throw new Error('Invalid database restore global gate kind');
	}
	if (!isDatabaseRestoreTarget(value.target)) {
		throw new Error('Invalid database restore global gate target');
	}
	if (!isDatabaseRestoreJobId(value.jobId)) {
		throw new Error('Invalid database restore global gate job id');
	}
	assertIsoTimestamp(value.createdAt, 'global gate createdAt');
}

export function assertDatabaseRestoreGlobalGate(
	value: unknown
): asserts value is SignedDatabaseRestoreGlobalGate {
	assertSignedPayload(
		value,
		DATABASE_RESTORE_GLOBAL_GATE_KEYS,
		assertDatabaseRestoreGlobalGatePayload,
		'Database restore global gate'
	);
}

export function assertDatabaseRestorePublishReceiptPayload(
	value: unknown
): asserts value is DatabaseRestorePublishReceiptPayload {
	if (!isPlainObject(value)) {
		throw new Error('Database restore publish receipt must be an object');
	}
	assertExactKeys(value, DATABASE_RESTORE_PUBLISH_RECEIPT_PAYLOAD_KEYS);
	if (value.version !== DATABASE_RESTORE_PUBLISH_RECEIPT_VERSION) {
		throw new Error(
			'Unsupported database restore publish receipt version'
		);
	}
	if (value.kind !== 'DATABASE_RESTORE_PUBLISH_RECEIPT') {
		throw new Error('Invalid database restore publish receipt kind');
	}
	if (!isDatabaseRestoreJobId(value.jobId)) {
		throw new Error('Invalid database restore publish receipt job id');
	}
	if (!isDatabaseRestoreTarget(value.target)) {
		throw new Error('Invalid database restore publish receipt target');
	}
	if (!isDatabaseRestoreStatus(value.manifestStatus)) {
		throw new Error('Invalid database restore publish receipt status');
	}
	if (
		typeof value.manifestSignature !== 'string' ||
		!SIGNATURE_PATTERN.test(value.manifestSignature)
	) {
		throw new Error(
			'Invalid database restore publish receipt manifest signature'
		);
	}
	assertIsoTimestamp(value.publishedAt, 'publish receipt publishedAt');
	assertReference(value.auditEventId, 'publish receipt auditEventId');
	assertNullableRevision(value.appRevision);
	assertNullableSignature(value.permitSignature);
	assertNullableIsoTimestamp(value.permitExpiresAt, 'permitExpiresAt');
	assertNullableReference(value.runId, 'publish receipt runId');
	assertNullableReference(value.evidence, 'publish receipt evidence');
	assertNullableReference(value.incident, 'publish receipt incident');
	const permitValues = [
		value.appRevision,
		value.permitSignature,
		value.permitExpiresAt,
		value.runId,
		value.evidence,
		value.incident
	];
	if (
		permitValues.some(item => item === null) &&
		permitValues.some(item => item !== null)
	) {
		throw new Error(
			'Database restore publish receipt permit fields are incomplete'
		);
	}
}

export function assertDatabaseRestorePublishReceipt(
	value: unknown
): asserts value is SignedDatabaseRestorePublishReceipt {
	assertSignedPayload(
		value,
		DATABASE_RESTORE_PUBLISH_RECEIPT_KEYS,
		assertDatabaseRestorePublishReceiptPayload,
		'Database restore publish receipt'
	);
}

export function assertDatabaseRestoreQueueSecret(
	secret: unknown
): asserts secret is string {
	if (
		typeof secret !== 'string' ||
		Buffer.byteLength(secret, 'utf8') < 32
	) {
		throw new Error(
			'DATABASE_RESTORE_QUEUE_SECRET must contain at least 32 bytes'
		);
	}
}

export function toPublicDatabaseRestoreJob(
	manifest: SignedDatabaseRestoreJobManifest,
	options: {
		canCancel?: boolean;
		cancellationPending?: boolean;
		cancellationRequested?: boolean;
		publicationConfirmed?: boolean;
	} = {}
): PublicDatabaseRestoreJob {
	return {
		jobId: manifest.jobId,
		target: manifest.target,
		status: manifest.status,
		originalFileName: manifest.originalFileName,
		fileSize: manifest.fileSize,
		sha256: manifest.sha256,
		requestedAt: manifest.requestedAt,
		startedAt: manifest.startedAt,
		finishedAt: manifest.finishedAt,
		attempt: manifest.attempt,
		error: manifest.error,
		canCancel: options.canCancel ?? false,
		cancellationPending: options.cancellationPending ?? false,
		cancellationRequested:
			options.cancellationRequested ?? manifest.status === 'CANCELLED',
		publicationConfirmed: options.publicationConfirmed ?? false
	};
}

function assertStatusFields(value: DatabaseRestoreJobPayload): void {
	if (value.status === 'QUEUED') {
		if (
			value.startedAt !== null ||
			value.finishedAt !== null ||
			value.attempt !== 0 ||
			value.error !== null ||
			value.result !== null
		) {
			throw new Error('Invalid QUEUED database restore state');
		}
		return;
	}

	if (!value.startedAt || value.attempt < 1) {
		throw new Error('Started database restore state is incomplete');
	}

	if (value.status === 'PROCESSING') {
		if (
			value.finishedAt !== null ||
			value.error !== null ||
			value.result !== null
		) {
			throw new Error('Invalid PROCESSING database restore state');
		}
		return;
	}

	if (!value.finishedAt) {
		throw new Error('Terminal database restore state has no finishedAt');
	}

	if (value.status === 'CANCELLED') {
		if (value.error !== null || value.result !== null) {
			throw new Error('Invalid CANCELLED database restore state');
		}
		return;
	}

	if (value.status === 'SUCCEEDED') {
		if (
			value.error !== null ||
			!value.result ||
			!value.result.restoredAt ||
			!value.result.verifiedAt
		) {
			throw new Error('Invalid SUCCEEDED database restore state');
		}
		return;
	}

	if (!value.error) {
		throw new Error('Failed database restore state has no error');
	}
}

function assertOriginalFileName(value: unknown): asserts value is string {
	if (
		typeof value !== 'string' ||
		value.length < 1 ||
		value.length > 255 ||
		value !== value.trim() ||
		/[\u0000-\u001f\u007f]/.test(value) ||
		/[\\/]/.test(value) ||
		!value.toLowerCase().endsWith('.dump')
	) {
		throw new Error('Invalid database restore original file name');
	}
}

function assertNullableJobError(
	value: unknown
): asserts value is DatabaseRestoreJobError | null {
	if (value === null) return;
	if (!isPlainObject(value)) {
		throw new Error('Invalid database restore error');
	}
	assertExactKeys(value, ['code', 'message']);
	if (
		typeof value.code !== 'string' ||
		!ERROR_CODE_PATTERN.test(value.code)
	) {
		throw new Error('Invalid database restore error code');
	}
	if (
		typeof value.message !== 'string' ||
		value.message.length < 1 ||
		value.message.length > 1000 ||
		/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value.message)
	) {
		throw new Error('Invalid database restore error message');
	}
}

function assertNullableJobResult(
	value: unknown
): asserts value is DatabaseRestoreJobResult | null {
	if (value === null) return;
	if (!isPlainObject(value)) {
		throw new Error('Invalid database restore result');
	}
	assertExactKeys(value, [
		'restoredAt',
		'safetyBackupFileName',
		'safetyBackupSha256',
		'verifiedAt'
	]);
	if (
		typeof value.safetyBackupFileName !== 'string' ||
		!/^safety-[0-9a-f-]{36}\.dump$/.test(value.safetyBackupFileName)
	) {
		throw new Error('Invalid database restore safety backup file name');
	}
	if (
		typeof value.safetyBackupSha256 !== 'string' ||
		!SHA256_PATTERN.test(value.safetyBackupSha256)
	) {
		throw new Error('Invalid database restore safety backup SHA-256');
	}
	assertNullableIsoTimestamp(value.restoredAt, 'restoredAt');
	assertNullableIsoTimestamp(value.verifiedAt, 'verifiedAt');
}

function assertIsoTimestamp(
	value: unknown,
	fieldName: string
): asserts value is string {
	if (
		typeof value !== 'string' ||
		Number.isNaN(Date.parse(value)) ||
		new Date(value).toISOString() !== value
	) {
		throw new Error(`Invalid database restore ${fieldName}`);
	}
}

function assertNullableIsoTimestamp(
	value: unknown,
	fieldName: string
): asserts value is string | null {
	if (value !== null) assertIsoTimestamp(value, fieldName);
}

function assertReference(
	value: unknown,
	fieldName: string
): asserts value is string {
	if (
		typeof value !== 'string' ||
		value !== value.trim() ||
		!REFERENCE_PATTERN.test(value)
	) {
		throw new Error(`Invalid database restore ${fieldName}`);
	}
}

function assertNullableReference(
	value: unknown,
	fieldName: string
): asserts value is string | null {
	if (value !== null) assertReference(value, fieldName);
}

function assertNullableRevision(
	value: unknown
): asserts value is string | null {
	if (
		value !== null &&
		(typeof value !== 'string' || !APP_REVISION_PATTERN.test(value))
	) {
		throw new Error('Invalid database restore publish receipt revision');
	}
}

function assertNullableSignature(
	value: unknown
): asserts value is string | null {
	if (
		value !== null &&
		(typeof value !== 'string' || !SIGNATURE_PATTERN.test(value))
	) {
		throw new Error(
			'Invalid database restore publish receipt permit signature'
		);
	}
}

function assertSignedPayload<T extends Record<string, unknown>>(
	value: unknown,
	expectedKeys: readonly string[],
	assertPayload: (payload: unknown) => asserts payload is T,
	label: string
): asserts value is T & { signature: string } {
	if (!isPlainObject(value)) {
		throw new Error(`${label} must be an object`);
	}
	assertExactKeys(value, expectedKeys);
	if (
		typeof value.signature !== 'string' ||
		!SIGNATURE_PATTERN.test(value.signature)
	) {
		throw new Error(`Invalid ${label.toLowerCase()} signature`);
	}
	const payload = { ...value };
	delete payload.signature;
	assertPayload(payload);
}

function verifySignedPayload(
	value: { signature: string },
	secret: string
): boolean {
	try {
		assertDatabaseRestoreQueueSecret(secret);
		const signedValue = value as unknown as Record<string, unknown>;
		const signature = value.signature;
		const payload = { ...signedValue };
		delete payload.signature;
		const expected = createHmac('sha256', secret)
			.update(canonicalDatabaseRestoreJson(payload))
			.digest();
		const supplied = Buffer.from(signature, 'hex');
		return (
			supplied.length === expected.length &&
			timingSafeEqual(supplied, expected)
		);
	} catch {
		return false;
	}
}

function parseDatabaseRestoreJson(raw: string, message: string): unknown {
	try {
		return JSON.parse(raw);
	} catch {
		throw new Error(message);
	}
}

function assertExactKeys(
	value: Record<string, unknown>,
	expectedKeys: readonly string[]
): void {
	const actualKeys = Object.keys(value).sort();
	const sortedExpectedKeys = [...expectedKeys].sort();
	if (
		actualKeys.length !== sortedExpectedKeys.length ||
		actualKeys.some((key, index) => key !== sortedExpectedKeys[index])
	) {
		throw new Error('Database restore manifest has unexpected fields');
	}
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	if (
		typeof value !== 'object' ||
		value === null ||
		Array.isArray(value)
	) {
		return false;
	}
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}
