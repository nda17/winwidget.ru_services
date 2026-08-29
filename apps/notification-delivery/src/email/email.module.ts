import {
	createEmailTransporter,
	EMAIL_TRANSPORTER
} from '../config/mailer.config';
import { EmailService } from './email.service';
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';

@Module({
	imports: [ConfigModule],
	providers: [
		{
			provide: EMAIL_TRANSPORTER,
			useFactory: createEmailTransporter,
			inject: [ConfigService]
		},
		EmailService
	],
	exports: [EmailService]
})
export class EmailModule {}
