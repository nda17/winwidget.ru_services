export async function waitForReportingShutdown(
	operation: Promise<unknown>,
	timeoutMs: number
): Promise<boolean> {
	let timer: NodeJS.Timeout | null = null;
	try {
		return await Promise.race([
			operation.then(() => true),
			new Promise<boolean>(resolve => {
				timer = setTimeout(() => resolve(false), timeoutMs);
				timer.unref();
			})
		]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}
