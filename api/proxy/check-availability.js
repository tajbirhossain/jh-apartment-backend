import fetch from 'node-fetch';
import cors from 'cors';

const corsMiddleware = cors({
  origin: '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'Api-Key']
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

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Nur POST erlaubt" });
  }

  try {
    const response = await fetch("https://login.smoobu.com/booking/checkApartmentAvailability", {
      method: "POST",
      headers: {
        'Api-Key': process.env.SMOOBU_API_TOKEN,
        'Authorization': `Bearer ${process.env.SMOOBU_API_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(req.body)
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`API Error: ${response.status}`, errorText);
      return res.status(response.status).json({
        error: `API Error: ${response.status}`,
        details: errorText
      });
    }

    const data = await response.json();
    return res.status(200).json(data);
  } catch (error) {
    console.error("Availability check error:", error);
    return res.status(500).json({ error: "Fehler beim Abrufen der Verfügbarkeit", details: error.message });
  }
}