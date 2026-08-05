import { AppModule } from '@/app.module';
import { getTrustProxyConfig } from '@/config/trust-proxy.config';
import { GoogleRecaptchaExceptionFilter } from '@/filters/google-recaptcha-exception.filter';
import { AppHttpExceptionFilter } from '@/filters/http-exception.filter';
import { RecaptchaDevLoggingInterceptor } from '@/interceptors/recaptcha-dev-logging.interceptor';
import { messagingContextMiddleware } from '@/messaging/messaging-context';
import { RequestMethod } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import 'colors';
import * as cookieParser from 'cookie-parser';

const API_PREFIX = 'api/v1';

const getCorsAllowedOrigins = () => {
	if (process.env.MODE === 'development') {
		return true;
	}

	const values = process.env.CORS_ALLOWED_ORIGINS?.split(',').map(value =>
		value.trim()
	);

	if (!values?.length || values.some(value => !value || value === '*')) {
		throw new Error(
			'CORS_ALLOWED_ORIGINS must contain exact http/https origins'
		);
	}

	const origins = values.map(value => {
		const url = new URL(value);

		if (
			!['http:', 'https:'].includes(url.protocol) ||
			url.username ||
			url.password ||
			url.pathname !== '/' ||
			url.search ||
			url.hash
		) {
			throw new Error(
				'CORS_ALLOWED_ORIGINS must contain exact http/https origins'
			);
		}

		return url.origin;
	});

	return [...new Set(origins)];
};

export const bootstrap = async () => {
	const app = await NestFactory.create(AppModule, {
		forceCloseConnections: true
	});
	app.enableShutdownHooks();
	const httpAdapter = app.getHttpAdapter();
	const instance = httpAdapter.getInstance();
	if (typeof instance?.set === 'function') {
		instance.set(
			'trust proxy',
			getTrustProxyConfig(process.env.TRUST_PROXY)
		);
	}

	app.setGlobalPrefix(API_PREFIX, {
		exclude: [
			{
				path: 'internal/v1/auth/introspect',
				method: RequestMethod.POST
			},
			{
				path: 'internal/v1/campaigns/audience-export',
				method: RequestMethod.POST
			},
			{
				path: 'internal/v1/widgets/auth/introspect',
				method: RequestMethod.POST
			},
			{
				path: 'internal/v1/widgets/owners/resolve',
				method: RequestMethod.POST
			},
			{
				path: 'internal/v1/widgets/owners/search',
				method: RequestMethod.POST
			}
		]
	});

	if (process.env.MODE === 'development') {
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		app.use(require('morgan')('dev'));
	}

	app.use(messagingContextMiddleware);
	app.use(cookieParser());
	app.useGlobalInterceptors(new RecaptchaDevLoggingInterceptor());
	app.useGlobalFilters(
		new GoogleRecaptchaExceptionFilter(),
		new AppHttpExceptionFilter()
	);
	app.enableCors({
		origin: getCorsAllowedOrigins(),
		credentials: true,
		exposedHeaders: 'set-cookie, x-request-id, x-correlation-id'
	});

	const port = process.env.PORT || 5000;
	const listenHost = process.env.API_LISTEN_HOST?.trim();
	const displayHost = listenHost || 'localhost';
	const onListen = () =>
		console.info(
			`🚀🚀🚀 Server running in ${process.env.MODE} mode at http://${displayHost}:${port} 🚀🚀🚀`
				.bgRed.bold
		);

	if (listenHost) {
		await app.listen(port, listenHost, onListen);
		return;
	}

	await app.listen(port, onListen);
};

bootstrap();
