import {
	BOOTSTRAP_FAILURE_CLEANUP_TIMEOUT_MS,
	terminateFailedBootstrap
} from './bootstrap-failure';

describe('failed bootstrap termination', () => {
	let exit: jest.SpyInstance;
	let previousExitCode: typeof process.exitCode;

	beforeEach(() => {
		previousExitCode = process.exitCode;
		jest.useFakeTimers();
		exit = jest.spyOn(process, 'exit').mockReturnValue(undefined as never);
	});

	afterEach(() => {
		process.exitCode = previousExitCode;
		jest.clearAllTimers();
		jest.useRealTimers();
		jest.restoreAllMocks();
	});

	it('closes the created app before exiting nonzero', async () => {
		const close = jest.fn().mockResolvedValue(undefined);
		await terminateFailedBootstrap({ close });
		expect(close).toHaveBeenCalledTimes(1);
		expect(exit).toHaveBeenCalledWith(1);
		expect(close.mock.invocationCallOrder[0]).toBeLessThan(
			exit.mock.invocationCallOrder[0]
		);
		expect(process.exitCode).toBe(1);
		expect(jest.getTimerCount()).toBe(0);
	});

	it('marks failure immediately but allows bounded cleanup to finish', async () => {
		let finish!: () => void;
		const close = jest.fn(
			() => new Promise<void>(resolve => (finish = resolve))
		);
		const failure = terminateFailedBootstrap({ close });
		expect(process.exitCode).toBe(1);
		expect(exit).not.toHaveBeenCalled();
		await jest.advanceTimersByTimeAsync(100);
		expect(exit).not.toHaveBeenCalled();
		finish();
		await failure;
		expect(exit).toHaveBeenCalledTimes(1);
		expect(jest.getTimerCount()).toBe(0);
	});

	it('still exits when cleanup rejects, without logging its credentials', async () => {
		const log = jest.spyOn(console, 'error').mockImplementation(() => {});
		const close = jest
			.fn()
			.mockRejectedValue(
				new Error('amqp://fixture-user:fixture-secret@localhost')
			);
		await terminateFailedBootstrap({ close });
		expect(exit).toHaveBeenCalledWith(1);
		expect(log).not.toHaveBeenCalled();
		expect(jest.getTimerCount()).toBe(0);
	});

	it('exits if application creation failed before returning a context', async () => {
		await terminateFailedBootstrap(undefined);
		expect(exit).toHaveBeenCalledTimes(1);
		expect(exit).toHaveBeenCalledWith(1);
	});

	it('cannot remain alive indefinitely when cleanup never resolves', async () => {
		void terminateFailedBootstrap({
			close: () => new Promise<void>(() => {})
		});
		await jest.advanceTimersByTimeAsync(
			BOOTSTRAP_FAILURE_CLEANUP_TIMEOUT_MS - 1
		);
		expect(exit).not.toHaveBeenCalled();
		await jest.advanceTimersByTimeAsync(1);
		expect(exit).toHaveBeenCalledTimes(1);
		expect(exit).toHaveBeenCalledWith(1);
	});
});
