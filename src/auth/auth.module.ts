import { AdminEventLogModule } from '@/admin-event-log/admin-event-log.module';
import { AuthController } from '@/auth/auth.controller';
import { AuthService } from '@/auth/auth.service';
import { AuthRateLimitGuard } from '@/auth/guards/auth-rate-limit.guard';
import { GoogleAuthEnabledGuard } from '@/auth/guards/social-auth-enabled/google-auth-enabled.guard';
import { YandexAuthEnabledGuard } from '@/auth/guards/social-auth-enabled/yandex-auth-enabled.guard';
import { RefreshTokenService } from '@/auth/refresh-token.service';
import { SocialMediaAuthController } from '@/auth/social-media/social-media-auth.controller';
import { SocialMediaAuthService } from '@/auth/social-media/social-media-auth.service';
import { GithubStrategy } from '@/auth/strategies/github.strategy';
import { GoogleStrategy } from '@/auth/strategies/google.strategy';
import { JwtStrategy } from '@/auth/strategies/jwt.strategy';
import { VerificationChallengeCleanupService } from '@/auth/verification-challenge-cleanup.service';
import { getJwtConfig } from '@/config/jwt.config';
import { EmailModule } from '@/email/email.module';
import { PrismaService } from '@/prisma.service';
import { SiteSettingsModule } from '@/site-settings/site-settings.module';
import { SmsModule } from '@/sms/sms.module';
import { UserModule } from '@/user/user.module';
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';

@Module({
	imports: [
		JwtModule.registerAsync({
			imports: [ConfigModule],
			inject: [ConfigService],
			useFactory: getJwtConfig
		}),
		UserModule,
		EmailModule,
		SmsModule,
		SiteSettingsModule,
		AdminEventLogModule
	],
	controllers: [AuthController, SocialMediaAuthController],
	providers: [
		JwtStrategy,
		PrismaService,
		AuthService,
		VerificationChallengeCleanupService,
		RefreshTokenService,
		AuthRateLimitGuard,
		GoogleAuthEnabledGuard,
		YandexAuthEnabledGuard,
		GoogleStrategy,
		GithubStrategy,
		SocialMediaAuthService
	]
})
export class AuthModule {}
