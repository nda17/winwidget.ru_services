import EmailLayout from '@email/_components/email-layout';
import { Text } from '@react-email/components';
import * as React from 'react';

interface PaymentSucceededEmailProps {
	amount: string;
	planLabel: string;
	billingPeriodLabel: string;
	expiresAtLabel: string | null;
}

const textStyle = {
	color: '#27272a',
	fontSize: '17px',
	lineHeight: '30px',
	margin: '0 0 16px'
};

const PaymentSucceededEmail = ({
	amount,
	planLabel,
	billingPeriodLabel,
	expiresAtLabel
}: PaymentSucceededEmailProps) => (
	<EmailLayout
		preview="Оплата WinWidget успешно подтверждена"
		title="Оплата успешно подтверждена"
		subtitle={`Тариф ${planLabel} активирован`}
		actionLabel="Перейти в кабинет"
		actionHref={`${process.env.RECAPTCHA_CLIENT_URL || 'https://winwidget.ru'}/cabinet`}
	>
		<Text style={textStyle}>
			Сумма: {amount} ₽. Период: {billingPeriodLabel}.
		</Text>
		{expiresAtLabel && (
			<Text style={textStyle}>
				Подписка действует до {expiresAtLabel} МСК.
			</Text>
		)}
	</EmailLayout>
);

export default PaymentSucceededEmail;
