import { AuditReceiptStatus } from '@prisma/operations-client';
import { AdminEventLogService } from '../admin-event-log/admin-event-log.service';
import { OperationsPrismaService } from '../prisma/operations-prisma.service';
import { OperationsRuntimeService } from '../runtime/operations-runtime.service';
import { AuditReceiptService } from './audit-receipt.service';

describe('AuditReceiptService', () => {
	it('claims before delivery and completes receipt plus audit atomically', async () => {
		const transaction = {
			auditEventReceipt: {
				updateMany: jest.fn().mockResolvedValue({ count: 1 })
			}
		};
		const prisma = {
			auditEventReceipt: {
				create: jest.fn().mockResolvedValue({})
			},
			$transaction: jest.fn(async callback => callback(transaction))
		} as unknown as OperationsPrismaService;
		const runtime = {
			auditReceiptLeaseMs: 60_000
		} as OperationsRuntimeService;
		const audit = {
			recordInTransaction: jest.fn().mockResolvedValue({})
		} as unknown as AdminEventLogService;
		const service = new AuditReceiptService(prisma, runtime, audit);
		const eventId = '3ad36f14-550c-47bd-8f69-2c913cdb83ee';

		const claim = await service.claim(eventId);
		expect(claim.state).toBe('claimed');
		if (claim.state !== 'claimed') throw new Error('claim failed');
		expect(prisma.auditEventReceipt.create).toHaveBeenCalledWith({
			data: expect.objectContaining({
				eventId,
				status: AuditReceiptStatus.PROCESSING,
				leaseToken: claim.leaseToken
			})
		});

		await service.deliver(eventId, claim.leaseToken, {
			id: eventId,
			section: 'CAMPAIGNS',
			action: 'CAMPAIGN_CREATE',
			description: 'Создана кампания'
		});
		expect(audit.recordInTransaction).toHaveBeenCalledWith(
			transaction,
			expect.objectContaining({ id: eventId })
		);
		expect(transaction.auditEventReceipt.updateMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({
					eventId,
					status: AuditReceiptStatus.PROCESSING,
					leaseToken: claim.leaseToken
				}),
				data: expect.objectContaining({
					status: AuditReceiptStatus.DELIVERED
				})
			})
		);
	});
});
