import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { ReminderRuntimeModule } from './reminders/reminder-runtime.module';
import {
	reminderDeliveryEnabled,
	remindersRole
} from './reminders/reminder-delivery.contract';
import { terminateFailedBootstrap } from './runtime/bootstrap-failure';

let application: NestExpressApplication | undefined;
async function bootstrap() {
	if (
		remindersRole() !== 'reminders' ||
		!reminderDeliveryEnabled() ||
		process.env.CRM_SALES_REMINDERS_PORT !== '5331'
	)
		throw new Error('Invalid CRM reminder runtime configuration');
	application = await NestFactory.create<NestExpressApplication>(
		ReminderRuntimeModule,
		{ forceCloseConnections: true }
	);
	application.enableShutdownHooks();
	await application.listen(5331, '127.0.0.1');
}
void bootstrap().catch(() => {
	Logger.error(
		'CRM reminder runtime bootstrap failed',
		undefined,
		'Bootstrap'
	);
	return terminateFailedBootstrap(application);
});
