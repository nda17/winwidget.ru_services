import {
	BadRequestException,
	Injectable,
	ServiceUnavailableException
} from '@nestjs/common';
import { Prisma } from '@prisma/billing-client';
import type { BillingActor } from '../auth/billing-request';
import type { BillingSettingsPatchDto } from '../http/billing.dto';
import { BillingPrismaService } from '../prisma/billing-prisma.service';
import {
	BILLING_PAYMENT_WEBHOOK_EVENTS,
	BILLING_PAYMENT_WEBHOOK_ROUTE
} from './payment-domain.service';
import {
	YOOKASSA_RECEIPT_CONTRACT,
	YooKassaService
} from '../provider/yookassa.service';
import { enqueueBillingAdminAudit } from './billing-admin-audit';
import {
	AUTO_RENEWAL_CONSENT_TEXT,
	AUTO_RENEWAL_CONSENT_VERSION
} from './billing-legal.constants';

@Injectable()
export class BillingSettingsService {
	constructor(
		private readonly prisma: BillingPrismaService,
		private readonly provider: YooKassaService
	) {}

	async publicSettings() {
		const settings = await this.requireSettings();
		return {
			paymentEnabled: settings.paymentEnabled,
			autoRenewalSignupEnabled: settings.autoRenewalSignupEnabled,
			autoRenewalTerms: this.autoRenewalTerms()
		};
	}

	async adminSettings() {
		return this.serializeAdmin(await this.requireSettings());
	}

	async providerReadiness() {
		const settings = await this.requireSettings();
		return {
			schemaVersion: 1,
			source: 'CODE_AND_PERSISTED_SETTINGS' as const,
			provider: {
				name: 'YOOKASSA' as const,
				...this.provider.configurationStatus()
			},
			features: {
				paymentEnabled: settings.paymentEnabled,
				autoRenewalSignupEnabled: settings.autoRenewalSignupEnabled,
				autoRenewalChargesEnabled: settings.autoRenewalChargesEnabled
			},
			receipt: YOOKASSA_RECEIPT_CONTRACT,
			webhook: {
				codeConfigured: true,
				method: 'POST' as const,
				route: BILLING_PAYMENT_WEBHOOK_ROUTE,
				acceptedEvents: [...BILLING_PAYMENT_WEBHOOK_EVENTS],
				duplicateDeliveryFence:
					'authenticated-provider-object-reverification' as const
			},
			externalVerification: {
				merchantAutoPayments: 'NOT_VERIFIED' as const,
				onlineCashRegister: 'NOT_VERIFIED' as const,
				ofd: 'NOT_VERIFIED' as const
			}
		};
	}

	async updateAdminSettings(
		patch: BillingSettingsPatchDto,
		context: {
			actor: BillingActor;
			ip?: string | null;
			userAgent?: string | null;
		}
	) {
		const changedFields = Object.entries(patch)
			.filter(([, value]) => value !== undefined)
			.map(([key]) => key)
			.sort();
		if (!changedFields.length) {
			throw new BadRequestException(
				'At least one Billing setting is required'
			);
		}
		return this.prisma.$transaction(
			async transaction => {
				await transaction.$queryRaw(
					Prisma.sql`SELECT id FROM billing.settings WHERE id = 'singleton' FOR UPDATE`
				);
				const current = await transaction.billingSettings.findUnique({
					where: { id: 'singleton' }
				});
				if (!current) {
					throw new ServiceUnavailableException(
						'Billing settings are unavailable'
					);
				}
				const sourceSequence = await this.nextSequence(transaction);
				const updated = await transaction.billingSettings.update({
					where: { id: 'singleton' },
					data: {
						paymentEnabled: patch.paymentEnabled ?? current.paymentEnabled,
						autoRenewalSignupEnabled:
							patch.autoRenewalSignupEnabled ??
							current.autoRenewalSignupEnabled,
						autoRenewalChargesEnabled:
							patch.autoRenewalChargesEnabled ??
							current.autoRenewalChargesEnabled,
						autoRenewalChargesEnabledAt:
							patch.autoRenewalChargesEnabled === true &&
							!current.autoRenewalChargesEnabled
								? new Date()
								: current.autoRenewalChargesEnabledAt,
						affiliateProgramEnabled:
							patch.affiliateProgramEnabled ??
							current.affiliateProgramEnabled,
						affiliateCashbackPercent:
							patch.affiliateCashbackPercent ??
							current.affiliateCashbackPercent,
						aggregateVersion: { increment: 1n },
						sourceSequence
					}
				});
				await enqueueBillingAdminAudit(transaction, {
					actor: {
						id: context.actor.subject,
						role: context.actor.roles.includes('DEV') ? 'DEV' : 'ADMIN',
						ip: context.ip,
						userAgent: context.userAgent
					},
					section: 'SITE_SETTINGS',
					action: 'SITE_SETTINGS_UPDATE',
					description: 'Обновлены настройки Billing',
					entity: {
						type: 'billing_settings',
						id: 'singleton',
						label: 'Настройки Billing',
						targetUserId: null
					},
					metadata: {
						changedFields,
						paymentEnabled: updated.paymentEnabled,
						autoRenewalSignupEnabled: updated.autoRenewalSignupEnabled,
						autoRenewalChargesEnabled: updated.autoRenewalChargesEnabled,
						affiliateProgramEnabled: updated.affiliateProgramEnabled,
						affiliateCashbackPercent: updated.affiliateCashbackPercent
					}
				});
				return this.serializeAdmin(updated);
			},
			{ isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
		);
	}

	private async requireSettings() {
		const settings = await this.prisma.billingSettings.findUnique({
			where: { id: 'singleton' }
		});
		if (!settings) {
			throw new ServiceUnavailableException(
				'Billing settings are unavailable'
			);
		}
		return settings;
	}

	private serializeAdmin(settings: {
		id: string;
		paymentEnabled: boolean;
		autoRenewalSignupEnabled: boolean;
		autoRenewalChargesEnabled: boolean;
		autoRenewalChargesEnabledAt: Date;
		affiliateProgramEnabled: boolean;
		affiliateCashbackPercent: number;
		updatedAt: Date;
	}) {
		return {
			id: 'singleton' as const,
			paymentEnabled: settings.paymentEnabled,
			autoRenewalSignupEnabled: settings.autoRenewalSignupEnabled,
			autoRenewalChargesEnabled: settings.autoRenewalChargesEnabled,
			autoRenewalChargesEnabledAt:
				settings.autoRenewalChargesEnabledAt.toISOString(),
			affiliateProgramEnabled: settings.affiliateProgramEnabled,
			affiliateCashbackPercent: settings.affiliateCashbackPercent,
			autoRenewalTerms: this.autoRenewalTerms(),
			updatedAt: settings.updatedAt.toISOString()
		};
	}

	private autoRenewalTerms() {
		return {
			version: AUTO_RENEWAL_CONSENT_VERSION,
			text: AUTO_RENEWAL_CONSENT_TEXT
		};
	}

	private async nextSequence(transaction: Prisma.TransactionClient) {
		const state = await transaction.billingSourceSequence.upsert({
			where: { id: 'billing' },
			create: { id: 'billing', nextValue: 2n },
			update: { nextValue: { increment: 1n } }
		});
		return state.nextValue - 1n;
	}
}
