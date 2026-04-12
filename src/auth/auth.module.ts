import { AuthController } from '@/auth/auth.controller';
import { AuthService } from '@/auth/auth.service';
import { AuthRateLimitGuard } from '@/auth/guards/auth-rate-limit.guard';
import { PhoneCodeCleanupService } from '@/auth/phone-code-cleanup.service';
import { RefreshTokenService } from '@/auth/refresh-token.service';
import { SocialMediaAuthController } from '@/auth/social-media/social-media-auth.controller';
import { SocialMediaAuthService } from '@/auth/social-media/social-media-auth.service';
import { GithubStrategy } from '@/auth/strategies/github.strategy';
import { GoogleStrategy } from '@/auth/strategies/google.strategy';
import { JwtStrategy } from '@/auth/strategies/jwt.strategy';
import { getJwtConfig } from '@/config/jwt.config';
import { EmailModule } from '@/email/email.module';
import { PrismaService } from '@/prisma.service';
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
		SmsModule
	],
	controllers: [AuthController, SocialMediaAuthController],
	providers: [
		JwtStrategy,
		PrismaService,
		AuthService,
		PhoneCodeCleanupService,
		RefreshTokenService,
		AuthRateLimitGuard,
		GoogleStrategy,
		GithubStrategy,
		SocialMediaAuthService
	]
})
export class AuthModule {}
