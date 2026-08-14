import { Module, OnApplicationShutdown } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { BillingAuthGuard } from './auth/billing-auth.guard';
import { BillingInternalGuard } from './auth/billing-internal.guard';
import { BillingCampaignsGuard } from './auth/billing-campaigns.guard';
import { BillingIdentityGuard } from './auth/billing-identity.guard';
import { BillingCampaignAudienceService } from './domain/billing-campaign-audience.service';
import { InternalCommandsService } from './domain/internal-commands.service';
import { BillingMessagingAdminService } from './domain/billing-messaging-admin.service';
import { PaymentDomainService } from './domain/payment-domain.service';
import { PaymentSuccessTransaction } from './domain/payment-success.transaction';
import { SubscriptionDomainService } from './domain/subscription-domain.service';
import { TariffAffiliateService } from './domain/tariff-affiliate.service';
import { BillingHealthController } from './health/billing-health.controller';
import { BillingHealthService } from './health/billing-health.service';
import { AffiliateController } from './http/affiliate.controller';
import { BillingCampaignAudienceController } from './http/billing-campaign-audience.controller';
import { BillingInternalController } from './http/billing-internal.controller';
import { BillingIdentityController } from './http/billing-identity.controller';
import { PaymentController } from './http/payment.controller';
import { SubscriptionController } from './http/subscription.controller';
import { TariffPricesController } from './http/tariff-prices.controller';
import { CoreInternalClient } from './internal/core-internal.client';
import { WidgetsInternalClient } from './internal/widgets-internal.client';
import { BillingOutboxPublisherService } from './messaging/billing-outbox-publisher.service';
import { BillingRabbitMqService } from './messaging/billing-rabbitmq.service';
import { BillingWorkerService } from './messaging/billing-worker.service';
import { BillingPrismaModule } from './prisma/billing-prisma.module';
import { BillingPrismaService } from './prisma/billing-prisma.service';
import { BillingProjectionService } from './projections/billing-projection.service';
import { BillingProviderWorkerService } from './provider/billing-provider-worker.service';
import { PaymentMethodCryptoService } from './provider/payment-method-crypto.service';
import { YooKassaService } from './provider/yookassa.service';
import { BillingRuntimeModule } from './runtime/billing-runtime.module';
import { parseBillingProcessRole } from './runtime/billing-runtime.service';
import { BillingSchedulerService } from './scheduler/billing-scheduler.service';

const BILLING_PROCESS_ROLE = parseBillingProcessRole(
	process.env.BILLING_PROCESS_ROLE
);

const API_CONTROLLERS =
	BILLING_PROCESS_ROLE === 'api'
		? [
				PaymentController,
				SubscriptionController,
				TariffPricesController,
				AffiliateController,
				BillingCampaignAudienceController,
				BillingIdentityController,
				BillingInternalController
			]
		: [];

const API_PROVIDERS =
	BILLING_PROCESS_ROLE === 'api'
		? [
				BillingAuthGuard,
				BillingInternalGuard,
				BillingCampaignsGuard,
				BillingIdentityGuard
			]
		: [];

@Module({
	imports: [
		ConfigModule.forRoot({ isGlobal: true }),
		BillingRuntimeModule,
		BillingPrismaModule
	],
	controllers: [BillingHealthController, ...API_CONTROLLERS],
	providers: [
		...API_PROVIDERS,
		CoreInternalClient,
		WidgetsInternalClient,
		PaymentDomainService,
		PaymentSuccessTransaction,
		SubscriptionDomainService,
		TariffAffiliateService,
		InternalCommandsService,
		BillingCampaignAudienceService,
		BillingMessagingAdminService,
		BillingProjectionService,
		PaymentMethodCryptoService,
		YooKassaService,
		BillingRabbitMqService,
		BillingWorkerService,
		BillingProviderWorkerService,
		BillingOutboxPublisherService,
		BillingSchedulerService,
		BillingHealthService
	]
})
export class BillingModule implements OnApplicationShutdown {
	constructor(private readonly prisma: BillingPrismaService) {}

	async onApplicationShutdown(): Promise<void> {
		await this.prisma.disconnect();
	}
}
