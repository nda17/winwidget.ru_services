import {
	Injectable,
	OnApplicationShutdown,
	ServiceUnavailableException
} from '@nestjs/common';
import { Client } from 'pg';
import type { Response } from 'express';

type Subscription = {
	scope: string;
	subject: string;
	response: Response;
	changed: () => void;
};
const CHANNEL = 'crm_live_changes_v1';

/** Ephemeral invalidations only. Each API instance listens to its OWN database.
 * HTTP snapshots after LISTEN/reconnect recover missed signals; no business
 * command or durable notification is acknowledged by this transport.
 */
@Injectable()
export class LiveChangesService implements OnApplicationShutdown {
	private client?: Client;
	private connecting?: Promise<void>;
	private stopped = false;
	private readonly subscriptions = new Set<Subscription>();

	private ensureListener(): Promise<void> {
		if (this.stopped)
			return Promise.reject(new ServiceUnavailableException());
		if (this.connecting) return this.connecting;
		if (this.client) return Promise.resolve();
		const value = process.env.SUPPORT_DATABASE_URL;
		if (!value) return Promise.reject(new ServiceUnavailableException());
		const client = new Client({
			connectionString: value,
			connectionTimeoutMillis: 3000,
			query_timeout: 3000,
			application_name: 'crm-live-listener',
			keepAlive: true,
			keepAliveInitialDelayMillis: 10000
		});
		this.client = client;
		const lost = () => {
			if (this.client !== client) return;
			this.client = undefined;
			for (const subscription of this.subscriptions)
				subscription.response.end();
			void client.end().catch(() => undefined);
		};
		client.on('error', lost);
		client.on('end', lost);
		client.on('notification', notification => {
			if (
				this.client !== client ||
				notification.channel !== CHANNEL ||
				!notification.payload ||
				notification.payload.length > 512
			)
				return;
			for (const subscription of this.subscriptions) {
				if (subscription.scope === notification.payload)
					subscription.changed();
			}
		});
		this.connecting = (async () => {
			try {
				await client.connect();
				await client.query('LISTEN crm_live_changes_v1');
				if (this.client !== client || this.stopped) throw new Error();
			} catch {
				lost();
				throw new ServiceUnavailableException(
					'Live updates are temporarily unavailable'
				);
			} finally {
				this.connecting = undefined;
			}
		})();
		return this.connecting;
	}

	async open(
		scope: string,
		subject: string,
		response: Response,
		authorize: () => Promise<void>
	): Promise<void> {
		await this.ensureListener();
		if (
			this.subscriptions.size >= 1000 ||
			[...this.subscriptions].filter(item => item.subject === subject)
				.length >= 12
		)
			throw new ServiceUnavailableException('Too many live connections');
		if (response.destroyed || this.stopped) return;
		response.status(200).set({
			'Content-Type': 'text/event-stream; charset=utf-8',
			'Cache-Control': 'no-store, no-transform',
			'X-Accel-Buffering': 'no'
		});
		response.flushHeaders();
		let closed = false;
		let dirty = true;
		let checking = false;
		let queued: ReturnType<typeof setTimeout> | undefined;
		const write = (event: string) => {
			if (!closed && !response.write('event: ' + event + '\ndata: {}\n\n'))
				response.end(); // A slow browser reconnects; never accumulate an unbounded queue.
		};
		const check = async () => {
			if (closed || checking) return;
			checking = true;
			const changed = dirty;
			dirty = false;
			try {
				await authorize();
				if (!closed) write(changed ? 'invalidate' : 'clock');
			} catch {
				if (!closed) {
					write('access');
					response.end();
				}
			} finally {
				checking = false;
				if (dirty && !closed) schedule();
			}
		};
		const schedule = () => {
			if (closed || queued) return;
			queued = setTimeout(() => {
				queued = undefined;
				void check();
			}, 500);
		};
		const subscription: Subscription = {
			scope,
			subject,
			response,
			changed: () => {
				dirty = true;
				schedule();
			}
		};
		this.subscriptions.add(subscription);
		// Always read HTTP state after registering LISTEN, including the initial race.
		const heartbeat = setInterval(() => {
			write('heartbeat');
			void check();
		}, 10000);
		const lifetime = setTimeout(() => response.end(), 5 * 60 * 1000);
		const close = () => {
			closed = true;
			clearInterval(heartbeat);
			clearTimeout(lifetime);
			if (queued) clearTimeout(queued);
			this.subscriptions.delete(subscription);
		};
		response.once('close', close);
		response.once('finish', close);
		schedule();
	}

	async onApplicationShutdown(): Promise<void> {
		this.stopped = true;
		for (const subscription of this.subscriptions)
			subscription.response.end();
		const client = this.client;
		this.client = undefined;
		await client?.end().catch(() => undefined);
	}
}
