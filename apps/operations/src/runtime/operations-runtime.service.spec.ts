import { ConfigService } from '@nestjs/config';
import {
	OperationsRuntimeService,
	parseOperationsPort,
	parseOperationsProcessRole
} from './operations-runtime.service';

describe('OperationsRuntimeService', () => {
	it('accepts the three isolated process roles and assigns separate ports', () => {
		expect(parseOperationsProcessRole('api')).toBe('api');
		expect(parseOperationsProcessRole('worker')).toBe('worker');
		expect(parseOperationsProcessRole('outbox-publisher')).toBe(
			'outbox-publisher'
		);
		expect(parseOperationsPort('api', {})).toBe(5200);
		expect(parseOperationsPort('worker', {})).toBe(5201);
		expect(parseOperationsPort('outbox-publisher', {})).toBe(5202);
	});

	it('fails closed for an unknown role', () => {
		expect(() => parseOperationsProcessRole('maintenance')).toThrow(
			'OPERATIONS_PROCESS_ROLE'
		);
	});

	it('enables only the selected role', () => {
		const config = {
			get: jest.fn((key: string) =>
				key === 'OPERATIONS_PROCESS_ROLE' ? 'worker' : undefined
			)
		} as unknown as ConfigService;
		const runtime = new OperationsRuntimeService(config);
		expect(runtime.apiEnabled).toBe(false);
		expect(runtime.workerEnabled).toBe(true);
		expect(runtime.outboxPublisherEnabled).toBe(false);
	});
});
