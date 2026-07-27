import { publicWidgetKeyPipe } from '@/widget/public-widget-key.pipe';
import { Controller, Get, Param, Res } from '@nestjs/common';
import { Response } from 'express';

@Controller()
export class QuizPublicController {
	/**
	 * GET /page-quiz/:key
	 * Preview page — standalone page with the quiz
	 */
	@Get('page-quiz/:key')
	serveQuizPage(
		@Param('key', publicWidgetKeyPipe) key: string,
		@Res() res: Response
	) {
		res.setHeader('Content-Security-Policy', "frame-ancestors 'self'");
		res.setHeader('X-Frame-Options', 'SAMEORIGIN');

		const html = `<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Квиз — WinWidget</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { background: #0d0d1a; min-height: 100vh; }
  </style>
</head>
<body>
  <script>window.winquizAutoOpen = true;</script>
  <script src="/widgets/quiz.js" data-key="${key}" async></script>
</body>
</html>`;

		res.status(200).type('text/html').send(html);
	}
}
