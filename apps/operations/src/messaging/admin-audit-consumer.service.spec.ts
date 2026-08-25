import type { ConsumeMessage } from 'amqplib';
import { Logger } from '@nestjs/common';
import { OperationsRuntimeService } from '../runtime/operations-runtime.service';
import { AdminAuditConsumerService } from './admin-audit-consumer.service';
import { AuditReceiptService } from './audit-receipt.service';
import { OPERATIONS_AUDIT_SOURCES } from './operations-messaging.constants';
import { OperationsRabbitMqService } from './operations-rabbitmq.service';

describe('AdminAuditConsumerService', () => {
	beforeAll(() => {
		jest
			.spyOn(Logger.prototype, 'log')
			.mockImplementation(() => undefined);
		jest
			.spyOn(Logger.prototype, 'warn')
			.mockImplementation(() => undefined);
		jest
			.spyOn(Logger.prototype, 'error')
			.mockImplementation(() => undefined);
	});

	afterAll(() => {
		jest.restoreAllMocks();
	});

	const source = OPERATIONS_AUDIT_SOURCES.find(
		item => item.source === 'platform'
	)!;
	const eventId = '3ad36f14-550c-47bd-8f69-2c913cdb83ee';
	const payload = {
		schemaVersion: 1,
		eventType: 'admin.audit.event.v1',
		eventId,
		occurredAt: '2026-08-24T00:00:00.000Z',
		correlationId: '68165343-a387-4dc1-b875-e511c3038c67',
		actorId: 'admin-1',
		section: 'PLATFORM_CONTENT',
		action: 'PLATFORM_SITE_SETTINGS_UPDATE',
		description: 'Настройки обновлены',
		entity: {
			type: 'site_settings',
			id: 'singleton',
			label: null,
			targetUserId: null
		},
		metadata: {
			actorRole: 'ADMIN',
			requestIp: null,
			requestUserAgent: null,
			changedFields: ['bannerEnabled'],
			bannerTextChanged: false,
			bannerEnabled: true
		}
	};
	const message = (attempt = 0) =>
		({
			content: Buffer.from(JSON.stringify(payload)),
			properties: {
				type: 'admin.audit.event.v1',
				messageId: eventId,
				headers: { 'x-retry-attempt': attempt }
			}
		}) as unknown as ConsumeMessage;

	function setup(delivery: 'success' | 'failure') {
		const runtime = {
			workerEnabled: true,
			auditMaxRetryAttempts: 4,
			auditRetryDelayMs: 30_000
		} as OperationsRuntimeService;
		const rabbit = {
			consumeAuditEvents: jest.fn(),
			publishAuditRetry: jest.fn().mockResolvedValue(undefined),
			publishAuditDeadLetter: jest.fn().mockResolvedValue(undefined)
		} as unknown as OperationsRabbitMqService;
		const receipts = {
			claim: jest.fn().mockResolvedValue({
				state: 'claimed',
				leaseToken: '5e511f01-7c25-46b0-8e0e-f7c443355db5'
			}),
			deliver:
				delivery === 'success'
					? jest.fn().mockResolvedValue(undefined)
					: jest.fn().mockRejectedValue(new Error('database')),
			scheduleRetry: jest.fn().mockResolvedValue(undefined),
			markDeadLettered: jest.fn().mockResolvedValue(undefined),
			releaseForRedelivery: jest.fn().mockResolvedValue(undefined)
		} as unknown as AuditReceiptService;
		return {
			service: new AdminAuditConsumerService(runtime, rabbit, receipts, {
				isActive: jest.fn().mockResolvedValue(true)
			} as never),
			rabbit,
			receipts
		};
	}

	it('starts ready but does not consume while ownership is staged', async () => {
		const runtime = { workerEnabled: true } as OperationsRuntimeService;
		const rabbit = {
			consumeAuditEvents: jest.fn(),
			prepareAuditTopology: jest.fn().mockResolvedValue(undefined)
		} as unknown as OperationsRabbitMqService;
		const service = new AdminAuditConsumerService(
			runtime,
			rabbit,
			{} as AuditReceiptService,
			{ isActive: jest.fn().mockResolvedValue(false) } as never
		);

		await service.onModuleInit();

		expect(service.isReady()).toBe(true);
		expect(rabbit.prepareAuditTopology).toHaveBeenCalledTimes(1);
		expect(rabbit.consumeAuditEvents).not.toHaveBeenCalled();
	});

	it('acks only after the claimed receipt and audit transaction succeeds', async () => {
		const { service, receipts } = setup('success');
		await expect(service.handle(source, message())).resolves.toBe('ack');
		expect(receipts.claim).toHaveBeenCalledWith(eventId);
		expect(receipts.deliver).toHaveBeenCalledWith(
			eventId,
			'5e511f01-7c25-46b0-8e0e-f7c443355db5',
			expect.objectContaining({ id: eventId })
		);
	});

	it('confirms retry publication before scheduling the receipt', async () => {
		const { service, rabbit, receipts } = setup('failure');
		await expect(service.handle(source, message(0))).resolves.toBe('ack');
		expect(rabbit.publishAuditRetry).toHaveBeenCalledWith(
			source,
			payload,
			eventId,
			1,
			30_000
		);
		expect(receipts.scheduleRetry).toHaveBeenCalledTimes(1);
		expect(
			(rabbit.publishAuditRetry as jest.Mock).mock.invocationCallOrder[0]
		).toBeLessThan(
			(receipts.scheduleRetry as jest.Mock).mock.invocationCallOrder[0]
		);
	});

	it('publishes to DLQ and terminally marks the receipt after the retry budget', async () => {
		const { service, rabbit, receipts } = setup('failure');
		await expect(service.handle(source, message(4))).resolves.toBe('ack');
		expect(rabbit.publishAuditDeadLetter).toHaveBeenCalledWith(
			source,
			payload,
			eventId,
			5
		);
		expect(receipts.markDeadLettered).toHaveBeenCalledWith(
			eventId,
			'5e511f01-7c25-46b0-8e0e-f7c443355db5',
			source,
			payload
		);
		expect(rabbit.publishAuditRetry).not.toHaveBeenCalled();
	});
});
