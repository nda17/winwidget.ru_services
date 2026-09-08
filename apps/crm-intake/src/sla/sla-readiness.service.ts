import { Injectable } from '@nestjs/common';
import { parseIntakeAccessOrigin } from '../access/intake-authorization.client';
import { intakeSlaEnabled, slaKeys, slaRecord } from './sla.contract';
import { readSlaJson, slaInternalToken } from './sla-recipients.client';

@Injectable()
export class SlaReadinessService {
	async ready() {
		try {
			if (!intakeSlaEnabled()) return false;
			slaInternalToken('CRM_INTAKE_NOTIFICATION_DELIVERY_TOKEN');
			const origin = parseIntakeAccessOrigin(
				process.env.NOTIFICATION_DELIVERY_INTERNAL_BASE_URL
			);
			const value = await readSlaJson(
				await fetch(`${origin}/internal/v1/crm-intake/sla/readiness`, {
					method: 'GET',
					redirect: 'error',
					cache: 'no-store',
					signal: AbortSignal.timeout(5000),
					headers: {
						'x-winwidget-service': 'crm-intake',
						'x-winwidget-internal-token': slaInternalToken(
							'NOTIFICATION_DELIVERY_CRM_INTAKE_TOKEN'
						)
					}
				}),
				4096
			);
			return (
				slaRecord(value) &&
				slaKeys(value, [
					'schemaVersion',
					'ready',
					'checkedAt',
					'channels'
				]) &&
				value.schemaVersion === 1 &&
				value.ready === true &&
				typeof value.checkedAt === 'string' &&
				new Date(value.checkedAt).toISOString() === value.checkedAt &&
				Date.now() - Date.parse(value.checkedAt) >= -5000 &&
				Date.now() - Date.parse(value.checkedAt) <= 30000 &&
				Array.isArray(value.channels) &&
				value.channels.length === 2 &&
				value.channels.includes('EMAIL') &&
				value.channels.includes('TELEGRAM')
			);
		} catch {
			return false;
		}
	}
}
