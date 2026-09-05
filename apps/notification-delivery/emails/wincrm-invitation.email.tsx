import EmailLayout from './_components/email-layout';
import { Text } from '@react-email/components';
import * as React from 'react';

export default function WincrmInvitationEmail({
	invitationId,
	expiresAtLabel
}: {
	invitationId: string;
	expiresAtLabel: string;
}) {
	return (
		<EmailLayout
			preview="Приглашение в WinCRM"
			title="Приглашение в WinCRM"
			subtitle={`Действует до ${expiresAtLabel} МСК`}
			actionLabel="Открыть приглашение"
			actionHref={`https://crm.winwidget.ru/invitations/${invitationId}`}
		>
			<Text className="ww-primary-text">
				Вас пригласили в команду WinCRM. Войдите с адресом электронной
				почты, на который отправлено это письмо.
			</Text>
			<Text className="ww-secondary-text">
				Ссылка сама по себе не предоставляет доступ. Он появится только
				после подтверждения электронной почты, принятия приглашения и
				проверки доступных мест.
			</Text>
			<Text className="ww-note-text">
				Если вы не ожидаете это приглашение, просто проигнорируйте письмо.
				Отменённое или просроченное приглашение принять нельзя.
			</Text>
		</EmailLayout>
	);
}
