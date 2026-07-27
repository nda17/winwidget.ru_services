import { loadConfig } from './config';
import { logger } from './logger';
import { createGateway } from './server';

const run = async () => {
	const config = loadConfig();
	const gateway = createGateway(config);
	const jwksReady = await gateway.initialize();

	await gateway.listen();
	logger.log('info', 'gateway_started', {
		listenHost: config.listenHost,
		port: config.port,
		routeCount: config.routes.length,
		jwksReady
	});

	let shuttingDown = false;
	const shutdown = async (signal: string, exitCode: number) => {
		if (shuttingDown) return;
		shuttingDown = true;
		logger.log('info', 'gateway_shutdown_started', { signal });
		await gateway.close();
		logger.log('info', 'gateway_shutdown_completed', { signal });
		process.exitCode = exitCode;
	};

	process.once('SIGTERM', () => {
		void shutdown('SIGTERM', 0);
	});
	process.once('SIGINT', () => {
		void shutdown('SIGINT', 0);
	});
	process.once('uncaughtException', () => {
		logger.log('error', 'uncaught_exception');
		void shutdown('uncaughtException', 1);
	});
	process.once('unhandledRejection', () => {
		logger.log('error', 'unhandled_rejection');
		void shutdown('unhandledRejection', 1);
	});
};

run().catch(() => {
	logger.log('error', 'gateway_start_failed');
	process.exitCode = 1;
});
