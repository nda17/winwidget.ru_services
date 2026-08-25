import { IdentityInternalClient } from '@/identity-boundary/identity-internal.client';
import type {
	AdminEventLogAction,
	AdminEventLogSection
} from '@/admin-event-log/admin-event-log.contract';
import {
	ADMIN_AUDIT_EVENT_TYPE,
	CORE_ADMIN_AUDIT_ROUTING_KEY
} from '@/messaging/messaging.constants';
import { createMessagingHeaders } from '@/messaging/messaging-context';
import { assertMessagingEventContract } from '@/messaging/messaging-event-contract';
import { PrismaService } from '@/prisma.service';
import { getClientIp } from '@/utils/ip.util';
import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { Request } from 'express';
import { randomUUID } from 'node:crypto';

export interface AdminEventLogRecordInput {
	adminId?: string | null;
	adminName?: string | null;
	adminEmail?: string | null;
	section: AdminEventLogSection;
	action: AdminEventLogAction;
	description: string;
	entityType?: string | null;
	entityId?: string | null;
	entityLabel?: string | null;
	targetUserId?: string | null;
	targetUserName?: string | null;
	targetUserEmail?: string | null;
	metadata?: Prisma.InputJsonValue;
	request?: Request;
	ip?: string | null;
	userAgent?: string | null;
}

interface UserSnapshot {
	name: string | null;
	email: string | null;
}

@Injectable()
export class AdminEventLogService {
	private readonly logger = new Logger(AdminEventLogService.name);

	constructor(
		private readonly prisma: PrismaService,
		private readonly identity: IdentityInternalClient
	) {}

	async record(input: AdminEventLogRecordInput) {
		return this.recordWithClient(this.prisma, input);
	}

	async recordOnce(recordId: string, input: AdminEventLogRecordInput) {
		const normalizedRecordId = recordId.trim();
		if (!/^[A-Za-z0-9_-]{1,128}$/.test(normalizedRecordId)) {
			throw new Error('Admin event log idempotency id is invalid');
		}
		try {
			return await this.recordWithClient(
				this.prisma,
				input,
				normalizedRecordId
			);
		} catch (error) {
			try {
				const existing = await this.prisma.outboxEvent.findUnique({
					where: {
						deduplicationKey: this.getDeduplicationKey(normalizedRecordId)
					}
				});
				if (
					existing?.eventType === ADMIN_AUDIT_EVENT_TYPE &&
					existing.routingKey === CORE_ADMIN_AUDIT_ROUTING_KEY &&
					this.matchesIdempotentAudit(existing.payload, input)
				) {
					return existing;
				}
			} catch {
				// The original error is logged below without exposing audit payloads.
			}
			throw error;
		}
	}

	recordInTransaction(
		transaction: Prisma.TransactionClient,
		input: AdminEventLogRecordInput
	) {
		return this.recordWithClient(transaction, input);
	}

	private async recordWithClient(
		client: Prisma.TransactionClient | PrismaService,
		input: AdminEventLogRecordInput,
		recordId?: string
	) {
		const [adminSnapshot, targetUserSnapshot] =
			await this.resolveUserSnapshots(input);
		const requestSnapshot = input.request
			? this.getRequestSnapshot(input.request)
			: {
					ip: input.ip || null,
					userAgent: input.userAgent || null
				};

		const eventId = randomUUID();
		const description = input.description.trim();
		if (!description) {
			throw new Error('Admin event description must not be empty');
		}
		const metadata = this.getMetadata(input.metadata);
		const headers = createMessagingHeaders({ messageId: eventId });
		const correlationId = String(headers['x-correlation-id']);
		const payload: Prisma.InputJsonObject = {
			schemaVersion: 1,
			eventType: ADMIN_AUDIT_EVENT_TYPE,
			eventId,
			occurredAt: new Date().toISOString(),
			correlationId,
			actorId: input.adminId || 'system:core',
			action: input.action,
			section: input.section,
			description,
			actorSnapshot: {
				name: adminSnapshot.name,
				email: adminSnapshot.email
			},
			entity: {
				type: input.entityType?.trim() || 'admin_event',
				id: input.entityId?.trim() || eventId,
				label: input.entityLabel || null,
				targetUserId: input.targetUserId || null,
				targetSnapshot: {
					name: targetUserSnapshot.name,
					email: targetUserSnapshot.email
				}
			},
			metadata: {
				...metadata,
				requestIp: requestSnapshot.ip,
				requestUserAgent: requestSnapshot.userAgent
			}
		};
		assertMessagingEventContract(payload, {
			eventType: ADMIN_AUDIT_EVENT_TYPE,
			routingKey: CORE_ADMIN_AUDIT_ROUTING_KEY,
			messageId: eventId
		});

		return client.outboxEvent.create({
			data: {
				messageId: eventId,
				...(recordId
					? { deduplicationKey: this.getDeduplicationKey(recordId) }
					: {}),
				eventType: ADMIN_AUDIT_EVENT_TYPE,
				routingKey: CORE_ADMIN_AUDIT_ROUTING_KEY,
				payload,
				headers
			}
		});
	}

	private getMetadata(value: Prisma.InputJsonValue | undefined) {
		if (value === undefined) return {};
		if (!value || typeof value !== 'object' || Array.isArray(value)) {
			throw new Error('Admin event metadata must be an object');
		}
		return value as Prisma.InputJsonObject;
	}

	private getDeduplicationKey(recordId: string) {
		return `core-admin-audit:${recordId}`;
	}

	private matchesIdempotentAudit(
		value: Prisma.JsonValue,
		input: AdminEventLogRecordInput
	): boolean {
		if (!value || typeof value !== 'object' || Array.isArray(value)) {
			return false;
		}
		const entity = value.entity;
		return (
			value.action === input.action &&
			Boolean(entity) &&
			typeof entity === 'object' &&
			!Array.isArray(entity) &&
			entity.id === (input.entityId?.trim() || value.eventId)
		);
	}

	private async resolveUserSnapshots(
		input: AdminEventLogRecordInput
	): Promise<[UserSnapshot, UserSnapshot]> {
		const requestedIds = [
			input.adminName === undefined && input.adminEmail === undefined
				? input.adminId
				: undefined,
			input.targetUserName === undefined &&
			input.targetUserEmail === undefined
				? input.targetUserId
				: undefined
		].filter((value): value is string => Boolean(value));
		const uniqueIds = [...new Set(requestedIds)];
		let snapshots = new Map<string, UserSnapshot>();
		if (uniqueIds.length) {
			try {
				snapshots = await this.identity.getAuditSnapshots(uniqueIds);
			} catch (error) {
				this.logger.warn(
					`Identity audit snapshot lookup failed: ${
						error instanceof Error ? error.message : String(error)
					}`
				);
			}
		}
		return [
			this.resolveUserSnapshot(
				input.adminId,
				input.adminName,
				input.adminEmail,
				snapshots
			),
			this.resolveUserSnapshot(
				input.targetUserId,
				input.targetUserName,
				input.targetUserEmail,
				snapshots
			)
		];
	}

	private resolveUserSnapshot(
		userId: string | null | undefined,
		providedName: string | null | undefined,
		providedEmail: string | null | undefined,
		snapshots: Map<string, UserSnapshot>
	): UserSnapshot {
		if (providedName !== undefined || providedEmail !== undefined) {
			return {
				name: providedName ?? null,
				email: providedEmail ?? null
			};
		}
		return (
			(userId && snapshots.get(userId)) || { name: null, email: null }
		);
	}

	private getRequestSnapshot(request?: Request) {
		if (!request) {
			return {
				ip: null,
				userAgent: null
			};
		}

		const userAgent = this.getHeaderValue(request.headers['user-agent']);

		return {
			ip: getClientIp(request) || null,
			userAgent: userAgent || null
		};
	}

	private getHeaderValue(value?: string | string[]) {
		if (Array.isArray(value)) {
			return value[0]?.trim() || null;
		}

		return value?.trim() || null;
	}
}
