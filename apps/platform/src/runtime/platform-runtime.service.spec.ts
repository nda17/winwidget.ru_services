import { ConfigService } from '@nestjs/config';
import { PlatformRuntimeService } from './platform-runtime.service';

function runtime(retentionDays?: string): PlatformRuntimeService {
	return new PlatformRuntimeService(
		new ConfigService({
			PLATFORM_PROCESS_ROLE: 'outbox-publisher',
			...(retentionDays === undefined
				? {}
				: { PLATFORM_OUTBOX_RETENTION_DAYS: retentionDays })
		})
	);
}

describe('PlatformRuntimeService Outbox retention', () => {
	it('defaults PLATFORM_OUTBOX_RETENTION_DAYS to seven days', () => {
		expect(runtime().outboxRetentionDays).toBe(7);
	});

	it.each([
		['1', 1],
		['365', 365]
	])('accepts bounded retention %s', (raw, expected) => {
		expect(runtime(raw).outboxRetentionDays).toBe(expected);
	});

	it.each(['0', '366', '1.5', 'not-a-number'])(
		'rejects unsafe retention %s',
		raw => {
			expect(() => runtime(raw)).toThrow(
				'PLATFORM_OUTBOX_RETENTION_DAYS must be an integer between 1 and 365'
			);
		}
	);
});
