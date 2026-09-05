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
	AcceptanceRabbit,
	ACCEPTANCE_EVENT_TYPE
} from './acceptance.messaging';
import {
	parseAcceptanceEvent,
	type AcceptanceEvent
} from './acceptance.contract';
import { AcceptanceProcessor } from './acceptance.processor';

@Injectable()
export class AcceptanceWorker
	implements OnApplicationBootstrap, BeforeApplicationShutdown
{
	private readonly running = new Set<Promise<void>>();
	constructor(
		private readonly processor: AcceptanceProcessor,
		private readonly rabbit: AcceptanceRabbit,
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
		let event: AcceptanceEvent;
		let retryAttempt: number;
		try {
			if (
				message.content.length > 16384 ||
				message.properties.type !== ACCEPTANCE_EVENT_TYPE ||
				message.properties.contentType !== 'application/json'
			)
				throw new Error('INVALID_EVENT');
			event = parseAcceptanceEvent(
				JSON.parse(message.content.toString('utf8'))
			);
			retryAttempt = message.properties.headers?.['x-retry-attempt'] ?? 0;
			if (
				message.properties.messageId !== event.eventId ||
				!Number.isInteger(retryAttempt) ||
				retryAttempt < 0 ||
				retryAttempt > 3
			)
				throw new Error('INVALID_EVENT');
		} catch {
			await this.quarantine(message);
			this.rabbit.ack(message);
			return;
		}
		const claim = await this.processor
			.claim(event, retryAttempt)
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
		const timer = setInterval(() => {
			if (renewing) return;
			renewing = true;
			void this.processor
				.renew(event, claim.token)
				.catch(() => false)
				.finally(() => {
					renewing = false;
				});
		}, 20000);
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
		}
	}
	private async quarantine(message: ConsumeMessage) {
		// Never persist arbitrary broker content or headers. Repeated poison deliveries share a digest-only receipt.
		const id = randomUUID();
		const digest = createHash('sha256')
			.update(message.content)
			.digest('hex');
		await this.prisma.acceptanceOutbox.createMany({
			data: [
				{
					id,
					eventId: id,
					deduplicationKey: `invalid:${digest}`,
					route: 'DLQ',
					payload: {
						schemaVersion: 1,
						eventId: id,
						workspaceId: id,
						workflowId: id,
						generation: 1,
						mode: 'EXECUTE'
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
