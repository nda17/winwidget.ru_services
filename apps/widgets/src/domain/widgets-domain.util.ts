import { BadRequestException, NotFoundException } from '@nestjs/common';
import type { Request } from 'express';
import { domainToASCII } from 'node:url';

const SECOND_LEVEL_SUFFIXES = new Set([
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
const INVALID_DOMAIN = 'Укажите корректный домен установки виджета';

export const normalizeInstallDomain = (value: unknown): string => {
	if (value === null || value === undefined) return '';
	if (typeof value !== 'string')
		throw new BadRequestException(INVALID_DOMAIN);
	const candidate = value.trim();
	if (!candidate) return '';
	if (/\s/.test(candidate) || candidate.includes('@')) {
		throw new BadRequestException(INVALID_DOMAIN);
	}
	let hostname: string;
	try {
		hostname = new URL(
			/^[a-z][a-z\d+.-]*:\/\//i.test(candidate)
				? candidate
				: `https://${candidate}`
		).hostname;
	} catch {
		throw new BadRequestException(INVALID_DOMAIN);
	}
	hostname = hostname
		.toLowerCase()
		.replace(/^\[/, '')
		.replace(/\]$/, '')
		.replace(/\.$/, '')
		.replace(/^\*\./, '')
		.replace(/^www\./, '');
	if (!hostname) throw new BadRequestException(INVALID_DOMAIN);
	if (
		LOCAL_DOMAINS.has(hostname) ||
		/^(\d{1,3}\.){3}\d{1,3}$/.test(hostname) ||
		hostname.includes(':')
	) {
		return hostname;
	}
	const ascii = domainToASCII(hostname);
	const labels = ascii.split('.');
	if (
		!ascii ||
		labels.length < 2 ||
		labels.some(label => !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(label))
	) {
		throw new BadRequestException(INVALID_DOMAIN);
	}
	const suffix = labels.slice(-2).join('.');
	return SECOND_LEVEL_SUFFIXES.has(suffix) && labels.length >= 3
		? labels.slice(-3).join('.')
		: suffix;
};

const safeDomain = (value: string | undefined): string | null => {
	if (!value) return null;
	try {
		return normalizeInstallDomain(value);
	} catch {
		return null;
	}
};

const firstHeader = (value: string | string[] | undefined) =>
	Array.isArray(value) ? value[0] : value;

export const getRequestDomain = (request: Request): string | null =>
	safeDomain(firstHeader(request.headers.origin)) ||
	safeDomain(
		firstHeader(request.headers.referer || request.headers.referrer)
	);

export const isDomainAllowed = (
	installDomain: string,
	requestDomain: string | null
): boolean =>
	Boolean(
		installDomain &&
		requestDomain &&
		safeDomain(installDomain) === requestDomain
	);

export const isDirectPageRequest = (
	request: Request,
	pagePath: string,
	publicKey: string
): boolean => {
	const raw = firstHeader(
		request.headers.referer || request.headers.referrer
	);
	if (!raw) return false;
	try {
		const url = new URL(raw);
		const domain = safeDomain(url.hostname);
		if (
			!domain ||
			(!LOCAL_DOMAINS.has(domain) && domain !== 'winwidget.ru')
		)
			return false;
		return (
			url.pathname.replace(/\/+$/, '') === `/${pagePath}/${publicKey}`
		);
	} catch {
		return false;
	}
};

export const getClientIp = (request: Request): string => {
	const forwarded = firstHeader(request.headers['x-forwarded-for']);
	return (
		forwarded?.split(',')[0]?.trim() ||
		request.ip ||
		request.socket.remoteAddress ||
		''
	).slice(0, 128);
};

export const normalizePage = (value: unknown, fallback = 1): number => {
	const number = Number(value);
	return Number.isInteger(number) && number > 0 ? number : fallback;
};

export const normalizeLimit = (
	value: unknown,
	fallback: number,
	max = 100
): number => {
	const number = Number(value);
	return Number.isInteger(number) && number > 0
		? Math.min(number, max)
		: fallback;
};

export const safePublicKey = (value: string): string => {
	if (!/^[a-f0-9]{12}$/.test(value)) {
		throw new NotFoundException('Виджет не найден');
	}
	return value;
};
