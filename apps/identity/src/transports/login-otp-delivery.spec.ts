import { ConfigService } from '@nestjs/config';
import net from 'node:net';
import { once } from 'node:events';
import tls from 'node:tls';
import { mkdtemp, readFile, unlink, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { VerificationTransportService } from './verification-transport.service';

describe('isolated login OTP delivery', () => {
	const originalFetch = global.fetch;
	afterEach(() => {
		global.fetch = originalFetch;
		jest.restoreAllMocks();
	});

	it('uses the bounded signal, exact SMS provider and rejects redirects', async () => {
		const calls: Array<{ url: string; init?: RequestInit }> = [];
		global.fetch = jest.fn(async (url, init) => {
			calls.push({ url: String(url), init });
			return Response.json({ success: true });
		}) as typeof fetch;
		const transport = new VerificationTransportService(
			new ConfigService({
				SMSAERO_EMAIL: 'synthetic@example.test',
				SMSAERO_API_KEY: 'synthetic-only'
			})
		);
		const signal = AbortSignal.timeout(1000);
		await transport.loginCode('SMS', '+79990001122', '123456', signal);
		expect(calls).toHaveLength(1);
		const url = new URL(calls[0].url);
		expect(`${url.origin}${url.pathname}`).toBe(
			'https://gate.smsaero.ru/v2/sms/send'
		);
		expect(url.search).toBe('');
		expect(calls[0].url).not.toContain('123456');
		expect(calls[0].url).not.toContain('79990001122');
		expect(JSON.parse(calls[0].init!.body as string)).toEqual({
			number: 79990001122,
			text: 'Код входа в WinWidget: 123456. Никому не сообщайте код.',
			sign: 'SMS Aero'
		});
		expect(calls[0].init).toMatchObject({
			signal,
			redirect: 'error',
			method: 'POST'
		});
	});

	it('closes the owned SMTP socket at the hard deadline without touching the registration mailer', async () => {
		const sockets = new Set<net.Socket>();
		const server = net.createServer(socket => {
			sockets.add(socket);
			socket.once('close', () => sockets.delete(socket));
		});
		server.listen(0, '127.0.0.1');
		await once(server, 'listening');
		const port = (server.address() as net.AddressInfo).port;
		const connect = net.connect.bind(net);
		const override = jest.spyOn(net, 'connect').mockImplementation(((
			options: net.NetConnectOpts
		) =>
			connect({
				...options,
				host: '127.0.0.1',
				port
			})) as typeof net.connect);
		const transport = new VerificationTransportService(
			new ConfigService({
				MODE: 'development',
				SMTP_SERVER: '127.0.0.1',
				SMTP_LOGIN: 'synthetic',
				SMTP_PASSWORD: 'synthetic'
			})
		);
		const started = performance.now();
		try {
			await expect(
				transport.loginCode(
					'EMAIL',
					'synthetic@example.test',
					'123456',
					AbortSignal.timeout(100)
				)
			).rejects.toThrow();
			expect(performance.now() - started).toBeLessThan(1500);
			expect(override).toHaveBeenCalledTimes(1);
			expect(transport.isEmailConfigured()).toBe(true);
		} finally {
			override.mockRestore();
			for (const socket of sockets) socket.destroy();
			await new Promise<void>(resolve => server.close(() => resolve()));
		}
	});

	it('never begins an external attempt for an already aborted request', async () => {
		global.fetch = jest.fn();
		const transport = new VerificationTransportService(
			new ConfigService({
				SMSAERO_EMAIL: 'synthetic@example.test',
				SMSAERO_API_KEY: 'synthetic-only'
			})
		);
		await expect(
			transport.loginCode(
				'SMS',
				'+79990001122',
				'123456',
				AbortSignal.abort()
			)
		).rejects.toThrow();
		expect(global.fetch).not.toHaveBeenCalled();
	});

	it('requires verified TLS on the production SMTP path before sending any AUTH', async () => {
		const directory = await mkdtemp(
			join(tmpdir(), 'identity-otp-tls-test-')
		);
		const keyFile = join(directory, 'key.pem');
		const certFile = join(directory, 'cert.pem');
		let server: tls.Server | undefined;
		const sockets = new Set<net.Socket>();
		try {
			// Disposable test-only key material; never printed or committed.
			execFileSync(
				'openssl',
				[
					'req',
					'-x509',
					'-newkey',
					'rsa:2048',
					'-nodes',
					'-keyout',
					keyFile,
					'-out',
					certFile,
					'-subj',
					'/CN=localhost',
					'-days',
					'1'
				],
				{ stdio: 'ignore' }
			);
			let secureConnections = 0;
			server = tls.createServer(
				{ key: await readFile(keyFile), cert: await readFile(certFile) },
				() => {
					secureConnections += 1;
				}
			);
			server.on('connection', socket => {
				sockets.add(socket);
				socket.once('close', () => sockets.delete(socket));
			});
			server.on('tlsClientError', () => undefined);
			server.listen(0, '127.0.0.1');
			await once(server, 'listening');
			const port = (server.address() as net.AddressInfo).port;
			const connect = net.connect.bind(net);
			jest.spyOn(net, 'connect').mockImplementation(((
				options: net.NetConnectOpts
			) =>
				connect({
					...options,
					host: '127.0.0.1',
					port
				})) as typeof net.connect);
			const transport = new VerificationTransportService(
				new ConfigService({
					MODE: 'production',
					SMTP_SERVER: 'localhost',
					SMTP_LOGIN: 'synthetic',
					SMTP_PASSWORD: 'synthetic'
				})
			);
			await expect(
				transport.loginCode(
					'EMAIL',
					'synthetic@example.test',
					'123456',
					AbortSignal.timeout(3000)
				)
			).rejects.toMatchObject({
				message: expect.stringMatching(/self.signed certificate/i)
			});
			expect(secureConnections).toBe(0);
		} finally {
			jest.restoreAllMocks();
			for (const socket of sockets) socket.destroy();
			if (server)
				await new Promise<void>(resolve => server!.close(() => resolve()));
			await unlink(keyFile).catch(() => undefined);
			await unlink(certFile).catch(() => undefined);
			await rmdir(directory);
		}
	});
});
