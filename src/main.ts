import { AppModule } from '@/app.module';
import { GoogleRecaptchaExceptionFilter } from '@/filters/google-recaptcha-exception.filter';
import { AppHttpExceptionFilter } from '@/filters/http-exception.filter';
import { RecaptchaDevLoggingInterceptor } from '@/interceptors/recaptcha-dev-logging.interceptor';
import { RequestMethod } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { path as appRoot } from 'app-root-path';
import 'colors';
import * as cookieParser from 'cookie-parser';
import * as express from 'express';
import { join } from 'path';

export const bootstrap = async () => {
	const app = await NestFactory.create(AppModule);
	const httpAdapter = app.getHttpAdapter();
	const instance = httpAdapter.getInstance();
	if (typeof instance?.set === 'function') {
		instance.set('trust proxy', true);
	}

	app.setGlobalPrefix('api', {
		exclude: [
			{ path: 'auth/google', method: RequestMethod.GET },
			{ path: 'auth/google/redirect', method: RequestMethod.GET },
			{ path: 'auth/github', method: RequestMethod.GET },
			{ path: 'auth/github/redirect', method: RequestMethod.GET },
			{ path: 'auth/yandex', method: RequestMethod.GET },
			{ path: 'auth/yandex/redirect', method: RequestMethod.GET },
			{ path: 'auth/vk', method: RequestMethod.GET },
			{ path: 'auth/vk/redirect', method: RequestMethod.GET },
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

	app.use(cookieParser());
	app.use('/api/widget', (req: any, res: any, next: any) => {
		res.setHeader('Access-Control-Allow-Origin', '*');
		res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
		res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
		if (req.method === 'OPTIONS') return res.status(204).end();
		next();
	});
	app.use('/api/quiz', (req: any, res: any, next: any) => {
		res.setHeader('Access-Control-Allow-Origin', '*');
		res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
		res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
		if (req.method === 'OPTIONS') return res.status(204).end();
		next();
	});
	app.use('/api/callback', (req: any, res: any, next: any) => {
		res.setHeader('Access-Control-Allow-Origin', '*');
		res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
		res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
		if (req.method === 'OPTIONS') return res.status(204).end();
		next();
	});
	app.use('/api/countdown-timer', (req: any, res: any, next: any) => {
		res.setHeader('Access-Control-Allow-Origin', '*');
		res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
		res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
		if (req.method === 'OPTIONS') return res.status(204).end();
		next();
	});
	app.use('/api/stop-offer', (req: any, res: any, next: any) => {
		res.setHeader('Access-Control-Allow-Origin', '*');
		res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
		res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
		if (req.method === 'OPTIONS') return res.status(204).end();
		next();
	});
	app.use('/api/online-consultant', (req: any, res: any, next: any) => {
		res.setHeader('Access-Control-Allow-Origin', '*');
		res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
		res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
		if (req.method === 'OPTIONS') return res.status(204).end();
		next();
	});
	app.use('/api/calculator', (req: any, res: any, next: any) => {
		res.setHeader('Access-Control-Allow-Origin', '*');
		res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
		res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
		if (req.method === 'OPTIONS') return res.status(204).end();
		next();
	});
	// Serve static widget runtime files: /widgets/wheel.js etc.
	app.use(express.static(join(appRoot, 'public')));
	app.useGlobalInterceptors(new RecaptchaDevLoggingInterceptor());
	app.useGlobalFilters(
		new GoogleRecaptchaExceptionFilter(),
		new AppHttpExceptionFilter()
	);
	app.enableCors({
		origin:
			process.env.MODE === 'development'
				? true
				: ([process.env.RECAPTCHA_CLIENT_URL].filter(Boolean) as string[]),
		credentials: true,
		exposedHeaders: 'set-cookie'
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
