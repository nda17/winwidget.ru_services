import EmailLayout from './_components/email-layout';
import { Text } from '@react-email/components';
import * as React from 'react';

export default function WincrmIntakeSlaEmail({
	entryId,
	title,
	dueAtLabel,
	timeZone
}: {
	entryId: string;
	title: string;
	dueAtLabel: string;
	timeZone: string;
}) {
	return (
		<EmailLayout
			preview="Входящее обращение ожидает обработки"
			title="Обращение без ответа"
			subtitle={`Срок взятия в работу: ${dueAtLabel} (${timeZone})`}
			actionLabel="Открыть обращение"
			actionHref={`https://crm.winwidget.ru/inbox?entry=${entryId}`}
		>
			<Text className="ww-primary-text">{title}</Text>
			<Text className="ww-secondary-text">
				Обращение ещё не взято в работу. Откройте WinCRM, проверьте историю
				и свяжитесь с клиентом. Для просмотра потребуется доступ к этому
				обращению.
			</Text>
		</EmailLayout>
	);
}
