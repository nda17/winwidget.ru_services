import EmailLayout from './_components/email-layout';
import { Text } from '@react-email/components';
import * as React from 'react';

export default function WincrmTaskReminderEmail({
	taskId,
	title,
	dueAtLabel,
	timeZone,
	trigger
}: {
	taskId: string;
	title: string;
	dueAtLabel: string;
	timeZone: string;
	trigger?: 'ASSIGNED';
}) {
	return (
		<EmailLayout
			preview={
				trigger === 'ASSIGNED'
					? 'Назначение задачи WinCRM'
					: 'Напоминание о задаче WinCRM'
			}
			title={
				trigger === 'ASSIGNED'
					? 'Назначение задачи'
					: 'Напоминание о задаче'
			}
			subtitle={`Срок: ${dueAtLabel} (${timeZone})`}
			actionLabel="Открыть задачу"
			actionHref={`https://crm.winwidget.ru/planner?task=${taskId}`}
		>
			<Text className="ww-primary-text">{title}</Text>
			<Text className="ww-secondary-text">
				Проверьте задачу в WinCRM. Для просмотра потребуется вход в рабочее
				пространство с доступом к этой задаче.
			</Text>
		</EmailLayout>
	);
}
