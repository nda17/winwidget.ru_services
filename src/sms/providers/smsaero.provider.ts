import {
	type SendSmsOptions,
	type SmsProvider
} from '@/sms/interfaces/sms-provider.interface';
import { ConfigService } from '@nestjs/config';
import {
	BadGatewayException,
	Injectable,
	InternalServerErrorException
} from '@nestjs/common';

type SmsAeroResponse = {
	success: boolean;
	data?: unknown;
	message?: string | null;
};

@Injectable()
export class SmsAeroProvider implements SmsProvider {
	private readonly endpoint = 'https://gate.smsaero.ru/v2/sms/send';

	constructor(private readonly configService: ConfigService) {}

	async send({ to, text }: SendSmsOptions) {
		const digits = to.replace(/\D/g, '');
		const number = digits.length === 10 ? `7${digits}` : digits;

		const email = this.configService.get<string>('SMSAERO_EMAIL');
		const apiKey = this.configService.get<string>('SMSAERO_API_KEY');
		const sign =
			this.configService.get<string>('SMSAERO_SIGN') || 'SMS Aero';

		if (!email || !apiKey) {
			throw new InternalServerErrorException(
				'SMS Aero credentials are not configured'
			);
		}

		if (!number) {
			throw new BadGatewayException('SMS provider request failed');
		}

		const params = new URLSearchParams({
			number,
			text,
			sign
		});

		const auth = Buffer.from(`${email}:${apiKey}`).toString('base64');

		const response = await fetch(`${this.endpoint}?${params.toString()}`, {
			method: 'GET',
			headers: {
				Authorization: `Basic ${auth}`
			}
		});

		if (!response.ok) {
			throw new BadGatewayException('SMS provider request failed');
		}

		const contentType = response.headers.get('content-type') || '';
		if (!contentType.includes('application/json')) {
			return;
		}

		const data = (await response.json()) as SmsAeroResponse;

		if (!data.success) {
			throw new BadGatewayException(
				data.message || 'SMS provider returned an error'
			);
		}
	}
}
