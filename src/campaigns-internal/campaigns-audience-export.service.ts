import { PrismaService } from '@/prisma.service';
import { BillingCoreStateService } from '@/billing-boundary/billing-core-state.service';
import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { Request, Response } from 'express';
import { createHash, randomUUID } from 'node:crypto';
import {
	CampaignsAudience,
	CampaignsAudienceChannel,
	CampaignsAudienceExportDto
} from './campaigns-internal.dto';

interface DestinationRow {
	destination: string;
}

const DEFAULT_CHUNK_SIZE = 500;
const MAX_CHUNK_SIZE = 2000;
const DEFAULT_TRANSACTION_TIMEOUT_MS = 5 * 60 * 1000;

@Injectable()
export class CampaignsAudienceExportService {
	constructor(
		private readonly prisma: PrismaService,
		private readonly billingState: BillingCoreStateService
	) {}

	async stream(
		dto: CampaignsAudienceExportDto,
		request: Request,
		response: Response
	): Promise<void> {
		const snapshotId = randomUUID();
		const asOf = new Date();
		let clientClosed = false;
		const onClientClose = () => {
			clientClosed = true;
		};
		response.once('close', onClientClose);
		const chunkSize = this.readBoundedInteger(
			'CAMPAIGNS_AUDIENCE_EXPORT_CHUNK_SIZE',
			DEFAULT_CHUNK_SIZE,
			1,
			MAX_CHUNK_SIZE
		);
		const timeout = this.readBoundedInteger(
			'CAMPAIGNS_AUDIENCE_EXPORT_TIMEOUT_MS',
			DEFAULT_TRANSACTION_TIMEOUT_MS,
			10_000,
			30 * 60 * 1000
		);
		try {
			const billingOwner = await this.billingState.isBillingOwner();

			await this.prisma.$transaction(
				async transaction => {
					await transaction.$executeRaw`SET TRANSACTION READ ONLY`;
					this.assertConnected(request, response, clientClosed);
					await this.writeLine(
						response,
						{
							type: 'snapshot',
							schemaVersion: 1,
							snapshotId,
							asOf: asOf.toISOString(),
							criteria: {
								channel: dto.channel,
								audience: dto.audience
							}
						},
						() => clientClosed
					);

					const hash = createHash('sha256');
					let cursor: string | null = null;
					let totalCount = 0;

					for (;;) {
						this.assertConnected(request, response, clientClosed);
						const rows = await this.getDestinations(
							transaction,
							dto.channel,
							dto.audience,
							asOf,
							cursor,
							chunkSize,
							billingOwner
						);
						if (!rows.length) break;

						for (const row of rows) {
							this.assertConnected(request, response, clientClosed);
							const destination = this.normalizeDestination(
								dto.channel,
								row.destination
							);
							if (!destination || destination === cursor) continue;
							hash.update(`${dto.channel}\u0000${destination}\n`, 'utf8');
							await this.writeLine(
								response,
								{
									type: 'recipient',
									destination
								},
								() => clientClosed
							);
							cursor = destination;
							totalCount += 1;
						}

						if (rows.length < chunkSize) break;
					}

					await this.writeLine(
						response,
						{
							type: 'complete',
							snapshotId,
							totalCount,
							sha256: hash.digest('hex')
						},
						() => clientClosed
					);
				},
				{
					isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
					maxWait: 5000,
					timeout
				}
			);
		} finally {
			response.off('close', onClientClose);
		}
	}

	private getDestinations(
		transaction: Prisma.TransactionClient,
		channel: CampaignsAudienceChannel,
		audience: CampaignsAudience,
		asOf: Date,
		cursor: string | null,
		limit: number,
		billingOwner: boolean
	): Promise<DestinationRow[]> {
		const cursorFilter = cursor
			? Prisma.sql`AND "destination" > ${cursor}`
			: Prisma.empty;
		const activeSubscriptionFilter =
			audience === 'ACTIVE_SUBSCRIBERS'
				? Prisma.sql`
					AND EXISTS (
						SELECT 1
						FROM ${
							billingOwner
								? Prisma.raw('"billing_subscription_read_projections"')
								: Prisma.raw('"subscriptions"')
						} AS "subscription"
						WHERE "subscription"."user_id" = "recipient"."user_id"
							AND "subscription"."status" = 'ACTIVE'::"SubscriptionStatus"
							AND (
								"subscription"."expires_at" IS NULL
								OR "subscription"."expires_at" > ${asOf}
							)
					)
				`
				: Prisma.empty;

		if (channel === 'EMAIL') {
			return transaction.$queryRaw<DestinationRow[]>(
				Prisma.sql`
					SELECT "destination"
					FROM (
						SELECT DISTINCT
							LOWER(BTRIM("identity"."value")) AS "destination",
							"identity"."user_id"
						FROM "auth_identities" AS "identity"
						INNER JOIN "User" AS "user"
							ON "user"."id" = "identity"."user_id"
						WHERE "identity"."type" = 'EMAIL'::"AuthIdentityType"
							AND "identity"."verified_at" IS NOT NULL
							AND BTRIM("identity"."value") <> ''
							AND "user"."status" = 'ACTIVE'::"UserStatus"
							AND "user"."deleted_at" IS NULL
					) AS "recipient"
					WHERE TRUE
						${activeSubscriptionFilter}
						${cursorFilter}
					GROUP BY "destination"
					ORDER BY "destination" ASC
					LIMIT ${limit}
				`
			);
		}

		return transaction.$queryRaw<DestinationRow[]>(
			Prisma.sql`
				SELECT "destination"
				FROM (
					SELECT DISTINCT
						BTRIM("channel"."chat_id") AS "destination",
						"channel"."user_id"
					FROM "telegram_notification_channels" AS "channel"
					INNER JOIN "User" AS "user"
						ON "user"."id" = "channel"."user_id"
					WHERE "channel"."is_active" = TRUE
						AND "channel"."disabled_at" IS NULL
						AND BTRIM("channel"."chat_id") <> ''
						AND "user"."status" = 'ACTIVE'::"UserStatus"
						AND "user"."deleted_at" IS NULL
				) AS "recipient"
				WHERE TRUE
					${activeSubscriptionFilter}
					${cursorFilter}
				GROUP BY "destination"
				ORDER BY "destination" ASC
				LIMIT ${limit}
			`
		);
	}

	private normalizeDestination(
		channel: CampaignsAudienceChannel,
		value: string
	): string {
		const normalized = value.trim();
		return channel === 'EMAIL' ? normalized.toLowerCase() : normalized;
	}

	private async writeLine(
		response: Response,
		value: Record<string, unknown>,
		isClientClosed: () => boolean
	): Promise<void> {
		if (isClientClosed() || response.destroyed || response.writableEnded) {
			throw new Error('Campaigns audience export client disconnected');
		}
		if (response.write(`${JSON.stringify(value)}\n`)) return;
		await new Promise<void>((resolve, reject) => {
			const cleanup = () => {
				response.off('drain', onDrain);
				response.off('close', onClose);
				response.off('error', onError);
			};
			const onDrain = () => {
				cleanup();
				resolve();
			};
			const onClose = () => {
				cleanup();
				reject(new Error('Campaigns audience export client disconnected'));
			};
			const onError = (error: Error) => {
				cleanup();
				reject(error);
			};

			response.once('drain', onDrain);
			response.once('close', onClose);
			response.once('error', onError);
			if (
				isClientClosed() ||
				response.destroyed ||
				response.writableEnded
			) {
				onClose();
			}
		});
	}

	private assertConnected(
		request: Request,
		response: Response,
		clientClosed: boolean
	): void {
		if (
			clientClosed ||
			request.aborted ||
			response.destroyed ||
			response.writableEnded
		) {
			throw new Error('Campaigns audience export client disconnected');
		}
	}

	private readBoundedInteger(
		name: string,
		fallback: number,
		min: number,
		max: number
	): number {
		const value = Number(process.env[name] || fallback);
		return Number.isInteger(value) && value >= min && value <= max
			? value
			: fallback;
	}
}
