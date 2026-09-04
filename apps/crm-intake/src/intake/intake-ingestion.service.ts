import {
	BadRequestException,
	ConflictException,
	ForbiddenException,
	HttpException,
	Injectable,
	ServiceUnavailableException,
	UnauthorizedException
} from '@nestjs/common';
import { IntakeSource, Prisma } from '@prisma/crm-intake-client';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';
import { IntakeAuthorizationClient } from '../access/intake-authorization.client';
import { CrmIntakePrismaService } from '../prisma/crm-intake-prisma.service';
import { IngestInboxEntryDto } from './intake.dto';
import { hashIntakeSourceToken } from './intake.service';

const UUID =
	/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const AUTH_ERROR = 'Source authentication is not valid';
const RATE_ERROR = {
	code: 'crm_intake_rate_limited',
	message: 'Intake request limit reached; retry later'
};
const digest = (value: string) =>
	createHash('sha256').update(value).digest('hex');

export function sourceTokenHash(
	authorization: string | undefined
): string {
	if (!authorization || !/^Bearer [A-Za-z0-9_-]{43}$/.test(authorization))
		throw new UnauthorizedException(AUTH_ERROR);
	try {
		return hashIntakeSourceToken(authorization.slice(7));
	} catch {
		throw new UnauthorizedException(AUTH_ERROR);
	}
}

function matchesSource(
	source: IntakeSource | null,
	tokenHash: string
): source is IntakeSource {
	// Always compare equal-length hashes, including an unknown source. Never expose the hash.
	const stored =
		source && /^[a-f0-9]{64}$/.test(source.tokenHash)
			? source.tokenHash
			: '0'.repeat(64);
	const matches = timingSafeEqual(
		Buffer.from(stored, 'hex'),
		Buffer.from(tokenHash, 'hex')
	);
	return (
		matches &&
		source !== null &&
		source.revokedAt === null &&
		source.kind === 'API'
	);
}

@Injectable()
export class IntakeIngestionRateLimiter {
	private readonly preauth = new Map<
		string,
		{ window: number; count: number }
	>();
	constructor(private readonly prisma: CrmIntakePrismaService) {}

	preauthenticate(peerIp: string, now = Date.now()): void {
		if (!isIP(peerIp))
			throw new BadRequestException('Request peer is unavailable');
		const window = Math.floor(now / 60_000);
		// Bounded memory, including requests carrying invalid source credentials.
		for (const [key, bucket] of this.preauth)
			if (bucket.window !== window) this.preauth.delete(key);
		let bucket = this.preauth.get(peerIp);
		if (!bucket) {
			if (this.preauth.size >= 10_000)
				throw new HttpException(RATE_ERROR, 429);
			bucket = { window, count: 0 };
			this.preauth.set(peerIp, bucket);
		}
		if (++bucket.count > 1200) throw new HttpException(RATE_ERROR, 429);
	}

	async consume(sourceId: string, peerIp: string): Promise<void> {
		try {
			await this.prisma.$transaction(async tx => {
				// Database time and atomic counters apply across Intake replicas. No public IP header is trusted.
				const buckets = [
					{ key: `source:${sourceId}`, limit: 120 },
					{ key: `ip:${digest(peerIp)}`, limit: 600 }
				].sort((a, b) => a.key.localeCompare(b.key));
				for (const bucket of buckets) {
					const rows = await tx.$queryRaw<
						Array<{ count: number }>
					>(Prisma.sql`
            INSERT INTO crm_intake.ingestion_rate_buckets (bucket_key, window_start, count)
            VALUES (${bucket.key}, date_trunc('minute', clock_timestamp() AT TIME ZONE 'UTC'), 1)
            ON CONFLICT (bucket_key, window_start) DO UPDATE SET count = crm_intake.ingestion_rate_buckets.count + 1
            WHERE crm_intake.ingestion_rate_buckets.count < ${bucket.limit}
            RETURNING count`);
					if (rows.length !== 1) throw new HttpException(RATE_ERROR, 429);
				}
				await tx.$executeRaw`DELETE FROM crm_intake.ingestion_rate_buckets WHERE (bucket_key, window_start) IN (SELECT bucket_key, window_start FROM crm_intake.ingestion_rate_buckets WHERE window_start < (clock_timestamp() AT TIME ZONE 'UTC') - interval '2 minutes' LIMIT 500)`;
			});
		} catch (error) {
			if (error instanceof HttpException) throw error;
			throw new ServiceUnavailableException(
				'Intake limits could not be confirmed'
			);
		}
	}
}

@Injectable()
export class IntakeIngestionService {
	constructor(
		private readonly prisma: CrmIntakePrismaService,
		private readonly authorization: IntakeAuthorizationClient,
		private readonly limits: IntakeIngestionRateLimiter
	) {}

	async ingest(
		sourceId: string,
		authorization: string | undefined,
		externalCommandId: string | undefined,
		dto: IngestInboxEntryDto,
		peerIp: string
	) {
		this.limits.preauthenticate(peerIp);
		const tokenHash = sourceTokenHash(authorization);
		if (
			!UUID.test(sourceId) ||
			!externalCommandId ||
			!UUID.test(externalCommandId)
		)
			throw new BadRequestException(
				'Source and Idempotency-Key must be UUID v4'
			);
		try {
			const source = await this.prisma.intakeSource.findUnique({
				where: { id: sourceId }
			});
			if (!matchesSource(source, tokenHash))
				throw new UnauthorizedException(AUTH_ERROR);
			await this.limits.consume(source.id, peerIp);
			// Every replay is freshly authorized. A durable source is not a durable user session.
			const context = await this.authorization.authorizeSource(
				source.workspaceId,
				source.createdBySubject
			);
			if (
				context.subject !== source.createdBySubject ||
				context.workspaceId !== source.workspaceId ||
				context.state === 'READ_ONLY' ||
				!['OWNER', 'CRM_ADMIN'].includes(context.role) ||
				!context.permissions.includes('intake:manage-sources') ||
				(source.teamId !== null &&
					!context.teamIds.includes(source.teamId))
			)
				throw new ForbiddenException(
					'Source authority is no longer active'
				);
			const payload = {
				title: dto.title.trim(),
				name: dto.name.trim(),
				phone: dto.phone ?? null,
				email: dto.email?.toLowerCase() ?? null,
				message: dto.message?.trim() || null
			};
			const requestHash = digest(
				JSON.stringify({
					schemaVersion: 1,
					sourceId: source.id,
					workspaceId: source.workspaceId,
					actor: source.createdBySubject,
					teamId: source.teamId,
					payload
				})
			);
			for (let attempt = 0; attempt < 3; attempt++) {
				try {
					return await this.prisma.$transaction(
						async tx => {
							// Rotation and revocation update this same row. Their commit cannot race past this lock.
							await tx.$queryRaw`SELECT id FROM crm_intake.intake_sources WHERE id = ${source.id}::uuid FOR UPDATE`;
							const current = await tx.intakeSource.findUnique({
								where: { id: source.id }
							});
							if (
								!matchesSource(current, tokenHash) ||
								current.tokenVersion !== source.tokenVersion ||
								current.version !== source.version ||
								current.workspaceId !== source.workspaceId ||
								current.createdBySubject !== source.createdBySubject ||
								current.teamId !== source.teamId
							)
								throw new UnauthorizedException(AUTH_ERROR);
							const receipt = await tx.inboundReceipt.findUnique({
								where: {
									sourceId_externalCommandId: {
										sourceId: source.id,
										externalCommandId
									}
								}
							});
							if (receipt) {
								if (
									receipt.requestHash !== requestHash ||
									receipt.workspaceId !== source.workspaceId
								)
									throw new ConflictException({
										code: 'crm_intake_command_conflict',
										message: 'Idempotency-Key was used for another request'
									});
								return {
									schemaVersion: 1 as const,
									entryId: receipt.entryId,
									receivedAt: receipt.receivedAt.toISOString()
								};
							}
							const entry = await tx.inboxEntry.create({
								data: {
									workspaceId: source.workspaceId,
									...payload,
									origin: 'API',
									sourceId: source.id,
									createdBySubject: source.createdBySubject,
									teamId: source.teamId
								}
							});
							const auditCommandId = randomUUID();
							await tx.intakeActivity.create({
								data: {
									workspaceId: source.workspaceId,
									entityKind: 'entry',
									entityId: entry.id,
									commandId: auditCommandId,
									actorSubject: source.createdBySubject,
									action: 'CREATED',
									entityVersion: 1
								}
							});
							await tx.inboundReceipt.create({
								data: {
									sourceId: source.id,
									externalCommandId,
									workspaceId: source.workspaceId,
									entryId: entry.id,
									auditCommandId,
									requestHash,
									receivedAt: entry.receivedAt
								}
							});
							return {
								schemaVersion: 1 as const,
								entryId: entry.id,
								receivedAt: entry.receivedAt.toISOString()
							};
						},
						{
							isolationLevel: Prisma.TransactionIsolationLevel.Serializable
						}
					);
				} catch (error) {
					if (
						error instanceof Prisma.PrismaClientKnownRequestError &&
						['P2002', 'P2034'].includes(error.code) &&
						attempt < 2
					)
						continue;
					throw error;
				}
			}
			throw new ServiceUnavailableException(
				'Retry the same intake request'
			);
		} catch (error) {
			if (error instanceof HttpException) throw error;
			// Do not log Prisma arguments, contact data, source credentials or dependency payloads.
			throw new ServiceUnavailableException({
				code: 'crm_intake_ingest_unavailable',
				message:
					'Intake is temporarily unavailable; retry the same request'
			});
		}
	}
}
