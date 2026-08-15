import { Injectable } from '@nestjs/common';
import {
	OutboxExchange,
	Prisma,
	type Role
} from '@prisma/identity-client';
import { randomUUID } from 'node:crypto';

export interface AuditEventInput {
	actorId: string;
	action: string;
	entityType: string;
	entityId: string;
	description: string;
	section?:
		| 'USERS'
		| 'TELEGRAM_BOT'
		| 'SITE_SETTINGS'
		| 'TASKS'
		| 'MESSAGING';
	entityLabel?: string | null;
	targetUserId?: string | null;
	metadata?: Prisma.InputJsonObject;
	requestId?: string;
	requestIp?: string;
	requestUserAgent?: string;
	correlationId?: string;
}

@Injectable()
export class IdentityEventsService {
	async emitBillingRequest(
		transaction: Prisma.TransactionClient,
		input: {
			eventType:
				| 'billing.referral.requested.v1'
				| 'billing.lifecycle-repair.requested.v1';
			aggregateType: string;
			aggregateId: string;
			state: Prisma.InputJsonObject;
			correlationId?: string;
		}
	): Promise<void> {
		const version = await this.nextVersion(
			transaction,
			input.aggregateType,
			input.aggregateId,
			input.eventType
		);
		await this.enqueueDomainEvent(transaction, {
			eventType: input.eventType,
			aggregateType: input.aggregateType,
			aggregateId: input.aggregateId,
			aggregateVersion: version.version,
			sourceSequence: version.sourceSequence,
			state: input.state,
			correlationId: input.correlationId
		});
	}

	async emitUserChanged(
		transaction: Prisma.TransactionClient,
		userId: string,
		correlationId?: string
	): Promise<void> {
		await transaction.$queryRaw(
			Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${`identity.user:${userId}`}, 0))`
		);
		const user = await transaction.user.findUnique({
			where: { id: userId },
			include: {
				authIdentities: true,
				telegramNotificationChannel: true
			}
		});
		if (!user) return;
		const identity = await this.nextVersion(
			transaction,
			'identity.user',
			userId,
			'identity.user.changed.v1'
		);
		const billing = await this.nextVersion(
			transaction,
			'billing.identity',
			userId,
			'billing.identity.changed.v1'
		);
		const identities = new Map(
			user.authIdentities.map(item => [item.type, item])
		);
		const roles = [...new Set(user.rights)].sort();
		const identityState = {
			id: user.id,
			status: user.status,
			deletedAt: user.deletedAt?.toISOString() || null,
			roles,
			hasEmailIdentity: identities.has('EMAIL'),
			hasPhoneIdentity: identities.has('PHONE'),
			hasTelegramIdentity: identities.has('TELEGRAM'),
			loginMethodCount:
				user.authIdentities.filter(item =>
					['EMAIL', 'GOOGLE', 'GITHUB', 'TELEGRAM'].includes(item.type)
				).length + (identities.get('PHONE')?.verifiedAt ? 1 : 0),
			createdAt: user.createdAt.toISOString(),
			updatedAt: user.updatedAt.toISOString()
		};
		const billingState = {
			id: user.id,
			name: user.name,
			email: identities.get('EMAIL')?.value || null,
			phone: identities.get('PHONE')?.value || null,
			status: user.status,
			deletedAt: user.deletedAt?.toISOString() || null,
			roles,
			telegramChatId: user.telegramNotificationChannel?.chatId || null,
			telegramChannelActive:
				user.telegramNotificationChannel?.isActive || false,
			createdAt: user.createdAt.toISOString(),
			updatedAt: user.updatedAt.toISOString()
		};
		await Promise.all([
			this.enqueueDomainEvent(transaction, {
				eventType: 'identity.user.changed.v1',
				aggregateType: 'identity.user',
				aggregateId: userId,
				aggregateVersion: identity.version,
				sourceSequence: identity.sourceSequence,
				state: identityState,
				correlationId
			}),
			this.enqueueDomainEvent(transaction, {
				eventType: 'billing.identity.changed.v1',
				aggregateType: 'billing.identity',
				aggregateId: userId,
				aggregateVersion: billing.version,
				sourceSequence: billing.sourceSequence,
				state: billingState,
				correlationId
			})
		]);
	}

	async emitAudit(
		transaction: Prisma.TransactionClient,
		input: AuditEventInput
	): Promise<void> {
		const safeMetadata = auditMetadata(input.action, input.metadata || {});
		const sourceSequence = await this.nextSequence(
			transaction,
			'admin.audit.identity.v1'
		);
		const snapshotIds = [
			...new Set([input.actorId, input.targetUserId].filter(Boolean))
		] as string[];
		const snapshots = await transaction.user.findMany({
			where: { id: { in: snapshotIds } },
			include: { authIdentities: true }
		});
		const snapshot = (id: string | null | undefined) => {
			const user = snapshots.find(item => item.id === id);
			return user
				? {
						name: user.name,
						email:
							user.authIdentities.find(item => item.type === 'EMAIL')
								?.value || null
					}
				: { name: null, email: null };
		};
		const eventId = randomUUID();
		const occurredAt = new Date().toISOString();
		await transaction.outboxEvent.create({
			data: {
				messageId: eventId,
				deduplicationKey: `admin.audit.identity.v1:${sourceSequence}`,
				exchange: OutboxExchange.AUDIT,
				eventType: 'admin.audit.event.v1',
				routingKey: 'admin.audit.identity.v1',
				sourceSequence,
				payload: {
					schemaVersion: 1,
					eventId,
					eventType: 'admin.audit.event.v1',
					occurredAt,
					correlationId: input.correlationId || eventId,
					actorId: input.actorId,
					actorSnapshot: snapshot(input.actorId),
					section: input.section || 'USERS',
					action: input.action,
					description: input.description,
					entity: {
						type: input.entityType,
						id: input.entityId,
						label: input.entityLabel || input.entityId,
						targetUserId: input.targetUserId || null,
						targetSnapshot: snapshot(input.targetUserId)
					},
					metadata: {
						...safeMetadata,
						...(input.requestId ? { requestId: input.requestId } : {}),
						...(input.requestIp ? { requestIp: input.requestIp } : {}),
						...(input.requestUserAgent
							? { requestUserAgent: input.requestUserAgent }
							: {})
					}
				}
			}
		});
	}

	private async enqueueDomainEvent(
		transaction: Prisma.TransactionClient,
		input: {
			eventType: string;
			aggregateType: string;
			aggregateId: string;
			aggregateVersion: bigint;
			sourceSequence: bigint;
			state: Prisma.InputJsonObject;
			correlationId?: string;
		}
	): Promise<void> {
		const eventId = randomUUID();
		const occurredAt = new Date().toISOString();
		await transaction.outboxEvent.create({
			data: {
				messageId: eventId,
				deduplicationKey: `${input.eventType}:${input.aggregateId}:${input.aggregateVersion}`,
				exchange: OutboxExchange.EVENTS,
				eventType: input.eventType,
				routingKey: input.eventType,
				aggregateType: input.aggregateType,
				aggregateId: input.aggregateId,
				aggregateVersion: input.aggregateVersion,
				sourceSequence: input.sourceSequence,
				headers: input.correlationId
					? { 'x-correlation-id': input.correlationId }
					: {},
				payload: {
					schemaVersion: 1,
					eventId,
					eventType: input.eventType,
					aggregateId: input.aggregateId,
					aggregateVersion: input.aggregateVersion.toString(),
					sourceSequence: input.sourceSequence.toString(),
					occurredAt,
					tombstone: false,
					state: input.state
				}
			}
		});
	}

	private async nextVersion(
		transaction: Prisma.TransactionClient,
		aggregateType: string,
		aggregateId: string,
		sequenceId: string
	): Promise<{ version: bigint; sourceSequence: bigint }> {
		const sourceSequence = await this.nextSequence(
			transaction,
			sequenceId
		);
		const rows = await transaction.$queryRaw<
			Array<{ version: bigint; sourceSequence: bigint }>
		>(Prisma.sql`
			INSERT INTO "identity"."aggregate_versions"
				("aggregate_type", "aggregate_id", "version", "source_sequence", "created_at", "updated_at")
			VALUES (${aggregateType}, ${aggregateId}, 1, ${sourceSequence}, NOW(), NOW())
			ON CONFLICT ("aggregate_type", "aggregate_id") DO UPDATE
			SET "version" = "identity"."aggregate_versions"."version" + 1,
				"source_sequence" = EXCLUDED."source_sequence",
				"updated_at" = NOW()
			RETURNING "version", "source_sequence" AS "sourceSequence"
		`);
		if (!rows[0]) throw new Error('Could not allocate aggregate version');
		return rows[0];
	}

	private async nextSequence(
		transaction: Prisma.TransactionClient,
		id: string
	): Promise<bigint> {
		const rows = await transaction.$queryRaw<Array<{ lastValue: bigint }>>(
			Prisma.sql`
				INSERT INTO "identity"."source_sequences"
					("id", "last_value", "created_at", "updated_at")
				VALUES (${id}, 1, NOW(), NOW())
				ON CONFLICT ("id") DO UPDATE
				SET "last_value" = "identity"."source_sequences"."last_value" + 1,
					"updated_at" = NOW()
				RETURNING "last_value" AS "lastValue"
			`
		);
		if (!rows[0]) throw new Error('Could not allocate source sequence');
		return rows[0].lastValue;
	}
}

const AUDIT_METADATA_KEYS: Record<string, readonly string[]> = {
	USER_UPDATE: ['changedFields', 'passwordChanged'],
	USER_TOGGLE_ACTIVATION: ['operation', 'commandId'],
	USER_SOFT_DELETE: ['operation', 'commandId'],
	USER_RESTORE: ['operation'],
	SITE_SETTINGS_UPDATE: [
		'changedFields',
		'recaptchaEnabled',
		'googleAuthEnabled',
		'yandexAuthEnabled',
		'githubAuthEnabled',
		'vkAuthEnabled',
		'telegramAuthEnabled'
	],
	TELEGRAM_BOT_WEBHOOK_REINSTALL: [
		'bot',
		'title',
		'dropPendingUpdates',
		'allowedUpdates',
		'secretConfigured',
		'installedAt'
	],
	VERIFICATION_CHALLENGE_CLEANUP_RUN: [
		'taskId',
		'title',
		'affectedCount',
		'message',
		'executedAt'
	],
	MESSAGING_FAILURE_RETRY: ['integration'],
	MESSAGING_FAILURE_CLOSE_WITHOUT_RETRY: ['integration', 'comment']
};

const RESERVED_AUDIT_KEYS = new Set([
	'eventid',
	'correlationid',
	'requestid',
	'requestip',
	'requestuseragent'
]);

const SECRET_AUDIT_KEY =
	/(password(?:hash|value|secret)?$|refresh.*token|access.*token|oauth.*token|otp|codehash|clientsecret|privatekey|authorization|cookie)/i;

export function auditMetadata(
	action: string,
	value: Prisma.InputJsonObject
): Prisma.InputJsonObject {
	const allowed = AUDIT_METADATA_KEYS[action];
	if (!allowed)
		throw new Error(`Unsupported Identity audit action ${action}`);
	const entries: Array<[string, Prisma.InputJsonValue]> = [];
	for (const [key, item] of Object.entries(value)) {
		const normalized = key.replace(/[^a-z0-9]/gi, '').toLowerCase();
		if (
			!allowed.includes(key) ||
			RESERVED_AUDIT_KEYS.has(normalized) ||
			SECRET_AUDIT_KEY.test(normalized)
		) {
			throw new Error(`Unsafe Identity audit metadata key ${key}`);
		}
		if (!safeAuditValue(item)) {
			throw new Error(`Unsafe Identity audit metadata value ${key}`);
		}
		entries.push([key, item]);
	}
	return Object.fromEntries(entries) as Prisma.InputJsonObject;
}

function safeAuditValue(
	value: Prisma.InputJsonValue | null | undefined
): value is Prisma.InputJsonValue {
	if (value === undefined) return false;
	if (value === null || typeof value === 'boolean') return true;
	if (typeof value === 'number') return Number.isSafeInteger(value);
	if (typeof value === 'string') return value.length <= 2_000;
	if (Array.isArray(value)) {
		return (
			value.length <= 100 &&
			value.every(item =>
				typeof item === 'string' ? item.length <= 255 : false
			)
		);
	}
	return false;
}

export function publicUser(user: {
	id: string;
	name: string | null;
	avatarPath: string | null;
	status: string;
	personalDataConsentRevokedAt: Date | null;
	deletedAt: Date | null;
	rights: Role[];
	createdAt: Date;
	updatedAt: Date;
	authIdentities: Array<{
		type: string;
		value: string;
		verifiedAt: Date | null;
	}>;
}) {
	const identity = (type: string) =>
		user.authIdentities.find(item => item.type === type);
	const loginMethodOrder = [
		'EMAIL',
		'PHONE',
		'GOOGLE',
		'GITHUB',
		'YANDEX',
		'VK',
		'TELEGRAM'
	];
	const loginMethods = loginMethodOrder.filter(type => {
		const item = identity(type);
		return Boolean(
			item?.value.trim() && (type !== 'PHONE' || item.verifiedAt)
		);
	});
	return {
		id: user.id,
		name: user.name,
		email: identity('EMAIL')?.value || null,
		phone: identity('PHONE')?.value || null,
		isPhoneVerified: Boolean(identity('PHONE')?.verifiedAt),
		avatarPath: user.avatarPath,
		status: user.status,
		personalDataConsentRevokedAt: user.personalDataConsentRevokedAt,
		deletedAt: user.deletedAt,
		rights: user.rights,
		loginMethods,
		createdAt: user.createdAt,
		updatedAt: user.updatedAt
	};
}
