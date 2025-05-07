import fetch from 'node-fetch';
import cors from 'cors';

const corsMiddleware = cors({
  origin: '*',
  methods: ['POST', 'OPTIONS'], // Removed GET since we only handle POST
  allowedHeaders: ['Content-Type', 'Authorization']
});

// runMiddleware remains the same

export default async function handler(req, res) {
  await runMiddleware(req, res, corsMiddleware);

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Nur POST erlaubt" });
  }

  try {
    // 1. Fixed API endpoint URL
    const response = await fetch("https://api.smoobu.com/api/availability", {
      method: "POST",
      headers: {
        // 2. Use only one authentication method
        'Api-Key': process.env.SMOOBU_API_TOKEN,
        // 'Authorization': `Bearer ${...}` // Remove if using API key
        'Content-Type': 'application/json',
        // 3. Add required user agent
        'User-Agent': 'Your-Service-Name/v1.0'
      },
      body: JSON.stringify(req.body)
    });

    // 4. Better error handling
    if (!response.ok) {
      const errorData = await response.json().catch(() => null);
      console.error('API Error Details:', {
        status: response.status,
        headers: Object.fromEntries(response.headers.entries()),
        error: errorData
      });
      
      return res.status(response.status).json({
        error: `Smoobu API Error: ${response.status} ${response.statusText}`,
        details: errorData || await response.text()
      });
    }

    const data = await response.json();
    return res.status(200).json(data);
  } catch (error) {
    console.error("Full error context:", {
      error: error.stack,
      request: {
        headers: req.headers,
        body: req.body
      }
    });
    return res.status(500).json({ 
      error: "Interner Serverfehler",
      details: process.env.NODE_ENV === 'development' ? error.message : null
    });
  }
}