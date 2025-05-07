import fetch from 'node-fetch';

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Nur POST erlaubt" });
  }

  try {
    const response = await fetch("https://login.smoobu.com/api/reservations", {
      method: "POST",
      headers: {
        'Api-Key': process.env.SMOOBU_API_TOKEN,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(req.body)
    });

    const data = await response.json();
    res.status(response.status).json(data);
  } catch (error) {
    res.status(500).json({ error: "Fehler beim Absenden der Buchung", details: error.message });
  }
}

