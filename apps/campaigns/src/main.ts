import {
	parseCampaignsListenHost,
	parseCampaignsPort
} from './health/campaigns-health.service';
import { CampaignsModule } from './campaigns.module';
import { Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';

async function bootstrap(): Promise<void> {
	const host = parseCampaignsListenHost(
		process.env.CAMPAIGNS_LISTEN_HOST,
		process.env.NODE_ENV
	);
	const port = parseCampaignsPort(process.env.CAMPAIGNS_HEALTH_PORT);
	const app = await NestFactory.create(CampaignsModule);
	app.useGlobalPipes(
		new ValidationPipe({
			transform: true,
			whitelist: true,
			forbidNonWhitelisted: true,
			stopAtFirstError: false
		})
	);
	app.enableShutdownHooks();
	await app.listen(port, host);
	Logger.log(
		`Campaigns service started host=${host} port=${port}`,
		'Bootstrap'
	);
}

void bootstrap();
