import { AuthController } from '@/auth/auth.controller';
import type { Request, Response } from 'express';

describe('AuthController refresh', () => {
	it('sets the rotated refresh cookie and keeps it out of the response body', async () => {
		const authService = {
			refreshSession: jest.fn().mockResolvedValue({
				user: { id: 'user-id' },
				accessToken: 'access-token',
				refreshToken: 'rotated-refresh-token'
			})
		};
		const refreshTokenService = {
			REFRESH_TOKEN_NAME: 'refreshToken',
			addRefreshTokenToResponse: jest.fn(),
			removeRefreshTokenFromResponse: jest.fn()
		};
		const controller = new AuthController(
			authService as never,
			{} as never,
			refreshTokenService as never,
			{} as never,
			{} as never
		);
		const request = {
			cookies: {
				refreshToken: 'current-refresh-token'
			}
		} as unknown as Request;
		const response = {} as Response;

		await expect(controller.refresh(request, response)).resolves.toEqual({
			user: { id: 'user-id' },
			accessToken: 'access-token'
		});
		expect(authService.refreshSession).toHaveBeenCalledWith(
			'current-refresh-token'
		);
		expect(
			refreshTokenService.addRefreshTokenToResponse
		).toHaveBeenCalledWith(response, 'rotated-refresh-token');
	});
});
