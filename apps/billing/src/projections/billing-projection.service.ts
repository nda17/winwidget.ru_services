import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { BillingPrismaService } from '../prisma/billing-prisma.service';
import {
	AUTO_RENEWAL_CONSENT_TEXT,
	AUTO_RENEWAL_CONSENT_VERSION
} from '../domain/billing-legal.constants';

export interface ProjectionEnvelope {
	eventId: string;
	eventType: string;
	aggregateId: string;
	aggregateVersion: bigint;
	sourceSequence: bigint;
	sourceSequenceContractVersion: 2 | null;
	sourceSequenceScope: 'billing.offer:offer' | null;
	occurredAt: Date;
	tombstone: boolean;
	state: Record<string, unknown> | null;
}

@Injectable()
export class BillingProjectionService {
	constructor(private readonly prisma: BillingPrismaService) {}

	parse(value: unknown, expectedType: string): ProjectionEnvelope {
		if (!value || typeof value !== 'object' || Array.isArray(value)) {
			throw new Error('Billing projection envelope must be an object');
		}
		const event = value as Record<string, unknown>;
		const billingOfferV2 = expectedType === 'billing.offer.changed.v2';
		const exactKeys = [
			'schemaVersion',
			'eventType',
			'eventId',
			'aggregateId',
			'aggregateVersion',
			'sourceSequence',
			'occurredAt',
			'tombstone',
			'state',
			...(billingOfferV2
				? ['sourceSequenceContractVersion', 'sourceSequenceScope']
				: [])
		].sort();
		if (
			Object.keys(event).length !== exactKeys.length ||
			Object.keys(event)
				.sort()
				.some((key, index) => key !== exactKeys[index]) ||
			event.schemaVersion !== (billingOfferV2 ? 2 : 1) ||
			event.eventType !== expectedType
		) {
			throw new Error('Billing projection envelope type is invalid');
		}
		for (const key of [
			'eventId',
			'aggregateId',
			'aggregateVersion',
			'sourceSequence',
			'occurredAt'
		] as const) {
			if (typeof event[key] !== 'string' || !event[key]) {
				throw new Error(`Billing projection envelope ${key} is invalid`);
			}
		}
		if (
			!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
				event.eventId as string
			)
		) {
			throw new Error('Billing projection envelope eventId is invalid');
		}
		if (
			!/^\d+$/.test(event.aggregateVersion as string) ||
			!/^\d+$/.test(event.sourceSequence as string)
		) {
			throw new Error('Billing projection version is invalid');
		}
		const aggregateVersion = BigInt(event.aggregateVersion as string);
		const sourceSequence = BigInt(event.sourceSequence as string);
		if (aggregateVersion < 1n || sourceSequence < 1n) {
			throw new Error('Billing projection version must be positive');
		}
		if (
			billingOfferV2 &&
			(event.sourceSequenceContractVersion !== 2 ||
				event.sourceSequenceScope !== 'billing.offer:offer')
		) {
			throw new Error('Billing offer scoped sequence contract is invalid');
		}
		const occurredAt = new Date(event.occurredAt as string);
		if (!Number.isFinite(occurredAt.getTime())) {
			throw new Error('Billing projection occurredAt is invalid');
		}
		if (typeof event.tombstone !== 'boolean') {
			throw new Error('Billing projection tombstone is invalid');
		}
		if (
			event.tombstone
				? event.state !== null
				: !event.state ||
					typeof event.state !== 'object' ||
					Array.isArray(event.state)
		) {
			throw new Error('Billing projection state is invalid');
		}
		const parsed = {
			eventId: event.eventId as string,
			eventType: event.eventType as string,
			aggregateId: event.aggregateId as string,
			aggregateVersion,
			sourceSequence,
			sourceSequenceContractVersion: billingOfferV2 ? (2 as const) : null,
			sourceSequenceScope: billingOfferV2
				? ('billing.offer:offer' as const)
				: null,
			occurredAt,
			tombstone: event.tombstone,
			state: event.state as Record<string, unknown> | null
		};
		this.assertParsedSourceState(parsed, expectedType);
		return parsed;
	}

	async applyIdentity(
		event: ProjectionEnvelope
	): Promise<'applied' | 'stale'> {
		const current = await this.prisma.identityContactProjection.findUnique(
			{
				where: { userId: event.aggregateId }
			}
		);
		if (current && current.projectionVersion >= event.aggregateVersion)
			return 'stale';
		const state = event.state;
		if (!event.tombstone)
			this.assertIdentityState(state!, event.aggregateId);
		const data = event.tombstone
			? {
					name: null,
					email: null,
					phone: null,
					status: 'DEACTIVATED',
					roles: [] as string[],
					telegramChatId: null,
					telegramChannelActive: false,
					deletedAt: event.occurredAt,
					tombstone: true,
					sourceCreatedAt: null,
					sourceUpdatedAt: event.occurredAt
				}
			: {
					name: this.nullableString(state!.name),
					email: this.nullableString(state!.email),
					phone: this.nullableString(state!.phone),
					status: state!.status as string,
					roles: state!.roles as string[],
					telegramChatId: this.nullableString(state!.telegramChatId),
					telegramChannelActive: state!.telegramChannelActive as boolean,
					deletedAt: this.nullableDate(state!.deletedAt),
					tombstone: false,
					sourceCreatedAt: this.requiredDate(state!.createdAt),
					sourceUpdatedAt: this.requiredDate(state!.updatedAt)
				};
		const changed = current
			? await this.prisma.identityContactProjection.updateMany({
					where: {
						userId: event.aggregateId,
						projectionVersion: { lt: event.aggregateVersion }
					},
					data: {
						...data,
						projectionVersion: event.aggregateVersion,
						sourceSequence: event.sourceSequence,
						lastEventId: event.eventId
					}
				})
			: null;
		if (changed?.count === 1) return 'applied';
		if (current) return 'stale';
		try {
			await this.prisma.identityContactProjection.create({
				data: {
					userId: event.aggregateId,
					...data,
					projectionVersion: event.aggregateVersion,
					sourceSequence: event.sourceSequence,
					lastEventId: event.eventId
				}
			});
			return 'applied';
		} catch (error) {
			if ((error as { code?: string }).code === 'P2002')
				return this.applyIdentity(event);
			throw error;
		}
	}

	async applyNotificationRouting(
		event: ProjectionEnvelope
	): Promise<'applied' | 'stale'> {
		const current =
			await this.prisma.notificationRoutingProjection.findUnique({
				where: { id: event.aggregateId }
			});
		if (current && current.projectionVersion >= event.aggregateVersion)
			return 'stale';
		if (!event.tombstone) {
			const state = event.state!;
			if (
				!this.exactKeys(state, [
					'id',
					'telegramChatId',
					'paymentsThreadId',
					'updatedAt'
				]) ||
				state.id !== event.aggregateId ||
				typeof state.updatedAt !== 'string'
			) {
				throw new Error('Notification routing state is invalid');
			}
		}
		const state = event.state;
		const data = {
			telegramChatId: event.tombstone
				? null
				: this.nullableString(state!.telegramChatId),
			paymentsThreadId: event.tombstone
				? null
				: this.nullableInteger(state!.paymentsThreadId),
			projectionVersion: event.aggregateVersion,
			sourceSequence: event.sourceSequence,
			tombstone: event.tombstone,
			lastEventId: event.eventId,
			sourceUpdatedAt: event.tombstone
				? event.occurredAt
				: this.requiredDate(state!.updatedAt)
		};
		if (current) {
			const changed =
				await this.prisma.notificationRoutingProjection.updateMany({
					where: {
						id: event.aggregateId,
						projectionVersion: { lt: event.aggregateVersion }
					},
					data
				});
			return changed.count === 1 ? 'applied' : 'stale';
		}
		try {
			await this.prisma.notificationRoutingProjection.create({
				data: { id: event.aggregateId, ...data }
			});
			return 'applied';
		} catch (error) {
			if ((error as { code?: string }).code === 'P2002')
				return this.applyNotificationRouting(event);
			throw error;
		}
	}

	async applyOffer(
		event: ProjectionEnvelope
	): Promise<'applied' | 'stale'> {
		if (
			event.aggregateId !== 'offer' ||
			event.sourceSequenceContractVersion !== 2 ||
			event.sourceSequenceScope !== 'billing.offer:offer'
		) {
			throw new Error('Billing offer aggregate is invalid');
		}
		const state = event.state;
		if (!event.tombstone) {
			const exactKeys = [
				'id',
				'content',
				'sha256',
				'updatedAt',
				'consentVersion',
				'consentText'
			].sort();
			if (
				!state ||
				Object.keys(state)
					.sort()
					.some((key, index) => key !== exactKeys[index]) ||
				Object.keys(state).length !== exactKeys.length ||
				state.id !== 'offer' ||
				typeof state.content !== 'string' ||
				typeof state.sha256 !== 'string' ||
				!/^[0-9a-f]{64}$/.test(state.sha256) ||
				createHash('sha256')
					.update(state.content, 'utf8')
					.digest('hex') !== state.sha256 ||
				typeof state.consentVersion !== 'string' ||
				!state.consentVersion ||
				typeof state.consentText !== 'string'
			) {
				throw new Error('Billing offer state is invalid');
			}
			this.requiredDate(state.updatedAt);
		}
		return this.prisma.$transaction(async transaction => {
			await transaction.$executeRaw`
				SELECT pg_advisory_xact_lock(hashtextextended(${'billing.offer:offer'}, 0))
			`;
			const current = await transaction.billingOfferProjection.findUnique({
				where: { id: 'offer' }
			});
			if (current && current.projectionVersion >= event.aggregateVersion)
				return 'stale';
			const content = event.tombstone ? null : (state!.content as string);
			const sha256 = event.tombstone ? null : (state!.sha256 as string);
			const consentVersion = event.tombstone
				? null
				: (state!.consentVersion as string);
			const consentText = event.tombstone
				? null
				: (state!.consentText as string);
			const sourceUpdatedAt = event.tombstone
				? event.occurredAt
				: this.requiredDate(state!.updatedAt);
			await transaction.billingOfferProjection.upsert({
				where: { id: 'offer' },
				create: {
					id: 'offer',
					content,
					sha256,
					consentVersion,
					consentText,
					sourceUpdatedAt,
					projectionVersion: event.aggregateVersion,
					sourceSequence: event.sourceSequence,
					tombstone: event.tombstone,
					lastEventId: event.eventId
				},
				update: {
					content,
					sha256,
					consentVersion,
					consentText,
					sourceUpdatedAt,
					projectionVersion: event.aggregateVersion,
					sourceSequence: event.sourceSequence,
					tombstone: event.tombstone,
					lastEventId: event.eventId
				}
			});
			await transaction.billingSettings.upsert({
				where: { id: 'singleton' },
				create: {
					id: 'singleton',
					offerSnapshot: content || '',
					offerSectionHash: sha256 || '',
					offerUpdatedAt: event.tombstone ? null : sourceUpdatedAt,
					consentVersion: consentVersion || '',
					consentText: consentText || ''
				},
				update: {
					offerSnapshot: content || '',
					offerSectionHash: sha256 || '',
					offerUpdatedAt: event.tombstone ? null : sourceUpdatedAt,
					consentVersion: consentVersion || '',
					consentText: consentText || ''
				}
			});
			return 'applied';
		});
	}

	private assertIdentityState(
		state: Record<string, unknown>,
		aggregateId: string
	) {
		if (
			!this.exactKeys(state, [
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
			]) ||
			state.id !== aggregateId ||
			(state.name !== null && typeof state.name !== 'string') ||
			(state.email !== null && typeof state.email !== 'string') ||
			(state.phone !== null && typeof state.phone !== 'string') ||
			!['ACTIVE', 'DEACTIVATED'].includes(String(state.status)) ||
			!Array.isArray(state.roles) ||
			!state.roles.every(role =>
				['USER', 'ADMIN', 'DEV'].includes(String(role))
			) ||
			(state.telegramChatId !== null &&
				typeof state.telegramChatId !== 'string') ||
			typeof state.telegramChannelActive !== 'boolean'
		) {
			throw new Error('Identity projection state is invalid');
		}
		this.requiredDate(state.createdAt);
		this.requiredDate(state.updatedAt);
		this.nullableDate(state.deletedAt);
	}

	private assertParsedSourceState(
		event: ProjectionEnvelope,
		expectedType: string
	): void {
		if (event.tombstone) return;
		const state = event.state!;
		if (expectedType === 'billing.identity.changed.v1') {
			this.assertIdentityState(state, event.aggregateId);
			return;
		}
		if (expectedType === 'billing.notification-routing.changed.v1') {
			if (
				!this.exactKeys(state, [
					'id',
					'telegramChatId',
					'paymentsThreadId',
					'updatedAt'
				]) ||
				state.id !== event.aggregateId ||
				typeof state.updatedAt !== 'string'
			)
				throw new Error('Notification routing state is invalid');
			this.nullableString(state.telegramChatId);
			this.nullableInteger(state.paymentsThreadId);
			this.requiredDate(state.updatedAt);
			return;
		}
		if (expectedType === 'billing.offer.changed.v2') {
			if (
				!this.exactKeys(state, [
					'id',
					'content',
					'sha256',
					'updatedAt',
					'consentVersion',
					'consentText'
				]) ||
				state.id !== 'offer' ||
				typeof state.content !== 'string' ||
				typeof state.sha256 !== 'string' ||
				!/^[0-9a-f]{64}$/.test(state.sha256) ||
				createHash('sha256')
					.update(state.content, 'utf8')
					.digest('hex') !== state.sha256 ||
				state.consentVersion !== AUTO_RENEWAL_CONSENT_VERSION ||
				state.consentText !== AUTO_RENEWAL_CONSENT_TEXT
			)
				throw new Error('Billing offer state is invalid');
			this.requiredDate(state.updatedAt);
			return;
		}
		if (expectedType === 'billing.trial.requested.v1') {
			if (
				!this.exactKeys(state, ['userId', 'trialDays', 'registeredAt']) ||
				state.userId !== event.aggregateId ||
				state.trialDays !== 7
			)
				throw new Error('Billing trial request state is invalid');
			this.requiredDate(state.registeredAt);
			return;
		}
		if (expectedType === 'billing.referral.requested.v1') {
			if (
				!this.exactKeys(state, [
					'referrerId',
					'referredUserId',
					'requestedAt'
				]) ||
				state.referredUserId !== event.aggregateId ||
				typeof state.referrerId !== 'string' ||
				!state.referrerId ||
				state.referrerId === event.aggregateId
			)
				throw new Error('Billing referral request state is invalid');
			this.requiredDate(state.requestedAt);
			return;
		}
		if (expectedType === 'billing.lifecycle-repair.requested.v1') {
			if (
				!this.exactKeys(state, [
					'commandId',
					'userId',
					'operation',
					'actorId',
					'actorRole',
					'requestedAt'
				]) ||
				state.userId !== event.aggregateId ||
				!['DEACTIVATE', 'DELETE'].includes(String(state.operation)) ||
				!['ADMIN', 'DEV'].includes(String(state.actorRole)) ||
				typeof state.commandId !== 'string' ||
				!this.uuid(state.commandId) ||
				typeof state.actorId !== 'string' ||
				!state.actorId
			)
				throw new Error('Billing lifecycle repair state is invalid');
			this.requiredDate(state.requestedAt);
		}
	}

	private uuid(value: unknown): value is string {
		return (
			typeof value === 'string' &&
			/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
				value
			)
		);
	}

	private exactKeys(
		value: Record<string, unknown>,
		expected: readonly string[]
	): boolean {
		const actual = Object.keys(value).sort();
		const sorted = [...expected].sort();
		return (
			actual.length === sorted.length &&
			actual.every((key, index) => key === sorted[index])
		);
	}

	private nullableString(value: unknown): string | null {
		if (value === null) return null;
		if (typeof value !== 'string')
			throw new Error('Projection string is invalid');
		return value;
	}

	private nullableInteger(value: unknown): number | null {
		if (value === null) return null;
		if (!Number.isInteger(value))
			throw new Error('Projection integer is invalid');
		return value as number;
	}

	private nullableDate(value: unknown): Date | null {
		if (value === null) return null;
		return this.requiredDate(value);
	}

	private requiredDate(value: unknown): Date {
		if (typeof value !== 'string')
			throw new Error('Projection date is invalid');
		const date = new Date(value);
		if (!Number.isFinite(date.getTime()))
			throw new Error('Projection date is invalid');
		return date;
	}
}
