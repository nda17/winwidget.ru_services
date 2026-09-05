import type { INestApplication } from '@nestjs/common';

export const BOOTSTRAP_FAILURE_CLEANUP_TIMEOUT_MS = 5_000;

/**
 * Failed bootstrap must not leave a process kept alive by AMQP reconnects,
 * Prisma pools or partially initialized background timers. Docker can restart
 * the existing container only after the process actually exits.
 *
 * This is a bounded best-effort cleanup of failed startup, not an in-flight
 * business-operation drain or a replacement for durable retry/receipt handling.
 */
export async function terminateFailedBootstrap(
	application: Pick<INestApplication, 'close'> | undefined
): Promise<never> {
	process.exitCode = 1;
	const deadline = setTimeout(
		() => process.exit(1),
		BOOTSTRAP_FAILURE_CLEANUP_TIMEOUT_MS
	);
	try {
		await application?.close();
	} catch {
		// Cleanup errors may contain connection credentials. Do not log them,
		// and do not let a failed cleanup prevent the nonzero process exit.
	} finally {
		clearTimeout(deadline);
		process.exit(1);
	}
}
