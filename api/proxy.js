import fetch from 'node-fetch';
import Cors from 'cors';
import initMiddleware from '../../lib/init-middleware';

const cors = initMiddleware(
  Cors({
    origin: '*',
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    credentials: true,
  })
);

export default async function handler(req, res) {
  await cors(req, res);

  const { pathname } = new URL(req.url, `http://${req.headers.host}`);

  if (pathname.endsWith('/health')) {
    return res.status(200).json({ status: 'ok' });
  }

  if (pathname.endsWith('/user')) {
    try {
      const response = await fetch('https://login.smoobu.com/api/user', {
        headers: {
          'Authorization': `Bearer ${process.env.SMOOBU_API_TOKEN}`,
          'Content-Type': 'application/json',
        },
      });

      const data = await response.json();
      return res.status(200).json(data);
    } catch (error) {
      return res.status(500).json({ error: 'Fehler beim Abruf der Nutzerdaten' });
    }
  }

  res.status(404).json({ error: 'Route nicht gefunden' });
}
