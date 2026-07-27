import { Link, Section, Text } from '@react-email/components';
import * as React from 'react';
import EmailLayout from './_components/email-layout';

export interface LeadNotificationEmailProps {
	widgetName: string;
	phone?: string;
	email?: string;
	name?: string;
	bonus?: string;
	detailLabel?: string;
	detailValue?: string;
	url?: string;
	dateLabel: string;
}

const SITE_URL =
	process.env.RECAPTCHA_CLIENT_URL || 'https://winwidget.ru';

const leadStyle = {
	color: '#27272a',
	fontSize: '17px',
	fontWeight: '400',
	lineHeight: '30px',
	margin: '0 0 22px'
};

const tableWrapStyle = {
	backgroundColor: '#ffffff',
	border: '1px solid #ececf2',
	borderRadius: '14px',
	overflow: 'hidden'
};

const tableStyle = {
	borderCollapse: 'collapse' as const,
	width: '100%'
};

const labelCellBaseStyle = {
	backgroundColor: '#faf7ff',
	color: '#71717a',
	fontSize: '14px',
	fontWeight: '700',
	lineHeight: '20px',
	padding: '14px 16px',
	verticalAlign: 'top',
	whiteSpace: 'nowrap' as const,
	width: '170px'
};

const valueCellBaseStyle = {
	color: '#18181b',
	fontSize: '14px',
	lineHeight: '20px',
	padding: '14px 16px',
	verticalAlign: 'top'
};

const accentValueStyle = {
	color: '#c21b84',
	fontWeight: '700'
};

const linkStyle = {
	color: '#c21b84',
	textDecoration: 'underline'
};

const LeadNotificationEmail = ({
	widgetName,
	phone,
	email,
	name,
	bonus,
	detailLabel,
	detailValue,
	url,
	dateLabel
}: LeadNotificationEmailProps) => {
	const rows: Array<{ label: string; value: React.ReactNode }> = [
		{ label: 'Дата', value: dateLabel }
	];

	if (name) rows.push({ label: 'Имя', value: name });
	if (phone) rows.push({ label: 'Телефон', value: phone });
	if (email) rows.push({ label: 'Email', value: email });
	if (bonus) {
		rows.push({
			label: 'Выигранный приз',
			value: <span style={accentValueStyle}>{bonus}</span>
		});
	}
	if (detailLabel && detailValue) {
		rows.push({
			label: detailLabel,
			value: <span style={accentValueStyle}>{detailValue}</span>
		});
	}
	if (url) {
		rows.push({
			label: 'Страница',
			value: (
				<Link href={url} style={linkStyle}>
					{url}
				</Link>
			)
		});
	}

	return (
		<EmailLayout
			preview={`Новая заявка с виджета «${widgetName}»`}
			title="🎯 Новая заявка с виджета"
			subtitle={`Виджет «${widgetName}»`}
			actionLabel="Открыть кабинет"
			actionHref={`${SITE_URL}/cabinet?tab=widgets`}
		>
			<Text style={leadStyle} className="ww-body-text">
				Вы получили новую заявку. Ниже данные посетителя и страницы, с
				которой она была отправлена.
			</Text>

			<Section style={tableWrapStyle}>
				<table
					role="presentation"
					cellPadding="0"
					cellSpacing="0"
					style={tableStyle}
				>
					<tbody>
						{rows.map(({ label, value }, index) => {
							const isLastRow = index === rows.length - 1;
							const borderBottom = isLastRow
								? 'none'
								: '1px solid #ececf2';

							return (
								<tr key={label}>
									<td
										style={{
											...labelCellBaseStyle,
											borderBottom
										}}
										className="ww-table-label"
									>
										{label}
									</td>
									<td
										style={{
											...valueCellBaseStyle,
											borderBottom
										}}
										className="ww-table-value"
									>
										{value}
									</td>
								</tr>
							);
						})}
					</tbody>
				</table>
			</Section>
		</EmailLayout>
	);
};

export default LeadNotificationEmail;
