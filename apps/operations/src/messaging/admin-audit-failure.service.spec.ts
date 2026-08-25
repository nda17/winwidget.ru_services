import { ConflictException } from '@nestjs/common';
import { AuditReceiptStatus } from '@prisma/operations-client';
import { AdminEventLogService } from '../admin-event-log/admin-event-log.service';
import { OperationsPrismaService } from '../prisma/operations-prisma.service';
import { AdminAuditFailureService } from './admin-audit-failure.service';
import { OperationsOutboxService } from './operations-outbox.service';

const EVENT_ID = '3ad36f14-550c-47bd-8f69-2c913cdb83ee';
const payload = {
	schemaVersion: 1,
	eventType: 'admin.audit.event.v1',
	eventId: EVENT_ID,
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

function setup(updateCount = 1, payloadOverride: unknown = payload) {
	const transaction = {
		auditEventReceipt: {
			findUnique: jest.fn().mockResolvedValue({
				id: 'f14f8f8e-5484-4595-9286-a233402249e0',
				eventId: EVENT_ID,
				consumer: 'operations-admin-event-log-v1',
				status: AuditReceiptStatus.DEAD_LETTERED,
				deadLetterSource: 'platform',
				deadLetterPayload: payloadOverride,
				manualRetryCycle: 0
			}),
			updateMany: jest.fn().mockResolvedValue({ count: updateCount })
		}
	};
	const prisma = {
		$transaction: jest.fn(async callback => callback(transaction))
	} as unknown as OperationsPrismaService;
	const outbox = {
		enqueue: jest.fn().mockResolvedValue({})
	} as unknown as OperationsOutboxService;
	const audit = {
		recordInTransaction: jest.fn().mockResolvedValue({})
	} as unknown as AdminEventLogService;
	return {
		service: new AdminAuditFailureService(prisma, outbox, audit),
		transaction,
		outbox,
		audit
	};
}

describe('AdminAuditFailureService', () => {
	it('CAS-transitions a DLQ receipt and enqueues the manual retry atomically', async () => {
		const value = setup();
		await expect(
			value.service.retry(EVENT_ID, {
				actorId: 'dev-1',
				correlationId: '8cff5536-30fc-4418-944c-4becae6f4b6c',
				ip: '127.0.0.1',
				userAgent: 'jest'
			})
		).resolves.toEqual({
			accepted: true,
			eventId: EVENT_ID,
			manualRetryCycle: 1
		});
		expect(
			value.transaction.auditEventReceipt.updateMany
		).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({
					status: AuditReceiptStatus.DEAD_LETTERED,
					manualRetryCycle: 0
				}),
				data: expect.objectContaining({
					status: AuditReceiptStatus.RETRY_SCHEDULED,
					manualRetryCycle: 1
				})
			})
		);
		expect(value.outbox.enqueue).toHaveBeenCalledWith(
			value.transaction,
			expect.objectContaining({
				messageId: EVENT_ID,
				deduplicationKey: `${EVENT_ID}:manual:1`,
				exchange: 'winwidget.manual-retry',
				routingKey: 'operations.admin.audit.platform.manual.v1',
				payload
			})
		);
		expect(value.audit.recordInTransaction).toHaveBeenCalledWith(
			value.transaction,
			expect.objectContaining({
				action: 'MESSAGING_FAILURE_RETRY',
				entityId: EVENT_ID
			})
		);
	});

	it('rejects a concurrent duplicate without a second Outbox row', async () => {
		const value = setup(0);
		await expect(
			value.service.retry(EVENT_ID, {
				actorId: 'dev-1',
				correlationId: '8cff5536-30fc-4418-944c-4becae6f4b6c',
				ip: null,
				userAgent: null
			})
		).rejects.toEqual(
			new ConflictException('Audit failure retry state changed')
		);
		expect(value.outbox.enqueue).not.toHaveBeenCalled();
	});

	it('rejects malformed retained payload before changing state', async () => {
		const value = setup(1, { eventId: EVENT_ID });
		await expect(
			value.service.retry(EVENT_ID, {
				actorId: 'dev-1',
				correlationId: '8cff5536-30fc-4418-944c-4becae6f4b6c',
				ip: null,
				userAgent: null
			})
		).rejects.toEqual(
			new ConflictException('Audit failure payload is invalid')
		);
		expect(
			value.transaction.auditEventReceipt.updateMany
		).not.toHaveBeenCalled();
	});
});
