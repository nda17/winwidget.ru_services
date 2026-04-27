import { Controller, Get, Param, Req, Res } from '@nestjs/common';
import { Request, Response } from 'express';

@Controller()
export class CountdownTimerPublicController {
	@Get('page-timer/:key')
	serveTimerPage(
		@Param('key') key: string,
		@Req() req: Request,
		@Res() res: Response
	) {
		const origin = `${req.protocol}://${req.get('host')}`;
		res.setHeader('Content-Type', 'text/html; charset=utf-8');
		return res.send(`<!doctype html>
<html lang="ru">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>Таймер — WinWidget</title>
  <style>
    html,body{margin:0;min-height:100%;background:#0d0d1a;font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
  </style>
</head>
<body>
  <script>window.wintimerAutoOpen = true;</script>
  <script src="${origin}/widgets/timer.js" data-key="${key}" async></script>
</body>
</html>`);
	}
}
