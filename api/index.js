import fetch from 'node-fetch';
import cors from 'cors';

const corsMiddleware = cors({
  origin: '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
});

const runMiddleware = (req, res, fn) => {
  return new Promise((resolve, reject) => {
    fn(req, res, (result) => {
      if (result instanceof Error) {
        return reject(result);
      }
      return resolve(result);
    });
  });
};

export default async function handler(req, res) {
  await runMiddleware(req, res, corsMiddleware);

  const { pathname } = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

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