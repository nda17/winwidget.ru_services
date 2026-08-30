import { Injectable } from '@nestjs/common';
import { DatabaseRestoreTarget } from './database-restore.contract';
import {
	DatabaseRestoreEventIdentity,
	DatabaseRestoreObservation,
	DatabaseRestoreStateService,
	RecoveredDatabaseRestoreJob
} from './database-restore-state.service';

const RESTORE_STATE_POLL_MS = 1_000;

@Injectable()
export class DatabaseRestoreRecoveryService {
	constructor(private readonly state: DatabaseRestoreStateService) {}

	async waitForEventSettlement(
		event: DatabaseRestoreEventIdentity,
		timeoutMs: number
	): Promise<DatabaseRestoreObservation> {
		const deadline = Date.now() + timeoutMs;
		while (true) {
			const observation = await this.state.observe(event);
			if (observation.state !== 'processing') return observation;
			const expiresAt = observation.job.leaseExpiresAt?.getTime() ?? 0;
			if (expiresAt <= Date.now()) {
				const recovered = await this.state.recoverExpiredJob(
					observation.job
				);
				if (recovered) {
					return { state: 'terminal', status: recovered.status };
				}
				continue;
			}
			const remaining = deadline - Date.now();
			if (remaining <= 0) return observation;
			await this.pause(
				Math.max(
					1,
					Math.min(
						RESTORE_STATE_POLL_MS,
						remaining,
						expiresAt - Date.now()
					)
				)
			);
		}
	}

	async waitForProcessingSlot(
		target: DatabaseRestoreTarget,
		timeoutMs: number
	): Promise<boolean> {
		const deadline = Date.now() + timeoutMs;
		while (true) {
			const fence = await this.state.findFence(target);
			if (!fence) return true;
			if (fence.status === 'PROCESSING') {
				const expiresAt = fence.leaseExpiresAt?.getTime() ?? 0;
				if (expiresAt <= Date.now()) {
					await this.state.recoverExpiredJob(fence);
					continue;
				}
			}
			const remaining = deadline - Date.now();
			if (remaining <= 0) return false;
			await this.pause(Math.min(RESTORE_STATE_POLL_MS, remaining));
		}
	}

	async recoverExpired(
		limit: number
	): Promise<RecoveredDatabaseRestoreJob[]> {
		const expired = await this.state.findExpired(limit);
		const recovered: RecoveredDatabaseRestoreJob[] = [];
		for (const job of expired) {
			const result = await this.state.recoverExpiredJob(job);
			if (result) recovered.push(result);
		}
		return recovered;
	}

	private pause(milliseconds: number): Promise<void> {
		return new Promise(resolve => setTimeout(resolve, milliseconds));
	}
}
