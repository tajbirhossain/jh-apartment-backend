import fetch from 'node-fetch';

export default async function handler(req, res) {
  const { pathname } = new URL(req.url, `http://${req.headers.host}`);

  const allowedOrigins = ['https://jh-apartments.de', 'http://127.0.0.1:5500'];
  const origin = req.headers.origin;

  if (allowedOrigins.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

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
