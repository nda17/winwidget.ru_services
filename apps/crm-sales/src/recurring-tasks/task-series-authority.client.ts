import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { salesAccessToken, serviceOrigin } from '../sales/sales-access';
import {
	exactReminderObject,
	readReminderJson
} from '../reminders/reminder-recipients.client';

export interface SeriesAuthorityRequest {
	schemaVersion: 1;
	workspaceId: string;
	seriesId: string;
	creatorBinding: { subject: string; membershipId: string | null };
	assigneeBinding: { subject: string; membershipId: string | null };
	template: {
		teamId: string | null;
		deal: {
			id: string;
			assignedToSubject: string;
			teamId: string | null;
		} | null;
	};
}
export type SeriesDeniedReason =
	| 'READ_ONLY'
	| 'CREATOR_REVOKED'
	| 'ASSIGNEE_REVOKED'
	| 'SCOPE_CHANGED';
@Injectable()
export class TaskSeriesAuthorityClient {
	async authorize(
		request: SeriesAuthorityRequest
	): Promise<
		| { allowed: true; reason: null }
		| { allowed: false; reason: SeriesDeniedReason }
	> {
		try {
			const response = await fetch(
				`${serviceOrigin(process.env.CRM_ACCESS_INTERNAL_BASE_URL)}/internal/v1/crm-access/task-series-authority`,
				{
					method: 'POST',
					redirect: 'error',
					cache: 'no-store',
					signal: AbortSignal.timeout(10_000),
					headers: {
						'content-type': 'application/json',
						'x-winwidget-service': 'crm-sales',
						'x-winwidget-internal-token': salesAccessToken()
					},
					body: JSON.stringify(request)
				}
			);
			const value = await readReminderJson(response);
			if (
				!exactReminderObject(value, [
					'schemaVersion',
					'workspaceId',
					'seriesId',
					'allowed',
					'reason'
				]) ||
				value.schemaVersion !== 1 ||
				value.workspaceId !== request.workspaceId ||
				value.seriesId !== request.seriesId ||
				typeof value.allowed !== 'boolean' ||
				(value.allowed
					? value.reason !== null
					: ![
							'READ_ONLY',
							'CREATOR_REVOKED',
							'ASSIGNEE_REVOKED',
							'SCOPE_CHANGED'
						].includes(String(value.reason)))
			)
				throw new Error('SERIES_AUTHORITY_CONTRACT');
			return value.allowed
				? { allowed: true, reason: null }
				: { allowed: false, reason: value.reason as SeriesDeniedReason };
		} catch {
			throw new ServiceUnavailableException(
				'Не удалось проверить права повторяющейся задачи'
			);
		}
	}
}
