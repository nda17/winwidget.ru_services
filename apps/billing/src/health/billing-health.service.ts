import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { BillingOutboxPublisherService } from '../messaging/billing-outbox-publisher.service';
import { BillingRabbitMqService } from '../messaging/billing-rabbitmq.service';
import { BillingWorkerService } from '../messaging/billing-worker.service';
import { BillingPrismaService } from '../prisma/billing-prisma.service';
import { BillingProviderWorkerService } from '../provider/billing-provider-worker.service';
import { PaymentMethodCryptoService } from '../provider/payment-method-crypto.service';
import { YooKassaService } from '../provider/yookassa.service';
import { BillingRuntimeService } from '../runtime/billing-runtime.service';
import { BillingSchedulerService } from '../scheduler/billing-scheduler.service';
import { WincrmProviderWorkerService } from '../provider/wincrm-provider-worker.service';
import { WincrmCommerceSchedulerService } from '../scheduler/wincrm-commerce-scheduler.service';
import { wincrmProviderMessagingEnabled } from '../provider/wincrm-provider.config';

@Injectable()
export class BillingHealthService {
	constructor(
		private readonly prisma: BillingPrismaService,
		private readonly runtime: BillingRuntimeService,
		private readonly rabbit: BillingRabbitMqService,
		private readonly worker: BillingWorkerService,
		private readonly providerWorker: BillingProviderWorkerService,
		private readonly yookassa: YooKassaService,
		private readonly paymentMethodCrypto: PaymentMethodCryptoService,
		private readonly publisher: BillingOutboxPublisherService,
		private readonly scheduler: BillingSchedulerService,
		private readonly wincrmWorker: WincrmProviderWorkerService,
		private readonly wincrmScheduler: WincrmCommerceSchedulerService
	) {}

	liveness() {
		return this.status('ok');
	}

	async readiness() {
		try {
			await this.prisma.$queryRaw`SELECT 1`;
			const [identity, , policy] = await Promise.all([
				this.prisma.serviceIdentity.findUnique({
					where: { id: 'singleton' },
					select: { serviceName: true, databaseId: true }
				}),
				this.prisma.crmEntitlement.findFirst({
					select: {
						provisioningCommandId: true,
						provisioningCommandType: true,
						policyVersion: true,
						graceUntil: true
					}
				}),
				this.prisma.crmCommercialPolicy.findFirst({
					orderBy: { version: 'desc' }
				})
			]);
			if (
				identity?.serviceName !== 'billing-service' ||
				!identity.databaseId ||
				!policy
			) {
				throw new Error();
			}
			// Entitlement reads must continue to resolve already-paid periods even
			// while new commerce sales are disabled.
			await this.prisma.crmPaidPeriod.findFirst({
				select: { id: true, startsAt: true, activationNotifiedAt: true }
			});
			if (wincrmProviderMessagingEnabled()) {
				await Promise.all([
					this.prisma.crmCommerceAccount.findFirst({
						select: { workspaceId: true, version: true }
					}),
					this.prisma.crmProviderOperation.findFirst({
						select: {
							id: true,
							pendingEventId: true,
							firstDispatchAt: true
						}
					})
				]);
			}
		} catch {
			throw new ServiceUnavailableException(
				'Billing database is not ready'
			);
		}
		if (
			this.runtime.rabbitEnabled &&
			(!this.rabbit.isConnected() || !this.rabbit.isTopologyReady())
		) {
			throw new ServiceUnavailableException('RabbitMQ is not ready');
		}
		if (
			this.runtime.workerEnabled &&
			(!this.worker.isReady() || !this.providerWorker.isReady())
		) {
			throw new ServiceUnavailableException('Billing worker is not ready');
		}
		if (this.runtime.outboxPublisherEnabled && !this.publisher.isReady()) {
			throw new ServiceUnavailableException(
				'Billing Outbox publisher is not ready'
			);
		}
		if (this.runtime.schedulerEnabled && !this.scheduler.isReady()) {
			throw new ServiceUnavailableException(
				'Billing scheduler is not ready'
			);
		}
		if (
			wincrmProviderMessagingEnabled() &&
			((this.runtime.workerEnabled && !this.wincrmWorker.isReady()) ||
				(this.runtime.schedulerEnabled && !this.wincrmScheduler.isReady()))
		) {
			throw new ServiceUnavailableException(
				'WinCRM commerce workers are not ready'
			);
		}
		const paymentMethodEncryptionKeyConfigured =
			this.paymentMethodCrypto.configurationStatus()
				.encryptionKeyConfigured;
		if (
			(this.runtime.apiEnabled || this.runtime.workerEnabled) &&
			!paymentMethodEncryptionKeyConfigured
		) {
			throw new ServiceUnavailableException(
				'Billing payment-method encryption is not ready'
			);
		}
		const providerReadiness = this.runtime.workerEnabled
			? this.providerReadiness(paymentMethodEncryptionKeyConfigured)
			: null;
		if (
			providerReadiness &&
			(!providerReadiness.providers.yookassa ||
				!providerReadiness.providerConfiguration
					.paymentMethodEncryptionKeyConfigured)
		) {
			throw new ServiceUnavailableException(
				'Billing provider configuration is not ready'
			);
		}
		return {
			...this.status('ready'),
			...(providerReadiness || {})
		};
	}

	private providerReadiness(
		paymentMethodEncryptionKeyConfigured: boolean
	) {
		const yookassa = this.yookassa.configurationStatus();
		return {
			providers: { yookassa: yookassa.credentialsConfigured },
			providerConfiguration: {
				yookassa,
				paymentMethodEncryptionKeyConfigured
			}
		};
	}

	private status(status: 'ok' | 'ready') {
		return {
			status,
			service: 'billing',
			role: this.runtime.role,
			revision: process.env.APP_REVISION || 'unknown'
		};
	}
}
