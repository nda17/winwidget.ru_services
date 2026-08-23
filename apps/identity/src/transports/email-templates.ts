import {
	Body,
	Button,
	Container,
	Head,
	Html,
	Img,
	Link,
	Preview,
	Section,
	Text
} from '@react-email/components';
import { createElement, type CSSProperties, type ReactNode } from 'react';

const brandGradient =
	'linear-gradient(87.12deg, #470B58 1.98%, #C21B84 50.27%, #FA595E 74.42%, #F8BD31 98.56%)';

const mobileStyles = `
	@media only screen and (max-width: 600px) {
		.ww-body { padding: 18px 8px !important; }
		.ww-header { padding: 20px 20px 22px !important; }
		.ww-brand-row { margin-bottom: 16px !important; }
		.ww-brand-logo { width: 40px !important; height: 40px !important; }
		.ww-brand-logo-cell { padding-right: 10px !important; }
		.ww-brand-name { font-size: 22px !important; line-height: 26px !important; }
		.ww-title { font-size: 15px !important; line-height: 20px !important; margin-bottom: 8px !important; }
		.ww-subtitle { font-size: 10px !important; line-height: 14px !important; }
		.ww-content { padding: 22px 20px !important; }
		.ww-body-text, .ww-primary-text, .ww-secondary-text { font-size: 14px !important; line-height: 22px !important; margin-bottom: 16px !important; }
		.ww-note-text { font-size: 12px !important; line-height: 18px !important; margin-top: 14px !important; }
		.ww-code-wrap { padding: 14px 16px !important; }
		.ww-code-text { font-size: 26px !important; line-height: 26px !important; letter-spacing: 6px !important; }
		.ww-password-text { font-size: 22px !important; line-height: 28px !important; letter-spacing: 3px !important; }
		.ww-table-label, .ww-table-value { font-size: 12px !important; line-height: 17px !important; padding: 11px 12px !important; }
		.ww-button { font-size: 15px !important; line-height: 15px !important; padding: 15px 22px !important; }
		.ww-footer { font-size: 12px !important; line-height: 18px !important; margin-top: 14px !important; }
	}
`;

function layout(input: {
	preview: string;
	title: string;
	subtitle: string;
	children: ReactNode;
	actionLabel?: string;
	actionHref?: string;
}) {
	const siteUrl =
		process.env.RECAPTCHA_CLIENT_URL || 'https://winwidget.ru';
	return createElement(
		Html,
		{ lang: 'ru' },
		createElement(Head, null, createElement('style', null, mobileStyles)),
		createElement(Preview, null, input.preview),
		createElement(
			Body,
			{
				style: {
					backgroundColor: '#f5f5f7',
					fontFamily:
						'-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
					margin: 0,
					padding: '32px 16px'
				},
				className: 'ww-body'
			},
			createElement(
				Container,
				{
					style: { margin: '0 auto', maxWidth: '600px' },
					className: 'ww-wrapper'
				},
				createElement(
					Section,
					{
						style: {
							backgroundColor: '#ffffff',
							border: '1px solid #e7e7ed',
							borderRadius: '18px',
							overflow: 'hidden'
						}
					},
					createElement(
						Section,
						{
							style: {
								backgroundColor: '#6a145f',
								backgroundImage: brandGradient,
								padding: '28px 32px 30px'
							},
							className: 'ww-header'
						},
						createElement(
							Section,
							{
								style: { marginBottom: '22px' },
								className: 'ww-brand-row'
							},
							createElement(
								'table',
								{
									role: 'presentation',
									cellPadding: '0',
									cellSpacing: '0',
									style: { borderCollapse: 'collapse' } as CSSProperties
								},
								createElement(
									'tbody',
									null,
									createElement(
										'tr',
										null,
										createElement(
											'td',
											{
												style: {
													padding: '0 14px 0 0',
													verticalAlign: 'middle'
												},
												className: 'ww-brand-logo-cell'
											},
											createElement(Img, {
												src: 'cid:winwidget-identity-logo',
												alt: 'WinWidget',
												width: '52',
												height: '52',
												style: {
													display: 'block',
													height: '52px',
													width: '52px'
												},
												className: 'ww-brand-logo'
											})
										),
										createElement(
											'td',
											{ style: { verticalAlign: 'middle' } },
											createElement(
												Link,
												{
													href: siteUrl,
													style: {
														color: '#ffffff',
														display: 'block',
														fontSize: '28px',
														fontWeight: '700',
														lineHeight: '32px',
														letterSpacing: '-0.02em',
														margin: 0,
														textDecoration: 'none'
													},
													className: 'ww-brand-name'
												},
												'winwidget.ru'
											)
										)
									)
								)
							)
						),
						createElement(
							Text,
							{
								style: {
									color: '#ffffff',
									fontSize: '28px',
									fontWeight: '700',
									lineHeight: '36px',
									margin: '0 0 10px'
								},
								className: 'ww-title'
							},
							input.title
						),
						createElement(
							Text,
							{
								style: {
									color: 'rgba(255,255,255,0.9)',
									fontSize: '16px',
									fontWeight: '600',
									lineHeight: '24px',
									margin: 0
								},
								className: 'ww-subtitle'
							},
							input.subtitle
						)
					),
					createElement(
						Section,
						{ style: { padding: '32px' }, className: 'ww-content' },
						input.children,
						input.actionLabel && input.actionHref
							? createElement(
									Section,
									{ style: { paddingTop: '14px' } },
									createElement(
										Button,
										{
											href: input.actionHref,
											style: {
												backgroundColor: '#c21b84',
												backgroundImage: brandGradient,
												borderRadius: '14px',
												color: '#ffffff',
												fontWeight: '700',
												padding: '18px 30px',
												textDecoration: 'none',
												fontSize: '16px',
												lineHeight: '16px',
												display: 'inline-block'
											},
											className: 'ww-button'
										},
										input.actionLabel
									)
								)
							: null
					)
				),
				createElement(
					Text,
					{
						style: {
							color: '#a1a1aa',
							fontSize: '14px',
							lineHeight: '22px',
							margin: '18px 0 0',
							textAlign: 'center'
						},
						className: 'ww-footer'
					},
					'Письмо отправлено автоматически сервисом ',
					createElement(
						Link,
						{
							href: 'https://winwidget.ru',
							style: { color: '#c21b84', textDecoration: 'underline' }
						},
						'winwidget.ru'
					)
				)
			)
		)
	);
}

const leadStyle = {
	color: '#27272a',
	fontSize: '17px',
	lineHeight: '30px',
	margin: '0 0 22px'
};

const noteStyle = {
	color: '#5f5f68',
	fontSize: '15px',
	lineHeight: '24px',
	margin: '18px 0 0'
};

export function verificationEmail(code: string) {
	return layout({
		preview: 'Подтвердите email в WinWidget',
		title: '🔐 Код подтверждения email',
		subtitle: 'Подтвердите адрес электронной почты для входа в WinWidget',
		children: createElement(
			Section,
			null,
			createElement(
				Text,
				{ style: leadStyle, className: 'ww-body-text' },
				'Вы получили это письмо, потому что кто-то указал данный адрес при регистрации в сервисе winwidget.ru. Если это были вы, используйте код ниже для подтверждения email.'
			),
			createElement(
				Section,
				{
					style: {
						backgroundColor: '#faf7ff',
						border: '1px solid #ececf2',
						borderRadius: '14px',
						padding: '18px 20px',
						textAlign: 'center'
					},
					className: 'ww-code-wrap'
				},
				createElement(
					Text,
					{
						style: {
							color: '#18181b',
							fontSize: '32px',
							fontWeight: '700',
							letterSpacing: '10px',
							lineHeight: '32px',
							margin: 0
						},
						className: 'ww-code-text'
					},
					code
				)
			),
			createElement(
				Text,
				{ style: noteStyle, className: 'ww-note-text' },
				'Код действует 10 минут.'
			),
			createElement(
				Text,
				{ style: noteStyle, className: 'ww-note-text' },
				'Если вы не запрашивали код, просто проигнорируйте это письмо.'
			)
		)
	});
}

export function passwordEmail(password: string) {
	const siteUrl =
		process.env.RECAPTCHA_CLIENT_URL || 'https://winwidget.ru';
	return layout({
		preview: 'Ваш временный пароль для входа в WinWidget',
		title: '🔑 Временный пароль для входа',
		subtitle:
			'Используйте его для входа и смените пароль после авторизации',
		actionLabel: 'Перейти ко входу',
		actionHref: `${siteUrl}/login`,
		children: createElement(
			Section,
			null,
			createElement(
				Text,
				{ style: leadStyle, className: 'ww-body-text' },
				'Вы получили это письмо, потому что для данного адреса был запрошен новый временный пароль вместо забытого. Используйте его для входа в аккаунт.'
			),
			createElement(
				Section,
				{
					style: {
						backgroundColor: '#faf7ff',
						border: '1px solid #ececf2',
						borderRadius: '14px',
						padding: '18px 20px',
						textAlign: 'center'
					},
					className: 'ww-code-wrap'
				},
				createElement(
					Text,
					{
						style: {
							color: '#18181b',
							fontSize: '28px',
							fontWeight: '700',
							letterSpacing: '4px',
							wordBreak: 'break-all',
							lineHeight: '34px'
						},
						className: 'ww-password-text'
					},
					password
				)
			),
			createElement(
				Text,
				{ style: noteStyle, className: 'ww-note-text' },
				'После входа рекомендуем сразу сменить временный пароль в профиле.'
			),
			createElement(
				Text,
				{ style: noteStyle, className: 'ww-note-text' },
				'Если это были не вы, просто проигнорируйте письмо и проверьте безопасность аккаунта.'
			)
		)
	});
}
