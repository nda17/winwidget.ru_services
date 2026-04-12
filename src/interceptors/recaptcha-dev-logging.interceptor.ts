import {
	CallHandler,
	ExecutionContext,
	Injectable,
	Logger,
	NestInterceptor
} from '@nestjs/common'
import { RecaptchaVerificationResult } from '@nestlab/google-recaptcha'
import { Observable, tap } from 'rxjs'
import { Request } from 'express'

type RequestWithRecaptchaResult = Request & {
	recaptchaValidationResult?: RecaptchaVerificationResult
}

@Injectable()
export class RecaptchaDevLoggingInterceptor implements NestInterceptor {
	private readonly logger = new Logger('reCAPTCHA')
	private readonly isDevelopment = process.env.MODE === 'development'

	intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
		if (!this.isDevelopment || context.getType() !== 'http') {
			return next.handle()
		}

		const request = context
			.switchToHttp()
			.getRequest<RequestWithRecaptchaResult>()

		return next.handle().pipe(
			tap(() => {
				const result = request.recaptchaValidationResult

				if (!result) {
					return
				}

				this.logger.debug(
					{
						method: request.method,
						path: request.originalUrl || request.url,
						tokenProvided: Boolean(request.headers.recaptcha),
						success: result.success,
						action: result.action,
						score: result.score,
						hostname: result.hostname,
						remoteIp: result.remoteIp ?? request.ip,
						errors: result.errors
					},
					'success'
				)
			})
		)
	}
}
