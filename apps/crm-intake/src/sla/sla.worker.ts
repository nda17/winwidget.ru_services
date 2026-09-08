import {
	Injectable,
	OnApplicationBootstrap,
	BeforeApplicationShutdown,
	ConflictException
} from '@nestjs/common';
import type { ConsumeMessage } from 'amqplib';
import { randomUUID, createHash } from 'node:crypto';
import { CrmIntakePrismaService } from '../prisma/crm-intake-prisma.service';
import { SlaRabbit, SLA_EVENT_TYPE } from './sla.messaging';
import { parseSlaEvent, type SlaEvent } from './sla.contract';
import { SlaProcessor } from './sla.processor';
import { SlaReadinessService } from './sla-readiness.service';

@Injectable()
export class SlaWorker
	implements OnApplicationBootstrap, BeforeApplicationShutdown
{
	private readonly running = new Set<Promise<void>>();
	constructor(
		private readonly processor: SlaProcessor,
		private readonly rabbit: SlaRabbit,
		private readonly prisma: CrmIntakePrismaService,
		private readonly readiness: SlaReadinessService
	) {}
	async onApplicationBootstrap() {
		if (!(await this.readiness.ready()))
			throw new Error('SLA_DELIVERY_NOT_READY');
		await this.rabbit.consume(message => {
			const task = this.handle(message);
			this.running.add(task);
			return task.finally(() => this.running.delete(task));
		});
	}
	async handle(message: ConsumeMessage) {
		let event: SlaEvent;
		let retryAttempt: number;
		try {
			if (
				message.content.length > 16384 ||
				message.properties.type !== SLA_EVENT_TYPE ||
				message.properties.contentType !== 'application/json'
			)
				throw new Error('INVALID_EVENT');
			event = parseSlaEvent(JSON.parse(message.content.toString('utf8')));
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
		} catch {
			if (await this.processor.fail(event, claim.token, retryAttempt))
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
		await this.prisma.slaOutbox.createMany({
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
						jobId: id,
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
