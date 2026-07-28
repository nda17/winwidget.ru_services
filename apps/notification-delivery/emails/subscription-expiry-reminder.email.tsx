import EmailLayout from './_components/email-layout';
import { Text } from '@react-email/components';
import * as React from 'react';

export interface SubscriptionExpiryReminderEmailProps {
	daysBeforeExpiry: number;
	planLabel: string;
	expiresAtLabel: string;
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

const noteTextStyle = {
	color: '#71717a',
	fontSize: '14px',
	lineHeight: '22px',
	margin: '24px 0 0'
};

const getDaysLabel = (days: number) => {
	const mod10 = days % 10;
	const mod100 = days % 100;
	if (mod10 === 1 && mod100 !== 11) return `${days} день`;
	if ([2, 3, 4].includes(mod10) && ![12, 13, 14].includes(mod100)) {
		return `${days} дня`;
	}
	return `${days} дней`;
};

const SubscriptionExpiryReminderEmail = ({
	daysBeforeExpiry,
	planLabel,
	expiresAtLabel
}: SubscriptionExpiryReminderEmailProps) => {
	const isLastDay = daysBeforeExpiry === 0;

	return (
		<EmailLayout
			preview={
				isLastDay
					? 'Сегодня последний день вашей подписки Winwidget'
					: `До окончания подписки Winwidget осталось ${getDaysLabel(daysBeforeExpiry)}`
			}
			title={
				isLastDay
					? 'Сегодня последний день подписки'
					: `Подписка закончится через ${getDaysLabel(daysBeforeExpiry)}`
			}
			subtitle={`Тариф ${planLabel} действует до ${expiresAtLabel} МСК`}
			actionLabel="Продлить подписку"
			actionHref={`${SITE_URL}/payment`}
		>
			<Text style={primaryTextStyle} className="ww-primary-text">
				{isLastDay
					? 'Сегодня последний день действия вашей подписки Winwidget.'
					: `До окончания вашей подписки Winwidget осталось ${getDaysLabel(daysBeforeExpiry)}.`}
			</Text>
			<Text style={secondaryTextStyle} className="ww-secondary-text">
				Продлите подписку заранее, чтобы виджеты продолжили работать без
				паузы.
			</Text>
			<Text style={noteTextStyle} className="ww-note-text">
				Если вы уже продлили подписку, это письмо можно игнорировать.
			</Text>
		</EmailLayout>
	);
};

export default SubscriptionExpiryReminderEmail;
