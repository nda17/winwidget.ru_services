import { ConfigService } from '@nestjs/config';
import nodemailer, { type Transporter } from 'nodemailer';
import type SMTPTransport from 'nodemailer/lib/smtp-transport';

export const EMAIL_TRANSPORTER = Symbol('EMAIL_TRANSPORTER');

interface EmailTransportConfig {
	transport: SMTPTransport.Options;
	defaults: SMTPTransport.Options;
}

export const getMailerConfig = async (
	configService: ConfigService
): Promise<EmailTransportConfig> => {
	const isDevelopment = configService.get('MODE') === 'development';
	const configuredPort = Number(configService.get<string>('SMTP_PORT'));
	const port =
		Number.isInteger(configuredPort) &&
		configuredPort >= 1 &&
		configuredPort <= 65_535
			? configuredPort
			: isDevelopment
				? 2525
				: 465;
	const configuredSecure = configService.get<string | boolean>(
		'SMTP_SECURE'
	);
	const secure =
		configuredSecure === true || configuredSecure === 'true'
			? true
			: configuredSecure === false || configuredSecure === 'false'
				? false
				: !isDevelopment;
	const getTimeout = (key: string, fallback: number): number => {
		const value = Number(configService.get<string>(key));
		return Number.isInteger(value) && value >= 1000 && value <= 60_000
			? value
			: fallback;
	};

	return {
		transport: {
			host: configService.get('SMTP_SERVER'),
			port,
			secure,
			connectionTimeout: getTimeout('SMTP_CONNECTION_TIMEOUT_MS', 5000),
			greetingTimeout: getTimeout('SMTP_GREETING_TIMEOUT_MS', 5000),
			socketTimeout: getTimeout('SMTP_SOCKET_TIMEOUT_MS', 15_000),
			auth: {
				user: configService.get('SMTP_LOGIN'),
				pass: configService.get('SMTP_PASSWORD')
			}
		},
		defaults: {
			from: '"winwidget.ru" <no-reply@winwidget.ru>'
		}
	};
};

export const createEmailTransporter = async (
	configService: ConfigService
): Promise<Transporter> => {
	const { transport, defaults } = await getMailerConfig(configService);
	return nodemailer.createTransport(transport, defaults);
};
