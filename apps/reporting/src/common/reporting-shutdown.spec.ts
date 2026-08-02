import { waitForReportingShutdown } from './reporting-shutdown';

describe('waitForReportingShutdown', () => {
	it('returns immediately for completed shutdown work', async () => {
		await expect(
			waitForReportingShutdown(Promise.resolve(), 100)
		).resolves.toBe(true);
	});

	it('bounds a stuck shutdown operation', async () => {
		jest.useFakeTimers();
		const result = waitForReportingShutdown(
			new Promise(() => undefined),
			100
		);
		await jest.advanceTimersByTimeAsync(100);
		await expect(result).resolves.toBe(false);
		jest.useRealTimers();
	});
});
