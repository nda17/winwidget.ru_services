import {
	Injectable,
	OnApplicationBootstrap,
	BeforeApplicationShutdown,
	ConflictException
} from '@nestjs/common';
import type { ConsumeMessage } from 'amqplib';
import { randomUUID, createHash } from 'node:crypto';
import { CrmIntakePrismaService } from '../prisma/crm-intake-prisma.service';
import {
	WidgetTransferRabbit,
	TRANSFER_EVENT_TYPE
} from './widget-transfer.messaging';
import {
	parseWidgetTransferEvent,
	type TransferEvent
} from './widget-transfer.contract';
import { WidgetTransferProcessor } from './widget-transfer.processor';

@Injectable()
export class WidgetTransferWorker
	implements OnApplicationBootstrap, BeforeApplicationShutdown
{
	private readonly running = new Set<Promise<void>>();
	constructor(
		private readonly processor: WidgetTransferProcessor,
		private readonly rabbit: WidgetTransferRabbit,
		private readonly prisma: CrmIntakePrismaService
	) {}
	async onApplicationBootstrap() {
		await this.rabbit.consume(message => {
			const task = this.handle(message);
			this.running.add(task);
			return task.finally(() => this.running.delete(task));
		});
	}
	async handle(message: ConsumeMessage) {
		let event: TransferEvent;
		let retryAttempt: number;
		let retryGeneration: number;
		try {
			if (
				message.content.length > 16384 ||
				message.properties.type !== TRANSFER_EVENT_TYPE ||
				message.properties.contentType !== 'application/json'
			)
				throw new Error('INVALID_EVENT');
			event = parseWidgetTransferEvent(
				JSON.parse(message.content.toString('utf8'))
			);
			retryAttempt = message.properties.headers?.['x-retry-attempt'] ?? 0;
			retryGeneration =
				message.properties.headers?.[
					'x-wincrm-transfer-retry-generation'
				] ?? 0;
			if (
				message.properties.messageId !== event.eventId ||
				!Number.isInteger(retryAttempt) ||
				retryAttempt < 0 ||
				retryAttempt > 3 ||
				!Number.isSafeInteger(retryGeneration) ||
				retryGeneration < 0 ||
				retryGeneration > 2147483646
			)
				throw new Error('INVALID_EVENT');
		} catch {
			await this.quarantine(message);
			this.rabbit.ack(message);
			return;
		}
		const claim = await this.processor
			.claim(event, retryAttempt, retryGeneration)
			.catch(async error => {
				if (!(error instanceof ConflictException)) throw error;
				await this.quarantine(message);
				return { state: 'DONE' as const };
			});
		if (claim.state === 'DONE') {
			this.rabbit.ack(message);
			return;
		}
		let renewing = false;
		let renewal: Promise<unknown> | null = null;
		const timer = setInterval(() => {
			if (renewing) return;
			renewing = true;
			renewal = this.processor
				.renew(event, claim.token)
				.catch(() => false)
				.finally(() => {
					renewing = false;
				});
		}, 10000);
		timer.unref();
		try {
			await this.processor.run(event, claim.token);
			this.rabbit.ack(message);
		} catch (error) {
			if (
				await this.processor.fail(event, claim.token, retryAttempt, error)
			)
				this.rabbit.ack(message);
			else await this.rabbit.nackAfterBackoff(message);
		} finally {
			clearInterval(timer);
			if (renewal) await renewal;
		}
	}
	private async quarantine(message: ConsumeMessage) {
		// Never persist arbitrary broker content or headers. Repeated poison deliveries share a digest-only receipt.
		const id = randomUUID();
		const digest = createHash('sha256')
			.update(message.content)
			.digest('hex');
		await this.prisma.widgetTransferOutbox.createMany({
			data: [
				{
					id,
					eventId: id,
					deduplicationKey: `invalid:${digest}`,
					route: 'DLQ',
					payload: {
						schemaVersion: 1,
						eventType: TRANSFER_EVENT_TYPE,
						occurredAt: new Date().toISOString(),
						transferId: id,
						connectorId: id,
						originalSubscriptionId: null,
						originalSubscriptionVersion: null,
						originalPeriodStartsAt: null,
						originalDeadline: null,
						eventId: id,
						workspaceId: id,
						sourceId: id,
						generation: 1
					},
					lastErrorCode: 'INVALID_EVENT'
				}
			],
			skipDuplicates: true
		});
	}
	async beforeApplicationShutdown() {
		await this.rabbit.cancel();
		await Promise.allSettled(this.running);
	}
}
