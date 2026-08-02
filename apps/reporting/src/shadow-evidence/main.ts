import { CoreInternalClient } from '../internal/core-internal.client';
import { ReportingPrismaModule } from '../prisma/reporting-prisma.module';
import { ReportingRuntimeModule } from '../runtime/reporting-runtime.module';
import {
	parseReportingShadowEvidence,
	serializeReportingShadowEvidence
} from './reporting-shadow-evidence.contract';
import { ReportingShadowEvidenceService } from './reporting-shadow-evidence.service';
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';

const MAX_EVIDENCE_BYTES = 2 * 1024 * 1024;

@Module({
	imports: [
		ConfigModule.forRoot({ isGlobal: true }),
		ReportingRuntimeModule,
		ReportingPrismaModule
	],
	providers: [CoreInternalClient, ReportingShadowEvidenceService]
})
class ReportingShadowEvidenceModule {}

async function run(): Promise<void> {
	const action = process.argv[2];
	if (action === '--self-test') {
		selfTest();
		return;
	}
	if (action !== 'generate' && action !== 'verify') {
		throw new Error(
			'Usage: reporting-shadow-evidence generate|verify|--self-test'
		);
	}
	if (process.env.REPORTING_PROCESS_ROLE !== 'backfill') {
		throw new Error(
			'Shadow evidence requires REPORTING_PROCESS_ROLE=backfill'
		);
	}
	const app = await NestFactory.createApplicationContext(
		ReportingShadowEvidenceModule,
		{ logger: false }
	);
	try {
		const service = app.get(ReportingShadowEvidenceService);
		if (action === 'generate') {
			const evidence = await service.generate();
			process.stdout.write(serializeReportingShadowEvidence(evidence));
			return;
		}
		await service.verify(await readStdin());
	} finally {
		await app.close();
	}
}

async function readStdin(): Promise<string> {
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of process.stdin) {
		const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		size += buffer.length;
		if (size > MAX_EVIDENCE_BYTES) {
			throw new Error('Shadow evidence exceeds the 2 MiB limit');
		}
		chunks.push(buffer);
	}
	return Buffer.concat(chunks).toString('utf8');
}

function selfTest(): void {
	const value = {
		schema: 'winwidget.reporting.shadow-evidence',
		version: 2,
		algorithm: 'projection-and-metrics-v1',
		revision: '0123456789abcdef0123456789abcdef01234567',
		imageId: `sha256:${'a'.repeat(64)}`,
		comparedAt: '2026-08-01T00:00:00.000Z',
		periodPolicy: {
			asOf: '2026-08-01T00:00:00.000Z',
			dashboardTimezone: 'UTC',
			dailySummaryTimezone: 'Europe/Moscow'
		},
		source: {
			kind: 'core-postgresql',
			database: 'default_db',
			systemIdentifier: '1',
			snapshotId: '00000000-0000-4000-8000-000000000001',
			snapshotSha256: 'b'.repeat(64),
			recordCount: 0,
			watermarks: {
				identityUser: '0',
				billingPayment: '0',
				billingSubscription: '0',
				widget: '0',
				lead: '0',
				reportingSettings: '0'
			}
		},
		target: {
			kind: 'reporting-postgresql',
			database: 'winwidget_reporting',
			role: 'winwidget_reporting_backup',
			systemIdentifier: '2',
			backfillSnapshotId: '00000000-0000-4000-8000-000000000002',
			backfillSha256: 'c'.repeat(64),
			transactionSnapshotSha256: 'd'.repeat(64),
			watermarks: {
				identityUser: '0',
				billingPayment: '0',
				billingSubscription: '0',
				widget: '0',
				lead: '0',
				reportingSettings: '0'
			}
		},
		checks: ['counts', 'totals', 'periods', 'checksums'].map(name => ({
			name,
			coreValue: {},
			reportingValue: {},
			coreSha256:
				'44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a',
			reportingSha256:
				'44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a',
			match: true
		}))
	};
	const canonical = serializeReportingShadowEvidence(value as never);
	parseReportingShadowEvidence(canonical);
	try {
		parseReportingShadowEvidence(canonical.replace(/\n$/, ''));
	} catch {
		return;
	}
	throw new Error(
		'Shadow evidence self-test accepted non-canonical bytes'
	);
}

function safeError(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	return message
		.replace(/postgres(?:ql)?:\/\/[^\s"']+/gi, '[REDACTED_DATABASE_URL]')
		.slice(0, 2_000);
}

if (require.main === module) {
	void run().catch(error => {
		process.stderr.write(
			`${JSON.stringify({
				level: 'fatal',
				service: 'reporting-shadow-evidence',
				message: safeError(error)
			})}\n`
		);
		process.exitCode = 1;
	});
}
