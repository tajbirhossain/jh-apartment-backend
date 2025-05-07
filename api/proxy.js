import fetch from 'node-fetch';
import cors from 'cors';

// Helper function to run middleware
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
  // Set CORS headers directly as a fallback
  res.setHeader('Access-Control-Allow-Credentials', true);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  // Handle preflight requests immediately
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const { pathname } = new URL(req.url, `http://${req.headers.host}`);

  // Then also try to use the cors middleware
  try {
    await runMiddleware(req, res, cors());
  } catch (error) {
    console.error('CORS middleware error:', error);
    // Continue anyway since we already set headers manually
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

  // Handle the apartments endpoint
  if (pathname.endsWith('/apartments')) {
    try {
      const response = await fetch('https://login.smoobu.com/api/apartments', {
        headers: {
          'Authorization': `Bearer ${process.env.SMOOBU_API_TOKEN}`,
          'Content-Type': 'application/json',
        },
      });

      const data = await response.json();
      return res.status(200).json(data);
    } catch (error) {
      return res.status(500).json({ error: 'Fehler beim Abruf der Unterkünfte' });
    }
  }

  res.status(404).json({ error: 'Route nicht gefunden' });
}