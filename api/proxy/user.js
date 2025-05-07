import fetch from 'node-fetch';

export default async function handler(req, res) {
  try {
    const response = await fetch('https://login.smoobu.com/api/apartments', {
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.SMOOBU_API_TOKEN}`
      }
    });

    if (!response.ok) {
      return res.status(response.status).json({ error: `Fehler vom Smoobu-Server: ${response.status}` });
    }

    const data = await response.json();
    res.status(200).json(data);
  } catch (error) {
    res.status(500).json({ error: 'Fehler beim Abruf der Daten', details: error.message });
  }
}

