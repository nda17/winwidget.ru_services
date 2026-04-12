import { EmailModule } from '@/email/email.module';
import { PrismaService } from '@/prisma.service';
import { SmsModule } from '@/sms/sms.module';
import { UserController } from '@/user/user.controller';
import { UserIdentityBindingService } from '@/user/user-identity-binding.service';
import { UserService } from '@/user/user.service';
import { Module } from '@nestjs/common';

@Module({
	imports: [EmailModule, SmsModule],
	controllers: [UserController],
	providers: [
		UserService,
		UserIdentityBindingService,
		PrismaService
	],
	exports: [UserService]
})
export class UserModule {}
