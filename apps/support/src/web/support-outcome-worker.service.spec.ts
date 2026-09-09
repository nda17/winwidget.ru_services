import { Test } from '@nestjs/testing';
import { SupportRabbitMqService } from '../messaging/support-rabbitmq.service';
import { SupportPrismaService } from '../prisma/support-prisma.service';
import { SupportRuntimeService } from '../runtime/support-runtime.service';
import { SUPPORT_OUTCOME_QUEUE } from './support-notifications.service';
import { SupportOutcomeWorkerService } from './support-outcome-worker.service';

describe('Support outcome worker startup', () => {
	it.each([
		{ workerEnabled: true, webChatEnabled: true },
		{ workerEnabled: true, webChatEnabled: false },
		{ workerEnabled: false, webChatEnabled: true }
	])(
		'waits for RabbitMQ initialization and respects process gates: %j',
		async runtime => {
			let connected = false;
			const events: string[] = [];
			const rabbit = {
				async onModuleInit() {
					events.push('rabbit-initializing');
					await Promise.resolve();
					connected = true;
					events.push('rabbit-ready');
				},
				consume: jest.fn(async () => {
					if (!connected) throw new Error('RabbitMQ consumer is disabled');
					events.push('outcome-consuming');
				})
			};
			const module = await Test.createTestingModule({
				// Keep the production order: Nest calls provider init hooks concurrently.
				providers: [
					SupportOutcomeWorkerService,
					{ provide: SupportPrismaService, useValue: {} },
					{ provide: SupportRuntimeService, useValue: runtime },
					{ provide: SupportRabbitMqService, useValue: rabbit }
				]
			}).compile();
			try {
				await module.init();
				if (runtime.workerEnabled && runtime.webChatEnabled) {
					expect(rabbit.consume).toHaveBeenCalledTimes(1);
					expect(rabbit.consume).toHaveBeenCalledWith(
						expect.any(Function),
						SUPPORT_OUTCOME_QUEUE
					);
					expect(events).toEqual([
						'rabbit-initializing',
						'rabbit-ready',
						'outcome-consuming'
					]);
				} else {
					expect(rabbit.consume).not.toHaveBeenCalled();
				}
			} finally {
				await module.close();
			}
		}
	);
});
