import { Injectable, Module, OnApplicationShutdown } from '@nestjs/common';
import {
	GLOBAL_MODULE_METADATA,
	MODULE_METADATA
} from '@nestjs/common/constants';
import { Test } from '@nestjs/testing';
import { NotificationDeliveryPrismaModule } from './notification-delivery-prisma.module';
import { NotificationDeliveryPrismaService } from './notification-delivery-prisma.service';

@Injectable()
class FirstConsumer {
	constructor(readonly prisma: NotificationDeliveryPrismaService) {}
}

@Injectable()
class SecondConsumer {
	constructor(readonly prisma: NotificationDeliveryPrismaService) {}
}

@Module({
	providers: [FirstConsumer],
	exports: [FirstConsumer]
})
class FirstConsumerModule {}

@Module({
	providers: [SecondConsumer],
	exports: [SecondConsumer]
})
class SecondConsumerModule {}

@Module({
	imports: [
		NotificationDeliveryPrismaModule,
		FirstConsumerModule,
		SecondConsumerModule
	]
})
class TestRootModule implements OnApplicationShutdown {
	constructor(
		private readonly prisma: NotificationDeliveryPrismaService
	) {}

	onApplicationShutdown() {
		return this.prisma.disconnect();
	}
}

describe('NotificationDeliveryPrismaModule', () => {
	const originalDatabaseUrl =
		process.env.NOTIFICATION_DELIVERY_DATABASE_URL;

	beforeEach(() => {
		process.env.NOTIFICATION_DELIVERY_DATABASE_URL =
			'postgresql://notification:notification@127.0.0.1:5432/test';
	});

	afterEach(() => {
		jest.restoreAllMocks();
		if (originalDatabaseUrl === undefined) {
			delete process.env.NOTIFICATION_DELIVERY_DATABASE_URL;
		} else {
			process.env.NOTIFICATION_DELIVERY_DATABASE_URL = originalDatabaseUrl;
		}
	});

	it('is global and exports only one Prisma service', () => {
		expect(
			Reflect.getMetadata(
				GLOBAL_MODULE_METADATA,
				NotificationDeliveryPrismaModule
			)
		).toBe(true);
		expect(
			Reflect.getMetadata(
				MODULE_METADATA.PROVIDERS,
				NotificationDeliveryPrismaModule
			)
		).toEqual([NotificationDeliveryPrismaService]);
		expect(
			Reflect.getMetadata(
				MODULE_METADATA.EXPORTS,
				NotificationDeliveryPrismaModule
			)
		).toEqual([NotificationDeliveryPrismaService]);
	});

	it('shares one client in a root context and disconnects it once', async () => {
		const connect = jest
			.spyOn(NotificationDeliveryPrismaService.prototype, '$connect')
			.mockResolvedValue();
		const disconnect = jest
			.spyOn(NotificationDeliveryPrismaService.prototype, '$disconnect')
			.mockResolvedValue();
		const moduleRef = await Test.createTestingModule({
			imports: [TestRootModule]
		}).compile();

		await moduleRef.init();

		expect(moduleRef.get(FirstConsumer).prisma).toBe(
			moduleRef.get(SecondConsumer).prisma
		);
		expect(connect).toHaveBeenCalledTimes(1);

		await moduleRef.close();

		expect(disconnect).toHaveBeenCalledTimes(1);
	});

	it.each(['', 'change_me', 'XYZXYZXYZ'])(
		'rejects an unsafe database URL placeholder: %p',
		databaseUrl => {
			process.env.NOTIFICATION_DELIVERY_DATABASE_URL = databaseUrl;

			expect(() => new NotificationDeliveryPrismaService()).toThrow(
				'Notification delivery database URL is missing'
			);
		}
	);
});
