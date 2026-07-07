export interface IGoogleProfile {
	providerId: string;
	email: string;
	firstName?: string;
	lastName?: string;
	picture?: string;
	accessToken: string;
}

export interface IGithubProfile {
	providerId: string;
	email: string;
	username?: string;
	picture?: string;
	accessToken: string;
}

export interface IYandexProfile {
	providerId: string;
	email: string;
	displayName?: string;
	picture?: string;
	accessToken: string;
}

export interface IVkProfile {
	provider: 'vk';
	providerId: string;
	email: string;
	firstName?: string;
	lastName?: string;
	picture?: string;
	accessToken: string;
}

export type TSocialProfile =
	| IGoogleProfile
	| IGithubProfile
	| IYandexProfile
	| IVkProfile;
