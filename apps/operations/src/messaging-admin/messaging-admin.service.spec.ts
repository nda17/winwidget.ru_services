import { BadRequestException } from '@nestjs/common';
import {
	IntegrationDeliveryFailure,
	IntegrationFailureResolution
} from '@prisma/operations-client';
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

const SOURCES = ['notificationDelivery', 'widgets', 'billing', 'identity'];
const now = new Date('2026-09-06T00:00:00.000Z');
const failureId = (item: object) => {
	expect('id' in item).toBe(true);
	return 'id' in item ? item.id : undefined;
};

const failure = (
	number: number,
	overrides: Partial<IntegrationDeliveryFailure> = {}
): IntegrationDeliveryFailure => ({
	id: `00000000-0000-4000-8000-${String(number).padStart(12, '0')}`,
	eventId: '10000000-0000-4000-8000-000000000001',
	integration: 'database-backup',
	eventType: 'test.failure',
	routingKey: 'test.failure',
	payload: {},
	attempts: 1,
	lastError: 'Synthetic failure',
	category: null,
	normalizedCode: null,
	safeReason: null,
	httpStatus: null,
	providerCode: null,
	retryable: null,
	failedAt: now,
	retryingAt: null,
	activeRetryToken: null,
	resolvedAt: null,
	resolution: null,
	resolutionComment: null,
	resolvedById: null,
	createdAt: now,
	updatedAt: now,
	...overrides
});

const rows = [
	failure(1),
	failure(2, { retryingAt: now }),
	failure(3, {
		resolvedAt: now,
		resolution: IntegrationFailureResolution.DELIVERED
	}),
	failure(4, {
		resolvedAt: now,
		resolution: IntegrationFailureResolution.CLOSED_NO_RETRY
	}),
	// Historical data with no known resolution must not be called delivered/closed.
	failure(5, { resolvedAt: now })
];

const createService = () => {
	const selected = (where: Record<string, unknown>) =>
		rows.filter(row =>
			Object.entries(where).every(([key, condition]) => {
				const value = row[key as keyof IntegrationDeliveryFailure];
				return condition &&
					typeof condition === 'object' &&
					'not' in condition
					? value !== condition.not
					: value === condition;
			})
		);
	const prisma = {
		integrationDeliveryFailure: {
			findMany: jest.fn(async ({ where }) => selected(where)),
			count: jest.fn(async ({ where }) => selected(where).length),
			updateMany: jest.fn()
		},
		$transaction: jest.fn()
	};
	const federation = {
		getFailures: jest.fn().mockResolvedValue({ items: [], total: 0 }),
		retryFailure: jest.fn(),
		closeFailure: jest.fn()
	};
	const outbox = { create: jest.fn() };
	const audit = { recordInTransaction: jest.fn() };
	return {
		prisma,
		federation,
		outbox,
		audit,
		service: new MessagingAdminService(
			prisma as never,
			federation as never,
			{} as never,
			outbox as never,
			audit as never
		)
	};
};

describe('Operations messaging failure read filters', () => {
	it.each([
		['FAILED', { resolvedAt: null, retryingAt: null }, [1]],
		['RETRYING', { resolvedAt: null, retryingAt: { not: null } }, [2]],
		[
			'RESOLVED',
			{ resolution: IntegrationFailureResolution.DELIVERED },
			[3]
		],
		[
			'CLOSED',
			{ resolution: IntegrationFailureResolution.CLOSED_NO_RETRY },
			[4]
		],
		['ALL', {}, [1, 2, 3, 4, 5]],
		['OPEN', { resolvedAt: null }, [1, 2]],
		['UNRESOLVED', { resolvedAt: null }, [1, 2]],
		[undefined, {}, [1, 2, 3, 4, 5]],
		['', {}, [1, 2, 3, 4, 5]]
	] as const)(
		'filters %s consistently for rows/count and forwards the unchanged public status',
		async (status, where, expectedRows) => {
			const value = createService();
			const filters = { status };
			const result = await value.service.getFailures(1, 20, filters);
			expect(
				value.prisma.integrationDeliveryFailure.findMany
			).toHaveBeenCalledWith({
				where,
				orderBy: [{ failedAt: 'desc' }, { id: 'desc' }],
				take: 20
			});
			expect(
				value.prisma.integrationDeliveryFailure.count
			).toHaveBeenCalledWith({ where });
			expect(result.items.map(failureId).sort()).toEqual(
				expectedRows.map(number => failure(number).id)
			);
			expect(result.total).toBe(expectedRows.length);
			expect(result).toMatchObject({
				page: 1,
				limit: 20,
				totalPages: 1,
				sourceErrors: {}
			});
			expect(value.federation.getFailures.mock.calls).toEqual(
				SOURCES.map(source => [source, 1, 20, filters])
			);
		}
	);

	it.each(['UNKNOWN', 'DELIVERED', 'CLOSED_NO_RETRY'])(
		'rejects unsupported %s before any repository or federation access',
		async status => {
			const value = createService();
			await expect(
				value.service.getFailures(1, 20, { status })
			).rejects.toThrow(BadRequestException);
			expect(
				value.prisma.integrationDeliveryFailure.findMany
			).not.toHaveBeenCalled();
			expect(
				value.prisma.integrationDeliveryFailure.count
			).not.toHaveBeenCalled();
			expect(value.federation.getFailures).not.toHaveBeenCalled();
		}
	);

	it('keeps unknown historical resolutions visible only under ALL, without rewriting data', async () => {
		const value = createService();
		for (const status of [
			'FAILED',
			'RETRYING',
			'RESOLVED',
			'CLOSED',
			'OPEN',
			'UNRESOLVED'
		]) {
			const result = await value.service.getFailures(1, 20, { status });
			expect(
				result.items.some(item => failureId(item) === failure(5).id)
			).toBe(false);
		}
		const result = await value.service.getFailures(1, 20, {
			status: 'ALL'
		});
		expect(
			result.items.find(item => failureId(item) === failure(5).id)
		).toMatchObject({
			resolution: null,
			resolvedAt: now.toISOString()
		});
		expect(
			value.prisma.integrationDeliveryFailure.updateMany
		).not.toHaveBeenCalled();
		expect(value.prisma.$transaction).not.toHaveBeenCalled();
		expect(value.outbox.create).not.toHaveBeenCalled();
		expect(value.audit.recordInTransaction).not.toHaveBeenCalled();
		expect(value.federation.retryFailure).not.toHaveBeenCalled();
		expect(value.federation.closeFailure).not.toHaveBeenCalled();
	});

	it('preserves category/integration filters and explicitly excludes unrelated owners', async () => {
		const value = createService();
		const result = await value.service.getFailures(2, 10, {
			status: 'FAILED',
			integration: 'webhook',
			category: 'TRANSIENT'
		});
		const where = {
			resolvedAt: null,
			retryingAt: null,
			integration: 'webhook',
			category: 'TRANSIENT'
		};
		expect(
			value.prisma.integrationDeliveryFailure.findMany
		).toHaveBeenCalledWith({
			where,
			orderBy: [{ failedAt: 'desc' }, { id: 'desc' }],
			take: 20
		});
		expect(
			value.prisma.integrationDeliveryFailure.count
		).toHaveBeenCalledWith({ where });
		expect(value.federation.getFailures.mock.calls).toEqual([
			[
				'widgets',
				1,
				20,
				{ status: 'FAILED', integration: 'webhook', category: 'TRANSIENT' }
			]
		]);
		expect(result.coverage).toEqual({
			operations: 'complete',
			widgets: 'complete',
			notificationDelivery: 'not_queried',
			billing: 'not_queried',
			identity: 'not_queried'
		});
	});

	it('reports a failed owner without hiding available FAILED rows', async () => {
		const value = createService();
		value.federation.getFailures.mockRejectedValueOnce(
			new Error('Synthetic unavailable source')
		);
		const result = await value.service.getFailures(1, 20, {
			status: 'FAILED'
		});
		expect(result.items.map(failureId)).toEqual([failure(1).id]);
		expect(result.total).toBe(1);
		expect(result.sourceErrors).toEqual({
			notificationDelivery: 'Источник ошибок временно недоступен'
		});
		expect(result.coverage).toEqual({
			operations: 'complete',
			notificationDelivery: 'unavailable',
			widgets: 'complete',
			billing: 'complete',
			identity: 'complete'
		});
	});
});
