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
import * as React from 'react';

interface EmailLayoutProps {
	preview: string;
	title: string;
	subtitle?: string;
	children: React.ReactNode;
	actionLabel?: string;
	actionHref?: string;
}

const brandGradient =
	'linear-gradient(87.12deg, #470B58 1.98%, #C21B84 50.27%, #FA595E 74.42%, #F8BD31 98.56%)';
const siteUrl = process.env.RECAPTCHA_CLIENT_URL || 'https://winwidget.ru';
const logoUrl = new URL('/icon-512x512.png', siteUrl).toString();

const bodyStyle = {
	backgroundColor: '#f5f5f7',
	fontFamily:
		'-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
	margin: '0',
	padding: '32px 16px'
};

const wrapperStyle = {
	margin: '0 auto',
	maxWidth: '600px'
};

const cardStyle = {
	backgroundColor: '#ffffff',
	border: '1px solid #e7e7ed',
	borderRadius: '18px',
	overflow: 'hidden'
};

const headerStyle = {
	backgroundColor: '#6a145f',
	backgroundImage: brandGradient,
	padding: '28px 32px 30px'
};

const brandRowStyle = {
	marginBottom: '22px'
};

const brandTableStyle = {
	borderCollapse: 'collapse' as const
};

const brandLogoCellStyle = {
	padding: '0 14px 0 0',
	verticalAlign: 'middle' as const
};

const logoStyle = {
	display: 'block',
	height: '52px',
	width: '52px'
};

const brandNameCellStyle = {
	verticalAlign: 'middle' as const
};

const brandNameStyle = {
	color: '#ffffff',
	display: 'block',
	fontSize: '28px',
	fontWeight: '700',
	lineHeight: '32px',
	letterSpacing: '-0.02em',
	margin: '0',
	textDecoration: 'none'
};

const titleStyle = {
	color: '#ffffff',
	fontSize: '28px',
	fontWeight: '700',
	lineHeight: '36px',
	margin: '0 0 10px'
};

const subtitleStyle = {
	color: 'rgba(255,255,255,0.9)',
	fontSize: '16px',
	fontWeight: '600',
	lineHeight: '24px',
	margin: '0'
};

const contentStyle = {
	padding: '32px'
};

const buttonWrapStyle = {
	paddingTop: '14px'
};

const buttonStyle = {
	backgroundColor: '#c21b84',
	backgroundImage: brandGradient,
	borderRadius: '14px',
	color: '#ffffff',
	display: 'inline-block',
	fontSize: '16px',
	fontWeight: '700',
	lineHeight: '16px',
	padding: '18px 30px',
	textDecoration: 'none'
};

const footerStyle = {
	color: '#a1a1aa',
	fontSize: '14px',
	lineHeight: '22px',
	margin: '18px 0 0',
	textAlign: 'center' as const
};

const footerLinkStyle = {
	color: '#c21b84',
	textDecoration: 'underline'
};

const EmailLayout = ({
	preview,
	title,
	subtitle,
	children,
	actionLabel,
	actionHref
}: EmailLayoutProps) => {
	return (
		<Html lang="ru">
			<Head>
				<style>{`
					@media only screen and (max-width: 600px) {
						.ww-body {
							padding: 18px 8px !important;
						}

						.ww-header {
							padding: 20px 20px 22px !important;
						}

						.ww-brand-row {
							margin-bottom: 16px !important;
						}

						.ww-brand-logo {
							width: 40px !important;
							height: 40px !important;
						}

						.ww-brand-logo-cell {
							padding-right: 10px !important;
						}

						.ww-brand-name {
							font-size: 22px !important;
							line-height: 26px !important;
						}

						.ww-title {
							font-size: 15px !important;
							line-height: 20px !important;
							margin-bottom: 8px !important;
						}

						.ww-subtitle {
							font-size: 10px !important;
							line-height: 14px !important;
						}

						.ww-content {
							padding: 22px 20px !important;
						}

						.ww-body-text,
						.ww-primary-text,
						.ww-secondary-text {
							font-size: 14px !important;
							line-height: 22px !important;
							margin-bottom: 16px !important;
						}

						.ww-note-text {
							font-size: 12px !important;
							line-height: 18px !important;
							margin-top: 14px !important;
						}

						.ww-code-wrap {
							padding: 14px 16px !important;
						}

						.ww-code-text {
							font-size: 26px !important;
							line-height: 26px !important;
							letter-spacing: 6px !important;
						}

						.ww-password-text {
							font-size: 22px !important;
							line-height: 28px !important;
							letter-spacing: 3px !important;
						}

						.ww-table-label,
						.ww-table-value {
							font-size: 12px !important;
							line-height: 17px !important;
							padding: 11px 12px !important;
						}

						.ww-button {
							font-size: 15px !important;
							line-height: 15px !important;
							padding: 15px 22px !important;
						}

						.ww-footer {
							font-size: 12px !important;
							line-height: 18px !important;
							margin-top: 14px !important;
						}
					}
				`}</style>
			</Head>
			<Preview>{preview}</Preview>
			<Body style={bodyStyle} className="ww-body">
				<Container style={wrapperStyle} className="ww-wrapper">
					<Section style={cardStyle}>
						<Section style={headerStyle} className="ww-header">
							<Section style={brandRowStyle} className="ww-brand-row">
								<table
									role="presentation"
									cellPadding="0"
									cellSpacing="0"
									style={brandTableStyle}
								>
									<tbody>
										<tr>
											<td
												style={brandLogoCellStyle}
												className="ww-brand-logo-cell"
											>
												<Img
													src={logoUrl}
													alt="WinWidget"
													width="52"
													height="52"
													style={logoStyle}
													className="ww-brand-logo"
												/>
											</td>
											<td style={brandNameCellStyle}>
												<Link
													href={siteUrl}
													style={brandNameStyle}
													className="ww-brand-name"
												>
													winwidget.ru
												</Link>
											</td>
										</tr>
									</tbody>
								</table>
							</Section>
							<Text style={titleStyle} className="ww-title">
								{title}
							</Text>
							{subtitle ? (
								<Text style={subtitleStyle} className="ww-subtitle">
									{subtitle}
								</Text>
							) : null}
						</Section>

						<Section style={contentStyle} className="ww-content">
							{children}

							{actionLabel && actionHref ? (
								<Section style={buttonWrapStyle}>
									<Button
										href={actionHref}
										style={buttonStyle}
										className="ww-button"
									>
										{actionLabel}
									</Button>
								</Section>
							) : null}
						</Section>
					</Section>

					<Text style={footerStyle} className="ww-footer">
						Письмо отправлено автоматически сервисом{' '}
						<Link href="https://winwidget.ru" style={footerLinkStyle}>
							winwidget.ru
						</Link>
					</Text>
				</Container>
			</Body>
		</Html>
	);
};

export default EmailLayout;
