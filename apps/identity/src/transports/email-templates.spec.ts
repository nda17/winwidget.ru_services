import { render } from '@react-email/render';
import { passwordEmail, verificationEmail } from './email-templates';
import {
	PASSWORD_EMAIL_SUBJECT,
	VERIFICATION_EMAIL_SUBJECT
} from './verification-transport.service';

describe('Identity verification email parity', () => {
	const configuredSiteUrl = process.env.RECAPTCHA_CLIENT_URL;

	beforeAll(() => {
		delete process.env.RECAPTCHA_CLIENT_URL;
	});

	afterAll(() => {
		if (configuredSiteUrl === undefined) {
			delete process.env.RECAPTCHA_CLIENT_URL;
			return;
		}
		process.env.RECAPTCHA_CLIENT_URL = configuredSiteUrl;
	});

	it('renders the frozen confirmation layout, mobile CSS and subject', () => {
		const html = render(verificationEmail('123456'));
		expect(VERIFICATION_EMAIL_SUBJECT).toBe('Код подтверждения email');
		expect(html).toContain('@media only screen and (max-width: 600px)');
		expect(html).toContain('class="ww-brand-logo-cell"');
		expect(html).toContain('role="presentation"');
		expect(html).toContain('Код подтверждения email');
		expect(html).toContain('123456');
		expect(html).toContain('Код действует 10 минут.');
		expect(html).toContain('Письмо отправлено автоматически сервисом');
		expect(html).toContain('https://winwidget.ru');
	});

	it('renders the frozen password action and subject without dropping mobile classes', () => {
		const html = render(passwordEmail('TempPass1'));
		expect(PASSWORD_EMAIL_SUBJECT).toBe('Временный пароль');
		expect(html).toContain('Временный пароль для входа');
		expect(html).toContain('TempPass1');
		expect(html).toContain('class="ww-password-text"');
		expect(html).toContain('class="ww-button"');
		expect(html).toContain('href="https://winwidget.ru/login"');
		expect(html).toContain('Перейти ко входу');
	});
});
