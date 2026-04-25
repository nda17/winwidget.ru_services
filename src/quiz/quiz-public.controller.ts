import { Controller, Get, Param, Req, Res } from '@nestjs/common';
import { Request, Response } from 'express';

@Controller()
export class QuizPublicController {
	/**
	 * GET /page-quiz/:key
	 * Preview page — standalone page with the quiz
	 */
	@Get('page-quiz/:key')
	serveQuizPage(
		@Param('key') key: string,
		@Req() req: Request,
		@Res() res: Response
	) {
		const origin = `${req.protocol}://${req.get('host')}`;

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
  <script src="${origin}/widgets/quiz.js" data-key="${key}" async></script>
</body>
</html>`;

		res.status(200).type('text/html').send(html);
	}
}
