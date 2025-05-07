import fetch from 'node-fetch';

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Nur POST erlaubt" });
  }

  try {
    const response = await fetch("https://login.smoobu.com/api/availability", {
      method: "POST",
      headers: {
        'Api-Key': process.env.SMOOBU_API_TOKEN,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(req.body)
    });

    const text = await response.text();
    try {
      const json = JSON.parse(text);
      res.status(response.status).json(json);
    } catch {
      res.status(response.status).json({ raw: text });
    }
  } catch (error) {
    res.status(500).json({ error: "Fehler beim Abrufen der Verfügbarkeit", details: error.message });
  }
}

