import EmailLayout from './_components/email-layout';
import { Text } from '@react-email/components';
import * as React from 'react';
import {
	SupportNotificationContent,
	supportConversationUrl
} from '../src/messaging/support-notification.contract';

export default function SupportNotificationEmail({
	content,
	client
}: {
	content: SupportNotificationContent;
	client: boolean;
}) {
	const title = client
		? 'Вам ответила поддержка'
		: content.notificationType === 'NEW_CONVERSATION'
			? 'Новое обращение в поддержку'
			: 'Новое сообщение в поддержке';
	return (
		<EmailLayout
			preview={title}
			title={title}
			subtitle={`Обращение №${content.conversationNumber}`}
			actionLabel="Открыть переписку"
			actionHref={supportConversationUrl(content, client)}
		>
			<Text className="ww-primary-text">
				{client
					? 'Ответ оператора уже доступен в вашем чате поддержки WinCRM.'
					: 'Откройте обращение в панели администратора, чтобы прочитать сообщения и ответить клиенту.'}
			</Text>
			<Text className="ww-secondary-text">
				Для просмотра переписки войдите в свой аккаунт.
			</Text>
		</EmailLayout>
	);
}
