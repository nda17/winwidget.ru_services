import { Injectable } from '@nestjs/common';
import {
	OperationalAlertSeverity,
	Prisma
} from '@prisma/operations-client';
import { OperationsPrismaService } from '../prisma/operations-prisma.service';

export interface RecordOperationalAlertInput {
	deduplicationKey: string;
	type: string;
	severity: OperationalAlertSeverity;
	source: string;
	referenceId: string;
	targetUserId?: string | null;
	targetUserName?: string | null;
	targetUserEmail?: string | null;
	title: string;
	message: string;
	alertAt?: Date;
	metadata?: Prisma.InputJsonValue;
}

@Injectable()
export class OperationalAlertService {
	constructor(private readonly prisma: OperationsPrismaService) {}

	record(input: RecordOperationalAlertInput) {
		for (const [name, value] of [
			['deduplicationKey', input.deduplicationKey],
			['type', input.type],
			['source', input.source],
			['referenceId', input.referenceId],
			['title', input.title],
			['message', input.message]
		] as const) {
			if (!value.trim() || value.length > 2_000) {
				throw new Error(`Operational alert ${name} is invalid`);
			}
		}
		return this.prisma.operationalAlert.upsert({
			where: { deduplicationKey: input.deduplicationKey },
			create: {
				...input,
				alertAt: input.alertAt || new Date(),
				metadata: input.metadata ?? {}
			},
			update: {
				type: input.type,
				severity: input.severity,
				source: input.source,
				referenceId: input.referenceId,
				targetUserId: input.targetUserId ?? null,
				targetUserName: input.targetUserName ?? null,
				targetUserEmail: input.targetUserEmail ?? null,
				title: input.title,
				message: input.message,
				alertAt: input.alertAt || new Date(),
				metadata: input.metadata ?? {},
				resolvedAt: null
			}
		});
	}

	resolve(deduplicationKey: string) {
		return this.prisma.operationalAlert.updateMany({
			where: { deduplicationKey, resolvedAt: null },
			data: { resolvedAt: new Date() }
		});
	}
}
