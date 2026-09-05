import { Module, OnApplicationShutdown } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { AvatarStorageService } from './avatar/avatar-storage.service';
import { AvatarCleanupService } from './avatar/avatar-cleanup.service';
import { AvatarService } from './avatar/avatar.service';
import { AccessJwtService } from './auth/access-jwt.service';
import { AuthRateLimitGuard } from './auth/auth-rate-limit.guard';
import { AuthSettingsController } from './auth/auth-settings.controller';
import { AuthSettingsService } from './auth/auth-settings.service';
import { AuthController } from './auth/auth.controller';
import { IdentityAuthGuard } from './auth/auth.guard';
import { AuthService } from './auth/auth.service';
import { RecaptchaGuard } from './auth/recaptcha.guard';
import { RefreshTokenService } from './auth/refresh-token.service';
import { LoginOtpController } from './auth/login-otp.controller';
import { LoginOtpService } from './auth/login-otp.service';
import { IdentityEventsService } from './events/identity-events.service';
import { IdentityHealthController } from './health/identity-health.controller';
import { IdentityHealthService } from './health/identity-health.service';
import { IdentityProviderHealthService } from './health/identity-provider-health.service';
import { OwnerClientsService } from './integrations/owner-clients.service';
import { IdentityInternalController } from './internal/internal.controller';
import { IdentityInternalGuard } from './internal/internal.guard';
import { IdentityInternalService } from './internal/internal.service';
import { DestinationUnavailableWorkerService } from './messaging/destination-worker.service';
import { IdentityMessagingAdminController } from './messaging/messaging-admin.controller';
import { IdentityMessagingAdminService } from './messaging/messaging-admin.service';
import { IdentityOutboxPublisherService } from './messaging/outbox-publisher.service';
import { IdentityRabbitMqService } from './messaging/rabbitmq.service';
import { OAuthController } from './oauth/oauth.controller';
import { OAuthService } from './oauth/oauth.service';
import { IdentityPrismaModule } from './prisma/identity-prisma.module';
import { IdentityPrismaService } from './prisma/identity-prisma.service';
import { IdentityHeartbeatService } from './runtime/identity-heartbeat.service';
import { IdentityHousekeepingService } from './runtime/identity-housekeeping.service';
import { IdentityRuntimeModule } from './runtime/identity-runtime.module';
import { parseIdentityProcessRole } from './runtime/identity-runtime.service';
import {
	TelegramAdminController,
	TelegramController
} from './telegram/telegram.controller';
import { TelegramService } from './telegram/telegram.service';
import { VerificationTransportService } from './transports/verification-transport.service';
import { UsersController } from './users/users.controller';
import { UsersService } from './users/users.service';

const PROCESS_ROLE = parseIdentityProcessRole(
	process.env.IDENTITY_PROCESS_ROLE
);

const API_CONTROLLERS =
	PROCESS_ROLE === 'api'
		? [
				AuthController,
				LoginOtpController,
				AuthSettingsController,
				OAuthController,
				UsersController,
				TelegramController,
				TelegramAdminController,
				IdentityInternalController,
				IdentityMessagingAdminController
			]
		: [];

const API_PROVIDERS =
	PROCESS_ROLE === 'api'
		? [
				AccessJwtService,
				AvatarCleanupService,
				AvatarService,
				AvatarStorageService,
				AuthRateLimitGuard,
				AuthSettingsService,
				AuthService,
				LoginOtpService,
				IdentityAuthGuard,
				IdentityInternalGuard,
				IdentityInternalService,
				IdentityMessagingAdminService,
				IdentityProviderHealthService,
				OAuthService,
				OwnerClientsService,
				RecaptchaGuard,
				RefreshTokenService,
				TelegramService,
				UsersService,
				VerificationTransportService
			]
		: [];

@Module({
	imports: [
		ConfigModule.forRoot({ isGlobal: true }),
		JwtModule.register({}),
		IdentityRuntimeModule,
		IdentityPrismaModule
	],
	controllers: [IdentityHealthController, ...API_CONTROLLERS],
	providers: [
		...API_PROVIDERS,
		IdentityEventsService,
		IdentityRabbitMqService,
		DestinationUnavailableWorkerService,
		IdentityOutboxPublisherService,
		IdentityHeartbeatService,
		IdentityHousekeepingService,
		IdentityHealthService
	]
})
export class IdentityModule implements OnApplicationShutdown {
	constructor(private readonly prisma: IdentityPrismaService) {}

	async onApplicationShutdown(): Promise<void> {
		await this.prisma.disconnect();
	}
}
