import EmailLayout from './_components/email-layout';
import { Text } from '@react-email/components';
import * as React from 'react';

export interface AdminBroadcastEmailProps {
	subject: string;
	message: string;
}

const primaryTextStyle = {
	color: '#27272a',
	fontSize: '17px',
	lineHeight: '30px',
	margin: '0 0 16px',
	whiteSpace: 'pre-line' as const
};

const noteTextStyle = {
	color: '#71717a',
	fontSize: '14px',
	lineHeight: '22px',
	margin: '24px 0 0'
};

const AdminBroadcastEmail = ({
	subject,
	message
}: AdminBroadcastEmailProps) => (
	<EmailLayout
		preview={subject}
		title={subject}
		subtitle="Оповещение от команды WinWidget"
	>
		<Text style={primaryTextStyle} className="ww-primary-text">
			{message}
		</Text>
		<Text style={noteTextStyle} className="ww-note-text">
			Вы получили это письмо, потому что у вас есть аккаунт на
			winwidget.ru.
		</Text>
	</EmailLayout>
);

export default AdminBroadcastEmail;
