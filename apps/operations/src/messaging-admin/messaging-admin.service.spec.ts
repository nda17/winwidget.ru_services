import { MessagingAdminService } from './messaging-admin.service';
import type { OperationsPrismaService } from '../prisma/operations-prisma.service';
import type { OperationsFederationClient } from '../federation/operations-federation.client';
import type { RabbitMqManagementClient } from '../federation/rabbitmq-management.client';
import type { OperationsOutboxService } from '../messaging/operations-outbox.service';
import type { AdminEventLogService } from '../admin-event-log/admin-event-log.service';

describe('MessagingAdminService notification kind routing', () => {
	it('queries only Notification Delivery for WinCRM invitation failures', async () => {
		const getFailures = jest
			.fn()
			.mockResolvedValue({ items: [], total: 0 });
		const service = new MessagingAdminService(
			{
				integrationDeliveryFailure: {
					findMany: jest.fn().mockResolvedValue([]),
					count: jest.fn().mockResolvedValue(0)
				}
			} as unknown as OperationsPrismaService,
			{ getFailures } as unknown as OperationsFederationClient,
			{} as RabbitMqManagementClient,
			{} as OperationsOutboxService,
			{} as AdminEventLogService
		);
		const result = await service.getFailures(1, 20, {
			integration: 'wincrm-invitation-email'
		});
		expect(getFailures).toHaveBeenCalledTimes(1);
		expect(getFailures).toHaveBeenCalledWith(
			'notificationDelivery',
			1,
			20,
			{ integration: 'wincrm-invitation-email' }
		);
		expect(result.coverage.notificationDelivery).toBe('complete');
		expect(result.coverage.identity).toBe('not_queried');
	});
});
