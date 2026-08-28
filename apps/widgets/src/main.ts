import { Logger, RequestMethod, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import express from 'express';
import type { NextFunction, Request, Response } from 'express';
import { join, resolve } from 'node:path';
import { WidgetsJsonLogger } from './common/widgets-json.logger';
import { parseWidgetsCorsAllowedOrigins } from './config/widgets-cors.config';
import {
	parseWidgetsListenHost,
	parseWidgetsPort
} from './config/widgets-network.config';
import { parseWidgetsProcessRole } from './runtime/widgets-runtime.service';
import { WidgetsModule } from './widgets.module';

async function bootstrap(): Promise<void> {
	const role = parseWidgetsProcessRole(process.env.WIDGETS_PROCESS_ROLE);
	const host = parseWidgetsListenHost(
		process.env.WIDGETS_LISTEN_HOST,
		process.env.NODE_ENV
	);
	const port = parseWidgetsPort(process.env.WIDGETS_PORT);
	const app = await NestFactory.create(WidgetsModule, {
		logger: new WidgetsJsonLogger(),
		forceCloseConnections: true
	});
	if (role === 'all' || role === 'api') {
		app.use(
			'/widgets',
			express.static(
				resolve(
					process.env.WIDGETS_ASSETS_DIR ||
						join(__dirname, '../../public/widgets')
				),
				{
					dotfiles: 'deny',
					etag: true,
					fallthrough: true,
					immutable: false,
					maxAge: '5m',
					setHeaders: response =>
						response.setHeader('Access-Control-Allow-Origin', '*')
				}
			)
		);
		if (process.env.MODE?.trim().toLowerCase() !== 'production') {
			app.use(
				'/uploads',
				express.static(
					resolve(
						process.env.WIDGETS_UPLOADS_DIR ||
							join(process.cwd(), 'uploads')
					),
					{
						dotfiles: 'deny',
						etag: true,
						fallthrough: true,
						maxAge: '1h'
					}
				)
			);
		}
		const publicPrefixes = [
			'widget',
			'quiz',
			'callback',
			'countdown-timer',
			'stop-offer',
			'ai-consultant',
			'calculator'
		].map(value => `/api/v1/${value}`);
		app.use(
			publicPrefixes,
			(request: Request, response: Response, next: NextFunction) => {
				response.setHeader('Access-Control-Allow-Origin', '*');
				response.setHeader(
					'Access-Control-Allow-Methods',
					'GET, POST, OPTIONS'
				);
				response.setHeader('Access-Control-Allow-Headers', 'Content-Type');
				if (request.method === 'OPTIONS')
					return response.status(204).end();
				next();
			}
		);
		app.use(
			'/api/v1/widget-events',
			(request: Request, response: Response, next: NextFunction) => {
				response.setHeader('Access-Control-Allow-Origin', '*');
				response.setHeader(
					'Access-Control-Allow-Methods',
					'POST, OPTIONS'
				);
				response.setHeader('Access-Control-Allow-Headers', 'Content-Type');
				if (request.method === 'OPTIONS')
					return response.status(204).end();
				next();
			}
		);
	}
	app.setGlobalPrefix('api/v1', {
		exclude: [
			{ path: 'health/live', method: RequestMethod.GET },
			{ path: 'health/ready', method: RequestMethod.GET },
			{
				path: 'internal/v1/widgets/admin-owner-overview',
				method: RequestMethod.POST
			},
			{
				path: 'internal/v1/identity/widgets/admin-owner-overview',
				method: RequestMethod.POST
			}
		]
	});
	if (role === 'all' || role === 'api') {
		const allowedOrigins = parseWidgetsCorsAllowedOrigins(
			process.env.CORS_ALLOWED_ORIGINS
		);
		app.enableCors({
			origin: (origin, callback) =>
				callback(null, !origin || allowedOrigins.includes(origin)),
			credentials: true,
			exposedHeaders: 'set-cookie, x-request-id, x-correlation-id'
		});
	}
	app.useGlobalPipes(
		new ValidationPipe({
			transform: true,
			whitelist: true,
			forbidNonWhitelisted: true
		})
	);
	app.enableShutdownHooks();
	await app.listen(port, host);
	Logger.log(
		`Widgets service started host=${host} port=${port} role=${role}`,
		'Bootstrap'
	);
}

void bootstrap().catch(error => {
	new WidgetsJsonLogger().fatal(error, 'Bootstrap');
	process.exitCode = 1;
});
