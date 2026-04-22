import { Section, Text } from '@react-email/components';
import * as React from 'react';
import EmailLayout from '@email/_components/email-layout';

const leadTextStyle = {
	color: '#27272a',
	fontSize: '17px',
	lineHeight: '30px',
	margin: '0 0 22px'
};

const codeWrapStyle = {
	backgroundColor: '#faf7ff',
	border: '1px solid #ececf2',
	borderRadius: '14px',
	padding: '18px 20px',
	textAlign: 'center' as const
};

const codeTextStyle = {
	color: '#18181b',
	fontSize: '32px',
	fontWeight: '700',
	letterSpacing: '10px',
	lineHeight: '32px',
	margin: '0'
};

const noteTextStyle = {
	color: '#5f5f68',
	fontSize: '15px',
	lineHeight: '24px',
	margin: '18px 0 0'
};

const VerificationEmail = ({ code }: { code: string }) => {
	return (
		<EmailLayout
			preview="Подтвердите email в WinWidget"
			title="🔐 Код подтверждения email"
			subtitle="Подтвердите адрес электронной почты для входа в WinWidget"
		>
			<Text style={leadTextStyle} className="ww-body-text">
				Вы получили это письмо, потому что кто-то указал данный адрес при
				регистрации в сервисе winwidget.ru. Если это были вы, используйте
				код ниже для подтверждения email.
			</Text>

			<Section style={codeWrapStyle} className="ww-code-wrap">
				<Text style={codeTextStyle} className="ww-code-text">
					{code}
				</Text>
			</Section>

			<Text style={noteTextStyle} className="ww-note-text">
				Код действует 10 минут.
			</Text>
			<Text style={noteTextStyle} className="ww-note-text">
				Если вы не запрашивали код, просто проигнорируйте это письмо.
			</Text>
		</EmailLayout>
	);
};

export default VerificationEmail;
