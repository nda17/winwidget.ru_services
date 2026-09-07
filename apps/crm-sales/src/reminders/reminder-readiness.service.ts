import { Injectable } from '@nestjs/common';
import { CrmSalesPrismaService } from '../prisma/crm-sales-prisma.service';
import { serviceOrigin } from '../sales/sales-access';
import { reminderDeliveryEnabled } from './reminder-delivery.contract';
import {
	exactReminderObject,
	readReminderJson
} from './reminder-recipients.client';

export function reminderInternalToken(
	name:
		| 'CRM_SALES_NOTIFICATION_DELIVERY_TOKEN'
		| 'NOTIFICATION_DELIVERY_CRM_SALES_TOKEN'
) {
	const token = process.env[name];
	if (
		!token ||
		token.length < 32 ||
		token.length > 4096 ||
		/[\s\x00-\x1f\x7f]/.test(token) ||
		/^(change|replace|example|placeholder|ci_)/i.test(token)
	)
		throw new Error('REMINDER_INTERNAL_CONFIGURATION');
	const peers = [
		'CRM_SALES_CRM_ACCESS_TOKEN',
		'CRM_SALES_CRM_INTAKE_TOKEN',
		'CRM_ACCESS_CRM_SALES_TOKEN',
		'CRM_SALES_NOTIFICATION_DELIVERY_TOKEN',
		'NOTIFICATION_DELIVERY_CRM_SALES_TOKEN'
	].filter(key => key !== name);
	if (peers.some(key => process.env[key] === token))
		throw new Error('REMINDER_INTERNAL_CREDENTIAL_ALIAS');
	return token;
}
@Injectable()
export class ReminderReadinessService {
	constructor(private readonly prisma: CrmSalesPrismaService) {}
	async transportReady(): Promise<boolean> {
		try {
			if (!reminderDeliveryEnabled()) return false;
			reminderInternalToken('CRM_SALES_NOTIFICATION_DELIVERY_TOKEN');
			const origin = serviceOrigin(
				process.env.NOTIFICATION_DELIVERY_INTERNAL_BASE_URL
			);
			const response = await fetch(
				`${origin}/internal/v1/crm-sales/task-reminders/readiness`,
				{
					method: 'GET',
					redirect: 'error',
					cache: 'no-store',
					signal: AbortSignal.timeout(5000),
					headers: {
						'x-winwidget-service': 'crm-sales',
						'x-winwidget-internal-token': reminderInternalToken(
							'NOTIFICATION_DELIVERY_CRM_SALES_TOKEN'
						)
					}
				}
			);
			const value = await readReminderJson(response, 4096);
			return (
				exactReminderObject(value, [
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
				Date.now() - Date.parse(value.checkedAt) <= 30_000 &&
				Array.isArray(value.channels) &&
				value.channels.length === 2 &&
				new Set(value.channels).size === 2 &&
				value.channels.includes('EMAIL') &&
				value.channels.includes('TELEGRAM')
			);
		} catch {
			return false;
		}
	}
	async ready() {
		try {
			if (!reminderDeliveryEnabled()) return false;
			const row = await this.prisma.reminderRuntime.findUnique({
				where: { id: 'reminders' }
			});
			if (
				!row?.ready ||
				row.revision !== process.env.APP_REVISION ||
				row.lastSeenAt.getTime() < Date.now() - 45_000 ||
				row.lastSeenAt.getTime() > Date.now() + 5000
			)
				return false;
			return this.transportReady();
		} catch {
			return false;
		}
	}
}
