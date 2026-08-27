import { Injectable } from '@nestjs/common';
import { OutboxStatus } from '@prisma/platform-client';
import { PlatformPrismaService } from '../prisma/platform-prisma.service';
import {
	PLATFORM_PROCESS_ROLES,
	parsePlatformPort,
	type PlatformProcessRole
} from '../runtime/platform-runtime.service';

const STALE_OUTBOX_MS = 15 * 60_000;
const READINESS_TIMEOUT_MS = 2_000;
const UUID =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type PlatformRoleReadiness = {
	service: 'platform-api' | 'platform-outbox-publisher';
	status: 'ok' | 'down';
	activeInstances: number;
	lastSeenAt: string | null;
	revision: string | null;
};

const ROLE_SERVICE_NAMES: Record<
	PlatformProcessRole,
	PlatformRoleReadiness['service']
> = {
	api: 'platform-api',
	'outbox-publisher': 'platform-outbox-publisher'
};

@Injectable()
export class PlatformMessagingAdminService {
	constructor(private readonly prisma: PlatformPrismaService) {}

	async overview() {
		const now = new Date();
		const staleBefore = new Date(now.getTime() - STALE_OUTBOX_MS);
		const [
			outboxGroups,
			oldestDuePending,
			oldestExpiredProcessing,
			oldestUnleasedProcessing,
			dueOutbox,
			staleOutbox,
			heartbeats
		] = await Promise.all([
			this.prisma.outboxEvent.groupBy({
				by: ['status'],
				_count: { _all: true }
			}),
			this.prisma.outboxEvent.findFirst({
				where: {
					status: OutboxStatus.PENDING,
					availableAt: { lte: now }
				},
				orderBy: { availableAt: 'asc' },
				select: { availableAt: true }
			}),
			this.prisma.outboxEvent.findFirst({
				where: {
					status: OutboxStatus.PROCESSING,
					leaseUntil: { lte: now }
				},
				orderBy: { leaseUntil: 'asc' },
				select: { leaseUntil: true }
			}),
			this.prisma.outboxEvent.findFirst({
				where: {
					status: OutboxStatus.PROCESSING,
					leaseUntil: null
				},
				orderBy: { createdAt: 'asc' },
				select: { createdAt: true }
			}),
			this.prisma.outboxEvent.count({
				where: {
					OR: [
						{
							status: OutboxStatus.PENDING,
							availableAt: { lte: now }
						},
						{
							status: OutboxStatus.PROCESSING,
							OR: [{ leaseUntil: null }, { leaseUntil: { lte: now } }]
						}
					]
				}
			}),
			this.prisma.outboxEvent.count({
				where: {
					OR: [
						{
							status: OutboxStatus.PENDING,
							availableAt: { lt: staleBefore }
						},
						{
							status: OutboxStatus.PROCESSING,
							OR: [
								{ leaseUntil: null },
								{ leaseUntil: { lt: staleBefore } }
							]
						}
					]
				}
			}),
			Promise.all(
				PLATFORM_PROCESS_ROLES.map(role =>
					this.getRoleReadiness(role, now)
				)
			)
		]);
		const outbox = { PENDING: 0, PROCESSING: 0, PUBLISHED: 0 };
		for (const group of outboxGroups) {
			outbox[group.status] = group._count._all;
		}
		const oldestPendingAt = [
			oldestDuePending?.availableAt || null,
			oldestExpiredProcessing?.leaseUntil || null,
			oldestUnleasedProcessing?.createdAt || null
		]
			.filter((value): value is Date => Boolean(value))
			.sort((left, right) => left.getTime() - right.getTime())[0];

		return {
			schemaVersion: 1 as const,
			generatedAt: now.toISOString(),
			outbox,
			oldestPendingAt: oldestPendingAt?.toISOString() || null,
			operational: { dueOutbox, staleOutbox },
			heartbeats
		};
	}

	private async getRoleReadiness(
		role: PlatformProcessRole,
		now: Date
	): Promise<PlatformRoleReadiness> {
		const service = ROLE_SERVICE_NAMES[role];
		try {
			const response = await fetch(
				`http://127.0.0.1:${parsePlatformPort(role)}/health/ready`,
				{
					headers: { Accept: 'application/json' },
					redirect: 'error',
					signal: AbortSignal.timeout(READINESS_TIMEOUT_MS)
				}
			);
			const body: unknown = await response.json().catch(() => null);
			if (!response.ok || !this.isRoleReadiness(body, role)) {
				return this.downRole(service);
			}
			return {
				service,
				status: 'ok',
				activeInstances: 1,
				lastSeenAt: now.toISOString(),
				revision: body.revision
			};
		} catch {
			return this.downRole(service);
		}
	}

	private isRoleReadiness(
		value: unknown,
		role: PlatformProcessRole
	): value is { revision: string } {
		if (!value || typeof value !== 'object' || Array.isArray(value)) {
			return false;
		}
		const body = value as Record<string, unknown>;
		const database =
			body.database &&
			typeof body.database === 'object' &&
			!Array.isArray(body.database)
				? (body.database as Record<string, unknown>)
				: null;
		return (
			body.status === 'ready' &&
			body.service === 'platform' &&
			body.role === role &&
			typeof body.revision === 'string' &&
			body.revision.length > 0 &&
			body.revision.length <= 128 &&
			database?.serviceName === 'platform-service' &&
			typeof database.databaseId === 'string' &&
			UUID.test(database.databaseId) &&
			typeof database.currentSemanticFingerprint === 'string' &&
			/^[0-9a-f]{64}$/.test(database.currentSemanticFingerprint) &&
			typeof database.createdAt === 'string' &&
			Number.isFinite(Date.parse(database.createdAt)) &&
			typeof database.updatedAt === 'string' &&
			Number.isFinite(Date.parse(database.updatedAt))
		);
	}

	private downRole(
		service: PlatformRoleReadiness['service']
	): PlatformRoleReadiness {
		return {
			service,
			status: 'down',
			activeInstances: 0,
			lastSeenAt: null,
			revision: null
		};
	}
}
