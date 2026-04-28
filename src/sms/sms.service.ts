import { type SendSmsOptions } from '@/sms/interfaces/sms-provider.interface';
import { Inject, Injectable } from '@nestjs/common';
import { SmsAeroProvider } from '@/sms/providers/smsaero.provider';

@Injectable()
export class SmsService {
	constructor(
		@Inject(SmsAeroProvider) private readonly provider: SmsAeroProvider
	) {}

	send(options: SendSmsOptions) {
		return this.provider.send(options);
	}

	sendVerificationCode(phone: string, code: string) {
		return this.provider.send({
			to: phone,
			text: `Ваш код подтверждения: ${code}`
		});
	}

	sendRestorePassword(phone: string, password: string) {
		return this.provider.send({
			to: phone,
			text: `Ваш новый пароль: ${password}`
		});
	}
}
