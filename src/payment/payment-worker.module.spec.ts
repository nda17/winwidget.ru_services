import { IntegrationWorkerModule } from '@/messaging/integration-worker.module';
import { PaymentCleanupService } from '@/payment/payment-cleanup.service';
import { PrismaService } from '@/prisma.service';
import { Test } from '@nestjs/testing';

describe('PaymentWorkerModule', () => {
	it('resolves the Billing-aware cleanup service in the worker context', async () => {
		const prisma = {
			messagingHeartbeat: {
				deleteMany: jest.fn().mockResolvedValue({ count: 0 })
			},
			disconnect: jest.fn().mockResolvedValue(undefined)
		};
		const moduleRef = await Test.createTestingModule({
			imports: [IntegrationWorkerModule]
		})
			.overrideProvider(PrismaService)
			.useValue(prisma)
			.compile();

		try {
			expect(moduleRef.get(PaymentCleanupService)).toBeInstanceOf(
				PaymentCleanupService
			);
		} finally {
			await moduleRef.close();
		}

		expect(prisma.disconnect).toHaveBeenCalledTimes(1);
	});
});
