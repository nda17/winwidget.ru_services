import { AppModule } from '@/app.module';
import { getTrustProxyConfig } from '@/config/trust-proxy.config';
import { GoogleRecaptchaExceptionFilter } from '@/filters/google-recaptcha-exception.filter';
import { AppHttpExceptionFilter } from '@/filters/http-exception.filter';
import { RecaptchaDevLoggingInterceptor } from '@/interceptors/recaptcha-dev-logging.interceptor';
import { messagingContextMiddleware } from '@/messaging/messaging-context';
import { RequestMethod } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { path as appRoot } from 'app-root-path';
import 'colors';
import * as cookieParser from 'cookie-parser';
import * as express from 'express';
import { join } from 'path';

const API_PREFIX = 'api/v1';
const API_BASE_PATH = `/${API_PREFIX}`;

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
			{ path: 'widget/:key', method: RequestMethod.GET },
			{ path: 'page-wheel/:key', method: RequestMethod.GET },
			{ path: 'quiz-widget/:key', method: RequestMethod.GET },
			{ path: 'page-quiz/:key', method: RequestMethod.GET },
			{ path: 'page-callback/:key', method: RequestMethod.GET },
			{ path: 'page-timer/:key', method: RequestMethod.GET },
			{ path: 'page-stop-offer/:key', method: RequestMethod.GET },
			{ path: 'page-online-consultant/:key', method: RequestMethod.GET },
			{ path: 'page-calculator/:key', method: RequestMethod.GET }
		]
	});

	if (process.env.MODE === 'development') {
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		app.use(require('morgan')('dev'));
	}

	app.use(messagingContextMiddleware);
	app.use(cookieParser());
	app.use(`${API_BASE_PATH}/widget`, (req: any, res: any, next: any) => {
		res.setHeader('Access-Control-Allow-Origin', '*');
		res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
		res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
		if (req.method === 'OPTIONS') return res.status(204).end();
		next();
	});
	app.use(`${API_BASE_PATH}/quiz`, (req: any, res: any, next: any) => {
		res.setHeader('Access-Control-Allow-Origin', '*');
		res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
		res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
		if (req.method === 'OPTIONS') return res.status(204).end();
		next();
	});
	app.use(`${API_BASE_PATH}/callback`, (req: any, res: any, next: any) => {
		res.setHeader('Access-Control-Allow-Origin', '*');
		res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
		res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
		if (req.method === 'OPTIONS') return res.status(204).end();
		next();
	});
	app.use(
		`${API_BASE_PATH}/countdown-timer`,
		(req: any, res: any, next: any) => {
			res.setHeader('Access-Control-Allow-Origin', '*');
			res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
			res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
			if (req.method === 'OPTIONS') return res.status(204).end();
			next();
		}
	);
	app.use(
		`${API_BASE_PATH}/stop-offer`,
		(req: any, res: any, next: any) => {
			res.setHeader('Access-Control-Allow-Origin', '*');
			res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
			res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
			if (req.method === 'OPTIONS') return res.status(204).end();
			next();
		}
	);
	app.use(
		`${API_BASE_PATH}/online-consultant`,
		(req: any, res: any, next: any) => {
			res.setHeader('Access-Control-Allow-Origin', '*');
			res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
			res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
			if (req.method === 'OPTIONS') return res.status(204).end();
			next();
		}
	);
	app.use(
		`${API_BASE_PATH}/calculator`,
		(req: any, res: any, next: any) => {
			res.setHeader('Access-Control-Allow-Origin', '*');
			res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
			res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
			if (req.method === 'OPTIONS') return res.status(204).end();
			next();
		}
	);
	app.use(
		`${API_BASE_PATH}/widget-events`,
		(req: any, res: any, next: any) => {
			res.setHeader('Access-Control-Allow-Origin', '*');
			res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
			res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
			if (req.method === 'OPTIONS') return res.status(204).end();
			next();
		}
	);
	// Serve static widget runtime files: /widgets/wheel.js etc.
	app.use(express.static(join(appRoot, 'public')));
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
