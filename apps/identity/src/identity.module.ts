import { Module, OnApplicationShutdown } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ConfigModule } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { AccessJwtService } from './auth/access-jwt.service';
import { AuthRateLimitGuard } from './auth/auth-rate-limit.guard';
import { AuthSettingsController } from './auth/auth-settings.controller';
import { AuthSettingsService } from './auth/auth-settings.service';
import { AuthController } from './auth/auth.controller';
import { IdentityAuthGuard } from './auth/auth.guard';
import { AuthService } from './auth/auth.service';
import { RecaptchaGuard } from './auth/recaptcha.guard';
import { RefreshTokenService } from './auth/refresh-token.service';
import { AvatarCleanupWorkerService } from './avatar/avatar-cleanup-worker.service';
import {
	AvatarMediaOwnershipGuard,
	AvatarMediaOwnershipService
} from './avatar/avatar-media-ownership.service';
import { AvatarStorageService } from './avatar/avatar-storage.service';
import {
	AvatarUploadAdmissionInterceptor,
	AvatarUploadAdmissionService
} from './avatar/avatar-upload-admission.service';
import { AvatarService } from './avatar/avatar.service';
import { IdentityEventsService } from './events/identity-events.service';
import { IdentityHealthController } from './health/identity-health.controller';
import { IdentityHealthService } from './health/identity-health.service';
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
import {
	IdentityOwnershipGuard,
	IdentityOwnershipService
} from './runtime/identity-ownership.service';
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
				AuthRateLimitGuard,
				AuthSettingsService,
				AuthService,
				AvatarMediaOwnershipGuard,
				AvatarMediaOwnershipService,
				AvatarUploadAdmissionInterceptor,
				AvatarUploadAdmissionService,
				AvatarService,
				IdentityAuthGuard,
				IdentityInternalGuard,
				IdentityInternalService,
				IdentityMessagingAdminService,
				OAuthService,
				OwnerClientsService,
				RecaptchaGuard,
				RefreshTokenService,
				TelegramService,
				UsersService,
				VerificationTransportService
			]
		: [];

const AVATAR_STORAGE_PROVIDERS =
	PROCESS_ROLE === 'api' || PROCESS_ROLE === 'worker'
		? [AvatarStorageService]
		: [];

const AVATAR_WORKER_PROVIDERS =
	PROCESS_ROLE === 'worker' ? [AvatarCleanupWorkerService] : [];

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
		...AVATAR_STORAGE_PROVIDERS,
		...AVATAR_WORKER_PROVIDERS,
		IdentityEventsService,
		IdentityOwnershipService,
		{ provide: APP_GUARD, useClass: IdentityOwnershipGuard },
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
