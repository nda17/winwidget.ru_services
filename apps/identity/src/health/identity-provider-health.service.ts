import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AuthSettingsService } from '../auth/auth-settings.service';
import { VerificationTransportService } from '../transports/verification-transport.service';

type ProviderHealthStatus = 'ok' | 'warning' | 'down' | 'disabled';

export type IdentityProviderHealthCheck = {
	id: 'smtp' | 'smsaero' | 'recaptcha';
	title: string;
	status: ProviderHealthStatus;
	message: string;
	latencyMs?: number;
};

const PROVIDER_PROBE_TIMEOUT_MS = 3_000;

@Injectable()
export class IdentityProviderHealthService {
	constructor(
		private readonly config: ConfigService,
		private readonly settings: AuthSettingsService,
		private readonly transport: VerificationTransportService
	) {}

	async providerHealth(): Promise<{
		service: 'identity';
		checks: IdentityProviderHealthCheck[];
	}> {
		const authSettings = await this.settings.get().catch(() => null);
		const checks = await Promise.all([
			this.checkSmtp(),
			this.checkSmsAero(),
			this.checkRecaptcha(authSettings?.recaptchaEnabled ?? null)
		]);
		return { service: 'identity', checks };
	}

	private checkSmtp(): Promise<IdentityProviderHealthCheck> {
		if (!this.transport.isEmailConfigured()) {
			return Promise.resolve({
				id: 'smtp',
				title: 'Email SMTP',
				status: 'warning',
				message: 'SMTP не настроен'
			});
		}
		return this.probe('smtp', 'Email SMTP', () =>
			this.transport.verifyEmailTransport()
		);
	}

	private checkSmsAero(): Promise<IdentityProviderHealthCheck> {
		if (!this.transport.isSmsConfigured()) {
			return Promise.resolve({
				id: 'smsaero',
				title: 'SMS Aero',
				status: 'warning',
				message: 'SMS Aero не настроен'
			});
		}
		return this.probe('smsaero', 'SMS Aero', () =>
			this.transport.verifySmsTransport()
		);
	}

	private async checkRecaptcha(
		databaseEnabled: boolean | null
	): Promise<IdentityProviderHealthCheck> {
		if (databaseEnabled === null) {
			return {
				id: 'recaptcha',
				title: 'reCAPTCHA',
				status: 'down',
				message: 'Настройки reCAPTCHA недоступны'
			};
		}
		const environmentEnabled =
			this.config.get<string>('RECAPTCHA_ENABLED') === 'true';
		if (!environmentEnabled) {
			return {
				id: 'recaptcha',
				title: 'reCAPTCHA',
				status: 'disabled',
				message: 'reCAPTCHA отключена конфигурацией'
			};
		}
		if (!databaseEnabled) {
			return {
				id: 'recaptcha',
				title: 'reCAPTCHA',
				status: 'disabled',
				message: 'reCAPTCHA отключена настройками'
			};
		}
		const secret =
			this.config.get<string>('RECAPTCHA_SECRET_KEY')?.trim() || '';
		return {
			id: 'recaptcha',
			title: 'reCAPTCHA',
			status: secret ? 'ok' : 'warning',
			message: secret ? 'Ключ настроен' : 'Ключ не настроен'
		};
	}

	private async probe(
		id: 'smtp' | 'smsaero',
		title: string,
		operation: () => Promise<void>
	): Promise<IdentityProviderHealthCheck> {
		const startedAt = Date.now();
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			await Promise.race([
				operation(),
				new Promise<never>((_, reject) => {
					timer = setTimeout(
						() => reject(new Error('provider health timeout')),
						PROVIDER_PROBE_TIMEOUT_MS
					);
				})
			]);
			return {
				id,
				title,
				status: 'ok',
				message: 'Подключение работает',
				latencyMs: Date.now() - startedAt
			};
		} catch {
			return {
				id,
				title,
				status: 'down',
				message: 'Проверка подключения не пройдена',
				latencyMs: Date.now() - startedAt
			};
		} finally {
			if (timer) clearTimeout(timer);
		}
	}
}
