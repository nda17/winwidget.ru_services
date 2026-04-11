export type SendSmsOptions = {
	to: string
	text: string
	ip?: string
}

export interface SmsProvider {
	send(options: SendSmsOptions): Promise<void>
}
