import { AdminEventLogService } from '@/admin-event-log/admin-event-log.service';
import { BillingInternalClient } from '@/billing-boundary/billing-internal.client';
import { parseBillingSettingsState } from '@/billing-boundary/billing-settings-state';
import { BillingSettingsState } from '@/messaging/billing-events';
import { getCurrentCorrelationId } from '@/messaging/messaging-context';
import { PrismaService } from '@/prisma.service';
import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import {
	BillingSettingsCompositionStatus,
	Prisma,
	type SiteSettings
} from '@prisma/client';
import { Request } from 'express';
import { randomUUID } from 'node:crypto';

export interface CoreSettingsPatch {
	bannerEnabled?: boolean;
	bannerText?: string;
	snowflakeEnabled?: boolean;
}

export interface BillingSettingsPatch {
	paymentEnabled?: boolean;
	autoRenewalSignupEnabled?: boolean;
	autoRenewalChargesEnabled?: boolean;
	affiliateProgramEnabled?: boolean;
	affiliateCashbackPercent?: number;
}

@Injectable()
export class BillingSettingsCompositionService {
	private readonly repairBatchSize = 5;

	constructor(
		private readonly prisma: PrismaService,
		private readonly client: BillingInternalClient,
		private readonly adminEventLog: AdminEventLogService
	) {}

	async execute(input: {
		corePatch: CoreSettingsPatch;
		billingPatch: BillingSettingsPatch;
		actorId: string;
		correlationId?: string;
		request?: Request;
	}): Promise<{
		coreSettings: SiteSettings;
		billingSettings: BillingSettingsState;
	}> {
		const id = randomUUID();
		await this.prisma.billingSettingsComposition.create({
			data: {
				id,
				corePatch: input.corePatch as Prisma.InputJsonObject,
				billingPatch: input.billingPatch as Prisma.InputJsonObject,
				actorId: input.actorId,
				correlationId:
					input.correlationId ?? getCurrentCorrelationId() ?? null
			}
		});
		return this.process(id, input.request);
	}

	async repairPending(): Promise<void> {
		const pending = await this.prisma.billingSettingsComposition.findMany({
			where: {
				status: {
					in: [
						BillingSettingsCompositionStatus.PENDING,
						BillingSettingsCompositionStatus.BILLING_APPLIED
					]
				}
			},
			orderBy: { updatedAt: 'asc' },
			take: this.repairBatchSize,
			select: { id: true }
		});
		for (const item of pending) {
			await this.process(item.id);
		}
	}

	private async process(
		id: string,
		request?: Request
	): Promise<{
		coreSettings: SiteSettings;
		billingSettings: BillingSettingsState;
	}> {
		try {
			let composition =
				await this.prisma.billingSettingsComposition.findUniqueOrThrow({
					where: { id }
				});
			if (
				composition.status === BillingSettingsCompositionStatus.PENDING
			) {
				const billingPatch = this.parseBillingPatch(
					composition.billingPatch
				);
				const applied = await this.client.updateSettings({
					commandId: composition.id,
					actorId: composition.actorId,
					occurredAt: composition.createdAt.toISOString(),
					settings: billingPatch
				});
				await this.prisma.billingSettingsComposition.updateMany({
					where: {
						id,
						status: BillingSettingsCompositionStatus.PENDING
					},
					data: {
						status: BillingSettingsCompositionStatus.BILLING_APPLIED,
						appliedBillingSettings:
							applied as unknown as Prisma.InputJsonObject,
						attempts: { increment: 1 },
						lastError: null
					}
				});
				composition =
					await this.prisma.billingSettingsComposition.findUniqueOrThrow({
						where: { id }
					});
			}

			if (
				composition.status === BillingSettingsCompositionStatus.COMPLETED
			) {
				return this.getCompletedResult(composition);
			}
			return this.completeCoreSide(composition.id, request);
		} catch (error) {
			await this.prisma.billingSettingsComposition
				.updateMany({
					where: {
						id,
						status: { not: BillingSettingsCompositionStatus.COMPLETED }
					},
					data: {
						attempts: { increment: 1 },
						lastError: this.safeError(error)
					}
				})
				.catch(() => undefined);
			throw error;
		}
	}

	private completeCoreSide(id: string, request?: Request) {
		return this.prisma.$transaction(async transaction => {
			await transaction.$executeRaw(
				Prisma.sql`
					SELECT "id"
					FROM "billing_settings_compositions"
					WHERE "id" = ${id}::uuid
					FOR UPDATE
				`
			);
			const composition =
				await transaction.billingSettingsComposition.findUniqueOrThrow({
					where: { id }
				});
			if (
				composition.status === BillingSettingsCompositionStatus.COMPLETED
			) {
				return this.getCompletedResult(composition, transaction);
			}
			if (
				composition.status !==
					BillingSettingsCompositionStatus.BILLING_APPLIED ||
				!composition.appliedBillingSettings
			) {
				throw new ServiceUnavailableException(
					'Billing settings composition is not ready'
				);
			}

			await transaction.$queryRaw(
				Prisma.sql`
					SELECT "id"
					FROM "site_settings"
					WHERE "id" = 'singleton'
					FOR UPDATE
				`
			);
			const corePatch = this.parseCorePatch(composition.corePatch);
			const coreSettings = Object.keys(corePatch).length
				? await transaction.siteSettings.update({
						where: { id: 'singleton' },
						data: corePatch
					})
				: await transaction.siteSettings.findUniqueOrThrow({
						where: { id: 'singleton' }
					});
			const billingSettings = this.parseAppliedSettings(
				composition.appliedBillingSettings
			);
			await this.adminEventLog.recordInTransaction(transaction, {
				adminId: composition.actorId,
				section: 'SITE_SETTINGS',
				action: 'SITE_SETTINGS_UPDATE',
				description: 'Обновлены настройки сайта',
				entityType: 'site_settings',
				entityId: 'singleton',
				entityLabel: 'Настройки сайта',
				metadata: {
					changedFields: [
						...Object.keys(corePatch),
						...Object.keys(
							this.parseBillingPatch(composition.billingPatch)
						)
					],
					billingCompositionId: composition.id,
					correlationId: composition.correlationId
				},
				request
			});
			await transaction.billingSettingsComposition.update({
				where: { id },
				data: {
					status: BillingSettingsCompositionStatus.COMPLETED,
					completedAt: new Date(),
					lastError: null
				}
			});
			return { coreSettings, billingSettings };
		});
	}

	private async getCompletedResult(
		composition: {
			appliedBillingSettings: Prisma.JsonValue | null;
		},
		transaction?: Prisma.TransactionClient
	) {
		const client = transaction ?? this.prisma;
		const coreSettings = await client.siteSettings.findUniqueOrThrow({
			where: { id: 'singleton' }
		});
		return {
			coreSettings,
			billingSettings: this.parseAppliedSettings(
				composition.appliedBillingSettings
			)
		};
	}

	private parseCorePatch(value: Prisma.JsonValue): CoreSettingsPatch {
		return this.parseObject(value) as CoreSettingsPatch;
	}

	private parseBillingPatch(
		value: Prisma.JsonValue
	): BillingSettingsPatch {
		return this.parseObject(value) as BillingSettingsPatch;
	}

	private parseAppliedSettings(
		value: Prisma.JsonValue | null
	): BillingSettingsState {
		if (!value) {
			throw new ServiceUnavailableException(
				'Applied Billing settings are unavailable'
			);
		}
		return parseBillingSettingsState(value);
	}

	private parseObject(value: Prisma.JsonValue): Record<string, unknown> {
		if (!value || typeof value !== 'object' || Array.isArray(value)) {
			throw new ServiceUnavailableException(
				'Billing settings composition payload is invalid'
			);
		}
		return value as Record<string, unknown>;
	}

	private safeError(error: unknown): string {
		return (error instanceof Error ? error.message : String(error)).slice(
			0,
			2000
		);
	}
}
