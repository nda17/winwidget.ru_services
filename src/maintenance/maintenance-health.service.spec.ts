import {
	MaintenanceHealthService,
	parseMaintenanceHealthPort
} from '@/maintenance/maintenance-health.service';
import type { MaintenanceWorkerService } from '@/maintenance/maintenance-worker.service';
import type { RabbitMqService } from '@/messaging/rabbitmq.service';
import type { PrismaService } from '@/prisma.service';
import { ServiceUnavailableException } from '@nestjs/common';

describe('MaintenanceHealthService', () => {
	const previousRevision = process.env.APP_REVISION;

	afterEach(() => {
		if (previousRevision === undefined) {
			delete process.env.APP_REVISION;
		} else {
			process.env.APP_REVISION = previousRevision;
		}
	});

	const createService = () => {
		const maintenanceWorker = {
			isReady: jest.fn().mockReturnValue(true)
		} as unknown as MaintenanceWorkerService;
		const rabbitMq = {
			isConnected: jest.fn().mockReturnValue(true),
			areConsumersReady: jest.fn().mockReturnValue(true)
		} as unknown as RabbitMqService;
		const prisma = {
			$queryRaw: jest.fn().mockResolvedValue([{ '?column?': 1 }])
		} as unknown as PrismaService;

		return {
			service: new MaintenanceHealthService(
				maintenanceWorker,
				rabbitMq,
				prisma
			),
			maintenanceWorker,
			rabbitMq,
			prisma
		};
	};

	it('returns liveness metadata without checking dependencies', () => {
		process.env.APP_REVISION = 'revision-1';
		const { service, maintenanceWorker, rabbitMq, prisma } =
			createService();

		expect(service.getLivenessHealth()).toEqual({
			status: 'ok',
			service: 'maintenance-worker',
			revision: 'revision-1'
		});
		expect(maintenanceWorker.isReady).not.toHaveBeenCalled();
		expect(rabbitMq.isConnected).not.toHaveBeenCalled();
		expect(rabbitMq.areConsumersReady).not.toHaveBeenCalled();
		expect(prisma.$queryRaw).not.toHaveBeenCalled();
	});

	it('returns readiness only when the worker, RabbitMQ and database are ready', async () => {
		process.env.APP_REVISION = 'revision-2';
		const { service, prisma } = createService();

		await expect(service.getReadinessHealth()).resolves.toEqual({
			status: 'ready',
			service: 'maintenance-worker',
			revision: 'revision-2'
		});
		expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
	});

	it('rejects readiness before the worker is initialized', async () => {
		const { service, maintenanceWorker, prisma } = createService();
		jest.mocked(maintenanceWorker.isReady).mockReturnValue(false);

		await expect(service.getReadinessHealth()).rejects.toThrow(
			new ServiceUnavailableException('Maintenance worker is not ready')
		);
		expect(prisma.$queryRaw).not.toHaveBeenCalled();
	});

	it('rejects readiness while RabbitMQ consumers are not registered', async () => {
		const { service, rabbitMq, prisma } = createService();
		jest.mocked(rabbitMq.areConsumersReady).mockReturnValue(false);

		await expect(service.getReadinessHealth()).rejects.toThrow(
			new ServiceUnavailableException('RabbitMQ consumers are not ready')
		);
		expect(prisma.$queryRaw).not.toHaveBeenCalled();
	});

	it('rejects readiness when RabbitMQ is disconnected', async () => {
		const { service, rabbitMq, prisma } = createService();
		jest.mocked(rabbitMq.isConnected).mockReturnValue(false);

		await expect(service.getReadinessHealth()).rejects.toThrow(
			new ServiceUnavailableException('RabbitMQ is not ready')
		);
		expect(prisma.$queryRaw).not.toHaveBeenCalled();
	});

	it('rejects readiness when the shared database connection fails', async () => {
		const { service, prisma } = createService();
		jest.mocked(prisma.$queryRaw).mockRejectedValue(new Error('db down'));

		await expect(service.getReadinessHealth()).rejects.toThrow(
			new ServiceUnavailableException('Database is not ready')
		);
	});

	it('rechecks worker state after the database probe', async () => {
		const { service, maintenanceWorker, prisma } = createService();
		jest
			.mocked(maintenanceWorker.isReady)
			.mockReturnValueOnce(true)
			.mockReturnValueOnce(false);

		await expect(service.getReadinessHealth()).rejects.toThrow(
			new ServiceUnavailableException('Maintenance worker is not ready')
		);
		expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
	});
});

describe('parseMaintenanceHealthPort', () => {
	it('uses port 4300 by default', () => {
		expect(parseMaintenanceHealthPort()).toBe(4300);
	});

	it.each([
		['1', 1],
		['4301', 4301],
		['65535', 65_535],
		[' 4300 ', 4300]
	])('accepts %s', (value, expected) => {
		expect(parseMaintenanceHealthPort(value)).toBe(expected);
	});

	it.each(['', '0', '65536', '1.5', '-1', 'not-a-port'])(
		'rejects invalid value %p',
		value => {
			expect(() => parseMaintenanceHealthPort(value)).toThrow(
				'MAINTENANCE_HEALTH_PORT must be an integer between 1 and 65535'
			);
		}
	);
});
