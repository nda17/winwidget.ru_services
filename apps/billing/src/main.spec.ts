describe('Billing bootstrap failure boundary', () => {
	const originalEnvironment = { ...process.env };

	afterEach(() => {
		process.env = { ...originalEnvironment };
		jest.restoreAllMocks();
		jest.resetModules();
	});

	async function boot(failure?: 'create' | 'listen') {
		process.env.MODE = 'development';
		process.env.BILLING_PROCESS_ROLE = 'worker';
		const app = {
			getHttpAdapter: jest.fn(() => ({
				getInstance: () => ({ set: jest.fn() })
			})),
			setGlobalPrefix: jest.fn(),
			use: jest.fn(),
			useBodyParser: jest.fn(),
			enableCors: jest.fn(),
			useGlobalFilters: jest.fn(),
			enableShutdownHooks: jest.fn(),
			listen:
				failure === 'listen'
					? jest.fn().mockRejectedValue(new Error('fixture-secret-listen'))
					: jest.fn().mockResolvedValue(undefined),
			close: jest.fn().mockResolvedValue(undefined)
		};
		const create =
			failure === 'create'
				? jest.fn().mockRejectedValue(new Error('fixture-secret-create'))
				: jest.fn().mockResolvedValue(app);
		const terminate = jest.fn().mockResolvedValue(undefined);
		let errorLog!: jest.SpyInstance;
		await jest.isolateModulesAsync(async () => {
			jest.doMock('@nestjs/core', () => ({ NestFactory: { create } }));
			jest.doMock('./billing.module', () => ({
				BillingModule: class {}
			}));
			jest.doMock('./runtime/bootstrap-failure', () => ({
				terminateFailedBootstrap: terminate
			}));
			const { Logger } = await import('@nestjs/common');
			errorLog = jest.spyOn(Logger, 'error').mockImplementation(() => {});
			jest.spyOn(Logger, 'log').mockImplementation(() => {});
			await import('./main');
			await new Promise<void>(resolve => setImmediate(resolve));
		});
		return { app, create, terminate, errorLog };
	}

	it('does not terminate a successful startup', async () => {
		const { app, terminate } = await boot();
		expect(app.listen).toHaveBeenCalledTimes(1);
		expect(terminate).not.toHaveBeenCalled();
		expect(
			app.enableShutdownHooks.mock.invocationCallOrder[0]
		).toBeLessThan(app.listen.mock.invocationCallOrder[0]);
	});

	it('passes the partially initialized context to bounded cleanup', async () => {
		const { app, terminate, errorLog } = await boot('listen');
		expect(terminate).toHaveBeenCalledTimes(1);
		expect(terminate).toHaveBeenCalledWith(app);
		expect(JSON.stringify(errorLog.mock.calls)).not.toContain(
			'fixture-secret'
		);
	});

	it('terminates even when the factory never returned a context', async () => {
		const { app, terminate, errorLog } = await boot('create');
		expect(app.listen).not.toHaveBeenCalled();
		expect(terminate).toHaveBeenCalledWith(undefined);
		expect(JSON.stringify(errorLog.mock.calls)).not.toContain(
			'fixture-secret'
		);
	});
});
