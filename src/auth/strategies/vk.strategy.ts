import { createHash, randomBytes } from 'crypto';

export interface IVkTokenResponse {
	access_token?: string;
	refresh_token?: string;
	id_token?: string;
	token_type?: string;
	expires_in?: number;
	user_id?: number | string;
	state?: string;
	scope?: string;
	error?: string;
	error_description?: string;
}

export interface IVkUserInfo {
	user_id: number | string;
	first_name?: string;
	last_name?: string;
	avatar?: string;
	email?: string;
}

export interface IVkPkcePair {
	codeVerifier: string;
	codeChallenge: string;
}

export const generateVkState = () => base64Url(randomBytes(24));

export const generateVkPkcePair = (): IVkPkcePair => {
	const codeVerifier = base64Url(randomBytes(48));
	const codeChallenge = base64Url(
		createHash('sha256').update(codeVerifier).digest()
	);

	return { codeVerifier, codeChallenge };
};

const base64Url = (value: Buffer) =>
	value
		.toString('base64')
		.replace(/\+/g, '-')
		.replace(/\//g, '_')
		.replace(/=+$/g, '');

export const buildVkAuthUrl = (
	clientId: string,
	callbackUrl: string,
	state: string,
	codeChallenge: string
): string => {
	const params = new URLSearchParams({
		client_id: clientId,
		redirect_uri: callbackUrl,
		response_type: 'code',
		scope: 'email',
		state,
		code_challenge: codeChallenge,
		code_challenge_method: 'S256'
	});

	return `https://id.vk.ru/authorize?${params}`;
};

export const exchangeVkCode = async (
	code: string,
	clientId: string,
	serviceToken: string,
	callbackUrl: string,
	codeVerifier: string,
	deviceId: string,
	state: string
): Promise<IVkTokenResponse> => {
	const params = new URLSearchParams({
		grant_type: 'authorization_code',
		client_id: clientId,
		service_token: serviceToken,
		redirect_uri: callbackUrl,
		code,
		code_verifier: codeVerifier,
		device_id: deviceId,
		state
	});

	const response = await fetch('https://id.vk.ru/oauth2/auth', {
		method: 'POST',
		headers: {
			'Content-Type': 'application/x-www-form-urlencoded'
		},
		body: params
	});

	if (!response.ok) {
		throw new Error(`VK token exchange HTTP error: ${response.status}`);
	}

	const data = (await response.json()) as IVkTokenResponse;

	if (!data.access_token || !data.user_id) {
		throw new Error(
			`VK token exchange failed: ${data.error || 'missing token'}`
		);
	}

	return data;
};

export const fetchVkUserInfo = async (
	accessToken: string,
	clientId: string
): Promise<IVkUserInfo> => {
	const params = new URLSearchParams({
		client_id: clientId,
		access_token: accessToken
	});

	const response = await fetch('https://id.vk.ru/oauth2/user_info', {
		method: 'POST',
		headers: {
			'Content-Type': 'application/x-www-form-urlencoded'
		},
		body: params
	});

	if (!response.ok) {
		throw new Error(`VK user info HTTP error: ${response.status}`);
	}

	const data = (await response.json()) as {
		user?: IVkUserInfo;
		error?: string;
		error_description?: string;
	};

	if (!data.user) {
		throw new Error(
			`VK user info failed: ${data.error_description || data.error || 'empty response'}`
		);
	}

	return data.user;
};
