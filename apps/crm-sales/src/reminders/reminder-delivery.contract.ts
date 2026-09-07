import { createHash } from 'node:crypto';
import type { ReminderBinding, ReminderRuleV1 } from './reminder-rule';
import { nextAllowedReminderInstant } from './reminder-time';

export const REMINDER_TICK = 'crm.sales.reminder.tick.v1';
export const REMINDER_QUEUE = 'winwidget.crm.sales.reminders';
export const REMINDER_EXCHANGE = 'winwidget.events';
export const reminderEventType = (channel: 'EMAIL' | 'TELEGRAM') =>
	`notification.wincrm.task-reminder.${channel.toLowerCase()}.requested.v1`;
export const sameBinding = (
	left: ReminderBinding,
	right: ReminderBinding
) =>
	left.subject === right.subject &&
	left.membershipId === right.membershipId;
export function quietUntil(rule: ReminderRuleV1, now: number) {
	return nextAllowedReminderInstant(
		now,
		rule.quietHours && {
			...rule.quietHours,
			timeZone: rule.timeZone
		}
	);
}
/** Only the latest nominal occurrence survives downtime. Never replay an array
 * of missed reminders. Its immutable index remains independent of tick timing. */
export function currentOccurrence(
	rule: ReminderRuleV1,
	dueAt: Date,
	now: number
) {
	const offset = rule.trigger.offsetMinutes * 60_000;
	const anchor =
		dueAt.getTime() +
		(rule.trigger.kind === 'BEFORE_DUE' ? -offset : offset);
	if (!Number.isFinite(anchor) || anchor < 0 || now < anchor) return null;
	// A pre-deadline reminder must not claim a past deadline is still ahead.
	if (rule.trigger.kind === 'BEFORE_DUE' && now >= dueAt.getTime())
		return null;
	const interval = (rule.repeats?.intervalMinutes ?? 0) * 60_000;
	const count = rule.repeats?.count ?? 1;
	const index = interval
		? Math.min(count - 1, Math.floor((now - anchor) / interval))
		: 0;
	return {
		index,
		nominalAt: new Date(anchor + index * interval),
		notBefore: quietUntil(rule, now)
	};
}
export function deliveryKey(input: {
	taskId: string;
	taskVersion: number;
	ruleId: string;
	ruleVersion: number;
	occurrenceIndex: number;
	recipient: ReminderBinding;
	channel: string;
}) {
	return createHash('sha256')
		.update(
			JSON.stringify([
				input.taskId,
				input.taskVersion,
				input.ruleId,
				input.ruleVersion,
				input.occurrenceIndex,
				input.recipient.subject,
				input.recipient.membershipId,
				input.channel
			])
		)
		.digest('hex');
}
export function reminderDeliveryEnabled() {
	const value = process.env.CRM_TASK_REMINDERS_ENABLED ?? 'false';
	if (!['true', 'false'].includes(value))
		throw new Error('Invalid CRM task reminder switch');
	return value === 'true';
}
export function remindersRole() {
	const role = process.env.CRM_SALES_PROCESS_ROLE ?? 'api';
	if (!['api', 'reminders'].includes(role))
		throw new Error('Invalid CRM Sales process role');
	return role;
}
