import {
	BILLING_REFERRAL_REQUESTED_EVENT_TYPE,
	BILLING_TRIAL_REQUESTED_EVENT_TYPE
} from '@/messaging/messaging.constants';
import {
	AUTO_RENEWAL_CONSENT_TEXT,
	AUTO_RENEWAL_CONSENT_VERSION
} from '@/payment/payment.constants';
import { PrismaService } from '@/prisma.service';
import { BadRequestException, Injectable } from '@nestjs/common';
import {
	IntegrationDeliveryReceiptStatus,
	Prisma,
	UserStatus
} from '@prisma/client';
import { createHash, randomUUID } from 'node:crypto';

const UUID_PATTERN =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const REPAIR_SCOPES = ['IDENTITY', 'TRIAL', 'REFERRAL', 'OFFER'] as const;
type RepairScope = (typeof REPAIR_SCOPES)[number];

@Injectable()
export class BillingSourceRepairService {
	constructor(private readonly prisma: PrismaService) {}

	async repair(body: unknown) {
		const input = this.parse(body);
		const result = await this.prisma.$transaction(async transaction => {
			const claim =
				await transaction.integrationDeliveryReceipt.createMany({
					data: [
						{
							id: randomUUID(),
							eventId: input.repairId,
							integration: 'billing-source-repair',
							status: IntegrationDeliveryReceiptStatus.PROCESSING,
							lockedAt: new Date(),
							deliveredAt: null
						}
					],
					skipDuplicates: true
				});
			if (claim.count === 0) return { duplicate: true };

			if (input.scopes.includes('OFFER')) {
				const offer = await transaction.legalPage.findUnique({
					where: { slug: 'oferta' }
				});
				await this.recordSourceEvent(transaction, {
					eventType: 'billing.offer.changed.v1',
					aggregateType: 'billing.offer',
					aggregateId: 'offer',
					state: offer
						? {
								id: 'offer',
								content: offer.content,
								sha256: createHash('sha256')
									.update(offer.content, 'utf8')
									.digest('hex'),
								updatedAt: offer.updatedAt.toISOString(),
								consentVersion: AUTO_RENEWAL_CONSENT_VERSION,
								consentText: AUTO_RENEWAL_CONSENT_TEXT
							}
						: null,
					tombstone: !offer
				});
			}

			const user = input.userId
				? await transaction.user.findUnique({
						where: { id: input.userId },
						select: { id: true, createdAt: true }
					})
				: null;
			if (input.scopes.includes('IDENTITY')) {
				if (user) {
					await transaction.$executeRaw(
						Prisma.sql`SELECT "billing_emit_identity_projection"(${input.userId!}, FALSE)`
					);
				} else {
					await this.recordSourceEvent(transaction, {
						eventType: 'billing.identity.changed.v1',
						aggregateType: 'billing.identity',
						aggregateId: input.userId!,
						state: null,
						tombstone: true
					});
				}
			}
			if (input.scopes.includes('TRIAL') && user) {
				await this.recordSourceEvent(transaction, {
					eventType: BILLING_TRIAL_REQUESTED_EVENT_TYPE,
					aggregateType: 'billing.trial',
					aggregateId: input.userId!,
					state: {
						userId: input.userId!,
						trialDays: 7,
						registeredAt: user.createdAt.toISOString()
					},
					tombstone: false
				});
			}
			if (input.scopes.includes('REFERRAL')) {
				if (!user) {
					throw new BadRequestException(
						'Billing referral repair requires an existing user'
					);
				}
				const referrer = await transaction.user.findFirst({
					where: {
						id: input.referrerId!,
						status: UserStatus.ACTIVE,
						deletedAt: null
					},
					select: { id: true }
				});
				if (!referrer) {
					throw new BadRequestException(
						'Billing referral repair requires an active referrer'
					);
				}
				await this.recordSourceEvent(transaction, {
					eventType: BILLING_REFERRAL_REQUESTED_EVENT_TYPE,
					aggregateType: 'billing.referral-request',
					aggregateId: input.userId!,
					state: {
						referrerId: input.referrerId!,
						referredUserId: input.userId!,
						requestedAt: user.createdAt.toISOString()
					},
					tombstone: false
				});
			}

			await transaction.integrationDeliveryReceipt.update({
				where: {
					eventId_integration: {
						eventId: input.repairId,
						integration: 'billing-source-repair'
					}
				},
				data: {
					status: IntegrationDeliveryReceiptStatus.DELIVERED,
					deliveredAt: new Date()
				}
			});
			return { duplicate: false };
		});

		return {
			schemaVersion: 1 as const,
			repairId: input.repairId,
			accepted: true as const,
			duplicate: result.duplicate
		};
	}

	private parse(body: unknown): {
		repairId: string;
		userId?: string;
		scopes: RepairScope[];
		referrerId?: string;
	} {
		if (!body || typeof body !== 'object' || Array.isArray(body)) {
			throw new BadRequestException('Invalid Billing repair request');
		}
		const input = body as Record<string, unknown>;
		if (
			Object.keys(input).some(
				key =>
					![
						'schemaVersion',
						'repairId',
						'userId',
						'scopes',
						'referrerId'
					].includes(key)
			) ||
			input.schemaVersion !== 1 ||
			typeof input.repairId !== 'string' ||
			!UUID_PATTERN.test(input.repairId) ||
			!Array.isArray(input.scopes) ||
			input.scopes.length < 1 ||
			input.scopes.some(
				scope => !REPAIR_SCOPES.includes(scope as RepairScope)
			)
		) {
			throw new BadRequestException('Invalid Billing repair request');
		}
		const scopes = [...new Set(input.scopes as RepairScope[])];
		const userId =
			typeof input.userId === 'string' ? input.userId.trim() : undefined;
		const referrerId =
			typeof input.referrerId === 'string'
				? input.referrerId.trim()
				: undefined;
		if (scopes.includes('OFFER')) {
			if (
				scopes.length !== 1 ||
				input.userId !== undefined ||
				input.referrerId !== undefined
			) {
				throw new BadRequestException(
					'Billing offer repair must be requested separately'
				);
			}
		} else if (!userId || userId.length > 255) {
			throw new BadRequestException(
				'Billing repair requires a valid userId'
			);
		}
		if (
			scopes.includes('REFERRAL') &&
			(!referrerId || referrerId.length > 255 || referrerId === userId)
		) {
			throw new BadRequestException(
				'Billing referral repair requires a valid referrerId'
			);
		}
		return {
			repairId: input.repairId,
			...(userId ? { userId } : {}),
			scopes,
			referrerId
		};
	}

	private async recordSourceEvent(
		transaction: Prisma.TransactionClient,
		input: {
			eventType: string;
			aggregateType: string;
			aggregateId: string;
			state: Prisma.InputJsonObject | null;
			tombstone: boolean;
		}
	): Promise<void> {
		const state =
			input.state === null ? null : JSON.stringify(input.state);
		await transaction.$executeRaw(
			Prisma.sql`
				SELECT "billing_record_source_event"(
					${input.eventType},
					${input.eventType},
					${input.aggregateType},
					${input.aggregateId},
					${state}::jsonb,
					${input.tombstone}
				)
			`
		);
	}
}
