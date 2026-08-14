import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/billing-client';
import type { Request, Response } from 'express';
import { createHash, randomUUID } from 'node:crypto';
import { BillingPrismaService } from '../prisma/billing-prisma.service';

const EXPORT_BATCH_SIZE = 2_000;
const EXPORT_TIMEOUT_MS = 15 * 60 * 1_000;

interface ActiveSubscriberRow {
	userId: string;
}

@Injectable()
export class BillingCampaignAudienceService {
	constructor(private readonly prisma: BillingPrismaService) {}

	async stream(request: Request, response: Response): Promise<void> {
		const snapshotId = randomUUID();
		let disconnected = false;
		const close = () => {
			disconnected = true;
		};
		response.once('close', close);
		try {
			await this.prisma.$transaction(
				async transaction => {
					await transaction.$executeRaw`SET TRANSACTION READ ONLY`;
					const [clock] = await transaction.$queryRaw<
						Array<{ asOf: Date }>
					>(Prisma.sql`
						SELECT transaction_timestamp() AS "asOf"
					`);
					if (!clock || !(clock.asOf instanceof Date)) {
						throw new Error(
							'Billing campaign snapshot database timestamp is unavailable'
						);
					}
					const asOf = clock.asOf;
					await this.write(
						response,
						{
							type: 'snapshot',
							schemaVersion: 1,
							snapshotId,
							asOf: asOf.toISOString()
						},
						() => disconnected || request.aborted
					);

					const hash = createHash('sha256');
					let totalCount = 0;
					let cursor: string | null = null;
					for (;;) {
						const cursorFilter: Prisma.Sql = cursor
							? Prisma.sql`AND user_id > ${cursor}`
							: Prisma.empty;
						const rows: ActiveSubscriberRow[] =
							await transaction.$queryRaw<
								ActiveSubscriberRow[]
							>(Prisma.sql`
							SELECT user_id AS "userId"
							FROM billing.subscriptions
							WHERE status = 'ACTIVE'::billing."SubscriptionStatus"
								AND (expires_at IS NULL OR expires_at > ${asOf})
								${cursorFilter}
							ORDER BY user_id ASC
							LIMIT ${EXPORT_BATCH_SIZE}
							`);
						if (!rows.length) break;
						for (const row of rows) {
							if (!row.userId || row.userId === cursor) continue;
							await this.write(
								response,
								{ type: 'subscriber', userId: row.userId },
								() => disconnected || request.aborted
							);
							hash.update(`${row.userId}\n`, 'utf8');
							cursor = row.userId;
							totalCount += 1;
						}
						if (rows.length < EXPORT_BATCH_SIZE) break;
					}
					await this.write(
						response,
						{
							type: 'complete',
							snapshotId,
							totalCount,
							sha256: hash.digest('hex')
						},
						() => disconnected || request.aborted
					);
				},
				{
					isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
					maxWait: 5_000,
					timeout: EXPORT_TIMEOUT_MS
				}
			);
		} finally {
			response.off('close', close);
		}
	}

	private async write(
		response: Response,
		value: Record<string, unknown>,
		disconnected: () => boolean
	): Promise<void> {
		if (disconnected() || response.destroyed || response.writableEnded) {
			throw new Error('Campaign subscriber export client disconnected');
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
				reject(
					new Error('Campaign subscriber export client disconnected')
				);
			};
			const onError = (error: Error) => {
				cleanup();
				reject(error);
			};
			response.once('drain', onDrain);
			response.once('close', onClose);
			response.once('error', onError);
			if (disconnected()) onClose();
		});
	}
}
