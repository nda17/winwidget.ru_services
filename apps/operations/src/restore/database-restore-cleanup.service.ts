import { Injectable, Logger } from '@nestjs/common';
import {
	DatabaseRestoreJobPhase,
	DatabaseRestoreJobStatus
} from '@prisma/operations-client';
import { rm } from 'node:fs/promises';
import { OperationsPrismaService } from '../prisma/operations-prisma.service';

const CLEANUP_STATUSES = [
	DatabaseRestoreJobStatus.SUCCEEDED,
	DatabaseRestoreJobStatus.FAILED,
	DatabaseRestoreJobStatus.CANCELLED
] as const;

export interface DatabaseRestoreCleanupJob {
	id: string;
	status: DatabaseRestoreJobStatus;
	phase: DatabaseRestoreJobPhase | null;
}

@Injectable()
export class DatabaseRestoreCleanupService {
	private readonly logger = new Logger(DatabaseRestoreCleanupService.name);

	constructor(private readonly prisma: OperationsPrismaService) {}

	async pending(limit: number): Promise<DatabaseRestoreCleanupJob[]> {
		return this.prisma.databaseRestoreJob.findMany({
			where: {
				OR: [
					{
						status: DatabaseRestoreJobStatus.SUCCEEDED,
						sourceDeletedAt: null
					},
					{
						AND: [
							{
								OR: [
									{
										status: DatabaseRestoreJobStatus.FAILED,
										phase: {
											in: [
												DatabaseRestoreJobPhase.PREPARING,
												DatabaseRestoreJobPhase.SAFETY_READY
											]
										}
									},
									{ status: DatabaseRestoreJobStatus.CANCELLED }
								]
							},
							{
								OR: [{ sourceDeletedAt: null }, { safetyDeletedAt: null }]
							}
						]
					}
				]
			},
			orderBy: { updatedAt: 'asc' },
			take: limit,
			select: { id: true, status: true, phase: true }
		});
	}

	async cleanup(input: {
		id: string;
		status: DatabaseRestoreJobStatus;
		phase: DatabaseRestoreJobPhase | null;
		source: string;
	}): Promise<void> {
		if (!this.shouldCleanup(input.status, input.phase)) return;
		const deleteSafety =
			(input.status === DatabaseRestoreJobStatus.FAILED &&
				this.isProvenPreMutation(input.phase)) ||
			input.status === DatabaseRestoreJobStatus.CANCELLED;
		const sourceResult = await this.removeArtifact(input.source);
		const safetyResult = deleteSafety
			? await this.removeArtifact(`${input.source}.safety`)
			: { deletedAt: null, error: null };
		const cleanupError = [sourceResult.error, safetyResult.error]
			.filter((value): value is string => Boolean(value))
			.join('; ');
		try {
			const updated = await this.prisma.databaseRestoreJob.updateMany({
				where: { id: input.id, status: input.status },
				data: {
					...(sourceResult.deletedAt
						? { sourceDeletedAt: sourceResult.deletedAt }
						: {}),
					...(safetyResult.deletedAt
						? { safetyDeletedAt: safetyResult.deletedAt }
						: {}),
					cleanupError: cleanupError || null
				}
			});
			if (updated.count !== 1) {
				this.logger.warn(
					`Database restore cleanup evidence CAS lost jobId=${input.id}`
				);
			}
		} catch (error) {
			this.logger.error(
				`Database restore cleanup evidence failed jobId=${input.id}: ${this.safeError(error)}`
			);
		}
	}

	async recordError(
		id: string,
		status: DatabaseRestoreJobStatus,
		error: unknown
	): Promise<void> {
		try {
			await this.prisma.databaseRestoreJob.updateMany({
				where: { id, status },
				data: { cleanupError: this.safeError(error) }
			});
		} catch (persistenceError) {
			this.logger.error(
				`Database restore cleanup error evidence failed jobId=${id}: ${this.safeError(persistenceError)}`
			);
		}
	}

	private async removeArtifact(path: string): Promise<{
		deletedAt: Date | null;
		error: string | null;
	}> {
		try {
			await rm(path, { force: true });
			return { deletedAt: new Date(), error: null };
		} catch (error) {
			return { deletedAt: null, error: this.safeError(error) };
		}
	}

	private shouldCleanup(
		status: DatabaseRestoreJobStatus,
		phase: DatabaseRestoreJobPhase | null
	): boolean {
		if (
			!CLEANUP_STATUSES.includes(
				status as (typeof CLEANUP_STATUSES)[number]
			)
		) {
			return false;
		}
		return (
			status !== DatabaseRestoreJobStatus.FAILED ||
			this.isProvenPreMutation(phase)
		);
	}

	private isProvenPreMutation(
		phase: DatabaseRestoreJobPhase | null
	): boolean {
		return (
			phase === DatabaseRestoreJobPhase.PREPARING ||
			phase === DatabaseRestoreJobPhase.SAFETY_READY
		);
	}

	private safeError(error: unknown): string {
		return (error instanceof Error ? error.message : String(error))
			.replace(/[\r\n]+/g, ' ')
			.slice(0, 2_000);
	}
}
