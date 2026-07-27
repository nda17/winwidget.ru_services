import { Text } from '@react-email/components';
import * as React from 'react';
import EmailLayout from './_components/email-layout';

export interface LimitReachedEmailProps {
	widgetName: string;
	limit: number;
}

const SITE_URL =
	process.env.RECAPTCHA_CLIENT_URL || 'https://winwidget.ru';

const primaryTextStyle = {
	color: '#27272a',
	fontSize: '17px',
	lineHeight: '30px',
	margin: '0 0 16px'
};

const secondaryTextStyle = {
	color: '#5f5f68',
	fontSize: '17px',
	lineHeight: '30px',
	margin: '0'
};

const LimitReachedEmail = ({
	widgetName,
	limit
}: LimitReachedEmailProps) => {
	return (
		<EmailLayout
			preview={`Лимит заявок исчерпан для виджета «${widgetName}»`}
			title="⚠️ Лимит заявок исчерпан"
			subtitle={`Виджет «${widgetName}»`}
			actionLabel="Выбрать тариф"
			actionHref={`${SITE_URL}/payment`}
		>
			<Text style={primaryTextStyle} className="ww-primary-text">
				Ваш виджет принял{' '}
				<strong>
					{limit} из {limit}
				</strong>{' '}
				доступных заявок и больше{' '}
				<strong>не принимает новые заявки</strong>.
			</Text>

			<Text style={secondaryTextStyle} className="ww-secondary-text">
				Чтобы продолжить сбор заявок, перейдите на платный тариф.
			</Text>
		</EmailLayout>
	);
};

export default LimitReachedEmail;
