export interface IYandexUserInfo {
	id: string;
	login: string;
	display_name: string;
	default_email: string;
	default_avatar_id: string;
	is_avatar_empty: boolean;
}

export const buildYandexAuthUrl = (
	clientId: string,
	callbackUrl: string,
	state?: string
): string => {
	const params = new URLSearchParams({
		client_id: clientId,
		response_type: 'code',
		redirect_uri: callbackUrl,
		force_confirm: 'no'
	});

	if (state) {
		params.set('state', state);
	}

	return `https://oauth.yandex.ru/authorize?${params}`;
};

export const exchangeYandexCode = async (
	code: string,
	clientId: string,
	clientSecret: string,
	callbackUrl: string
): Promise<string> => {
	const body = new URLSearchParams({
		grant_type: 'authorization_code',
		code,
		client_id: clientId,
		client_secret: clientSecret,
		redirect_uri: callbackUrl
	});

	const response = await fetch('https://oauth.yandex.ru/token', {
		method: 'POST',
		headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
		body: body.toString()
	});

	if (!response.ok) {
		throw new Error(
			`Yandex token exchange HTTP error: ${response.status}`
		);
	}

	const data = (await response.json()) as {
		access_token?: string;
		error?: string;
	};

	if (!data.access_token) {
		throw new Error(`Yandex token exchange failed: ${data.error}`);
	}

	return data.access_token;
};

export const fetchYandexUserInfo = async (
	accessToken: string
): Promise<IYandexUserInfo> => {
	const response = await fetch(
		'https://login.yandex.ru/info?format=json',
		{
			headers: { Authorization: `OAuth ${accessToken}` }
		}
	);

	if (!response.ok) {
		throw new Error(`Yandex user info HTTP error: ${response.status}`);
	}

	return response.json() as Promise<IYandexUserInfo>;
};

export const buildYandexAvatarUrl = (
	userInfo: IYandexUserInfo
): string => {
	if (userInfo.is_avatar_empty) return '';
	return `https://avatars.yandex.net/get-yapic/${userInfo.default_avatar_id}/islands-200`;
};
