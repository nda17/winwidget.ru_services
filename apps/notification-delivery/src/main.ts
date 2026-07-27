import { messagingContextMiddleware } from './messaging/messaging-context';
import { parseNotificationDeliveryHealthPort } from './notification-delivery/notification-delivery-health.service';
import { NotificationDeliveryModule } from './notification-delivery/notification-delivery.module';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';

const NOTIFICATION_DELIVERY_LISTEN_HOST = '127.0.0.1';

export const parseNotificationDeliveryListenHost = (
	value: string | undefined
): string => {
	const host = value?.trim() || NOTIFICATION_DELIVERY_LISTEN_HOST;
	if (host !== NOTIFICATION_DELIVERY_LISTEN_HOST) {
		throw new Error('NOTIFICATION_DELIVERY_LISTEN_HOST must be 127.0.0.1');
	}
	return host;
};

async function bootstrap() {
	const healthPort = parseNotificationDeliveryHealthPort(
		process.env.NOTIFICATION_DELIVERY_HEALTH_PORT
	);
	const listenHost = parseNotificationDeliveryListenHost(
		process.env.NOTIFICATION_DELIVERY_LISTEN_HOST
	);
	const app = await NestFactory.create(NotificationDeliveryModule);
	app.use(messagingContextMiddleware);
	app.enableShutdownHooks();
	await app.listen(healthPort, listenHost);
	Logger.log(
		`Notification delivery worker started; health endpoint=http://${listenHost}:${healthPort}`,
		'Bootstrap'
	);
}

void bootstrap();
