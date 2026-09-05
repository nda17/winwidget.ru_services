import {
	ConflictException,
	ForbiddenException,
	Injectable,
	ServiceUnavailableException
} from '@nestjs/common';
import { Prisma, type CrmCommercialPolicy } from '@prisma/billing-client';
import type { BillingActor } from '../auth/billing-request';
import type { UpdateCrmCommercialPolicyDto } from '../http/billing.dto';
import { BillingPrismaService } from '../prisma/billing-prisma.service';
import { enqueueBillingAdminAudit } from './billing-admin-audit';
import {
	assertBillingCommandReceipt,
	billingCommandRequestHash,
	lockBillingCommand
} from './billing-command-idempotency';

const COMMAND_TYPE = 'UPDATE_WINCRM_COMMERCIAL_POLICY';

export function serializeCrmCommercialPolicy(policy: CrmCommercialPolicy) {
	return {
		schemaVersion: 1 as const,
		productCode: 'WINCRM' as const,
		version: policy.version,
		currency: 'RUB' as const,
		monthlyPriceMinor: policy.monthlyPriceMinor,
		yearlyPriceMinor: policy.yearlyPriceMinor,
		additionalSeatMonthlyPriceMinor:
			policy.additionalSeatMonthlyPriceMinor,
		additionalSeatYearlyPriceMinor: policy.additionalSeatYearlyPriceMinor,
		includedSeats: policy.includedSeats,
		trialSeatLimit: policy.trialSeatLimit,
		trialDays: policy.trialDays,
		graceDays: policy.graceDays,
		createdAt: policy.createdAt.toISOString()
	};
}

export async function requireCrmCommercialPolicy(
	client: Pick<Prisma.TransactionClient, 'crmCommercialPolicy'>
) {
	const policy = await client.crmCommercialPolicy.findFirst({
		orderBy: { version: 'desc' }
	});
	if (!policy) {
		throw new ServiceUnavailableException({
			code: 'crm_commercial_policy_unavailable',
			message: 'Настройки WinCRM временно недоступны'
		});
	}
	return policy;
}

@Injectable()
export class CrmCommercialPolicyService {
	constructor(private readonly prisma: BillingPrismaService) {}

	async get() {
		return serializeCrmCommercialPolicy(
			await requireCrmCommercialPolicy(this.prisma)
		);
	}

	async update(
		dto: UpdateCrmCommercialPolicyDto,
		context: {
			actor: BillingActor;
			ip?: string | null;
			userAgent?: string | null;
		}
	) {
		const actorRole = context.actor.roles.includes('DEV')
			? 'DEV'
			: context.actor.roles.includes('ADMIN')
				? 'ADMIN'
				: null;
		if (!actorRole) {
			throw new ForbiddenException(
				'Настройки WinCRM могут изменять ADMIN и DEV'
			);
		}
		const requestHash = billingCommandRequestHash(COMMAND_TYPE, {
			...dto,
			actorId: context.actor.subject
		});
		for (let attempt = 1; attempt <= 3; attempt += 1) {
			try {
				return await this.prisma.$transaction(
					async transaction => {
						await lockBillingCommand(transaction, dto.commandId);
						const prior =
							await transaction.billingCommandReceipt.findUnique({
								where: { commandId: dto.commandId }
							});
						if (prior) {
							return assertBillingCommandReceipt(
								prior,
								COMMAND_TYPE,
								requestHash
							);
						}
						await transaction.$executeRaw(Prisma.sql`
							SELECT pg_advisory_xact_lock(
								hashtextextended('billing-wincrm-commercial-policy', 0)
							)
						`);
						const current = await requireCrmCommercialPolicy(transaction);
						if (current.version !== dto.expectedVersion) {
							throw new ConflictException({
								code: 'crm_commercial_policy_version_conflict',
								message:
									'Настройки изменились. Обновите страницу и повторите сохранение'
							});
						}
						if (current.version >= 2_147_483_647) {
							throw new ServiceUnavailableException(
								'WinCRM policy version limit reached'
							);
						}
						const updated = await transaction.crmCommercialPolicy.create({
							data: {
								version: current.version + 1,
								monthlyPriceMinor: dto.monthlyPriceMinor,
								yearlyPriceMinor: dto.yearlyPriceMinor,
								additionalSeatMonthlyPriceMinor:
									dto.additionalSeatMonthlyPriceMinor,
								additionalSeatYearlyPriceMinor:
									dto.additionalSeatYearlyPriceMinor,
								includedSeats: dto.includedSeats,
								trialSeatLimit: dto.trialSeatLimit,
								trialDays: 5,
								graceDays: 3,
								createdByUserId: context.actor.subject
							}
						});
						const result = serializeCrmCommercialPolicy(updated);
						await enqueueBillingAdminAudit(transaction, {
							actor: {
								id: context.actor.subject,
								role: actorRole,
								ip: context.ip,
								userAgent: context.userAgent
							},
							section: 'SITE_SETTINGS',
							action: 'SITE_SETTINGS_UPDATE',
							description: 'Обновлены цены и лимиты сотрудников WinCRM',
							entity: {
								type: 'crm_commercial_policy',
								id: String(updated.version),
								label: 'WinCRM',
								targetUserId: null
							},
							metadata: {
								commandId: dto.commandId,
								before: serializeCrmCommercialPolicy(current),
								after: result
							}
						});
						await transaction.billingCommandReceipt.create({
							data: {
								commandId: dto.commandId,
								commandType: COMMAND_TYPE,
								requestHash,
								requestHashVersion: 1,
								result
							}
						});
						return result;
					},
					{
						isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
						maxWait: 5_000,
						timeout: 30_000
					}
				);
			} catch (error) {
				if (
					attempt === 3 ||
					!error ||
					typeof error !== 'object' ||
					!('code' in error) ||
					error.code !== 'P2034'
				)
					throw error;
			}
		}
		throw new Error('WinCRM policy update retry loop exhausted');
	}
}
