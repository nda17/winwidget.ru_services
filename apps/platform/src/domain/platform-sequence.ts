import { Prisma, PrismaClient } from '@prisma/platform-client';

export async function nextPlatformSequence(
	transaction: Prisma.TransactionClient
): Promise<bigint> {
	const state = await transaction.platformSourceSequence.upsert({
		where: { id: 'platform' },
		create: { id: 'platform', nextValue: 2n },
		update: { nextValue: { increment: 1n } }
	});
	return state.nextValue - 1n;
}

type PlatformDatabaseClient = Prisma.TransactionClient | PrismaClient;

export async function readPlatformSemanticFingerprint(
	client: PlatformDatabaseClient
): Promise<string> {
	const rows = await client.$queryRaw<{ fingerprint: string }[]>(
		Prisma.sql`SELECT platform.current_semantic_fingerprint() AS fingerprint`
	);
	const fingerprint = rows[0]?.fingerprint;
	if (
		rows.length !== 1 ||
		!fingerprint ||
		!/^[0-9a-f]{64}$/.test(fingerprint)
	) {
		throw new Error('PLATFORM_SEMANTIC_FINGERPRINT_READ_FAILED');
	}
	return fingerprint;
}

export async function refreshPlatformSemanticFingerprint(
	transaction: Prisma.TransactionClient
): Promise<string> {
	const rows = await transaction.$queryRaw<{ fingerprint: string }[]>(
		Prisma.sql`
			SELECT platform.refresh_current_semantic_fingerprint(
				platform.current_semantic_fingerprint()
			) AS fingerprint
		`
	);
	const fingerprint = rows[0]?.fingerprint;
	if (
		rows.length !== 1 ||
		!fingerprint ||
		!/^[0-9a-f]{64}$/.test(fingerprint)
	) {
		throw new Error('PLATFORM_SEMANTIC_FINGERPRINT_REFRESH_FAILED');
	}
	return fingerprint;
}
