import * as React from 'react';

const VerificationEmail = ({ url }: { url: string }) => {
	return (
		<div>
			<h1>Здравствуйте!</h1>

			<p>
				Вы получили это письмо, потому что кто-то указал его при
				регистрации в сервисе winwidget.ru. Если это были вы, перейдите по
				ссылке, чтобы подтвердить свой адрес электронной почты.
			</p>

			<a href={url}>Подтвердить email адрес</a>

			<p>или скопируйте ссылку и вставьте её в свой браузер.</p>

			<a
				href={url}
				target="_blank"
				style={{
					color: '#A981DC'
				}}
			>
				{url}
			</a>

			<p
				style={{
					color: '#FC0303'
				}}
			>
				Это письмо было сгенерировано и отправлено роботом. Вам не нужно
				отвечать на него. Если у вас есть вопрос, пожалуйста, свяжитесь с
				нами по адресу info@winwidget.ru
			</p>
		</div>
	);
};

export default VerificationEmail;
