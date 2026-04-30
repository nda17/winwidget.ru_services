import { BadRequestException } from '@nestjs/common';
import { Request } from 'express';
import { domainToASCII } from 'url';

const SECOND_LEVEL_PUBLIC_SUFFIXES = new Set([
	'co.uk',
	'org.uk',
	'ac.uk',
	'gov.uk',
	'com.au',
	'net.au',
	'org.au',
	'com.br',
	'com.tr',
	'co.jp',
	'com.ua',
	'com.ru',
	'net.ru',
	'org.ru',
	'pp.ru'
]);

const LOCAL_DOMAINS = new Set([
	'localhost',
	'127.0.0.1',
	'0.0.0.0',
	'::1'
]);

const INVALID_DOMAIN_MESSAGE =
	'Укажите корректный домен установки виджета';

const isIpv4 = (hostname: string) =>
	/^(\d{1,3}\.){3}\d{1,3}$/.test(hostname);

const getHeaderValue = (
	value: string | string[] | undefined
): string | undefined => {
	if (Array.isArray(value)) return value[0];
	return value;
};

const getRootDomain = (hostname: string) => {
	const labels = hostname.split('.').filter(Boolean);

	if (labels.length < 2) {
		if (LOCAL_DOMAINS.has(hostname)) return hostname;
		throw new BadRequestException(INVALID_DOMAIN_MESSAGE);
	}

	const publicSuffix = labels.slice(-2).join('.');
	if (
		SECOND_LEVEL_PUBLIC_SUFFIXES.has(publicSuffix) &&
		labels.length >= 3
	) {
		return labels.slice(-3).join('.');
	}

	return labels.slice(-2).join('.');
};

export const normalizeInstallDomain = (value: unknown): string => {
	if (value === undefined || value === null) return '';
	if (typeof value !== 'string') {
		throw new BadRequestException(INVALID_DOMAIN_MESSAGE);
	}

	const candidate = value.trim();
	if (!candidate) return '';
	if (/\s/.test(candidate) || candidate.includes('@')) {
		throw new BadRequestException(INVALID_DOMAIN_MESSAGE);
	}

	const withProtocol = /^[a-z][a-z\d+\-.]*:\/\//i.test(candidate)
		? candidate
		: `https://${candidate}`;

	let hostname = '';
	try {
		hostname = new URL(withProtocol).hostname;
	} catch {
		throw new BadRequestException(INVALID_DOMAIN_MESSAGE);
	}

	hostname = hostname
		.toLowerCase()
		.replace(/^\[/, '')
		.replace(/\]$/, '')
		.replace(/\.$/, '')
		.replace(/^\*\./, '')
		.replace(/^www\./, '');

	if (!hostname) throw new BadRequestException(INVALID_DOMAIN_MESSAGE);
	if (
		LOCAL_DOMAINS.has(hostname) ||
		isIpv4(hostname) ||
		hostname.includes(':')
	) {
		return hostname;
	}

	const asciiHostname = domainToASCII(hostname);
	if (!asciiHostname)
		throw new BadRequestException(INVALID_DOMAIN_MESSAGE);

	const labels = asciiHostname.split('.');
	if (
		labels.some(
			label =>
				!label ||
				!/^[a-z0-9-]+$/i.test(label) ||
				label.startsWith('-') ||
				label.endsWith('-')
		)
	) {
		throw new BadRequestException(INVALID_DOMAIN_MESSAGE);
	}

	return getRootDomain(asciiHostname.toLowerCase());
};

const safeNormalizeDomain = (value: string | undefined) => {
	if (!value) return null;
	try {
		return normalizeInstallDomain(value);
	} catch {
		return null;
	}
};

export const getWidgetRequestDomain = (req: Request) => {
	const originDomain = safeNormalizeDomain(
		getHeaderValue(req.headers.origin)
	);
	if (originDomain) return originDomain;

	return safeNormalizeDomain(
		getHeaderValue(req.headers.referer || req.headers.referrer)
	);
};

const getInternalDomains = () => {
	return new Set(
		[
			'winwidget.ru',
			'www.winwidget.ru',
			'api.winwidget.ru',
			process.env.RECAPTCHA_CLIENT_URL
		]
			.map(value => safeNormalizeDomain(value))
			.filter(Boolean) as string[]
	);
};

const isInternalWidgetDomain = (domain: string | null) => {
	if (!domain) return false;
	if (LOCAL_DOMAINS.has(domain)) return true;
	return getInternalDomains().has(domain);
};

export const isWidgetDomainAllowed = (
	installDomain: string,
	requestDomain: string | null
) => {
	if (isInternalWidgetDomain(requestDomain)) return true;

	const normalizedInstallDomain = safeNormalizeDomain(installDomain);
	if (!normalizedInstallDomain || !requestDomain) return false;

	return normalizedInstallDomain === requestDomain;
};
