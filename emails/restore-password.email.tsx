import { Section, Text } from '@react-email/components';
import * as React from 'react';
import EmailLayout from '@email/_components/email-layout';

const SITE_URL =
	process.env.RECAPTCHA_CLIENT_URL || 'https://winwidget.ru';

const leadTextStyle = {
	color: '#27272a',
	fontSize: '17px',
	lineHeight: '30px',
	margin: '0 0 22px'
};

const passwordWrapStyle = {
	backgroundColor: '#faf7ff',
	border: '1px solid #ececf2',
	borderRadius: '14px',
	padding: '18px 20px',
	textAlign: 'center' as const
};

const passwordTextStyle = {
	color: '#18181b',
	fontSize: '28px',
	fontWeight: '700',
	letterSpacing: '4px',
	lineHeight: '34px',
	margin: '0',
	wordBreak: 'break-all' as const
};

const noteTextStyle = {
	color: '#5f5f68',
	fontSize: '15px',
	lineHeight: '24px',
	margin: '18px 0 0'
};

const NewPasswordEmail = ({ password }: { password: string }) => {
	return (
		<EmailLayout
			preview="Ваш временный пароль для входа в WinWidget"
			title="🔑 Временный пароль для входа"
			subtitle="Используйте его для входа и смените пароль после авторизации"
			actionLabel="Перейти ко входу"
			actionHref={`${SITE_URL}/login`}
		>
			<Text style={leadTextStyle} className="ww-body-text">
				Вы получили это письмо, потому что для данного адреса был запрошен
				новый временный пароль вместо забытого. Используйте его для входа в
				аккаунт.
			</Text>

			<Section style={passwordWrapStyle} className="ww-code-wrap">
				<Text style={passwordTextStyle} className="ww-password-text">
					{password}
				</Text>
			</Section>

			<Text style={noteTextStyle} className="ww-note-text">
				После входа рекомендуем сразу сменить временный пароль в профиле.
			</Text>
			<Text style={noteTextStyle} className="ww-note-text">
				Если это были не вы, просто проигнорируйте письмо и проверьте
				безопасность аккаунта.
			</Text>
		</EmailLayout>
	);
};

export default NewPasswordEmail;
